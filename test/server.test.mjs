import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-server-'));
const PORT = 18081;
const BASE = `http://localhost:${PORT}`;

let child;
async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy');
}

test.before(async () => {
  child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), LE_FRIGO_DB: join(dir, 'server.sqlite') },
    stdio: 'pipe',
  });
  await waitForHealth();
});

test.after(() => { try { child?.kill(); } catch {} });

// Chronicle tests run FIRST: the server seeds its demo pantry at startup,
// and later generate tests mutate those rows (a reappearance revives a
// rescued/discarded ingredient), so the pristine seed is only visible now.
// Chronicle tests run FIRST: the server seeds its demo pantry at startup,
// and later generate tests must not be able to mutate it (generate logs
// nothing; only fridge checks record ingredients).
test('GET /api/chronicle — a fresh session is empty; the demo session holds the sample', async () => {
  const mine = await (await fetch(`${BASE}/api/chronicle`)).json();
  assert.equal(mine.ok, true);
  assert.equal(mine.demo, false, 'default session is not the demo');
  assert.equal(mine.totals.tracked, 0, 'a fresh session starts with an empty fridge');
  assert.equal(mine.investigation, null, 'no case without observations');
  const demo = await (await fetch(`${BASE}/api/chronicle?session=demo`)).json();
  assert.equal(demo.demo, true, 'demo flag set');
  assert.equal(demo.totals.tracked, 4, 'four seeded demo dossiers');
  assert.equal(demo.survivors.length, 2, 'spinach + cold rice survive');
  assert.equal(demo.rescued.length, 1, 'stale bread was rescued');
  assert.equal(demo.departed.length, 1, 'wilted lettuce departed');
  assert.deepEqual(demo.ghosts.map((g) => g.ingredient).sort(), ['cold rice', 'spinach']);
  assert.equal(demo.investigation.ingredient, 'spinach', 'prime suspect is the most-seen ghost');
  assert.ok(/commitment problem/.test(demo.investigation.verdict), '3-appearance ghost gets the commitment verdict');
  const again = await (await fetch(`${BASE}/api/chronicle?lang=id&session=demo`)).json();
  assert.ok(again.investigation.title.startsWith('THE CASE OF THE FORGOTTEN'), 'English-only: lang=id is ignored');
});

test('POST /api/fridge-check twice makes a Ghost; POST /api/generate twice does not', async () => {
  const headers = { 'content-type': 'application/json' };
  const check = async (ingredients) => (await fetch(`${BASE}/api/fridge-check`, {
    method: 'POST', headers, body: JSON.stringify({ ingredients }),
  })).json();
  const first = await check('api-bean, cold rice');
  assert.equal(first.ok, true);
  assert.ok(first.observation_id, 'first observation has an id');
  const second = await check('api-bean');
  assert.notEqual(second.observation_id, first.observation_id, 'each check is its own observation');
  let c = await (await fetch(`${BASE}/api/chronicle`)).json();
  assert.equal(c.ghosts.length, 1, 'one ghost after two observations');
  assert.equal(c.ghosts[0].ingredient, 'api-bean');
  assert.equal(c.investigation.ingredient, 'api-bean');
  // Re-generating the same menu twice must not touch the Chronicle.
  for (let i = 0; i < 2; i++) {
    const gen = await (await fetch(`${BASE}/api/generate`, {
      method: 'POST', headers, body: JSON.stringify({ ingredients: 'api-bean, cold rice', lang: 'en' }),
    })).json();
    assert.equal(gen.ok, true, 'generate ok');
  }
  c = await (await fetch(`${BASE}/api/chronicle`)).json();
  assert.equal(c.totals.tracked, 2, 'still only api-bean + cold rice');
  assert.equal(c.ghosts.length, 1, 'still one ghost — generate manufactured none');
});

