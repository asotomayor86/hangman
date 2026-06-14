// Estado vivo de una partida de hangman en Neon Postgres.
//
// Tabla: hangman_rooms ( code text pk, state jsonb, updated_at timestamptz,
//                        expires_at timestamptz )
// Se crea en caliente la primera vez que se accede (CREATE TABLE IF NOT EXISTS).
//
// El cliente NUNCA debe recibir la palabra completa (a no ser que sea el setter
// o estemos en pantalla de resultado). Para eso existe sanitizeForUser().

import { neon } from '@neondatabase/serverless';

let sqlInstance = null;
let schemaReady = false;

function sql() {
  if (sqlInstance) return sqlInstance;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('Falta DATABASE_URL en las variables del proyecto.');
  sqlInstance = neon(url);
  return sqlInstance;
}

async function ensureSchema() {
  if (schemaReady) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS hangman_rooms (
      code TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS hangman_rooms_expires_at ON hangman_rooms(expires_at)`;
  schemaReady = true;
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

/** Devuelve el estado actual de la sala (o null si no existe o ha caducado). */
export async function getState(code) {
  await ensureSchema();
  const rows = await sql()`
    SELECT state FROM hangman_rooms
    WHERE code = ${code} AND expires_at > NOW()
  `;
  return rows[0]?.state ?? null;
}

/** Persiste el estado (renovando TTL a 24h). */
export async function saveState(state) {
  await ensureSchema();
  state.v += 1;
  state.updatedAt = Date.now();
  await sql()`
    INSERT INTO hangman_rooms (code, state, updated_at, expires_at)
    VALUES (${state.code}, ${JSON.stringify(state)}::jsonb, NOW(),
            NOW() + INTERVAL '24 hours')
    ON CONFLICT (code) DO UPDATE
      SET state = EXCLUDED.state,
          updated_at = NOW(),
          expires_at = NOW() + INTERVAL '24 hours'
  `;
  return state;
}

/** Borra el estado. */
export async function deleteState(code) {
  await ensureSchema();
  await sql()`DELETE FROM hangman_rooms WHERE code = ${code}`;
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
