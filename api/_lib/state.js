// Estado vivo de una partida de hangman en Upstash Redis.
//
// Clave: hangman:room:{CODE}  →  JSON con el estado completo de la sala
// TTL: 24h (las partidas familiares duran como mucho una sesión).
//
// El cliente NUNCA debe recibir la palabra completa (a no ser que sea el setter
// o estemos en pantalla de resultado). Para eso existe sanitizeForUser().

import { Redis } from '@upstash/redis';

const TTL_SECONDS = 60 * 60 * 24;

// Lazy init: si no hay Redis configurado, lanzamos error solo al usarlo,
// no al cargar el módulo (así otros endpoints siguen funcionando).
let redisInstance = null;
function redis() {
  if (redisInstance) return redisInstance;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Falta configurar Redis (UPSTASH_REDIS_REST_URL/TOKEN o KV_REST_API_*).');
  }
  redisInstance = new Redis({ url, token });
  return redisInstance;
}

function key(code) {
  return `hangman:room:${code}`;
}

/** Crea un estado nuevo de sala (lobby con dos jugadores aún sin entrar). */
export function freshState(code, players, timeLimit = 120) {
  return {
    code,
    v: 1,
    updatedAt: Date.now(),
    phase: 'lobby',
    players: players.map(p => ({
      userId: p.userId,
      name: p.name,
      joined: false,
      joinedAt: null,
    })),
    timeLimit,
    round: null,
  };
}

/** Devuelve el estado actual de la sala (o null si no existe). */
export async function getState(code) {
  return await redis().get(key(code));
}

/** Persiste el estado (con TTL). */
export async function saveState(state) {
  state.v += 1;
  state.updatedAt = Date.now();
  await redis().set(key(state.code), state, { ex: TTL_SECONDS });
  return state;
}

/** Borra el estado (al final de la sala o por TTL). */
export async function deleteState(code) {
  await redis().del(key(code));
}

/** Normaliza una palabra: mayúsculas, sin tildes, mantiene ñ. */
export function normalizeWord(s) {
  return String(s).toUpperCase()
    .replace(/Á|À|Â|Ä/g, 'A')
    .replace(/É|È|Ê|Ë/g, 'E')
    .replace(/Í|Ì|Î|Ï/g, 'I')
    .replace(/Ó|Ò|Ô|Ö/g, 'O')
    .replace(/Ú|Ù|Û|Ü/g, 'U');
}

/** ¿Es una palabra válida (sólo letras y espacios, mínimo 3 letras)? */
export function isValidWord(s) {
  const n = normalizeWord(String(s).trim());
  if (n.length < 3) return false;
  if (!/^[A-ZÑ ]+$/.test(n)) return false;
  if (n.replace(/ /g, '').length < 3) return false;
  return true;
}

/** Construye la versión enmascarada (huecos en letras sin acertar). */
export function maskedFrom(word, guessed) {
  if (!word) return '';
  const set = new Set(guessed || []);
  return word.split('').map(ch => {
    if (ch === ' ') return ' ';
    return set.has(ch) ? ch : '_';
  }).join('');
}

/** ¿Está la palabra completamente adivinada? */
export function isWordComplete(word, guessed) {
  const set = new Set(guessed || []);
  return word.split('').every(ch => ch === ' ' || set.has(ch));
}

/**
 * Devuelve el estado tal y como debe verlo `userId`:
 *  - Si es el setter, ve la palabra original (la escribió él).
 *  - Si no, sólo recibe la versión enmascarada.
 *  - En pantalla de resultado se incluye originalWord para los dos.
 */
export function sanitizeForUser(state, userId) {
  if (!state) return null;
  const me = state.players.find(p => p.userId === userId);
  const out = {
    code: state.code,
    v: state.v,
    updatedAt: state.updatedAt,
    phase: state.phase,
    timeLimit: state.timeLimit,
    players: state.players,
    me: me ? { id: me.userId, name: me.name } : null,
  };
  if (state.round) {
    const r = state.round;
    const isSetter = r.setterId === userId;
    const showOriginal = isSetter || state.phase === 'result';
    out.round = {
      setterId: r.setterId,
      guesserId: r.guesserId,
      maskedWord: r.word ? maskedFrom(r.word, r.guessed) : '',
      originalWord: showOriginal ? r.originalWord : null,
      wordLength: r.word ? r.word.length : 0,
      guessed: r.guessed || [],
      wrong: r.wrong || [],
      endTime: r.endTime,
      result: r.result,
      resultStatus: r.resultStatus || null,
    };
  }
  return out;
}

/**
 * Aplica caducidad de tiempo si toca: si estamos en fase 'guessing' y se ha
 * agotado el reloj, transiciona a fase 'result' con outcome 'time-out'.
 * Devuelve true si cambió el estado.
 */
export function applyTimeoutIfDue(state) {
  if (!state || state.phase !== 'guessing' || !state.round) return false;
  if (!state.round.endTime) return false;
  if (Date.now() < state.round.endTime) return false;
  state.round.result = 'time-out';
  state.phase = 'result';
  return true;
}