test('POST /api/ingredients/:name/status — human-in-the-loop fate', async () => {
  const headers = { 'content-type': 'application/json' };
  const mark = await fetch(`${BASE}/api/ingredients/api-bean/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'rescued' }),
  });
  assert.equal(mark.status, 200);
  const j = await mark.json();
  assert.equal(j.ok, true);
  assert.equal(j.ingredient, 'api-bean');
  assert.equal(j.status, 'rescued', 'api-bean rescued');
  const bad = await fetch(`${BASE}/api/ingredients/api-bean/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'eaten' }),
  });
  assert.equal(bad.status, 400, 'invalid status rejected');
  const missing = await fetch(`${BASE}/api/ingredients/never-seen-thing/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'rescued' }),
  });
  assert.equal(missing.status, 404, 'unknown ingredient rejected');
  // The bulletin reflects the new fate immediately; the case is closed.
  const c = await (await fetch(`${BASE}/api/chronicle`)).json();
  assert.equal(c.rescued.length, 1, 'api-bean joined the rescued');
  assert.equal(c.ghosts.length, 0, 'no ghost left once the prime suspect is rescued');
  assert.equal(c.investigation, null, 'case closed');
});

test('X-Frigo-Session isolates judges; demo data is not in a judge\'s session', async () => {
  const headers = (s) => ({ 'content-type': 'application/json', 'X-Frigo-Session': s });
  const check = await (await fetch(`${BASE}/api/fridge-check`, {
    method: 'POST', headers: headers('judge-a'), body: JSON.stringify({ ingredients: 'judge-bean' }),
  })).json();
  assert.equal(check.ok, true);
  const a = await (await fetch(`${BASE}/api/chronicle`, { headers: headers('judge-a') })).json();
  assert.equal(a.totals.tracked, 1, 'judge A sees their bean');
  const b = await (await fetch(`${BASE}/api/chronicle`, { headers: headers('judge-b') })).json();
  assert.equal(b.totals.tracked, 0, 'judge B has an empty fridge');
  // Spinach lives only in 'demo', so marking it in judge-a's session 404s.
  const demoMark = await fetch(`${BASE}/api/ingredients/spinach/status`, {
    method: 'POST', headers: headers('judge-a'), body: JSON.stringify({ status: 'rescued' }),
  });
  assert.equal(demoMark.status, 404, 'demo data is not in a judge\'s session');
});

// Audit v13 P0-B: the demo session is read-only AT THE SERVER, not
// just in the UI. A crafted ?session=demo (or header) must not inject
// ingredients or fates into the sample bulletin.
test('the demo session rejects every mutation with 403', async () => {
  const headers = { 'content-type': 'application/json' };
  const check = await fetch(`${BASE}/api/fridge-check?session=demo`, {
    method: 'POST', headers, body: JSON.stringify({ ingredients: 'injected test bean' }),
  });
  assert.equal(check.status, 403, 'fridge-check into demo is forbidden');
  const status = await fetch(`${BASE}/api/ingredients/spinach/status`, {
    method: 'POST', headers: { ...headers, 'X-Frigo-Session': 'demo' }, body: JSON.stringify({ status: 'rescued' }),
  });
  assert.equal(status.status, 403, 'a fate in demo is forbidden');
  const gen = await fetch(`${BASE}/api/generate?session=demo`, {
    method: 'POST', headers, body: JSON.stringify({ ingredients: 'cold rice', lang: 'en' }),
  });
  assert.equal(gen.status, 403, 'generate into demo is forbidden');
  // And the demo bulletin is untouched by all three attempts.
  const demo = await (await fetch(`${BASE}/api/chronicle?session=demo`)).json();
  assert.equal(demo.totals.tracked, 4, 'still four demo dossiers — no injection');
  assert.equal(demo.ghosts.length, 2, 'spinach + cold rice only');
});

// Audit v13 E: meals, checkpoints, receipts and Box archives are scoped
// by session. Judge A must never see Judge B's menu in /api/state, and
// Judge B's receipt/archive requests for Judge A's meal must 404.
test('session isolation for meals, state, receipts and archives', async () => {
  const headers = (s) => ({ 'content-type': 'application/json', 'X-Frigo-Session': s });
  const genA = await (await fetch(`${BASE}/api/generate`, {
    method: 'POST', headers: headers('judge-meal-a'), body: JSON.stringify({ ingredients: 'iso-meal-bean, cheese', lang: 'en' }),
  })).json();
  assert.equal(genA.ok, true, 'judge A generates');
  const mealA = genA.meal_id;
  const genB = await (await fetch(`${BASE}/api/generate`, {
    method: 'POST', headers: headers('judge-meal-b'), body: JSON.stringify({ ingredients: 'other-bean, cheese', lang: 'en' }),
  })).json();
  assert.equal(genB.ok, true, 'judge B generates');
  const stateA = await (await fetch(`${BASE}/api/state`, { headers: headers('judge-meal-a') })).json();
  assert.equal(stateA.meals.length, 1, 'judge A sees only their own meal');
  assert.equal(stateA.meals[0].id, mealA, 'and it is their meal');
  const stateB = await (await fetch(`${BASE}/api/state`, { headers: headers('judge-meal-b') })).json();
  assert.equal(stateB.meals.length, 1, 'judge B sees only their own meal');
  assert.equal(stateB.meals[0].id, genB.meal_id, 'and it is theirs');
  // Receipts: judge B gets a 404 for judge A's meal (never a hint it exists).
  assert.equal((await fetch(`${BASE}/api/meals/${mealA}/receipt`, { headers: headers('judge-meal-b') })).status, 404, 'cross-session receipt 404s');
  assert.equal((await fetch(`${BASE}/api/meals/${mealA}/receipt?session=judge-meal-a`, { headers: headers('judge-meal-b') })).status, 200, 'the owner reads their receipt via ?session=');
  // Archive: same ownership rule, checked before any Box upload.
  assert.equal((await fetch(`${BASE}/api/meals/${mealA}/archive-box`, { method: 'POST', headers: headers('judge-meal-b') })).status, 404, 'cross-session archive 404s');
  const own = await fetch(`${BASE}/api/meals/${mealA}/archive-box`, { method: 'POST', headers: headers('judge-meal-a') });
  assert.equal(own.status, 200, 'the owner archives their own meal');
});

// Audit v14 P1-C: archiving mutates (and can upload to Box), so the
// demo read-only rule must cover archive-box too — even though no demo
// meal exists through the API (generate is blocked for demo), a demo
// meal placed in the DB directly must still refuse to archive.
test('archive-box is also protected by the demo read-only rule', async () => {
  process.env.LE_FRIGO_DB = join(dir, 'server.sqlite');
  const { insertMeal, closeDb } = await import('../src/db.mjs');
  const demoMealId = insertMeal({
    session_id: 'demo', lang: 'en', ingredients: ['demo-bean'], title: 'Demo Meal',
    dignity_loss_percentage: 10, menu_json: { title: 'Demo Meal', preparation: ['Do nothing.'] }, rejected: false,
  });
  closeDb(); // the server owns the file from here on
  const r = await fetch(`${BASE}/api/meals/${demoMealId}/archive-box`, {
    method: 'POST', headers: { 'X-Frigo-Session': 'demo' },
  });
  assert.equal(r.status, 403, 'archiving a demo meal is forbidden');
});

test('GET /healthz', async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.service, 'le-frigo-vide');
});

test('GET /connected?format=json — rawApiKeysInEnv 0, honest connector status', async () => {
  const r = await fetch(`${BASE}/connected?format=json`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.rawApiKeysInEnv, 0, `expected 0 raw keys, got ${j.rawApiKeysInEnv} (${j.rawApiKeyNames})`);
  assert.equal(j.gateway.source, 'https://api.sprites.dev/v1/gateway/list');
  // Environment-aware: on a Sprite the gateway IS live, so connectors it
  // lists may claim connected; in this VM there is no gateway, so none may.
  // Availability and execution are separate (audit v14 P2-F):
  // `gateway_connected`/`connected` match discovery exactly; `via` and
  // `feature_execution` describe how the FEATURE actually runs — live
  // only when the operation genuinely uses the service. Pinecone and
  // Apify are never live (no index / no Actor configured), so their
  // `via` is always 'local-fallback' with a fallback_reason, even when
  // the gateway lists them. A connector that is only in the available
  // catalog (e.g. Box on the Sprite) must still report local-fallback.
  for (const name of ['openrouter', 'pinecone', 'apify', 'box']) {
    const c = j.connectors[name];
    assert.ok(c, `missing connector ${name}`);
    const discovered = (j.gateway.connectors || []).includes(name);
    assert.equal(c.connected, discovered, `${name}.connected must match gateway discovery (discovered=${discovered})`);
    assert.equal(c.gateway_connected, discovered, `${name}.gateway_connected must match discovery`);
    assert.equal(c.via, c.feature_execution === 'live' ? 'sprites-gateway' : 'local-fallback', `${name}.via must mirror feature_execution`);
    if (c.feature_execution === 'local-fallback') assert.ok(c.fallback_reason, `${name} is a fallback but gives no reason`);
    else assert.equal(c.fallback_reason, null, `${name} is live but still carries a fallback reason`);
    // last_execution is null until the feature runs once; once recorded
    // it must carry the full shape (audit v15 P2).
    if (c.last_execution !== null) {
      assert.equal(typeof c.last_execution.ok, 'boolean', `${name}.last_execution.ok must be a boolean`);
      assert.equal(typeof c.last_execution.via, 'string', `${name}.last_execution.via must be a string`);
      assert.ok(!Number.isNaN(new Date(c.last_execution.at).getTime()), `${name}.last_execution.at must be a timestamp`);
    }
    if (discovered) assert.ok(c.baseUrl, `${name} connected but has no baseUrl`);
  }
  // Pinecone / Apify never execute live, whatever the gateway says.
  assert.equal(j.connectors.pinecone.feature_execution, 'local-fallback', 'pinecone matching is always local');
  assert.equal(j.connectors.apify.feature_execution, 'local-fallback', 'apify headlines are always local');
});

test('GET /connected (HTML) renders the same honest status', async () => {
  const r = await fetch(`${BASE}/connected`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('rawApiKeysInEnv: 0'));
  assert.ok(text.includes('NOT INSTALLED'));
});

test('POST /api/generate — normal menu via HTTP', async () => {
  const r = await fetch(`${BASE}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ingredients: 'cold rice, one egg', lang: 'en' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.meal_id);
  // Four-section narrative contract.
  assert.ok(j.menu.aura_analysis && j.menu.aura_analysis.length > 80, 'aura section present');
  assert.ok(j.menu.world_context && j.menu.world_context.length > 40, 'world section present');
  assert.ok(Array.isArray(j.menu.preparation) && j.menu.preparation.length >= 3, 'preparation steps present');
  assert.ok(j.menu.sommelier, 'sommelier present');
  assert.ok(Number.isInteger(j.menu.existential_dread), 'existential_dread present');
});

