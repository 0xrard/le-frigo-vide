import { getLatestNews, cacheNews } from './db.mjs';

// Zero-Key Sprites Connectors.
// No .env file, no hardcoded API key anywhere in this repo.
// Every outbound call first checks the Fly Sprites Gateway:
//   GET https://api.sprites.dev/v1/gateway/list
// (documented at https://sprites.dev) and falls back honestly to a local
// implementation when a connector is not installed. A connector is never
// reported as connected unless the gateway actually lists it.
//
// PROVEN LIVE on Sprite le-frigo-vide, 2026-11-27: that endpoint returns
// HTTP 200 with { available: [...catalog...], connections: [
//   { provider: "openrouter", gateway_base_url:
//     "https://api.sprites.dev/v1/gateway/openrouter/<connection-id>", ... },
//   ... ] } and NO Authorization header is sent — the Sprite's network
// identity is injected by the gateway itself. Outside a Sprite the same
// endpoint returns {"error": ...}, which is treated as "no gateway".
// The old address http://localhost:43123/v1/gateway/list was WRONG on a
// Sprite: nothing listens on port 43123 there (verified: connection refused).
// Per-connector calls go to <gateway_base_url>/v1/chat/completions etc.,
// e.g. POST https://api.sprites.dev/v1/gateway/openrouter/<id>/v1/chat/completions

export const GATEWAY_LIST_URL = 'https://api.sprites.dev/v1/gateway/list';
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
    if (data?.error) throw new Error(`gateway list error: ${data.error}`);
    // Live Sprites shape: { available: [...], connections: [{ provider,
    // gateway_base_url, id, ... }] }. Older/alternate shapes use gateways /
    // connectors / data as the list — accept those too, but `connections`
    // wins because it is the shape proven live on 2026-11-27.
    const { connectors, connections } = extractConnections(data);
    const availableProviders = Array.isArray(data?.available)
      ? data.available.map((a) => String(a?.provider || a?.name || '')).filter(Boolean)
      : [];
    gatewayCache = {
      available: true, source: GATEWAY_LIST_URL,
      connectors, connections, availableProviders,
      raw: data, error: null,
    };
  } catch (err) {
    gatewayCache = {
      available: false, source: GATEWAY_LIST_URL,
      connectors: [], connections: {}, availableProviders: [],
      raw: null, error: String(err?.message || err),
    };
  }
  gatewayCacheAt = now;
  return gatewayCache;
}

export function extractConnections(data) {
  const list = data?.connections ?? data?.gateways ?? data?.connectors ?? data?.data ?? [];
  const names = new Set();
  const byProvider = {};
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry === 'string') {
      if (entry) { names.add(entry.toLowerCase()); byProvider[entry.toLowerCase()] = { baseUrl: null, id: entry }; }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const provider = String(entry.provider || entry.name || entry.id || '').toLowerCase();
    if (!provider) continue;
    const baseUrl = entry.gateway_base_url || entry.base_url || entry.baseUrl
      || entry.url || entry.gateway_url || entry.gatewayUrl || null;
    names.add(provider);
    byProvider[provider] = { baseUrl, id: entry.id || null, provider };
  }
  return { connectors: [...names], connections: byProvider };
}

function hasConnector(gateway, ...names) {
  if (!gateway?.available) return false;
  return names.some((n) => gateway.connectors.some((c) => c.includes(n)));
}

function gatewayBaseUrl(gateway, name) {
  return gateway?.connections?.[name]?.baseUrl || null;
}

// Last-execution record (audit v15 P2): `feature_execution` is the MODE
// the feature is configured for — it must never be read as "the last
// call succeeded". The actual outcome of the most recent operation in
// THIS process lives here, per connector: { at, ok, via, reason }.
// `ok` means the operation delivered its result (by whatever path);
// `via` says which path it took. Null until the feature runs once.
const LAST_EXECUTION = {};
function recordExecution(name, result) {
  LAST_EXECUTION[name] = {
    at: new Date().toISOString(),
    ok: Boolean(result?.ok),
    via: result?.via || null,
    reason: result?.reason || null,
  };
  return result;
}

