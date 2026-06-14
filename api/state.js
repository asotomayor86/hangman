// GET /api/state?code=XXX → estado actual de la sala, sanitizado para el usuario.
//
// La primera lectura crea el estado en KV a partir de la sala del hub. Cualquier
// lectura aplica timeout del reloj si ya ha pasado (transición a fase 'result').

import { requireUser } from './_lib/auth.js';
import { getState, saveState, freshState, sanitizeForUser, applyTimeoutIfDue } from './_lib/state.js';
import { getHubRoom } from './_lib/hub.js';

export default async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (e) {
    console.error('GET /api/state crashed:', e);
    return res.status(500).json({ error: e.message || 'Error interno' });
  }
}

async function handle(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const user = requireUser(req, res);
  if (!user) return;

  const code = (req.query?.code ?? '').toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Falta el código de sala' });

  let state = await getState(code);

  let created = false;
  if (!state) {
    // Primera vez que se accede: validamos sala en el hub y creamos estado
    let sala;
    try {
      sala = await getHubRoom(code);
    } catch {
      return res.status(502).json({ error: 'No se pudo consultar la sala en el hub' });
    }
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });
    const players = (sala.players || []).filter(p => p.role === 'player');
    if (players.length !== 2) {
      return res.status(400).json({ error: 'El ahorcado necesita 2 jugadores en la sala' });
    }
    if (!players.find(p => p.userId === user.id)) {
      return res.status(403).json({ error: 'No eres jugador de esta sala' });
    }
    state = freshState(code, players);
    created = true;
  } else {
    if (!state.players.find(p => p.userId === user.id)) {
      return res.status(403).json({ error: 'No eres jugador de esta sala' });
    }
  }

  // Auto-join al hacer poll: registramos que este usuario está dentro
  const me = state.players.find(p => p.userId === user.id);
  let joined = false;
  if (!me.joined) {
    me.joined = true;
    me.joinedAt = Date.now();
    joined = true;
  }

  const timeoutTriggered = applyTimeoutIfDue(state);

  if (created || joined || timeoutTriggered) {
    await saveState(state);
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(sanitizeForUser(state, user.id));
}
