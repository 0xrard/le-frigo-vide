import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DB per test file, before any pipeline call.
const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-test-'));
process.env.LE_FRIGO_DB = join(dir, 'test.sqlite');

const { generateMenu, computeDignityLoss, filterLlmUnsafeItems } = await import('../src/pipeline.mjs');
const { initDb, listCheckpoints, closeDb } = await import('../src/db.mjs');
const { QUOTES } = await import('../src/quotes.mjs');

test('quotes seed: 30-50 existentialist quotes, 4 authors', () => {
  assert.ok(QUOTES.length >= 30 && QUOTES.length <= 50, `expected 30-50 quotes, got ${QUOTES.length}`);
  const authors = new Set(QUOTES.map((q) => q.author));
  for (const a of ['Albert Camus', 'Friedrich Nietzsche', 'Franz Kafka', 'Emil Cioran']) {
    assert.ok(authors.has(a), `missing author ${a}`);
  }
});

test('1 — menu normal: cold rice, one egg, wilted lettuce', async () => {
  const result = await generateMenu({ ingredients: 'cold rice, one egg, wilted lettuce', lang: 'en' });
  assert.equal(result.ok, true);
  assert.equal(result.rejected, false);
  assert.ok(result.meal_id, 'meal_id persisted');
  assert.ok(result.menu.title, 'menu has a title');
  // New four-section narrative contract (2026-11-27).
  assert.ok(typeof result.menu.aura_analysis === 'string' && result.menu.aura_analysis.length > 80, 'I. Fridge Aura Analysis present');
  assert.ok(typeof result.menu.world_context === 'string' && result.menu.world_context.length > 40, 'II. Outside World Context present');
  assert.ok(Array.isArray(result.menu.preparation) && result.menu.preparation.length >= 3, 'III. Preparation has 3-4 steps');
  assert.ok(typeof result.menu.sommelier === 'string' && result.menu.sommelier.length > 30, 'IV. Sommelier Pairing present');
  assert.ok(Number.isInteger(result.menu.existential_dread) && result.menu.existential_dread >= 0 && result.menu.existential_dread <= 100, 'existential_dread 0-100');
  assert.match(result.menu.food_safety || '', /Technically Edible/, 'food_safety label present');
  assert.ok(result.menu.quote, 'menu carries a quote');
  assert.ok(result.menu.quote_author, 'menu credits the quote author');
  assert.ok(Number.isInteger(result.dignity_loss_percentage), 'dignity is an integer');
  assert.ok(result.dignity_loss_percentage >= 0 && result.dignity_loss_percentage <= 100);
  assert.ok(result.dread, 'dread pairing present (fallback counts)');
  // Honest fallback: no gateway in this VM, so synthesis must say local-fallback.
  assert.equal(result.synthesis_via, 'local-fallback');
});

test('1c — local fallback menu is long and narrative, not a one-line template', async () => {
  // The user asked (2026-11-27) for the fallback to carry the full four
  // sections with real length and metaphor, so a 429 still shows a rich menu.
  const result = await generateMenu({ ingredients: 'cold rice, one egg, wilted lettuce', lang: 'en' });
  assert.equal(result.synthesis_via, 'local-fallback');
  assert.ok(result.menu.aura_analysis.length > 150, `aura too short: ${result.menu.aura_analysis.length}`);
  assert.ok(result.menu.world_context.length > 50, `world too short: ${result.menu.world_context.length}`);
  assert.equal(result.menu.preparation.length, 4, 'fallback preparation has exactly 4 steps');
  for (const step of result.menu.preparation) assert.ok(step.length > 40, `prep step too short: ${step}`);
  assert.ok(result.menu.sommelier.length > 40, 'sommelier too short');
  assert.match(result.menu.title, /Risotto of Alienation/, 'poetic title for the rice case');
  assert.match(result.menu.aura_analysis, /cold rice/, 'aura names the main ingredient');
  assert.match(result.menu.world_context, /cold rice|skillet/, 'world context references cooking');
  // Example format (user 2026-11-27): aura ends with a playful Camus-style
  // line; step 2 carries the fate metaphor; step 3 uses the third ingredient.
  assert.match(result.menu.aura_analysis, /Camus/, 'aura ends with the Camus-style line');
  assert.match(result.menu.preparation[1], /fate|plans from the start of the year/i, 'step 2 has the fate metaphor');
  assert.match(result.menu.preparation[2], /wilted lettuce/i, 'step 3 uses the third ingredient');
  assert.match(result.menu.food_safety, /Technically Edible \(Local check\)/, 'fallback food safety is honest about the local check');
});