test('POST /api/generate — trap rejected via HTTP', async () => {
  const r = await fetch(`${BASE}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ingredients: '2 AA batteries, cold rice, dish soap', lang: 'en' }),
  });
  const j = await r.json();
  assert.equal(j.rejected, true);
});

test('POST /api/meals/:id/archive-box — local fallback returns receipt for download', async () => {
  const gen = await fetch(`${BASE}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ingredients: 'stale bread, cheese', lang: 'en' }),
  });
  const meal = await gen.json();
  const r = await fetch(`${BASE}/api/meals/${meal.meal_id}/archive-box`, { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.via, 'local-fallback');
  assert.ok(j.receipt_html && j.receipt_html.includes('CULINARY SIN RECEIPT'), 'fallback receipt HTML returned');
  assert.ok(j.receipt_html.includes('Existential Dread'), 'receipt carries the score line');
  assert.ok(j.receipt_html.includes('Fridge Aura Analysis'), 'receipt carries section I');
  assert.ok(j.receipt_html.includes('Sommelier Pairing'), 'receipt carries section IV');
});

test('GET / serves the Michelin UI', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('Le Frigo Vide'));
  assert.ok(text.includes('id="ingredients-input"'));
  assert.ok(text.includes('id="preset-trap"'));
  assert.ok(!text.includes('id="lang-toggle"'), 'English-only MVP: no language toggle');
  // Revisions 2026-11-27: tab title is just the name, footer is trimmed,
  // receipt title is English, and the header carries the logo.
  assert.ok(text.includes('<title>Le Frigo Vide</title>'), 'tab title is just "Le Frigo Vide"');
  assert.ok(!text.includes('Chef Jean-Paul</title>'), 'no "— Chef Jean-Paul" in the tab title');
  assert.ok(text.includes('Le Frigo Vide · Fly.io Hacksgiving 2026</p>'), 'footer trimmed to name + event');
  assert.ok(!text.includes('zero npm dependencies'), 'footer no longer lists the zero-deps pitch');
  assert.ok(text.includes('Culinary Sin Receipt'), 'receipt title is English');
  assert.ok(!text.includes('Struk Dosa Kuliner'), 'no Indonesian receipt title left in the UI');
  assert.ok(text.includes('src="/logo.svg"'), 'header logo present');
  assert.ok(text.includes('id="chronicle"'), 'Le Bulletin du Frigo section present');
  assert.ok(text.includes('id="survivors-list"'), 'dossier lists present');
  assert.ok(text.includes('id="investigation"'), 'investigation card present');
  assert.ok(text.includes('id="fridge-check-btn"'), 'Log Fridge Check button present');
  assert.ok(text.includes('id="view-demo-btn"'), 'Sample Chronicle toggle present');
  assert.ok(text.includes('id="demo-badge"'), 'DEMO DATA badge present');
  assert.ok(text.includes('id="safety-warning"'), 'safety warning element present');
});

