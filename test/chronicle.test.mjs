import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DB per test file, before any db import.
const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-chronicle-'));
process.env.LE_FRIGO_DB = join(dir, 'chronicle.sqlite');

const { initDb, setIngredientStatus, seedChronicleDemo, getSessionEvents, getRecurringCulprits } = await import('../src/db.mjs');
const { buildChronicle, daysSince } = await import('../src/chronicle.mjs');
const { logFridgeCheck, generateMenu } = await import('../src/pipeline.mjs');

test.before(() => { initDb(); });

test('two separate fridge checks make a Ghost (added -> confirmed_present)', () => {
  const first = logFridgeCheck({ ingredients: 'ghost-bean, cold rice', sessionId: 'ghost' });
  assert.equal(first.ok, true);
  assert.ok(first.observation_id, 'first observation has an id');
  const second = logFridgeCheck({ ingredients: 'ghost-bean', sessionId: 'ghost' });
  assert.notEqual(second.observation_id, first.observation_id, 'each check is its own observation');
  const c = buildChronicle('en', 'ghost');
  assert.equal(c.totals.tracked, 2, 'ghost-bean + cold rice tracked');
  assert.equal(c.ghosts.length, 1, 'one ghost');
  assert.equal(c.ghosts[0].ingredient, 'ghost-bean');
  assert.equal(c.ghosts[0].appearances, 2, 'seen in two observations');
  assert.equal(c.investigation.ingredient, 'ghost-bean');
  assert.ok(c.investigation.title.includes('GHOST-BEAN'), 'case names the ghost');
  const again = buildChronicle('id', 'ghost');
  assert.ok(again.investigation.title.startsWith('THE CASE OF THE FORGOTTEN'), 'English-only: lang=id is ignored');
});

test('re-generating a menu twice logs nothing — no Ghost from generate', async () => {
  const a = await generateMenu({ ingredients: 'gen-bean, cold rice', sessionId: 'gen' });
  assert.equal(a.ok, true, 'first generate ok');
  const b = await generateMenu({ ingredients: 'gen-bean, cold rice', sessionId: 'gen' });
  assert.equal(b.ok, true, 'second generate ok');
  const c = buildChronicle('en', 'gen');
  assert.equal(c.totals.tracked, 0, 'generate never records an ingredient');
  assert.equal(c.ghosts.length, 0, 'no ghost manufactured by re-generating');
  assert.equal(c.investigation, null, 'no case without observations');
});

test('a fate closes the case; an unknown ingredient and a bad status are rejected', () => {
  logFridgeCheck({ ingredients: 'fate-bean', sessionId: 'fate' });
  logFridgeCheck({ ingredients: 'fate-bean', sessionId: 'fate' });
  assert.equal(buildChronicle('en', 'fate').ghosts.length, 1, 'ghost before the fate');
  const eventId = setIngredientStatus('fate-bean', 'rescued', 'fate');
  assert.ok(eventId, 'fate recorded as an event');
  const c = buildChronicle('en', 'fate');
  assert.equal(c.rescued.length, 1, 'fate-bean rescued');
  assert.equal(c.ghosts.length, 0, 'case closed once the suspect is rescued');
  assert.equal(c.investigation, null, 'no open case');
  assert.equal(setIngredientStatus('never-seen-thing', 'rescued', 'fate'), null, 'unknown ingredient -> null');
  assert.throws(() => setIngredientStatus('fate-bean', 'eaten', 'fate'), /status must be/, 'invalid status rejected');
});

// Audit v13 P0-C: "A fresh sighting after a fate is a new instance."
// added -> confirmed_present -> cooked -> added must end ACTIVE with
// ONE appearance in the new cycle — not still rescued, and not 3.
test('a fresh sighting after a fate starts a new cycle (reappearance)', () => {
  const S = 'chronicle-revive';
  const revive = () => logFridgeCheck({ ingredients: 'revive-bean', sessionId: S, lang: 'en' });
  revive(); revive();
  let c = buildChronicle('en', S);
  assert.equal(c.ghosts.length, 1, 'revive-bean is a ghost after two sightings');
  assert.equal(c.investigation.ingredient, 'revive-bean');
  setIngredientStatus('revive-bean', 'rescued', S);
  c = buildChronicle('en', S);
  assert.equal(c.rescued.length, 1, 'revive-bean rescued');
  assert.equal(c.ghosts.length, 0, 'case closed');

  // Bought again: the new sighting is a NEW instance.
  revive();
  c = buildChronicle('en', S);
  const d = c.survivors.find((x) => x.ingredient === 'revive-bean');
  assert.ok(d, 'revive-bean is a survivor again');
  assert.equal(d.status, 'active', 'fresh sighting revives it to active');
  assert.equal(d.appearances, 1, 'one appearance in the NEW cycle, not 3 across history');
  assert.equal(c.ghosts.length, 0, 'one appearance is not yet a ghost');
  assert.equal(c.investigation, null, 'no case while the new cycle is young');

  // Seen a second time in the new cycle: the Ghost returns.
  revive();
  c = buildChronicle('en', S);
  assert.equal(c.ghosts.length, 1, 'ghost again after two sightings in the new cycle');
  assert.equal(c.ghosts[0].ingredient, 'revive-bean');
  assert.equal(c.ghosts[0].appearances, 2, 'two appearances in the new cycle');
  assert.equal(c.investigation.ingredient, 'revive-bean');
});

