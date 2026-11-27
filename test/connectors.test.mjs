import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// apifyFetchNews touches the DB (news_cache); keep it in a temp dir so
// the test never writes to the repo's data/ directory.
process.env.LE_FRIGO_DB = join(mkdtempSync(join(tmpdir(), 'le-frigo-vide-connectors-')), 'connectors.sqlite');

const { extractConnections, extractJsonObject, discoverGateway, callOpenRouter, GATEWAY_LIST_URL, FALLBACK_NEWS, isNewsStale, NEWS_CACHE_TTL_MS, buildBoxMultipart, pineconeQuery, apifyFetchNews, getConnectedStatus, boxUpload } = await import('../src/connectors.mjs');

// The exact response shape proven live on Sprite le-frigo-vide, 2026-11-27:
// GET https://api.sprites.dev/v1/gateway/list returns HTTP 200 with
// { available: [...catalog...], connections: [{ provider, gateway_base_url, id }] }.
// Connection IDs below are placeholders in the same shape (not real IDs).
const LIVE_SHAPE = {
  available: [
    { provider: 'box', display_name: 'Box' },
    { provider: 'openrouter', display_name: 'OpenRouter' },
    { provider: 'slack', display_name: 'Slack (User)' },
  ],
  connections: [
    { id: 'conn-apify-1', provider: 'apify', gateway_base_url: 'https://api.sprites.dev/v1/gateway/apify/conn-apify-1' },
    { id: 'conn-ollama-1', provider: 'ollama', gateway_base_url: 'https://api.sprites.dev/v1/gateway/ollama/conn-ollama-1' },
    { id: 'conn-pinecone-1', provider: 'pinecone', gateway_base_url: 'https://api.sprites.dev/v1/gateway/pinecone/conn-pinecone-1' },
    { id: 'conn-openrouter-1', provider: 'openrouter', gateway_base_url: 'https://api.sprites.dev/v1/gateway/openrouter/conn-openrouter-1' },
  ],
};

test('gateway discovery parses the live Sprites shape (connections + gateway_base_url)', () => {
  const { connectors, connections } = extractConnections(LIVE_SHAPE);
  assert.deepEqual([...connectors].sort(), ['apify', 'ollama', 'openrouter', 'pinecone']);
  assert.equal(connections.openrouter.baseUrl, 'https://api.sprites.dev/v1/gateway/openrouter/conn-openrouter-1');
  assert.equal(connections.pinecone.baseUrl, 'https://api.sprites.dev/v1/gateway/pinecone/conn-pinecone-1');
  assert.equal(connections.apify.baseUrl, 'https://api.sprites.dev/v1/gateway/apify/conn-apify-1');
  // OpenRouter chat completions go under the discovered base URL.
  assert.equal(`${connections.openrouter.baseUrl}/v1/chat/completions`, 'https://api.sprites.dev/v1/gateway/openrouter/conn-openrouter-1/v1/chat/completions');
});

test('available catalog alone does NOT count as connected (Box is listed but not connected)', () => {
  const { connectors } = extractConnections(LIVE_SHAPE);
  assert.ok(!connectors.includes('box'), 'box is in available[] but has no connection and must stay local-fallback');
  assert.ok(!connectors.includes('slack'), 'slack is in available[] but has no connection');
});

test('empty connections list parses to no connectors (local-baseline)', () => {
  const { connectors, connections } = extractConnections({ available: [], connections: [] });
  assert.deepEqual(connectors, []);
  assert.deepEqual(connections, {});
});

test('old alternate shapes still parse (gateways/connectors/data)', () => {
  const { connectors } = extractConnections({ gateways: [{ provider: 'openrouter', base_url: 'https://example.invalid/x' }] });
  assert.ok(connectors.includes('openrouter'));
});