test('GET /logo.svg serves the brand mark as SVG', async () => {
  const r = await fetch(`${BASE}/logo.svg`);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('image/svg+xml'), 'SVG content-type');
  const text = await r.text();
  assert.ok(text.includes('<svg'), 'valid SVG document');
  assert.ok(text.includes('Le Frigo Vide logo'), 'logo carries its label');
});

// The shared classifier: the browser imports it from app.js, so the
// server must serve the exact file (and only that file — the route
// does not expose the shared directory).
test('GET /shared/ingredient-classifier.mjs serves the shared classifier', async () => {
  const r = await fetch(`${BASE}/shared/ingredient-classifier.mjs`);
  assert.equal(r.status, 200, 'the browser can load the shared module');
  assert.ok((r.headers.get('content-type') || '').includes('text/javascript'), 'JavaScript content-type');
  const text = await r.text();
  assert.ok(text.includes('export function classifyIngredient'), 'the classifier is in the file');
  assert.ok(text.includes('export const COOKING_RULES'), 'the cooking rules are in the file');
  const other = await fetch(`${BASE}/shared/other.mjs`);
  assert.equal(other.status, 404, 'no other file in shared/ is served');
  const traversal = await fetch(`${BASE}/shared/../src/pipeline.mjs`);
  assert.equal(traversal.status, 404, 'no traversal out of shared/');
});
