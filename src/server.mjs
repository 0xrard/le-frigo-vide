import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { initDb, getMeal, listMeals, listCheckpoints, getLatestNews, getRecurringCulprits, markMealArchived, seedChronicleDemo, setIngredientStatus } from './db.mjs';
import { getConnectedStatus, boxUpload } from './connectors.mjs';
import { generateMenu, buildReceiptHtml, logFridgeCheck } from './pipeline.mjs';
import { buildChronicle } from './chronicle.mjs';

// Session isolation: every browser gets its own fridge. The client sends
// a stable id in localStorage via the X-Frigo-Session header; ?session=
// (used only for the read-only 'demo' sample) overrides the header;
// CLI/tests with neither get the shared 'default' session.
export function resolveSession(req, url) {
  const q = url?.searchParams?.get('session');
  if (q && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(q)) return q;
  const h = String(req?.headers?.['x-frigo-session'] || '').trim();
  if (h && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(h)) return h;
  return 'default';
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
export const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('invalid JSON body'); }
}

function connectedHtml(status) {
  const row = (c) => `<tr><td>${c.name}</td><td>${c.connected ? 'CONNECTED' : 'NOT INSTALLED'}</td><td>${c.via}</td><td>${c.note}</td></tr>`;
  const rows = Object.values(status.connectors).map(row).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connected — Le Frigo Vide</title>
<style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px;text-align:left;font-size:14px}</style></head>
<body><h1>Le Frigo Vide — Connected</h1>
<p><strong>rawApiKeysInEnv: ${status.rawApiKeysInEnv}</strong> — ${status.rawApiKeysInEnv === 0 ? 'zero-key posture holds. No API key lives in the environment.' : 'key-like variables detected in the environment (listed in JSON view).'}</p>
<p>Gateway: ${status.gateway.available ? `available (${status.gateway.source})` : `unavailable — ${status.gateway.error || 'gateway list not reachable'}`}. Docs: ${status.gateway.docs}. Connectors seen: ${status.gateway.connectors.join(', ') || '(none)'}</p>
<table><tr><th>Connector</th><th>Status</th><th>Via</th><th>Note</th></tr>${rows}</table>
<p><a href="/connected?format=json">JSON view</a> · <a href="/">Back to the bistro</a></p></body></html>`;
}

export function createServer() {
  initDb();
  seedChronicleDemo();
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'le-frigo-vide', status: 'alive', uptime_seconds: Math.round(process.uptime()), time: new Date().toISOString() });
      }

      // The shared ingredient classifier: one module, imported by the
      // backend (src/pipeline.mjs) and by the browser frontend
      // (public/app.js imports it as '../shared/ingredient-classifier.mjs',
      // which resolves to this path). Only this exact file is served —
      // the route does not expose the shared directory.
      if (req.method === 'GET' && path === '/shared/ingredient-classifier.mjs') {
        const filePath = join(__dirname, '..', 'shared', 'ingredient-classifier.mjs');
        const data = await readFile(filePath);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': data.length });
        return res.end(data);
      }

      if (req.method === 'GET' && path === '/connected') {
        const status = await getConnectedStatus();
        if (url.searchParams.get('format') === 'json') return sendJson(res, 200, status);
        return sendText(res, 200, connectedHtml(status));
      }

      if (req.method === 'GET' && path === '/api/state') {
        const status = await getConnectedStatus();
        const session = resolveSession(req, url);
        return sendJson(res, 200, {
          connected: status,
          meals: listMeals(10, session),
          checkpoints: listCheckpoints(10, session),
          recurring_culprits: getRecurringCulprits(5, session),
          latest_news: getLatestNews(),
        });
      }

      if (req.method === 'GET' && path === '/api/chronicle') {
        // English-only MVP (v18.1): the `lang` query parameter is ignored.
        return sendJson(res, 200, buildChronicle('en', resolveSession(req, url)));
      }

      // The demo session is READ-ONLY at the server level, not just in
      // the UI: no mutation may target it, however the request is made
      // (audit v13 P0-B — ?session=demo + a crafted POST must not inject
      // ingredients or fates into the sample bulletin).
      // (sendJson returns undefined, so the guard must return a real
      // boolean — returning its result would let the handler fall
      // through and mutate the demo anyway.)
      const demoGuard = () => {
        if (resolveSession(req, url) !== 'demo') return false;
        sendJson(res, 403, { ok: false, error: 'demo session is read-only' });
        return true;
      };

      // Log Fridge Check — a NEW observation. This is the ONLY endpoint
      // that records ingredients; Ask Chef Jean-Paul (generate) never does.
      if (req.method === 'POST' && path === '/api/fridge-check') {
        if (demoGuard()) return;
        const body = await readBody(req).catch((e) => { sendJson(res, 400, { ok: false, error: e.message }); return null; });
        if (body === null) return;
        const result = logFridgeCheck({ ingredients: body.ingredients, sessionId: resolveSession(req, url), lang: body.lang || 'en' });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      const statusMatch = path.match(/^\/api\/ingredients\/([^/]+)\/status$/);
      if (req.method === 'POST' && statusMatch) {
        if (demoGuard()) return;
        const name = decodeURIComponent(statusMatch[1] || '');
        const body = await readBody(req).catch((e) => { sendJson(res, 400, { ok: false, error: e.message }); return null; });
        if (body === null) return;
        try {
          const eventId = setIngredientStatus(name, body.status, resolveSession(req, url));
          if (!eventId) return sendJson(res, 404, { ok: false, error: 'ingredient not found' });
          return sendJson(res, 200, { ok: true, ingredient: name.toLowerCase(), status: body.status, event_id: eventId });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      if (req.method === 'POST' && path === '/api/generate') {
        if (demoGuard()) return;
        const body = await readBody(req).catch((e) => { sendJson(res, 400, { ok: false, error: e.message }); return null; });
        if (body === null) return;
        const result = await generateMenu({ ingredients: body.ingredients, lang: body.lang || 'en', sessionId: resolveSession(req, url) });
        return sendJson(res, 200, result);
      }

      const archiveMatch = path.match(/^\/api\/meals\/(\d+)\/archive-box$/);
      if (req.method === 'POST' && archiveMatch) {
        // Archiving mutates (and can upload to Box), so the read-only
        // demo rule applies here too (audit v14 P1-C) — no demo meal
        // exists today, but the rule must be consistent.
        if (demoGuard()) return;
        const meal = getMeal(Number(archiveMatch[1]));
        // A meal belongs to one session; another session gets a 404
        // (never a hint that the meal exists).
        if (!meal || meal.session_id !== resolveSession(req, url)) return sendJson(res, 404, { ok: false, error: 'meal not found' });
        const menu = meal.menu_json || {};
        const receipt = buildReceiptHtml(meal, menu);
        const filename = `culinary-sin-receipt-meal-${meal.id}.html`;
        const uploaded = await boxUpload({ filename, content: receipt, contentType: 'text/html' });
        if (uploaded.ok) markMealArchived(meal.id);
        // Local fallback: hand the receipt back so the browser can download it.
        return sendJson(res, 200, {
          ok: uploaded.ok, meal_id: meal.id, filename,
          via: uploaded.via, box_id: uploaded.boxId || null,
          reason: uploaded.reason || null, note: uploaded.note,
          receipt_html: uploaded.ok ? null : receipt,
          download_filename: filename,
        });
      }

      const receiptMatch = path.match(/^\/api\/meals\/(\d+)\/receipt$/);
      if (req.method === 'GET' && receiptMatch) {
        const meal = getMeal(Number(receiptMatch[1]));
        if (!meal || meal.session_id !== resolveSession(req, url)) return sendJson(res, 404, { ok: false, error: 'meal not found' });
        return sendText(res, 200, buildReceiptHtml(meal, meal.menu_json || {}));
      }

      // Static files from public/
      if (req.method === 'GET') {
        const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        const filePath = normalize(join(PUBLIC_DIR, rel));
        if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
          return sendText(res, 404, '<h1>404 — Not on the menu.</h1><p><a href="/">Back to Le Frigo Vide</a></p>', 'text/html; charset=utf-8');
        }
        const data = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'content-length': data.length });
        return res.end(data);
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Le Frigo Vide listening on http://localhost:${PORT} — Chef Jean-Paul is in.`);
    console.log(`Health: http://localhost:${PORT}/healthz — Connected: http://localhost:${PORT}/connected`);
  });
}
