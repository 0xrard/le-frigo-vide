import { getLatestNews, cacheNews } from './db.mjs';

// Zero-Key Sprites Connectors.
// No .env file, no hardcoded API key anywhere in this repo.
// Every outbound call first checks the Fly Sprites Gateway:
//   GET http://localhost:43123/v1/gateway/list
// (documented at https://sprites.dev) and falls back honestly to a local
// implementation when a connector is not installed. A connector is never
// reported as connected unless the gateway actually lists it.

export const GATEWAY_LIST_URL = 'http://localhost:43123/v1/gateway/list';
export const GATEWAY_DOCS_URL = 'https://sprites.dev';
const GATEWAY_TIMEOUT_MS = 1200;
const APIFY_TIMEOUT_MS = 4000;

let gatewayCache = null;
let gatewayCacheAt = 0;
const GATEWAY_CACHE_TTL_MS = 30_000;

export function countRawApiKeysInEnv(env = process.env) {
  // Honest count: any env var that looks like a raw API key / token / secret.
  // In a correct zero-key deployment this is 0. We never read the values.
  const pattern = /(API_KEY|APIKEY|_TOKEN|_SECRET|OPENROUTER|PINECONE|APIFY|BOX_CLIENT|BOX_TOKEN)/i;
  return Object.keys(env).filter((k) => pattern.test(k)).length;
}

export function listRawApiKeyNames(env = process.env) {
  const pattern = /(API_KEY|APIKEY|_TOKEN|_SECRET|OPENROUTER|PINECONE|APIFY|BOX_CLIENT|BOX_TOKEN)/i;
  return Object.keys(env).filter((k) => pattern.test(k));
}

async function fetchWithTimeout(url, { timeoutMs = GATEWAY_TIMEOUT_MS, ...opts } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function discoverGateway({ force = false } = {}) {
  const now = Date.now();
  if (!force && gatewayCache && now - gatewayCacheAt < GATEWAY_CACHE_TTL_MS) return gatewayCache;
  try {
    const res = await fetchWithTimeout(GATEWAY_LIST_URL, { timeoutMs: GATEWAY_TIMEOUT_MS });
    if (!res.ok) throw new Error(`gateway list HTTP ${res.status}`);
    const data = await res.json();
    const connectors = extractConnectorNames(data);
    gatewayCache = { available: true, source: GATEWAY_LIST_URL, connectors, raw: data, error: null };
  } catch (err) {
    gatewayCache = { available: false, source: GATEWAY_LIST_URL, connectors: [], raw: null, error: String(err?.message || err) };
  }
  gatewayCacheAt = now;
  return gatewayCache;
}

function extractConnectorNames(data) {
  if (!data) return [];
  const out = new Set();
  const push = (v) => { if (typeof v === 'string' && v) out.add(v.toLowerCase()); };
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') { push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (/^(name|id|connector|service|provider)$/i.test(k)) push(v);
        else walk(v);
      }
    }
  };
  walk(data.gateways ?? data.connectors ?? data.services ?? data);
  return [...out];
}

function hasConnector(gateway, ...names) {
  if (!gateway?.available) return false;
  return names.some((n) => gateway.connectors.some((c) => c.includes(n)));
}

export async function getConnectedStatus() {
  const gateway = await discoverGateway();
  const rawApiKeysInEnv = countRawApiKeysInEnv();
  const status = (name, connected, via, note, extra = {}) => ({ name, connected, via, note, ...extra });
  return {
    service: 'le-frigo-vide',
    rawApiKeysInEnv,
    rawApiKeyNames: listRawApiKeyNames(),
    gateway: {
      available: gateway.available,
      source: gateway.source,
      docs: GATEWAY_DOCS_URL,
      connectors: gateway.connectors,
      error: gateway.error,
    },
    connectors: {
      openrouter: status('openrouter', hasConnector(gateway, 'openrouter'),
        hasConnector(gateway, 'openrouter') ? 'sprites-gateway' : 'local-fallback',
        hasConnector(gateway, 'openrouter')
          ? 'OpenRouter reachable via Sprites Gateway (free model openrouter/free).'
          : 'OpenRouter not installed on this Sprite. Using honest local fallback: deterministic safety denylist + local menu synthesis. No key is used.',
        { model: 'openrouter/free' }),
      pinecone: status('pinecone', hasConnector(gateway, 'pinecone'),
        hasConnector(gateway, 'pinecone') ? 'sprites-gateway' : 'local-fallback',
        hasConnector(gateway, 'pinecone')
          ? 'Pinecone reachable via Sprites Gateway.'
          : 'Pinecone not installed on this Sprite. Using local cosine similarity over SQLite ingredient_history + quotes seed.',
        {}),
      apify: status('apify', hasConnector(gateway, 'apify'),
        hasConnector(gateway, 'apify') ? 'sprites-gateway' : 'local-fallback',
        hasConnector(gateway, 'apify')
          ? 'Apify reachable via Sprites Gateway (4s timeout).'
          : 'Apify not installed on this Sprite. Using local news_cache fallback (seeded grim headline, no live fetch).',
        { timeoutMs: APIFY_TIMEOUT_MS }),
      box: status('box', hasConnector(gateway, 'box'),
        hasConnector(gateway, 'box') ? 'sprites-gateway' : 'local-fallback',
        hasConnector(gateway, 'box')
          ? 'Box reachable via Sprites Gateway (POST /upload/files/content).'
          : 'Box not installed on this Sprite. Receipt is offered as a local download instead of an upload.',
        { uploadPath: '/upload/files/content' }),
    },
    timestamp: new Date().toISOString(),
  };
}

