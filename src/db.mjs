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
      session_id TEXT NOT NULL DEFAULT 'default',
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
      session_id TEXT NOT NULL DEFAULT 'default',
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
      session_id TEXT NOT NULL DEFAULT 'default',
      ingredient TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      embedding TEXT,
      seeded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, ingredient)
    );
    CREATE TABLE IF NOT EXISTS ingredient_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT 'default',
      ingredient TEXT NOT NULL,
      event_type TEXT NOT NULL,
      observation_id TEXT,
      source TEXT NOT NULL DEFAULT 'live',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_ingredient
      ON ingredient_events (session_id, ingredient);
  `);
  // Session migration: databases from before the event-sourced Chronicle
  // have ingredient_history keyed by ingredient alone (and possibly the
  // short-lived status/status_at columns). Rebuild it keyed by
  // (session_id, ingredient), keeping every row under 'default'.
  // Capture the legacy rows FIRST: the rebuild drops the status columns,
  // and the legacy-events migration below needs the old fates.
  const cols = new Set(db.prepare('PRAGMA table_info(ingredient_history)').all().map((c) => c.name));
  let legacySnapshot = null;
  if (!cols.has('session_id')) {
    const has = (n) => (cols.has(n) ? n : null);
    const firstSeen = has('first_seen') || 'last_seen';
    const seeded = has('seeded') || '0';
    legacySnapshot = db.prepare(`SELECT ingredient, count, ${firstSeen} AS first_seen, last_seen,
      ${has('status') || "'active'"} AS status, ${has('status_at') || 'NULL'} AS status_at
      FROM ingredient_history`).all();
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE ingredient_history_new (
        session_id TEXT NOT NULL DEFAULT 'default',
        ingredient TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        embedding TEXT,
        seeded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, ingredient)
      )`);
      db.exec(`INSERT INTO ingredient_history_new
        (session_id, ingredient, count, first_seen, last_seen, embedding, seeded)
        SELECT 'default', ingredient, count, ${firstSeen}, last_seen, embedding, ${seeded}
        FROM ingredient_history`);
      db.exec('DROP TABLE ingredient_history');
      db.exec('ALTER TABLE ingredient_history_new RENAME TO ingredient_history');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  // Session scoping for meals / checkpoints (v13.1): one column each.
  // Old rows belong to 'default' — no data is dropped or rewritten.
  for (const table of ['meals', 'checkpoints_log']) {
    const tcols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!tcols.has('session_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'`);
  }
  // Events source label (v13.1): 'live' for real observations,
  // 'legacy_migration' for events synthesized from old history.
  const ecols = new Set(db.prepare('PRAGMA table_info(ingredient_events)').all().map((c) => c.name));
  if (!ecols.has('source')) db.exec(`ALTER TABLE ingredient_events ADD COLUMN source TEXT NOT NULL DEFAULT 'live'`);
  // Legacy-events migration (v13.1, audit D): v12 stored history only as
  // aggregates in ingredient_history — the event-sourced Chronicle reads
  // nothing from there, so an old DB showed an empty Chronicle. When the
  // event log is empty but history rows exist, synthesize one event per
  // recorded sighting (first 'added', rest 'confirmed_present') plus the
  // old fate when one was stored. History rows are NEVER deleted; the
  // migration runs once (a non-empty event log means it already ran).
  migrateLegacyHistoryToEvents(db, legacySnapshot);
  return db;
}

// Synthesize events from pre-event-sourced history. `legacySnapshot` is
// the pre-rebuild rows (with status) when a rebuild just ran; otherwise
// the current 'default' history rows are read (status already gone, so
// only sightings are synthesized). Returns the number of events created.
//
// PER-INGREDIENT, not global (audit v14 P0-A): a v13 database can hold
// legacy history rows AND newer events at the same time, and one event
// anywhere must not skip the whole migration. For each history row the
// missing sightings are computed as count minus the distinct
// observations already in the event log, and only the missing ones are
// added. When an ingredient already has events, its synthesized
// sightings are 'confirmed_present' only — never a new 'added' — so
// they cannot reset the ingredient's current cycle.
function migrateLegacyHistoryToEvents(db, legacySnapshot = null) {
  const rows = legacySnapshot ?? db.prepare(
    `SELECT ingredient, count, first_seen, last_seen, 'active' AS status, NULL AS status_at
     FROM ingredient_history WHERE session_id = 'default'`).all();
  if (!rows.length) return 0;
  const safeTime = (v) => {
    const t = new Date(v || '').getTime();
    return Number.isNaN(t) ? Date.now() : t;
  };
  const evStmt = db.prepare(`INSERT INTO ingredient_events
    (session_id, ingredient, event_type, observation_id, source, created_at)
    VALUES ('default', ?, ?, ?, 'legacy_migration', ?)`);
  const existingObs = db.prepare(`SELECT COUNT(DISTINCT observation_id) AS n FROM ingredient_events
    WHERE session_id = 'default' AND ingredient = ? AND observation_id IS NOT NULL`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const count = Math.max(1, Number(r.count) || 1);
      const already = existingObs.get(r.ingredient).n;
      const missing = count - already;
      if (missing <= 0) continue;
      const first = safeTime(r.first_seen || r.last_seen);
      const last = Math.max(first, safeTime(r.last_seen || r.first_seen));
      for (let i = 0; i < missing; i++) {
        // Spread the sightings evenly between first_seen and last_seen.
        // The first synthesized sighting is 'added' only when the
        // ingredient has no events at all; otherwise every synthesized
        // sighting is a confirmation of the older history.
        const t = missing === 1 ? last : first + ((last - first) * i) / (missing - 1);
        const type = (already === 0 && i === 0) ? 'added' : 'confirmed_present';
        evStmt.run(r.ingredient, type, `legacy-migration-${r.ingredient}-${already + i}`, new Date(t).toISOString());
        n++;
      }
      if ((r.status === 'rescued' || r.status === 'discarded') && already === 0) {
        evStmt.run(r.ingredient, r.status === 'rescued' ? 'cooked' : 'discarded', null, new Date(safeTime(r.status_at || r.last_seen)).toISOString());
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return n;
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
    (session_id, lang, ingredients, title, dignity_loss_percentage, quote, quote_author, dread, menu_json, rejected, rejection_reason, checkpoint_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const r = stmt.run(
    meal.session_id || 'default',
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

export function listMeals(limit = 20, sessionId = 'default') {
  const d = getDb();
  return d.prepare('SELECT * FROM meals WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).map(parseMeal);
}

export function updateMealCheckpoint(id, checkpointId) {
  getDb().prepare('UPDATE meals SET checkpoint_id = ? WHERE id = ?').run(checkpointId, Number(id));
}

export function markMealArchived(id) {
  getDb().prepare('UPDATE meals SET archived_box = 1 WHERE id = ?').run(Number(id));
}

export function logCheckpoint({ meal_id, session_id, checkpoint_id, dignity_loss_percentage, status = 'requested', note = null }) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO checkpoints_log
    (meal_id, session_id, checkpoint_id, dignity_loss_percentage, status, note)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    meal_id ?? null, session_id || 'default', checkpoint_id ?? null, dignity_loss_percentage ?? null, status, note,
  );
  return Number(r.lastInsertRowid);
}

export function updateCheckpointLog(id, { checkpoint_id, status, note }) {
  getDb().prepare('UPDATE checkpoints_log SET checkpoint_id = COALESCE(?, checkpoint_id), status = COALESCE(?, status), note = COALESCE(?, note) WHERE id = ?')
    .run(checkpoint_id ?? null, status ?? null, note ?? null, Number(id));
}

export function listCheckpoints(limit = 20, sessionId = 'default') {
  return getDb().prepare('SELECT * FROM checkpoints_log WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit);
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

// Normalize one ingredient name for storage: lowercase, trimmed.
export function normalizeIngredient(raw) {
  return String(raw || '').trim().toLowerCase();
}

// Memory store (Pinecone local-cosine fallback + recurring culprits),
// scoped per session. Called ONLY from a fridge check — never from a
// menu generate, so re-generating the same menu cannot inflate counts.
export function recordIngredients(ingredients, embeddingFor, sessionId = 'default') {
  const d = getDb();
  const now = new Date().toISOString();
  for (const raw of ingredients || []) {
    const ing = normalizeIngredient(raw);
    if (!ing) continue;
    const emb = embeddingFor ? JSON.stringify(embeddingFor(ing)) : null;
    d.prepare(`INSERT INTO ingredient_history (session_id, ingredient, count, first_seen, last_seen, embedding)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(session_id, ingredient) DO UPDATE SET
        count = count + 1,
        last_seen = excluded.last_seen,
        first_seen = COALESCE(ingredient_history.first_seen, excluded.first_seen),
        embedding = COALESCE(excluded.embedding, ingredient_history.embedding)`)
      .run(sessionId, ing, now, now, emb);
  }
}

export function getRecurringCulprits(limit = 5, sessionId = 'default') {
  return getDb().prepare('SELECT ingredient, count, last_seen FROM ingredient_history WHERE session_id = ? ORDER BY count DESC, last_seen DESC LIMIT ?').all(sessionId, limit);
}

export function getIngredientEmbeddings(sessionId = 'default') {
  return getDb().prepare('SELECT ingredient, embedding FROM ingredient_history WHERE session_id = ? AND embedding IS NOT NULL').all(sessionId)
    .map((r) => ({ ingredient: r.ingredient, embedding: safeJson(r.embedding, null) })).filter((r) => Array.isArray(r.embedding));
}

// --- Event-sourced lifecycle -------------------------------------------------
// The Chronicle reads ONLY this log. One fridge check = one observation:
// each ingredient in it logs `added` (first sighting in this session) or
// `confirmed_present` (seen before). A menu generate logs NOTHING, so
// re-generating the same menu can never manufacture a Ghost.

export function logIngredientEvent({ sessionId = 'default', ingredient, eventType, observationId = null, source = 'live' }) {
  const ing = normalizeIngredient(ingredient);
  if (!ing) throw new Error('ingredient name is required');
  if (!['added', 'confirmed_present', 'cooked', 'discarded'].includes(eventType)) throw new Error(`unknown event_type: ${eventType}`);
  const d = getDb();
  // created_at is written explicitly as ISO (not the datetime('now')
  // default): the log must hold ONE timestamp format. The default writes
  // "2026-11-27 15:28:00" (space), while the migration and the demo seed
  // write "2026-11-27T10:00:00.000Z" — and as strings the space sorts
  // before the T, which broke chronological ordering (audit v15 P0).
  const r = d.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, ing, eventType, observationId, source, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

// What kind of sighting is the NEXT one for this ingredient? A fresh
// arrival after a fate starts a NEW instance ('added'), not a
// 'confirmed_present' — otherwise a re-bought spinach would stay
// 'rescued' forever (audit C).
export function nextObservationEventType(sessionId = 'default', ingredient) {
  // Latest by TIME, not by id (audit v15 P0): a migrated old event can
  // have a higher id than the newest live one, and the next sighting
  // must follow the newest real event, not the newest row. unixepoch()
  // for the same mixed-format reason as getSessionEvents.
  const row = getDb().prepare(`SELECT event_type FROM ingredient_events
    WHERE session_id = ? AND ingredient = ? ORDER BY unixepoch(created_at) DESC, id DESC LIMIT 1`)
    .get(sessionId, normalizeIngredient(ingredient));
  if (!row) return 'added';
  if (row.event_type === 'cooked' || row.event_type === 'discarded') return 'added';
  return 'confirmed_present';
}

// Events are read in CHRONOLOGICAL order (audit v15 P0): the migration
// appends old sightings with old created_at AFTER newer live events in
// id order, so `ORDER BY id` would put two old observations inside a
// new purchase cycle and manufacture a false Ghost. created_at is the
// timeline; id only breaks ties (same-second events).
// The ordering uses unixepoch(created_at), not the raw string: the log
// mixes two timestamp formats — live rows written by SQLite's
// datetime('now') ("2026-11-27 15:28:00", space) and migrated/seeded
// rows written as ISO ("2026-11-27T10:00:00.000Z"). As strings, the
// space sorts BEFORE the T, so a 15:28 live event would sort before a
// 10:00 ISO event on the same day and the new cycle would be computed
// backwards (found by a smoke test of the repurchase case, 2026-11-27).
// unixepoch() parses both formats, so the order is by real time.
export function getSessionEvents(sessionId = 'default') {
  return getDb().prepare('SELECT * FROM ingredient_events WHERE session_id = ? ORDER BY unixepoch(created_at) ASC, id ASC').all(sessionId);
}

export function hasIngredientEvents(sessionId = 'default', ingredient) {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM ingredient_events WHERE session_id = ? AND ingredient = ?').get(sessionId, normalizeIngredient(ingredient));
  return row.n > 0;
}

// Human-in-the-loop: record the fate of one ingredient as an event.
// Returns the event id, or null when the ingredient was never observed
// in this session. Throws on a bad status.
export function setIngredientStatus(name, status, sessionId = 'default') {
  if (status !== 'rescued' && status !== 'discarded') throw new Error('status must be "rescued" or "discarded"');
  const ing = normalizeIngredient(name);
  if (!ing) throw new Error('ingredient name is required');
  if (!hasIngredientEvents(sessionId, ing)) return null;
  return logIngredientEvent({ sessionId, ingredient: ing, eventType: status === 'rescued' ? 'cooked' : 'discarded' });
}

// Demo pantry, strictly separated: it lives ONLY in the 'demo' session,
// never in a user's session. Seeded once (first boot), flagged seeded in
// the history rows so the API can label it DEMO DATA.
export function seedChronicleDemo(nowMs = Date.now()) {
  const d = getDb();
  const count = d.prepare("SELECT COUNT(*) AS n FROM ingredient_events WHERE session_id = 'demo'").get().n;
  if (count > 0) return 0;
  const day = 86_400_000;
  const iso = (agoMs) => new Date(nowMs - agoMs).toISOString();
  // [ingredient, observations, first_seen_ago, fate]
  // The Ghost: spinach, 3 observations, never cooked, never thrown out.
  const seeds = [
    { ingredient: 'spinach', observations: 3, firstSeenAgo: 3 * day, fate: null, fateAgo: null },
    { ingredient: 'cold rice', observations: 2, firstSeenAgo: 2 * day, fate: null, fateAgo: null },
    { ingredient: 'stale bread', observations: 2, firstSeenAgo: 4 * day, fate: 'cooked', fateAgo: 1 * day },
    { ingredient: 'wilted lettuce', observations: 1, firstSeenAgo: 2 * day, fate: 'discarded', fateAgo: 2 * day },
  ];
  const evStmt = d.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, created_at)
    VALUES ('demo', ?, ?, ?, ?)`);
  const histStmt = d.prepare(`INSERT INTO ingredient_history (session_id, ingredient, count, first_seen, last_seen, seeded)
    VALUES ('demo', ?, ?, ?, ?, 1)
    ON CONFLICT(session_id, ingredient) DO NOTHING`);
  let n = 0;
  for (const s of seeds) {
    for (let i = 0; i < s.observations; i++) {
      // Each observation is its own observation_id, one day apart.
      evStmt.run(s.ingredient, i === 0 ? 'added' : 'confirmed_present', `demo-obs-${s.ingredient}-${i}`, iso(s.firstSeenAgo - i * day));
      n++;
    }
    if (s.fate) {
      evStmt.run(s.ingredient, s.fate, null, iso(s.fateAgo));
      n++;
    }
    // Last sighting: the most recent observation (one day apart), or the
    // fate event when it came later.
    const lastObsAgo = s.firstSeenAgo - (s.observations - 1) * day;
    const lastSeenAgo = s.fate ? Math.min(lastObsAgo, s.fateAgo) : lastObsAgo;
    histStmt.run(s.ingredient, s.observations, iso(s.firstSeenAgo), iso(lastSeenAgo));
  }
  return n;
}

function safeJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