export async function getConnectedStatus() {
  const gateway = await discoverGateway();
  const rawApiKeysInEnv = countRawApiKeysInEnv();
  // Availability, mode and last result are SEPARATE fields (audits v14
  // P2-F, v15 P2):
  // `gateway_connected` — the gateway lists this connector;
  // `feature_execution` — the MODE the feature is configured for ('live'
  // only when the operation is wired to genuinely use the service,
  // 'local-fallback' otherwise). A live MODE is not a successful call.
  // `fallback_reason` — WHY the mode is a fallback (configuration);
  // `last_execution` — WHAT the most recent operation actually did in
  // this process (null until the feature runs once). `via` mirrors
  // `feature_execution`. Pinecone and Apify are NEVER 'live': the gateway
  // connection exists, but no Pinecone index and no Apify Actor are
  // configured, so no query or run is ever sent — matching runs locally
  // (cosine similarity over SQLite) and the dread pairing serves the
  // local news_cache. Never claim a Pinecone lookup or an Apify scrape
  // happened.
  const status = (name, gatewayConnected, featureExecution, fallbackReason, note, extra = {}) => ({
    name,
    connected: gatewayConnected,
    gateway_connected: gatewayConnected,
    feature_execution: featureExecution,
    via: featureExecution === 'live' ? 'sprites-gateway' : 'local-fallback',
    fallback_reason: fallbackReason,
    last_execution: LAST_EXECUTION[name] || null,
    note,
    ...extra,
  });
  const has = (n) => hasConnector(gateway, n);
  return {
    service: 'le-frigo-vide',
    rawApiKeysInEnv,
    rawApiKeyNames: listRawApiKeyNames(),
    gateway: {
      available: gateway.available,
      source: gateway.source,
      docs: GATEWAY_DOCS_URL,
      connectors: gateway.connectors,
      connections: gateway.connections || {},
      availableProviders: gateway.availableProviders || [],
      error: gateway.error,
    },
    connectors: {
      openrouter: status('openrouter', has('openrouter'),
        has('openrouter') ? 'live' : 'local-fallback',
        has('openrouter') ? null : 'openrouter connector not installed on this Sprite',
        has('openrouter')
          ? 'OpenRouter reachable via Sprites Gateway (free model openrouter/free).'
          : 'OpenRouter not installed on this Sprite. Using honest local fallback: deterministic safety denylist + local menu synthesis. No key is used.',
        { model: 'openrouter/free', baseUrl: gatewayBaseUrl(gateway, 'openrouter') }),
      pinecone: status('pinecone', has('pinecone'), 'local-fallback',
        has('pinecone')
          ? 'no Pinecone index configured — matching is local cosine over SQLite'
          : 'pinecone connector not installed on this Sprite',
        has('pinecone')
          ? 'Pinecone wired (local-fallback active): reachable via Sprites Gateway, but no Pinecone index is configured, so matching runs locally — cosine similarity over SQLite ingredient_history + quotes seed.'
          : 'Pinecone not installed on this Sprite. Using local cosine similarity over SQLite ingredient_history + quotes seed.',
        { baseUrl: gatewayBaseUrl(gateway, 'pinecone') }),
      apify: status('apify', has('apify'), 'local-fallback',
        has('apify')
          ? 'no Apify Actor configured — headlines are local (fictional fallback)'
          : 'apify connector not installed on this Sprite',
        has('apify')
          ? 'Apify wired (local-fallback active): reachable via Sprites Gateway, but no Actor is configured, so the Global Dread Pairing serves the local news_cache (seeded fictional headlines, no live scrape).'
          : 'Apify not installed on this Sprite. Using local news_cache fallback (seeded fictional headline, no live fetch).',
        { timeoutMs: APIFY_TIMEOUT_MS, baseUrl: gatewayBaseUrl(gateway, 'apify') }),
      box: status('box', has('box'),
        has('box') ? 'live' : 'local-fallback',
        has('box') ? null : 'box connector not installed on this Sprite',
        has('box')
          ? 'Box reachable via Sprites Gateway (POST /upload/files/content).'
          : 'Box not installed on this Sprite. Receipt is offered as a local download instead of an upload.',
        { uploadPath: '/upload/files/content', baseUrl: gatewayBaseUrl(gateway, 'box') }),
    },
    timestamp: new Date().toISOString(),
  };
}

