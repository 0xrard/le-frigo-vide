import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Audit v13 D: v12 stored history only as aggregates in ingredient_history
// (no events at all), so the event-sourced Chronicle showed an EMPTY
// fridge after an upgrade. Boot must synthesize one event per recorded
// sighting (labelled legacy_migration), preserving old fates, and must
// NEVER delete the history rows. The legacy DB is built BEFORE any
// initDb call, so the migration runs on first boot.
const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-migration-'));
process.env.LE_FRIGO_DB = join(dir, 'legacy.sqlite');

const legacy = new DatabaseSync(process.env.LE_FRIGO_DB);
// v12 (Chronicle) schema: 8 columns, ingredient PK, status + status_at.
legacy.exec(`CREATE TABLE ingredient_history (
  ingredient TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  embedding TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  status_at TEXT,
  seeded INTEGER NOT NULL DEFAULT 0
)`);
legacy.prepare('INSERT INTO ingredient_history (ingredient, count, first_seen, last_seen, status, seeded) VALUES (?, ?, ?, ?, ?, ?)')
  .run('spinach', 3, '2026-11-20T10:00:00.000Z', '2026-11-25T10:00:00.000Z', 'active', 0);
legacy.prepare('INSERT INTO ingredient_history (ingredient, count, first_seen, last_seen, status, status_at, seeded) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('stale bread', 2, '2026-11-20T10:00:00.000Z', '2026-11-24T10:00:00.000Z', 'rescued', '2026-11-24T10:00:00.000Z', 0);
legacy.close();

const { initDb, closeDb, getDb, getSessionEvents, nextObservationEventType } = await import('../src/db.mjs');
const { buildChronicle } = await import('../src/chronicle.mjs');

test.before(() => { initDb(); });
test.after(() => { closeDb(); });

test('v12 history migrates into events: sightings + fates, history kept', () => {
  const c = buildChronicle('en', 'default');
  assert.equal(c.totals.tracked, 2, 'both legacy ingredients appear in the Chronicle');
  const spinach = c.survivors.find((x) => x.ingredient === 'spinach');
  assert.ok(spinach, 'spinach is a survivor');
  assert.equal(spinach.appearances, 3, 'count 3 became 3 sightings');
  assert.equal(spinach.source, 'legacy_migration', 'synthesized events carry the label');
  assert.equal(c.ghosts.length, 1, 'spinach is a ghost again (3 appearances)');
  assert.equal(c.investigation.ingredient, 'spinach');
  const bread = c.rescued.find((x) => x.ingredient === 'stale bread');
  assert.ok(bread, 'stale bread keeps its old fate');
  assert.equal(bread.appearances, 2, 'count 2 became 2 sightings');
  // The migration never deletes history, and it runs exactly once.
  // (node:sqlite rows are null-prototype, so compare plain objects.)
  const rows = getDb().prepare('SELECT ingredient, count FROM ingredient_history ORDER BY ingredient').all()
    .map((r) => ({ ingredient: r.ingredient, count: r.count }));
  assert.deepEqual(rows, [{ ingredient: 'spinach', count: 3 }, { ingredient: 'stale bread', count: 2 }], 'history rows untouched');
  assert.equal(getSessionEvents('default').length, 6, '3 spinach sightings + 2 bread sightings + 1 fate');
  closeDb(); initDb(); // a real reboot: the migration must not re-run
  assert.equal(getSessionEvents('default').length, 6, 'migration does not re-run');
});

// Audit v14 P0-A: a v13 database can hold legacy history rows AND newer
// events at the same time. The old global "any event skips everything"
// gate lost the legacy spinach entirely. The migration is per-ingredient:
// only the history that no event represents is synthesized.
test('a v13 mixed DB migrates only the unrepresented legacy history', () => {
  closeDb();
  const dir3 = mkdtempSync(join(tmpdir(), 'le-frigo-vide-migration13-'));
  const path3 = join(dir3, 'mixed.sqlite');
  const mixed = new DatabaseSync(path3);
  // v13 schema: session_id present, events table WITHOUT the source column.
  mixed.exec(`CREATE TABLE ingredient_history (
    session_id TEXT NOT NULL DEFAULT 'default', ingredient TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    embedding TEXT, seeded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, ingredient)
  )`);
  mixed.exec(`CREATE TABLE ingredient_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL DEFAULT 'default',
    ingredient TEXT NOT NULL, event_type TEXT NOT NULL, observation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  mixed.prepare('INSERT INTO ingredient_history (session_id, ingredient, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run('default', 'spinach', 3, '2026-11-20T10:00:00.000Z', '2026-11-25T10:00:00.000Z');
  mixed.prepare('INSERT INTO ingredient_history (session_id, ingredient, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run('default', 'new rice', 1, '2026-11-26T10:00:00.000Z', '2026-11-26T10:00:00.000Z');
  mixed.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, created_at)
    VALUES ('default', 'new rice', 'added', 'v13-obs-1', '2026-11-26T10:00:00.000Z')`).run();
  mixed.close();
  process.env.LE_FRIGO_DB = path3;
  initDb();
  const c = buildChronicle('en', 'default');
  assert.equal(c.totals.tracked, 2, 'both ingredients appear');
  const spinach = c.survivors.find((x) => x.ingredient === 'spinach');
  assert.ok(spinach, 'legacy spinach is no longer lost');
  assert.equal(spinach.appearances, 3, 'count 3 became 3 sightings');
  assert.equal(spinach.source, 'legacy_migration', 'synthesized events carry the label');
  assert.equal(c.ghosts.length, 1, 'spinach is a ghost again');
  const rice = c.survivors.find((x) => x.ingredient === 'new rice');
  assert.ok(rice, 'new rice is still there');
  assert.equal(rice.appearances, 1, 'its one event was NOT duplicated');
  assert.equal(rice.source, 'live', 'its event stays live, not legacy');
  assert.equal(getSessionEvents('default').length, 4, '3 synthesized + 1 existing, nothing more');
  closeDb(); initDb(); // a real reboot: the migration must not re-run
  assert.equal(getSessionEvents('default').length, 4, 'migration does not re-run');
});

// Audit v15 P0 — the exact scenario: spinach has 3 old observations in
// history, plus ONE live event `added` on 27 Nov (a re-purchase). The
// migration must add the 2 missing old sightings WITHOUT pulling them
// into the new purchase cycle. Before the fix, `ORDER BY id` put the
// migrated rows (higher ids, older dates) after the 27 Nov event, so
// the dossier counted 3 appearances and manufactured a false Ghost.
test('migrated old sightings stay in the old cycle, not the new purchase', () => {
  closeDb();
  const dir4 = mkdtempSync(join(tmpdir(), 'le-frigo-vide-migration15-'));
  const path4 = join(dir4, 'repurchase.sqlite');
  const db = new DatabaseSync(path4);
  db.exec(`CREATE TABLE ingredient_history (
    session_id TEXT NOT NULL DEFAULT 'default', ingredient TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    embedding TEXT, seeded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, ingredient)
  )`);
  db.exec(`CREATE TABLE ingredient_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL DEFAULT 'default',
    ingredient TEXT NOT NULL, event_type TEXT NOT NULL, observation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare('INSERT INTO ingredient_history (session_id, ingredient, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run('default', 'spinach', 3, '2026-11-20T10:00:00.000Z', '2026-11-25T10:00:00.000Z');
  db.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, created_at)
    VALUES ('default', 'spinach', 'added', 'repurchase-27-nov', '2026-11-27T10:00:00.000Z')`).run();
  db.close();
  process.env.LE_FRIGO_DB = path4;
  initDb();
  // The migration added the 2 missing old sightings (ids 2 and 3, dated
  // 20 and 25 Nov) — but the dossier must read them in TIME order.
  const events = getSessionEvents('default');
  assert.equal(events.length, 3, '1 live + 2 migrated events');
  assert.equal(events[0].created_at.slice(0, 10), '2026-11-20', 'oldest first by time, not by id');
  assert.equal(events[2].event_type, 'added', 'the newest event by time is the 27 Nov re-purchase');
  const c = buildChronicle('en', 'default');
  const spinach = c.survivors.find((x) => x.ingredient === 'spinach');
  assert.ok(spinach, 'spinach is a survivor');
  assert.equal(spinach.appearances, 1, 'ONE appearance in the new purchase cycle — not 3');
  assert.equal(c.ghosts.length, 0, 'no false Ghost from the old cycle');
  assert.equal(c.investigation, null, 'no case while the new cycle is young');
  assert.equal(nextObservationEventType('default', 'spinach'), 'confirmed_present', 'the next check follows the newest event by time');
});

test('a 4-column legacy DB (no status) migrates sightings only', () => {
  // Switch to a fresh legacy DB with the original 4-column schema.
  closeDb();
  const dir2 = mkdtempSync(join(tmpdir(), 'le-frigo-vide-migration4-'));
  const path2 = join(dir2, 'legacy4.sqlite');
  const old = new DatabaseSync(path2);
  old.exec(`CREATE TABLE ingredient_history (
    ingredient TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL DEFAULT (datetime('now')), embedding TEXT
  )`);
  old.prepare('INSERT INTO ingredient_history (ingredient, count, last_seen) VALUES (?, ?, ?)')
    .run('cold rice', 2, '2026-11-25T10:00:00.000Z');
  old.close();
  process.env.LE_FRIGO_DB = path2;
  initDb();
  const c = buildChronicle('en', 'default');
  assert.equal(c.totals.tracked, 1, 'cold rice appears');
  assert.equal(c.survivors[0].appearances, 2, 'count 2 became 2 sightings');
  assert.equal(c.survivors[0].status, 'active', 'no fate was stored, so it is active');
});
