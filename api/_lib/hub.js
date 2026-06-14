// Cliente del Hub familiar (one-page-to-rule-them-all).
//
// El juego consulta la sala creada en el hub y le devuelve los resultados.
// Variables de entorno:
//   HUB_URL            -> URL base del hub (sin barra final)
//   HUB_RESULT_SECRET  -> secreto compartido para enviar resultados

function hubUrl() {
  const base = process.env.HUB_URL;
  if (!base) throw new Error('Falta la variable de entorno HUB_URL');
  return base.replace(/\/+$/, '');
}

/** Devuelve la sala del hub o null si no existe. */
export async function getHubRoom(code) {
  const res = await fetch(`${hubUrl()}/api/rooms/${encodeURIComponent(code)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Hub respondió ${res.status} al leer la sala`);
  return res.json();
}

/** ¿Está este userId entre los jugadores (role 'player') de la sala? */
export function esJugadorDeSala(sala, userId) {
  if (!sala || !Array.isArray(sala.players)) return false;
  return sala.players.some((p) => p.userId === userId && p.role === 'player');
}

/**
 * Envía el resultado de una partida al hub.
 * @param {string} code
 * @param {{ results: Array<{userId:string, result:'win'|'loss'|'draw', score?:number, position?:number}>, kind?: 'ranked'|'practice', notes?: string }} payload
 */
export async function submitHubResult(code, payload) {
  const secret = process.env.HUB_RESULT_SECRET;
  if (!secret) throw new Error('Falta la variable de entorno HUB_RESULT_SECRET');

  const res = await fetch(
    `${hubUrl()}/api/rooms/${encodeURIComponent(code)}/result`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ kind: 'ranked', ...payload }),
    },
  );

  let body = {};
  try { body = await res.json(); } catch { /* sin cuerpo */ }
  return { ok: res.ok, status: res.status, ...body };
}

/**
 * Envía el resultado de la ronda actual al hub si todavía no se ha enviado y
 * actualiza `state.round.resultStatus` in-place. Idempotente: si ya está enviado
 * o en curso, no hace nada. Se invoca en cuanto la fase cambia a 'result', sin
 * esperar a la cuenta atrás.
 */
export async function submitMatchResultToHub(state, code) {
  if (state.phase !== 'result' || !state.round?.result) return;
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
  const motivoLog =
    result === 'guesser' ? 'palabra adivinada'
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
