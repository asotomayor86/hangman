// POST /api/action { code, type, payload }
//
// Aplica una acción del juego al estado compartido en KV. Tipos:
//   - set-time      payload: { timeLimit: 60|120|180 }
//   - choose-setter payload: { setterId }
//   - set-word      payload: { word } (solo el setter)
//   - guess-letter  payload: { letter } (solo el guesser)
//   - submit-result (cualquier jugador, idempotente)
//   - next-round    (cualquier jugador, vuelve a fase 'choosing')

import { requireUser } from './_lib/auth.js';
import {
  getState,
  saveState,
  applyTimeoutIfDue,
  applyMatchOutcome,
  normalizeWord,
  isValidWord,
  isWordComplete,
} from './_lib/state.js';
import { submitMatchResultToHub } from './_lib/hub.js';

export default async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (e) {
    console.error('POST /api/action crashed:', e);
    return res.status(500).json({ error: e.message || 'Error interno' });
  }
}

async function handle(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const user = requireUser(req, res);
  if (!user) return;

  const code = (req.body?.code ?? '').toString().trim().toUpperCase();
  const type = req.body?.type;
  const payload = req.body?.payload || {};
  if (!code) return res.status(400).json({ error: 'Falta el código de sala' });
  if (!type) return res.status(400).json({ error: 'Falta tipo de acción' });

  const state = await getState(code);
  if (!state) return res.status(404).json({ error: 'Sala no inicializada' });
  if (!state.players.find(p => p.userId === user.id)) {
    return res.status(403).json({ error: 'No eres jugador de esta sala' });
  }

  applyTimeoutIfDue(state);

  try {
    switch (type) {
      case 'set-time':
        actionSetTime(state, payload);
        break;
      case 'choose-setter':
        actionChooseSetter(state, payload);
        break;
      case 'set-word':
        actionSetWord(state, user, payload);
        break;
      case 'guess-letter':
        actionGuessLetter(state, user, payload);
        break;
      case 'submit-result':
        // Reintento manual: la lógica vive en el helper.
        break;
      case 'next-round':
        actionNextRound(state);
        break;
      default:
        return res.status(400).json({ error: 'Acción desconocida' });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Si acabamos de transicionar a 'result' (por jugar la letra que cierra la
  // ronda, por timeout, o por reintento manual con 'submit-result'), enviamos
  // ya el resultado al hub: no esperamos a la cuenta atrás ni a un poll.
  if (state.phase === 'result' && state.round?.result) {
    await submitMatchResultToHub(state, code);
  }

  await saveState(state);
  res.status(200).json({ ok: true, v: state.v });
}

function actionSetTime(state, payload) {
  if (state.phase !== 'lobby') {
    throw new Error('No se puede cambiar el tiempo en mitad de una partida');
  }
  const t = parseInt(payload.timeLimit, 10);
  if (![60, 120, 180].includes(t)) throw new Error('Tiempo no válido');
  state.timeLimit = t;
}

function actionChooseSetter(state, payload) {
  if (state.phase !== 'lobby') {
    throw new Error('Ya hay una ronda en curso');
  }
  if (!state.players.every(p => p.joined)) {
    throw new Error('Faltan jugadores por entrar');
  }
  const setterId = payload.setterId;
  const setter = state.players.find(p => p.userId === setterId);
  if (!setter) throw new Error('Jugador no encontrado');
  const guesser = state.players.find(p => p.userId !== setterId);
  state.phase = 'writing';
  state.round = {
    setterId,
    guesserId: guesser.userId,
    word: null,
    originalWord: null,
    guessed: [],
    wrong: [],
    endTime: null,
    result: null,
    resultStatus: null,
  };
}

function actionSetWord(state, user, payload) {
  if (state.phase !== 'writing') throw new Error('No es el momento de escribir la palabra');
  if (state.round.setterId !== user.id) {
    throw new Error('Solo el que pone la palabra puede enviarla');
  }
  const raw = String(payload.word || '').trim();
  if (!isValidWord(raw)) throw new Error('Palabra no válida (solo letras y espacios, mínimo 3)');
  state.round.originalWord = raw;
  state.round.word = normalizeWord(raw);
  state.round.endTime = Date.now() + state.timeLimit * 1000;
  state.phase = 'guessing';
}

function actionGuessLetter(state, user, payload) {
  if (state.phase !== 'guessing') throw new Error('No es el momento de adivinar');
  if (state.round.guesserId !== user.id) {
    throw new Error('Solo el que adivina puede pulsar letras');
  }
  const letter = String(payload.letter || '').toUpperCase();
  if (!/^[A-ZÑ]$/.test(letter)) throw new Error('Letra no válida');
  if (state.round.guessed.includes(letter) || state.round.wrong.includes(letter)) return;

  if (state.round.word.includes(letter)) {
    state.round.guessed.push(letter);
    if (isWordComplete(state.round.word, state.round.guessed)) {
      state.round.result = 'guesser';
      state.phase = 'result';
      applyMatchOutcome(state);
    }
  } else {
    state.round.wrong.push(letter);
    if (state.round.wrong.length >= 6) {
      state.round.result = 'setter';
      state.phase = 'result';
      applyMatchOutcome(state);
    }
  }
}

async function actionSubmitResult(state, code) {
  if (state.phase !== 'result' || !state.round?.result) {
    throw new Error('No hay resultado para enviar');
  }
  if (state.round.resultStatus?.ok) return;
  if (state.round.resultStatus?.sending) return;

  state.round.resultStatus = { sending: true, ok: false, error: null };

  const { setterId, guesserId, result } = state.round;
  let results;
  if (result === 'guesser') {
    results = [
      { userId: guesserId, result: 'win' },
      { userId: setterId, result: 'loss' },
    ];
  } else {
    results = [
      { userId: setterId, result: 'win' },
      { userId: guesserId, result: 'loss' },
    ];
  }
  const motivoLog = result === 'guesser' ? 'palabra adivinada'
    : result === 'time-out' ? 'tiempo agotado'
    : 'sin vidas';

  try {
    const out = await submitHubResult(code, {
      results,
      notes: `Ahorcado: ${motivoLog}`,
    });
    state.round.resultStatus = out.ok
      ? { sending: false, ok: true, error: null }
      : { sending: false, ok: false, error: out.error || `Hub respondió ${out.status}` };
  } catch (e) {
    state.round.resultStatus = { sending: false, ok: false, error: e.message };
  }
}

function actionNextRound(state) {
  if (state.phase !== 'result') throw new Error('No hay resultado todavía');
  if (state.seriesWinner) {
    throw new Error('La serie ya ha terminado. Volved al hub.');
  }
  state.phase = 'lobby';
  state.round = null;
  state.resumeAt = null;
  state.seriesGame = (state.seriesGame || 1) + 1;
}
