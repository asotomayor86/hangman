// Sesión sin estado para serverless: cookie con `payload.firma` (HMAC-SHA256).
// La cookie se fija tras un login SSO contra Neon Auth del hub (que es quien
// valida la contraseña real). Aquí solo persistimos quién es entre peticiones.

import crypto from 'node:crypto';

const COOKIE_USER = 'hangman_user';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 días

function signingSecret() {
  return (
    process.env.AUTH_SIGNING_SECRET ||
    process.env.HUB_RESULT_SECRET ||
    'dev-insecure-secret'
  );
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(value) {
  return crypto.createHmac('sha256', signingSecret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function signUser(user) {
  const payload = b64url(JSON.stringify({ id: user.id, name: user.name || '' }));
  return `${payload}.${hmac(payload)}`;
}

export function readUser(req) {
  const c = parseCookies(req);
  const raw = c[COOKIE_USER];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  if (!safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.id) return null;
    return { id: data.id, name: data.name || '' };
  } catch {
    return null;
  }
}

export function setUserCookie(res, user) {
  const cookie = [
    `${COOKIE_USER}=${encodeURIComponent(signUser(user))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${MAX_AGE}`,
  ].join('; ');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

export function clearUserCookie(res) {
  const cookie = `${COOKIE_USER}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

export function requireUser(req, res) {
  const user = readUser(req);
  if (!user) {
    res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
    return null;
  }
  return user;
}