test('1b — LLM safety verdict cannot expand the denylist (Sprite 2026-11-27 regression)', () => {
  // The live OpenRouter classifier rejected "expired yogurt" as unsafe and
  // broke test 3 on the Sprite. Expired/stale food is still food.
  assert.deepEqual(filterLlmUnsafeItems(['expired yogurt']), []);
  assert.deepEqual(filterLlmUnsafeItems(['expired yogurt', 'cold rice']), []);
  assert.deepEqual(filterLlmUnsafeItems(['2 AA batteries', 'cold rice']), ['2 AA batteries']);
  assert.deepEqual(filterLlmUnsafeItems(['dish soap', 'cold rice']), ['dish soap']);
  assert.deepEqual(filterLlmUnsafeItems(null), []);
});

test('2 — menu jebakan ditolak safety gate: 2 AA batteries, cold rice, dish soap', async () => {
  const result = await generateMenu({ ingredients: '2 AA batteries, cold rice, dish soap', lang: 'en' });
  assert.equal(result.rejected, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'unsafe');
  assert.ok(result.reason.toLowerCase().includes('batter'), 'reason names the battery');
  assert.ok(result.meal_id, 'rejected meal is still logged');
});

test('3 — dignity_loss > 80 memicu checkpoint (sprite-env checkpoint create, logged)', async () => {
  const ingredients = 'expired yogurt, cold rice, wilted lettuce, stale bread, one sad pickle';
  const dignity = computeDignityLoss(ingredients.split(', '));
  assert.ok(dignity > 80, `expected dignity > 80, got ${dignity}`);
  const before = listCheckpoints(100).length;
  const result = await generateMenu({ ingredients, lang: 'en' });
  assert.equal(result.ok, true);
  assert.ok(result.dignity_loss_percentage > 80, `expected >80, got ${result.dignity_loss_percentage}`);
  assert.ok(result.checkpoint, 'checkpoint was triggered');
  const after = listCheckpoints(100);
  assert.ok(after.length > before, 'checkpoints_log gained a row');
  const latest = after[0];
  assert.equal(latest.meal_id, result.meal_id);
  assert.equal(latest.dignity_loss_percentage, result.dignity_loss_percentage);
  assert.ok(['requested', 'created', 'failed'].includes(latest.status), `unexpected status ${latest.status}`);
  assert.ok(/lowest point/i.test(latest.note || ''), 'log note names the Lowest Point snapshot');
});

test('4 — toggle bahasa ID: chef_note Indonesia, judul puitis Indonesia', async () => {
  const result = await generateMenu({ ingredients: 'cold rice, one egg, wilted lettuce', lang: 'id' });
  assert.equal(result.ok, true);
  // Indonesian by common words, not one marker word: the live LLM writes
  // fluent Indonesian without ever using the local fallback's word "Kulkas"
  // (Sprite 2026-11-27: "Nasi dingin, selada layu..." failed the old check).
  assert.match(result.menu.chef_note, /nasi|telur|kulkas|sudah|tidak|yang/i, `expected Indonesian chef_note, got: ${result.menu.chef_note}`);
  assert.ok(!result.menu.chef_note.includes('The fridge does not lie'), 'chef_note must not be English when lang=id');
  // Poetic Indonesian title (user spec 2026-11-27), not the old French title.
  assert.match(result.menu.title, /Risotto Keterasingan/);
  // The four sections exist in Indonesian too.
  assert.ok(result.menu.aura_analysis.length > 100, 'aura ID present');
  assert.equal(result.menu.preparation.length, 4, 'preparation ID has 4 steps');
  assert.ok(result.menu.sommelier.length > 30, 'sommelier ID present');
  assert.match(result.menu.aura_analysis, /kulkas/i, 'aura ID mentions the fridge');
  assert.match(result.menu.aura_analysis, /Camus/, 'aura ID ends with the Camus-style line');
  assert.match(result.menu.food_safety, /Aman Secara Teknis \(Pemeriksaan Lokal\)/, 'ID food safety is honest about the local check');
  assert.match(result.menu.preparation[2], /wilted lettuce/i, 'step 3 ID uses the third ingredient');
});

test('frontend IDs: every getElementById in app.js exists in index.html', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf-8');
  const ids = [...js.matchAll(/\$\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `expected many IDs, found ${ids.length}`);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `IDs used in app.js but missing in index.html: ${missing.join(', ')}`);
  assert.ok(existsSync(new URL('../public/style.css', import.meta.url)));
  assert.ok(html.includes('preset-trap'), 'trap preset button present');
  assert.ok(html.includes('2 AA batteries, cold rice, dish soap'), 'trap preset carries the exact trap ingredients');
});
