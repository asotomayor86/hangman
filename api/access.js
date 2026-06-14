import { setUserCookie, clearUserCookie } from './_lib/auth.js';

// POST /api/access { userId, name }
//   Fija la cookie de identidad después de que el cliente haya iniciado sesión
//   contra Neon Auth del hub (el hub valida la contraseña real).
// DELETE /api/access
//   Cierra la sesión local del juego (la sesión del hub se cierra aparte).
export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    clearUserCookie(res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const userId = (req.body?.userId ?? '').toString();
  const name = (req.body?.name ?? '').toString().slice(0, 60);
  if (!userId) return res.status(400).json({ error: 'Falta userId' });
  setUserCookie(res, { id: userId, name });
  res.status(200).json({ ok: true, user: { id: userId, name } });
}