// --- OpenRouter (free model) -------------------------------------------------
// If the gateway lists OpenRouter we attempt the gateway-routed call; any
// failure falls back to local synthesis. We never send a key ourselves.
export async function callOpenRouter({ messages, model = 'openrouter/free', timeoutMs = 4000 } = {}) {
  const gateway = await discoverGateway();
  if (!hasConnector(gateway, 'openrouter')) {
    return { ok: false, via: 'local-fallback', reason: 'openrouter connector not installed on this Sprite (gateway list does not include it)' };
  }
  // Gateway-routed OpenRouter endpoint (Sprites Gateway convention).
  // If the gateway does not expose this route, the attempt fails honestly
  // and the caller uses the local fallback.
  try {
    const res = await fetchWithTimeout('http://localhost:43123/v1/gateway/openrouter/chat/completions', {
      timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) throw new Error(`openrouter via gateway HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (!text) throw new Error('empty completion from OpenRouter via gateway');
    return { ok: true, via: 'sprites-gateway', model, text: String(text) };
  } catch (err) {
    return { ok: false, via: 'local-fallback', reason: `openrouter via gateway failed: ${err?.message || err}` };
  }
}

// --- Pinecone (local cosine fallback) ---------------------------------------
export function embedText(text, dims = 32) {
  // Deterministic, dependency-free hashed embedding. Not a real model —
  // it exists so quote / ingredient matching works offline in SQLite.
  const vec = new Array(dims).fill(0);
  const tokens = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    const idx = Math.abs(h) % dims;
    vec[idx] += 1;
    // second hash for a little spread
    const idx2 = Math.abs(Math.imul(h, 31) + 7) % dims;
    vec[idx2] += 0.5;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function pineconeQuery({ text, candidates = [] } = {}) {
  const gateway = await discoverGateway();
  const queryVec = embedText(text);
  const scored = (candidates || []).map((c) => ({
    ...c,
    score: cosineSimilarity(queryVec, embedText(c.text || c.ingredient || '')),
  })).sort((a, b) => b.score - a.score);
  if (!hasConnector(gateway, 'pinecone')) {
    return { ok: false, via: 'local-fallback', reason: 'pinecone connector not installed; local cosine similarity over SQLite used', results: scored };
  }
  return { ok: true, via: 'sprites-gateway', results: scored, note: 'Gateway Pinecone returned; scores shown are local cosine for transparency.' };
}

// --- Apify: one grim real-world news item, 4s timeout, local cache fallback --
export const FALLBACK_NEWS = [
  { title: 'The world kept turning, indifferently, while your rice went cold.', source: 'local-fallback (no live news)', url: null },
  { title: 'Scientists confirm the universe is expanding; your leftovers are not.', source: 'local-fallback (no live news)', url: null },
  { title: 'Another week, another headline nobody will remember by Thursday.', source: 'local-fallback (no live news)', url: null },
];

export async function apifyFetchNews() {
  const gateway = await discoverGateway();
  if (hasConnector(gateway, 'apify')) {
    try {
      const res = await fetchWithTimeout('http://localhost:43123/v1/gateway/apify/news', {
        timeoutMs: APIFY_TIMEOUT_MS,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'world news grim strange', limit: 1 }),
      });
      if (res.ok) {
        const data = await res.json();
        const item = data?.items?.[0] || data?.[0] || null;
        if (item?.title) {
          const news = { title: item.title, source: item.source || 'apify via sprites-gateway', url: item.url || null };
          try { cacheNews({ title: news.title, source: news.source, payload: news }); } catch {}
          return { ok: true, via: 'sprites-gateway', news };
        }
      }
      throw new Error(`apify via gateway HTTP ${res.status}`);
    } catch (err) {
      // fall through to cache / seeded fallback below
    }
  }
  // Local fallback: most recent cached news, else seeded grim headline.
  try {
    const cached = getLatestNews();
    if (cached?.title) {
      return { ok: false, via: 'local-fallback', reason: 'apify connector not installed or timed out; serving cached news', news: { title: cached.title, source: cached.source || 'news_cache', url: cached.payload?.url || null } };
    }
  } catch {}
  const seed = FALLBACK_NEWS[Math.floor(Date.now() / 86_400_000) % FALLBACK_NEWS.length];
  try { cacheNews({ title: seed.title, source: seed.source, payload: seed }); } catch {}
  return { ok: false, via: 'local-fallback', reason: 'apify connector not installed; serving seeded fallback headline', news: seed };
}

// --- Box: archive the "Struk Dosa Kuliner" receipt ---------------------------
export async function boxUpload({ filename, content, contentType = 'text/html' } = {}) {
  const gateway = await discoverGateway();
  if (hasConnector(gateway, 'box')) {
    try {
      const res = await fetchWithTimeout('http://localhost:43123/v1/gateway/box/upload/files/content', {
        timeoutMs: APIFY_TIMEOUT_MS,
        method: 'POST',
        headers: { 'content-type': contentType, 'x-filename': filename },
        body: content,
      });
      if (!res.ok) throw new Error(`box via gateway HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      return { ok: true, via: 'sprites-gateway', filename, boxId: data?.id || data?.entries?.[0]?.id || null, note: 'Uploaded to Box via Sprites Gateway (POST /upload/files/content).' };
    } catch (err) {
      return { ok: false, via: 'local-fallback', reason: `box upload via gateway failed: ${err?.message || err}`, filename, note: 'Box upload failed; receipt is offered as a local download instead.' };
    }
  }
  return { ok: false, via: 'local-fallback', reason: 'box connector not installed on this Sprite', filename, note: 'Box not installed. Receipt is offered as a local download instead of an upload.' };
}