// --- OpenRouter (free model) -------------------------------------------------
// If the gateway lists OpenRouter we attempt the gateway-routed call; any
// failure falls back to local synthesis. We never send a key ourselves.
//
// Timeout note (Sprite 2026-11-27): a tiny completion returns in ~2.7s,
// but a full menu JSON takes much longer — the old 4s timeout made every
// real call fail and silently fall back to local synthesis. Default is
// now 15s; the pipeline passes 8s for the short safety classification
// and 20s for the full menu synthesis.
export async function callOpenRouter({ messages, model = 'openrouter/free', timeoutMs = 15000, maxTokens = null, retryDelayMs = 15000 } = {}) {
  const gateway = await discoverGateway();
  const baseUrl = gatewayBaseUrl(gateway, 'openrouter');
  if (!hasConnector(gateway, 'openrouter') || !baseUrl) {
    return recordExecution('openrouter', { ok: false, via: 'local-fallback', reason: 'openrouter connector not installed on this Sprite (gateway list does not include it)' });
  }
  // Gateway-routed OpenRouter endpoint, proven live 2026-11-27:
  // POST <gateway_base_url>/v1/chat/completions, e.g.
  // https://api.sprites.dev/v1/gateway/openrouter/<connection-id>/v1/chat/completions
  // No Authorization header — the gateway injects the credential itself.
  // If the call fails, the caller uses the local fallback.
  // Retry once on HTTP 429: the free tier rate-limits (proven by the
  // Sprite service log, 2026-11-27 — a burst of 429s after many calls),
  // and a short wait often clears a per-minute window. Other failures
  // (timeout, 4xx/5xx) are not retried.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        timeoutMs,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
      });
      if (res.status === 429 && attempt === 1) {
        console.error(`[openrouter] HTTP 429 (free-tier rate limit); retrying once after ${retryDelayMs}ms`);
        await sleep(retryDelayMs);
        continue;
      }
      if (!res.ok) throw new Error(`openrouter via gateway HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
      if (!text) throw new Error('empty completion from OpenRouter via gateway');
      return recordExecution('openrouter', { ok: true, via: 'sprites-gateway', model, text: String(text) });
    } catch (err) {
      // Log the reason server-side (service log) so a silent fallback on
      // the Sprite can be diagnosed without guessing: timeout vs HTTP
      // error vs bad payload. The client still gets an honest local-fallback.
      console.error(`[openrouter] gateway call failed (${timeoutMs}ms): ${err?.message || err}`);
      return recordExecution('openrouter', { ok: false, via: 'local-fallback', reason: `openrouter via gateway failed: ${err?.message || err}` });
    }
  }
  return recordExecution('openrouter', { ok: false, via: 'local-fallback', reason: 'openrouter via gateway failed: HTTP 429 (free-tier rate limit, retry exhausted)' });
}

// Extract the first JSON object from a model reply: strip ```json fences,
// then take the span from the first `{` to the last `}`. Free models wrap
// JSON in prose and fences, so a bare JSON.parse on the raw text fails.
// Returns the parsed object, or null when nothing parses.
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let body = text;
  // Free models usually wrap the JSON in a ```json fence — take its content.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1];
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
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
  // Matching is ALWAYS local cosine (audit v14 P2-F): even when the
  // gateway lists Pinecone, no index is configured and no query is ever
  // sent — so `via` must never claim 'sprites-gateway' for this feature.
  const discovered = hasConnector(gateway, 'pinecone');
  return recordExecution('pinecone', {
    ok: true, via: 'local-fallback',
    reason: discovered
      ? 'pinecone gateway discovered, but no index is configured — matching is local cosine over SQLite'
      : 'pinecone connector not installed; local cosine similarity over SQLite used',
    results: scored,
    note: 'Scores are local cosine until a Pinecone index is configured for this app.',
  });
}

// --- Apify: one grim news item, 4s timeout, local cache fallback --------
// The fallback headlines are CLEARLY FICTIONAL, in Chef Jean-Paul's voice
// (audit v14 P0-D): the old list had one real-sounding claim — "Global
// coffee prices just jumped 12%" — which the LLM was then told to treat
// as real news. No fallback headline may ever read like a real report.
// A live Apify Actor would replace these with real, sourced headlines.
export const FALLBACK_NEWS = [
  { title: 'The International Bureau of Refrigerator Existentialism reports that another spinach has refused to fulfil its destiny.', source: 'local-fallback (fictional headline — no live news)', url: null },
  { title: 'The Ministry of Leftover Affairs confirms that Tuesday has been cancelled for the third week running.', source: 'local-fallback (fictional headline — no live news)', url: null },
  { title: 'A committee of very serious cheeses has declared that nobody is coming to dinner, ever again.', source: 'local-fallback (fictional headline — no live news)', url: null },
  { title: 'The Society for the Preservation of Cold Rice announces that hope has been postponed until further notice.', source: 'local-fallback (fictional headline — no live news)', url: null },
  { title: 'Official bulletin: the fridge light has been on all night, watching. It has seen everything.', source: 'local-fallback (fictional headline — no live news)', url: null },
  { title: 'The Department of Expired Yoghurt regrets to inform you that time is, in fact, running out.', source: 'local-fallback (fictional headline — no live news)', url: null },
];

