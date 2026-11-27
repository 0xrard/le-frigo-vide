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
  // What must always hold: `connected` matches discovery exactly, and
  // `via` matches `connected`. A connector that is only in the available
  // catalog (e.g. Box on the Sprite) must still report local-fallback.
  for (const name of ['openrouter', 'pinecone', 'apify', 'box']) {
    assert.ok(j.connectors[name], `missing connector ${name}`);
    const discovered = (j.gateway.connectors || []).includes(name);
    assert.equal(j.connectors[name].connected, discovered, `${name}.connected must match gateway discovery (discovered=${discovered})`);
    assert.equal(j.connectors[name].via, discovered ? 'sprites-gateway' : 'local-fallback', `${name}.via must match connected`);
    if (discovered) assert.ok(j.connectors[name].baseUrl, `${name} connected but has no baseUrl`);
  }
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
  assert.ok(text.includes('id="lang-toggle"'));
  // Revisions 2026-11-27: tab title is just the name, footer is trimmed,
  // receipt title is English, and the header carries the logo.
  assert.ok(text.includes('<title>Le Frigo Vide</title>'), 'tab title is just "Le Frigo Vide"');
  assert.ok(!text.includes('Chef Jean-Paul</title>'), 'no "— Chef Jean-Paul" in the tab title');
  assert.ok(text.includes('Le Frigo Vide · Fly.io Hacksgiving 2026</p>'), 'footer trimmed to name + event');
  assert.ok(!text.includes('zero npm dependencies'), 'footer no longer lists the zero-deps pitch');
  assert.ok(text.includes('Culinary Sin Receipt'), 'receipt title is English');
  assert.ok(!text.includes('Struk Dosa Kuliner'), 'no Indonesian receipt title left in the UI');
  assert.ok(text.includes('src="/logo.svg"'), 'header logo present');
});

test('GET /logo.svg serves the brand mark as SVG', async () => {
  const r = await fetch(`${BASE}/logo.svg`);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('image/svg+xml'), 'SVG content-type');
  const text = await r.text();
  assert.ok(text.includes('<svg'), 'valid SVG document');
  assert.ok(text.includes('Le Frigo Vide logo'), 'logo carries its label');
});
