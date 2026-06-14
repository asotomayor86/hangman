import { requireUser } from './_lib/auth.js';
import { getHubRoom, esJugadorDeSala, submitHubResult } from './_lib/hub.js';

// POST /api/result { code, results: [{userId, result, score?}], notes? }
//   - Exige sesión local (cookie firmada por /api/access).
//   - Comprueba que el usuario actual pertenece a la sala del hub.
//   - Comprueba que todos los userIds del resultado pertenecen a la sala.
//   - Reenvía al hub con HUB_RESULT_SECRET.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const user = requireUser(req, res);
  if (!user) return;

  const code = (req.body?.code ?? '').toString().trim().toUpperCase();
  const results = req.body?.results;
  const notes = req.body?.notes;
  if (!code) return res.status(400).json({ error: 'Falta el código de sala' });
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'Falta el resultado' });
  }

  let sala;
  try {
    sala = await getHubRoom(code);
  } catch {
    return res.status(502).json({ error: 'No se pudo consultar la sala en el hub' });
  }
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });
  if (!esJugadorDeSala(sala, user.id)) {
    return res.status(403).json({ error: 'No eres jugador de esta sala' });
  }
  for (const r of results) {
    if (!esJugadorDeSala(sala, r.userId)) {
      return res.status(400).json({ error: 'Hay un jugador del resultado que no está en la sala' });
    }
  }

  const out = await submitHubResult(code, { results, notes });
  if (!out.ok) {
    return res.status(out.status || 502).json({ error: out.error || 'No se pudo guardar el resultado' });
  }
  res.status(200).json({ ok: true, matchId: out.matchId });
}
