import test from 'node:test';
import assert from 'node:assert/strict';

const { extractConnections } = await import('../src/connectors.mjs');

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