test('callOpenRouter retries once on HTTP 429, then succeeds (Sprite 2026-11-27 regression)', async () => {
  // The Sprite service log showed a burst of HTTP 429s (free-tier rate
  // limit) at 08:45–08:48 UTC. A single retry after a short wait often
  // clears a per-minute window; other failures are not retried.
  const realFetch = globalThis.fetch;
  let calls = 0;
  const listBody = { connections: [{ provider: 'openrouter', gateway_base_url: 'https://gw.test/openrouter/x', id: 'x' }] };
  globalThis.fetch = async (url, opts) => {
    calls++;
    if (String(url) === GATEWAY_LIST_URL) {
      return { ok: true, status: 200, json: async () => listBody };
    }
    if (calls === 2) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"hi": true}' } }] }) };
  };
  try {
    await discoverGateway({ force: true });
    const res = await callOpenRouter({ messages: [{ role: 'user', content: 'hi' }], retryDelayMs: 10 });
    assert.equal(res.ok, true, `expected retry to succeed, got ${JSON.stringify(res)}`);
    assert.equal(res.via, 'sprites-gateway');
    assert.equal(calls, 3, `expected list + 2 posts, got ${calls} fetch calls`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('callOpenRouter gives up honestly after a second 429', async () => {
  const realFetch = globalThis.fetch;
  const listBody = { connections: [{ provider: 'openrouter', gateway_base_url: 'https://gw.test/openrouter/x', id: 'x' }] };
  globalThis.fetch = async (url) => {
    if (String(url) === GATEWAY_LIST_URL) return { ok: true, status: 200, json: async () => listBody };
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    await discoverGateway({ force: true });
    const res = await callOpenRouter({ messages: [{ role: 'user', content: 'hi' }], retryDelayMs: 10 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FALLBACK_NEWS has 5-6 grim variations, each embeddable mid-sentence', () => {
  // User 2026-11-27: Outside World Context must not always say "the world
  // kept turning...". Headlines are embedded after "remember that ...", so
  // they must read as a clause (lowercase-able first word, one sentence).
  assert.ok(FALLBACK_NEWS.length >= 5 && FALLBACK_NEWS.length <= 6, `expected 5-6 headlines, got ${FALLBACK_NEWS.length}`);
  const titles = new Set();
  for (const n of FALLBACK_NEWS) {
    assert.ok(typeof n.title === 'string' && n.title.length > 30, `headline too short: ${n.title}`);
    assert.ok(n.title.endsWith('.'), `headline must end with a period (stripped on embed): ${n.title}`);
    assert.ok(n.source, 'headline needs a source label');
    assert.ok(!titles.has(n.title), `duplicate headline: ${n.title}`);
    titles.add(n.title);
  }
  // The old coffee-price and traffic headlines were removed (audit v14
  // P1-D): they read like real news. Every headline now names an
  // obviously imaginary institution instead.
  assert.ok(FALLBACK_NEWS.some((n) => /Bureau of Refrigerator Existentialism/i.test(n.title)), 'one headline from the Bureau of Refrigerator Existentialism');
  assert.ok(FALLBACK_NEWS.some((n) => /Ministry of Leftover Affairs/i.test(n.title)), 'one headline from the Ministry of Leftover Affairs');
});

test('isNewsStale: fresh within the hour, stale after it, stale when missing', () => {
  const now = Date.now();
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  assert.equal(isNewsStale(fmt(now - 10 * 60 * 1000), now), false, '10 minutes old is fresh');
  assert.equal(isNewsStale(fmt(now - NEWS_CACHE_TTL_MS - 1000), now), true, 'older than TTL is stale');
  assert.equal(isNewsStale(null, now), true, 'missing timestamp is stale');
  assert.equal(isNewsStale('not a date', now), true, 'unparsable timestamp is stale');
});

test('buildBoxMultipart builds a valid Box upload body (attributes + file)', () => {
  // Regression: a raw text/html body was rejected with HTTP 415 live on
  // 2026-11-27, right after Box was linked. Box wants multipart/form-data.
  const { body, boundary, contentTypeHeader } = buildBoxMultipart({ filename: 'culinary-sin-receipt-meal-1.html', content: '<h1>LE FRIGO VIDE</h1>' });
  assert.ok(contentTypeHeader.startsWith('multipart/form-data; boundary='), 'multipart content-type');
  assert.ok(contentTypeHeader.includes(boundary), 'header carries the boundary');
  const text = body.toString('utf8');
  assert.ok(text.includes('name="attributes"'), 'attributes part present');
  assert.ok(text.includes('"name":"culinary-sin-receipt-meal-1.html"'), 'attributes name the file');
  assert.ok(text.includes('"parent":{"id":"0"}'), 'attributes target the root folder');
  assert.ok(text.includes('name="file"; filename="culinary-sin-receipt-meal-1.html"'), 'file part present with filename');
  assert.ok(text.includes('Content-Type: text/html'), 'file part carries the content type');
  assert.ok(text.includes('<h1>LE FRIGO VIDE</h1>'), 'file content embedded');
  assert.ok(text.trimEnd().endsWith(`--${boundary}--`), 'body ends with the closing boundary');
});

test('extractJsonObject handles fenced, prose-wrapped and bare JSON', () => {
  assert.deepEqual(extractJsonObject('{"hi": true}'), { hi: true });
  assert.deepEqual(extractJsonObject('```json\n{"safe": false, "unsafe_items": ["dish soap"]}\n```'), { safe: false, unsafe_items: ['dish soap'] });
  assert.deepEqual(extractJsonObject('Here is your menu:\n{"title": "Le Riz", "courses": [{"name": "Riz"}]}\nBon appétit.'), { title: 'Le Riz', courses: [{ name: 'Riz' }] });
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject(null), null);
});

// Audit v14 P1-D: no fallback headline may ever read like a real news
// report — each one must name an obviously imaginary institution, and
// none may carry a number that looks like a real statistic.
test('fallback news headlines are clearly fictional, never real-sounding', () => {
  assert.ok(FALLBACK_NEWS.length >= 4, 'enough headlines to rotate');
  for (const n of FALLBACK_NEWS) {
    assert.match(n.title, /Bureau|Ministry|committee|Society|Official bulletin|Department/, `fictional institution in: ${n.title}`);
    assert.ok(!/%/.test(n.title), `no percentage that looks like a real statistic: ${n.title}`);
    assert.ok(!/jumped|plunged|rose \d|fell \d/.test(n.title), `no market-move language: ${n.title}`);
    assert.match(n.source, /fictional/, 'source says fictional');
  }
});

test('the dread pairing serves a fictional fallback headline', async () => {
  const res = await apifyFetchNews();
  assert.equal(res.via, 'local-fallback', 'dread pairing is always a local fallback');
  assert.ok(FALLBACK_NEWS.some((n) => n.title === res.news.title), 'the headline comes from the fictional set');
});

// Audit v14 P2-F: matching is always local cosine, so `via` must never
// claim 'sprites-gateway' for Pinecone — even when the gateway lists it.
test('pineconeQuery never claims the gateway executed the match', async () => {
  const res = await pineconeQuery({ text: 'cold rice', candidates: [{ text: 'The fridge does not lie.', author: 'Camus' }] });
  assert.equal(res.via, 'local-fallback', 'matching is local, whatever the gateway lists');
  assert.ok(res.results.length === 1, 'results are still scored locally');
});

// Audit v15 P2: `feature_execution` is the configured MODE, not a
// success claim. The actual outcome of the most recent operation lives
// in `last_execution` — a live mode with a failed last call must show
// the failure, and a successful call must show it.
test('last_execution records the actual outcome of the most recent call', async () => {
  const realFetch = globalThis.fetch;
  const listBody = {
    connections: [
      { provider: 'openrouter', gateway_base_url: 'https://gw.test/openrouter/x', id: 'x' },
      { provider: 'box', gateway_base_url: 'https://gw.test/box/y', id: 'y' },
    ],
  };
  globalThis.fetch = async (url) => {
    if (String(url) === GATEWAY_LIST_URL) return { ok: true, status: 200, json: async () => listBody };
    if (String(url).includes('/upload/files/content')) {
      return { ok: true, status: 200, json: async () => ({ id: 'box-123' }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  };
  try {
    await discoverGateway({ force: true });
    const before = await getConnectedStatus();
    assert.equal(before.connectors.openrouter.feature_execution, 'live', 'openrouter mode is live when the gateway lists it');
    assert.equal(before.connectors.openrouter.gateway_connected, true);
    // A successful OpenRouter call records a successful last execution.
    const res = await callOpenRouter({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.ok, true);
    const after = await getConnectedStatus();
    const last = after.connectors.openrouter.last_execution;
    assert.ok(last, 'last_execution is recorded');
    assert.equal(last.ok, true, 'the successful call is recorded as ok');
    assert.equal(last.via, 'sprites-gateway');
    assert.ok(!Number.isNaN(new Date(last.at).getTime()), 'last_execution carries a timestamp');
    // A successful Box upload records its box id outcome too.
    const up = await boxUpload({ filename: 'receipt.html', content: '<h1>x</h1>' });
    assert.equal(up.ok, true);
    assert.equal(up.boxId, 'box-123');
    const afterBox = await getConnectedStatus();
    assert.equal(afterBox.connectors.box.last_execution.ok, true);
    assert.equal(afterBox.connectors.box.last_execution.via, 'sprites-gateway');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed call records a failed last_execution, not a live claim', async () => {
  const realFetch = globalThis.fetch;
  const listBody = { connections: [{ provider: 'openrouter', gateway_base_url: 'https://gw.test/openrouter/x', id: 'x' }] };
  globalThis.fetch = async (url) => {
    if (String(url) === GATEWAY_LIST_URL) return { ok: true, status: 200, json: async () => listBody };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    await discoverGateway({ force: true });
    const res = await callOpenRouter({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.ok, false, 'the call failed');
    const status = await getConnectedStatus();
    assert.equal(status.connectors.openrouter.feature_execution, 'live', 'the MODE is still live — it is not a success claim');
    const last = status.connectors.openrouter.last_execution;
    assert.equal(last.ok, false, 'but the last execution shows the failure');
    assert.match(last.reason, /500/, 'with the reason');
  } finally {
    globalThis.fetch = realFetch;
  }
});
