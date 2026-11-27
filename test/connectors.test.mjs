import test from 'node:test';
import assert from 'node:assert/strict';

const { extractConnections, extractJsonObject, discoverGateway, callOpenRouter, GATEWAY_LIST_URL, FALLBACK_NEWS, isNewsStale, NEWS_CACHE_TTL_MS } = await import('../src/connectors.mjs');

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
  assert.ok(FALLBACK_NEWS.some((n) => /coffee/i.test(n.title)), 'one headline about coffee prices');
  assert.ok(FALLBACK_NEWS.some((n) => /traffic/i.test(n.title)), 'one headline about traffic');
});

test('isNewsStale: fresh within the hour, stale after it, stale when missing', () => {
  const now = Date.now();
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  assert.equal(isNewsStale(fmt(now - 10 * 60 * 1000), now), false, '10 minutes old is fresh');
  assert.equal(isNewsStale(fmt(now - NEWS_CACHE_TTL_MS - 1000), now), true, 'older than TTL is stale');
  assert.equal(isNewsStale(null, now), true, 'missing timestamp is stale');
  assert.equal(isNewsStale('not a date', now), true, 'unparsable timestamp is stale');
});

test('extractJsonObject handles fenced, prose-wrapped and bare JSON', () => {
  assert.deepEqual(extractJsonObject('{"hi": true}'), { hi: true });
  assert.deepEqual(extractJsonObject('```json\n{"safe": false, "unsafe_items": ["dish soap"]}\n```'), { safe: false, unsafe_items: ['dish soap'] });
  assert.deepEqual(extractJsonObject('Here is your menu:\n{"title": "Le Riz", "courses": [{"name": "Riz"}]}\nBon appétit.'), { title: 'Le Riz', courses: [{ name: 'Riz' }] });
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject(null), null);
});
