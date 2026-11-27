import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(__dirname, '..', 'data', 'le-frigo-vide.sqlite');

let db = null;
let dbPath = null;

export function initDb(path = process.env.LE_FRIGO_DB || DEFAULT_DB_PATH) {
  if (db && dbPath === path) return db;
  if (db) { try { db.close(); } catch {} db = null; }
  dbPath = path;
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lang TEXT NOT NULL DEFAULT 'en',
      ingredients TEXT NOT NULL DEFAULT '[]',
      title TEXT,
      dignity_loss_percentage INTEGER DEFAULT 0,
      quote TEXT,
      quote_author TEXT,
      dread TEXT,
      menu_json TEXT,
      rejected INTEGER NOT NULL DEFAULT 0,
      rejection_reason TEXT,
      checkpoint_id TEXT,
      archived_box INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS checkpoints_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id INTEGER,
      checkpoint_id TEXT,
      dignity_loss_percentage INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'requested',
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS news_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS ingredient_history (
      ingredient TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      embedding TEXT
    );
  `);
  return db;
}

export function getDb() {
  if (!db) return initDb();
  return db;
}

export function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; dbPath = null; }
}

export function insertMeal(meal) {
  const d = getDb();
  const stmt = d.prepare(`INSERT INTO meals
    (lang, ingredients, title, dignity_loss_percentage, quote, quote_author, dread, menu_json, rejected, rejection_reason, checkpoint_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const r = stmt.run(
    meal.lang || 'en',
    JSON.stringify(meal.ingredients || []),
    meal.title || null,
    meal.dignity_loss_percentage ?? 0,
    meal.quote || null,
    meal.quote_author || null,
    meal.dread || null,
    meal.menu_json ? JSON.stringify(meal.menu_json) : null,
    meal.rejected ? 1 : 0,
    meal.rejection_reason || null,
    meal.checkpoint_id || null,
  );
  return Number(r.lastInsertRowid);
}

export function getMeal(id) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM meals WHERE id = ?').get(Number(id));
  if (!row) return null;
  return parseMeal(row);
}

export function parseMeal(row) {
  return {
    ...row,
    ingredients: safeJson(row.ingredients, []),
    menu_json: safeJson(row.menu_json, null),
    rejected: Boolean(row.rejected),
    archived_box: Boolean(row.archived_box),
  };
}

export function listMeals(limit = 20) {
  const d = getDb();
  return d.prepare('SELECT * FROM meals ORDER BY id DESC LIMIT ?').all(limit).map(parseMeal);
}

export function updateMealCheckpoint(id, checkpointId) {
  getDb().prepare('UPDATE meals SET checkpoint_id = ? WHERE id = ?').run(checkpointId, Number(id));
}

export function markMealArchived(id) {
  getDb().prepare('UPDATE meals SET archived_box = 1 WHERE id = ?').run(Number(id));
}

export function logCheckpoint({ meal_id, checkpoint_id, dignity_loss_percentage, status = 'requested', note = null }) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO checkpoints_log
    (meal_id, checkpoint_id, dignity_loss_percentage, status, note)
    VALUES (?, ?, ?, ?, ?)`).run(
    meal_id ?? null, checkpoint_id ?? null, dignity_loss_percentage ?? null, status, note,
  );
  return Number(r.lastInsertRowid);
}

export function updateCheckpointLog(id, { checkpoint_id, status, note }) {
  getDb().prepare('UPDATE checkpoints_log SET checkpoint_id = COALESCE(?, checkpoint_id), status = COALESCE(?, status), note = COALESCE(?, note) WHERE id = ?')
    .run(checkpoint_id ?? null, status ?? null, note ?? null, Number(id));
}

export function listCheckpoints(limit = 20) {
  return getDb().prepare('SELECT * FROM checkpoints_log ORDER BY id DESC LIMIT ?').all(limit);
}

export function cacheNews({ title, source, payload }) {
  const d = getDb();
  const r = d.prepare('INSERT INTO news_cache (title, source, payload) VALUES (?, ?, ?)')
    .run(title, source || 'local-fallback', payload ? JSON.stringify(payload) : null);
  return Number(r.lastInsertRowid);
}

export function getLatestNews() {
  const row = getDb().prepare('SELECT * FROM news_cache ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return { ...row, payload: safeJson(row.payload, null) };
}

export function recordIngredients(ingredients, embeddingFor) {
  const d = getDb();
  const now = new Date().toISOString();
  for (const raw of ingredients || []) {
    const ing = String(raw).trim().toLowerCase();
    if (!ing) continue;
    const emb = embeddingFor ? JSON.stringify(embeddingFor(ing)) : null;
    d.prepare(`INSERT INTO ingredient_history (ingredient, count, last_seen, embedding)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(ingredient) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, embedding = COALESCE(excluded.embedding, ingredient_history.embedding)`)
      .run(ing, now, emb);
  }
}

export function getRecurringCulprits(limit = 5) {
  return getDb().prepare('SELECT ingredient, count, last_seen FROM ingredient_history ORDER BY count DESC, last_seen DESC LIMIT ?').all(limit);
}

export function getIngredientEmbeddings() {
  return getDb().prepare('SELECT ingredient, embedding FROM ingredient_history WHERE embedding IS NOT NULL').all()
    .map((r) => ({ ingredient: r.ingredient, embedding: safeJson(r.embedding, null) })).filter((r) => Array.isArray(r.embedding));
}

function safeJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