// The seeded fallback headline is cached, but news goes stale: a cached
// headline older than this is replaced by a fresh random one. (Before this,
// the cache never expired, so the first headline ever cached — "the world
// kept turning..." — was served forever, no matter how many seeds existed.)
export const NEWS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Pure helper, unit-tested: is a news_cache fetched_at (SQLite datetime
// 'now', UTC) older than the TTL? Missing or unparsable counts as stale.
export function isNewsStale(fetchedAt, nowMs = Date.now()) {
  if (!fetchedAt) return true;
  const t = new Date(String(fetchedAt).replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t >= NEWS_CACHE_TTL_MS;
}

export async function apifyFetchNews() {
  const gateway = await discoverGateway();
  // Honest note: the Sprites Apify gateway exposes Actors, not a generic
  // "news" endpoint (the old /v1/gateway/apify/news URL never existed), and
  // no Actor is configured for this app. So even when the Apify connector
  // is discovered live, the dread pairing still comes from the local
  // news_cache / seeded fallback — same honest behaviour as the live
  // Sprite build, whose news stage also reports local-baseline.
  void gateway;
  // Local fallback: most recent cached news while it is fresh; when it
  // goes stale (older than NEWS_CACHE_TTL_MS), pick a fresh random seed —
  // different from the cached one when possible — and cache that instead.
  // The old daily rotation never rotated in practice, because a cached row
  // was served forever and the seed path only ran on an empty cache.
  try {
    const cached = getLatestNews();
    if (cached?.title && !isNewsStale(cached.fetched_at)) {
      return recordExecution('apify', { ok: true, via: 'local-fallback', reason: 'no Apify Actor configured; serving cached fictional headline', news: { title: cached.title, source: cached.source || 'news_cache', url: cached.payload?.url || null } });
    }
    const pool = FALLBACK_NEWS.filter((n) => n.title !== cached?.title);
    const candidates = pool.length ? pool : FALLBACK_NEWS;
    const seed = candidates[Math.floor(Math.random() * candidates.length)];
    try { cacheNews({ title: seed.title, source: seed.source, payload: seed }); } catch {}
    return recordExecution('apify', { ok: true, via: 'local-fallback', reason: 'no Apify Actor configured; serving seeded fictional headline', news: seed });
  } catch {}
  const seed = FALLBACK_NEWS[Math.floor(Math.random() * FALLBACK_NEWS.length)];
  try { cacheNews({ title: seed.title, source: seed.source, payload: seed }); } catch {}
  return recordExecution('apify', { ok: true, via: 'local-fallback', reason: 'no Apify Actor configured; serving seeded fictional headline', news: seed });
}

// --- Box: archive the "Culinary Sin Receipt" --------------------------------
// Box's upload API takes multipart/form-data: an `attributes` JSON part
// ({ name, parent: { id: '0' } } — root folder) and a `file` part. A raw
// body is rejected with HTTP 415 (proven live 2026-11-27, right after the
// Box connector was linked). Built by hand: builtins only, no dependency.
export function buildBoxMultipart({ filename, content, contentType = 'text/html' } = {}) {
  const boundary = `----lefrigovide-${Math.random().toString(16).slice(2)}`;
  const attributes = JSON.stringify({ name: filename, parent: { id: '0' } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\nContent-Type: application/json\r\n\r\n${attributes}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from(String(content ?? '')),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, boundary, contentTypeHeader: `multipart/form-data; boundary=${boundary}` };
}

const BOX_TIMEOUT_MS = 15_000;

export async function boxUpload({ filename, content, contentType = 'text/html' } = {}) {
  const gateway = await discoverGateway();
  const baseUrl = gatewayBaseUrl(gateway, 'box');
  if (hasConnector(gateway, 'box') && baseUrl) {
    try {
      const { body, contentTypeHeader } = buildBoxMultipart({ filename, content, contentType });
      const res = await fetchWithTimeout(`${baseUrl}/upload/files/content`, {
        timeoutMs: BOX_TIMEOUT_MS,
        method: 'POST',
        headers: { 'content-type': contentTypeHeader },
        body,
      });
      if (!res.ok) throw new Error(`box via gateway HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      return recordExecution('box', { ok: true, via: 'sprites-gateway', filename, boxId: data?.id || data?.entries?.[0]?.id || null, note: 'Uploaded to Box via Sprites Gateway (POST /upload/files/content).' });
    } catch (err) {
      return recordExecution('box', { ok: false, via: 'local-fallback', reason: `box upload via gateway failed: ${err?.message || err}`, filename, note: 'Box upload failed; receipt is offered as a local download instead.' });
    }
  }
  return recordExecution('box', { ok: false, via: 'local-fallback', reason: 'box connector not installed on this Sprite', filename, note: 'Box not installed. Receipt is offered as a local download instead of an upload.' });
}
