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
  for (const name of ['openrouter', 'pinecone', 'apify', 'box']) {
    assert.ok(j.connectors[name], `missing connector ${name}`);
    // No gateway in this VM: nothing may claim to be connected.
    assert.equal(j.connectors[name].connected, false, `${name} must not claim connected without a gateway`);
    assert.equal(j.connectors[name].via, 'local-fallback');
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
  assert.ok(j.receipt_html && j.receipt_html.includes('STRUK DOSA KULINER'), 'fallback receipt HTML returned');
});

test('GET / serves the Michelin UI', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('Le Frigo Vide'));
  assert.ok(text.includes('id="ingredients-input"'));
  assert.ok(text.includes('id="preset-trap"'));
  assert.ok(text.includes('id="lang-toggle"'));
});