// Audit v14 P2-E: 'spinach, spinach' is ONE ingredient in one
// observation — one event, one appearance, count 1 in the aggregate
// history. The event log and the memory must never disagree.
// Audit v15 P0 (found by a smoke test of the repurchase case): the log
// mixes two timestamp formats — live rows "2026-11-27 15:28:00" (space,
// SQLite datetime('now')) and migrated/seeded rows
// "2026-11-27T10:00:00.000Z" (ISO). As strings the space sorts before
// the T, so a 15:28 event sorted BEFORE a 10:00 event on the same day
// and the new purchase cycle was computed backwards (1 appearance
// instead of 2). Ordering must be by real time (unixepoch), not by
// string.
test('event ordering is by real time, not by timestamp string', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { closeDb } = await import('../src/db.mjs');
  closeDb();
  const dir2 = mkdtempSync(join(tmpdir(), 'le-frigo-vide-mixedtime-'));
  const path2 = join(dir2, 'mixedtime.sqlite');
  const db = new DatabaseSync(path2);
  db.exec(`CREATE TABLE ingredient_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL DEFAULT 'default',
    ingredient TEXT NOT NULL, event_type TEXT NOT NULL, observation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, created_at)
    VALUES ('default', 'spinach', 'added', 'obs-1', '2026-11-27T10:00:00.000Z')`).run();
  db.prepare(`INSERT INTO ingredient_events (session_id, ingredient, event_type, observation_id, created_at)
    VALUES ('default', 'spinach', 'confirmed_present', 'obs-2', '2026-11-27 15:28:00')`).run();
  db.close();
  process.env.LE_FRIGO_DB = path2;
  initDb();
  const events = getSessionEvents('default');
  assert.equal(events[0].observation_id, 'obs-1', 'the 10:00 ISO event comes first by real time');
  assert.equal(events[1].observation_id, 'obs-2', 'the 15:28 space-format event comes second — it is later, not earlier');
  const c = buildChronicle('en', 'default');
  const spinach = c.survivors.find((x) => x.ingredient === 'spinach');
  assert.equal(spinach.appearances, 2, 'both observations are in the current cycle');
  assert.equal(c.ghosts.length, 1, 'two appearances make a Ghost');
  // Restore this file's own DB so the tests after this one are not
  // reading the throwaway mixed-format database.
  closeDb();
  process.env.LE_FRIGO_DB = join(dir, 'chronicle.sqlite');
  initDb();
});

test('duplicate ingredients in one observation are deduplicated', () => {
  const r = logFridgeCheck({ ingredients: 'dup-bean, dup-bean, DUP-BEAN', sessionId: 'dup' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ingredients, ['dup-bean'], 'one ingredient after dedupe');
  const c = buildChronicle('en', 'dup');
  assert.equal(c.totals.tracked, 1, 'one dossier');
  assert.equal(c.survivors[0].appearances, 1, 'one appearance, not two');
  assert.equal(getSessionEvents('dup').length, 1, 'one event recorded');
  assert.equal(getRecurringCulprits(5, 'dup')[0].count, 1, 'aggregate history count is 1 too');
});

test('sessions are isolated: one judge never sees another judge\'s fridge', () => {
  logFridgeCheck({ ingredients: 'iso-bean', sessionId: 'iso-a' });
  assert.equal(buildChronicle('en', 'iso-a').totals.tracked, 1, 'judge A sees their bean');
  assert.equal(buildChronicle('en', 'iso-b').totals.tracked, 0, 'judge B has an empty fridge');
  assert.equal(buildChronicle('en', 'default').totals.tracked, 0, 'the default session is untouched too');
});

test('seedChronicleDemo fills ONLY the demo session, once', () => {
  assert.ok(seedChronicleDemo() > 0, 'demo seeded on first call');
  assert.equal(seedChronicleDemo(), 0, 'second call is a no-op');
  const demo = buildChronicle('en', 'demo');
  assert.equal(demo.demo, true, 'demo flag set');
  assert.equal(demo.totals.tracked, 4, 'four demo dossiers');
  assert.equal(demo.survivors.length, 2, 'spinach + cold rice survive');
  assert.equal(demo.rescued.length, 1, 'stale bread was rescued');
  assert.equal(demo.departed.length, 1, 'wilted lettuce departed');
  assert.deepEqual(demo.ghosts.map((g) => g.ingredient).sort(), ['cold rice', 'spinach'], 'both repeat offenders are ghosts');
  assert.equal(demo.investigation.ingredient, 'spinach', 'prime suspect is the most-seen ghost');
  assert.ok(/commitment problem/.test(demo.investigation.verdict), '3-appearance ghost gets the commitment verdict');
  const again = buildChronicle('id', 'demo');
  assert.ok(/commitment problem/.test(again.investigation.verdict), 'English-only: lang=id is ignored');
  // And the user's own session is still empty — demo data never leaks in.
  assert.equal(buildChronicle('en', 'default').totals.tracked, 0, 'default session stays empty');
});

test('daysSince counts whole days from first_seen', () => {
  const now = Date.now();
  assert.equal(daysSince(new Date(now - 3 * 86_400_000).toISOString(), now), 3);
  assert.equal(daysSince(new Date(now - 1000).toISOString(), now), 0);
  assert.equal(daysSince(null, now), 0);
  assert.equal(daysSince('not a date', now), 0);
});
