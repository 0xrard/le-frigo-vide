import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { initDb, getMeal, listMeals, listCheckpoints, getLatestNews, getRecurringCulprits, markMealArchived } from './db.mjs';
import { getConnectedStatus, boxUpload } from './connectors.mjs';
import { generateMenu, buildReceiptHtml } from './pipeline.mjs';

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
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'le-frigo-vide', status: 'alive', uptime_seconds: Math.round(process.uptime()), time: new Date().toISOString() });
      }

      if (req.method === 'GET' && path === '/connected') {
        const status = await getConnectedStatus();
        if (url.searchParams.get('format') === 'json') return sendJson(res, 200, status);
        return sendText(res, 200, connectedHtml(status));
      }

      if (req.method === 'GET' && path === '/api/state') {
        const status = await getConnectedStatus();
        return sendJson(res, 200, {
          connected: status,
          meals: listMeals(10),
          checkpoints: listCheckpoints(10),
          recurring_culprits: getRecurringCulprits(5),
          latest_news: getLatestNews(),
        });
      }

      if (req.method === 'POST' && path === '/api/generate') {
        const body = await readBody(req).catch((e) => { sendJson(res, 400, { ok: false, error: e.message }); return null; });
        if (body === null) return;
        const result = await generateMenu({ ingredients: body.ingredients, lang: body.lang || 'en' });
        return sendJson(res, 200, result);
      }

      const archiveMatch = path.match(/^\/api\/meals\/(\d+)\/archive-box$/);
      if (req.method === 'POST' && archiveMatch) {
        const meal = getMeal(Number(archiveMatch[1]));
        if (!meal) return sendJson(res, 404, { ok: false, error: 'meal not found' });
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
        if (!meal) return sendJson(res, 404, { ok: false, error: 'meal not found' });
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
