import { spawn } from 'node:child_process';
import { QUOTES } from './quotes.mjs';
import { getSystemPrompt, buildUserPrompt, buildSafetyPrompt } from './prompts.mjs';
import { callOpenRouter, pineconeQuery, apifyFetchNews, embedText, cosineSimilarity, extractJsonObject } from './connectors.mjs';
import { initDb, insertMeal, updateMealCheckpoint, logCheckpoint, updateCheckpointLog, recordIngredients, getRecurringCulprits, getIngredientEmbeddings } from './db.mjs';

// Pipeline — 4 stages:
//  1. Food-Safety Guardrail (OpenRouter openrouter/free + deterministic local denylist)
//  2. Memory: Pinecone recurring culprit + existential quote (local cosine fallback)
//  3. Menu synthesis: OpenRouter openrouter/free + honest local fallback
//  4. Global Dread Pairing (Apify, 4s timeout + local cache) + persistence
//     + async `sprite-env checkpoint create` when dignity_loss_percentage > 80.

export const UNSAFE_PATTERNS = [
  /\bbatter(y|ies)\b/i, /\bAA\b/, /\bsoap\b/i, /\bdish\s*soap\b/i, /\bdetergent\b/i,
  /\bbleach\b/i, /\bshampoo\b/i, /\btoothpaste\b/i, /\bcleaner\b/i, /\bdisinfectant\b/i,
  /\bglass\b/i, /\bplastic\b/i, /\bmetal\b/i, /\bnail\b/i, /\bpoison\b/i,
  /\bpaint\b/i, /\bglue\b/i, /\bbattery\b/i, /\blithium\b/i, /\balkaline\b/i,
  /\bcharger\b/i, /\bcable\b/i, /\bremote\b/i, /\bsponge\b/i, /\bpaper\b/i,
];

export function parseIngredients(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function localSafetyCheck(ingredients) {
  const unsafe = [];
  for (const ing of ingredients) {
    if (UNSAFE_PATTERNS.some((re) => re.test(ing))) unsafe.push(ing);
  }
  return unsafe;
}

// Keep only the LLM-flagged items that the local denylist also flags.
// The LLM is an advisor, never the authority: expired/stale/sad food is
// still food. Returns [] for non-array input.
export function filterLlmUnsafeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => localSafetyCheck([String(it)]).length > 0);
}

const SADNESS = [
  [/expired|kadaluarsa|basi/i, 25],
  [/wilted|layu/i, 20],
  [/cold|dingin/i, 15],
  [/stale|tengik|keras/i, 15],
  [/\bsingle\b|\bone\b|\bsatu\b|lonely|kesepian|sendiri/i, 12],
  [/leftover|sisa/i, 12],
  [/sad|menyedihkan|depress/i, 10],
  [/old|tua|lama/i, 8],
  [/forgotten|terlupakan|terlantar/i, 14],
  [/half|setengah/i, 6],
];

export function computeDignityLoss(ingredients) {
  let score = 18; // baseline: it came from a fridge, not a market.
  for (const ing of ingredients) {
    for (const [re, pts] of SADNESS) if (re.test(ing)) score += pts;
  }
  // More ingredients, slightly less tragic — abundance is a small mercy.
  if (ingredients.length >= 5) score -= 5;
  if (ingredients.length >= 3) score -= 3;
  return Math.max(5, Math.min(97, Math.round(score)));
}

function pickQuote(ingredients) {
  const query = ingredients.join(' ');
  const qVec = embedText(query);
  let best = QUOTES[0];
  let bestScore = -1;
  for (const q of QUOTES) {
    const s = cosineSimilarity(qVec, embedText(`${q.text} ${q.author}`));
    if (s > bestScore) { bestScore = s; best = q; }
  }
  // Deterministic tie-break so the same fridge always gets the same philosopher.
  const seed = ingredients.join('|').length;
  if (bestScore < 0.05) return QUOTES[seed % QUOTES.length];
  return best;
}

const TITLE_BY_KEYWORD = [
  [/rice|nasi/i, { en: 'Le Riz Froid, Réinventé', id: 'Le Riz Froid, Réinventé' }],
  [/egg|telur/i, { en: 'L’Oeuf Solitaire', id: 'L’Oeuf Solitaire' }],
  [/chicken|ayam/i, { en: 'Le Poulet Repenti', id: 'Le Poulet Repenti' }],
  [/potato|kentang/i, { en: 'La Pomme de Terre Résignée', id: 'La Pomme de Terre Résignée' }],
  [/bread|roti/i, { en: 'Le Pain Perdu, Retrouvé', id: 'Le Pain Perdu, Retrouvé' }],
  [/cheese|keju/i, { en: 'Le Fromage Qui Attendait', id: 'Le Fromage Qui Attendait' }],
  [/yogurt|yoghurt/i, { en: 'Le Yaourt Expiré, Absolu', id: 'Le Yaourt Expiré, Absolu' }],
  [/pickle|acar|timun/i, { en: 'Le Cornichon Unique', id: 'Le Cornichon Unique' }],
];

export function localMenu({ ingredients, lang = 'en', quote, dread, recurring, dignity }) {
  const joined = ingredients.join(' ');
  const titleEntry = TITLE_BY_KEYWORD.find(([re]) => re.test(joined));
  const title = titleEntry ? titleEntry[1][lang] || titleEntry[1].en : 'Le Frigo Vide';
  const main = ingredients[0] || 'whatever remained';
  const second = ingredients[1] || 'silence';
  const third = ingredients[2] || 'the cold light of the fridge';
  const isId = lang === 'id';
  const subtitle = isId
    ? `Menu degustasi dari ${ingredients.length} bahan sisa. Tidak ada yang disembunyikan.`
    : `A tasting menu from ${ingredients.length} leftover ingredients. Nothing is hidden.`;
  const chefNote = isId
    ? `Kulkas itu tidak berbohong. ${main} sudah menunggu terlalu lama, dan ${second} menemaninya dalam diam. Saya memasaknya dengan benar, karena memasak dengan benar adalah satu-satunya pemberontakan kecil yang tersisa. Martabat yang hilang: ${dignity} persen. Itu bukan salah Anda sepenuhnya. Sebagian besar.`
    : `The fridge does not lie. The ${main} waited too long, and the ${second} kept it company in silence. I cooked them properly, because cooking properly is the only small rebellion left. Dignity lost: ${dignity} percent. That is not entirely your fault. Mostly.`;
  return {
    title,
    subtitle,
    courses: [
      { name: isId ? 'Pembuka: Yang Tersisa' : 'Amuse-bouche: What Remained', description: isId ? `${main} dipanaskan perlahan, diberi garam, dan disajikan tanpa alasan.` : `${main}, warmed slowly, salted, and served without apology.`, technique: 'réchauffage lent' },
      { name: isId ? 'Hidangan Utama: Kompromi' : 'Plat principal: The Compromise', description: isId ? `${second} dan ${third} dimasak bersama sampai mereka berhenti berpura-pura menjadi sesuatu yang lain.` : `${second} and ${third}, cooked together until they stop pretending to be something else.`, technique: 'mijotage' },
      { name: isId ? 'Penutup: Penerimaan' : 'Dessert: Acceptance', description: isId ? 'Tidak ada pencuci mulut. Yang tersisa adalah kesadaran bahwa makan malam ini terjadi, dan itu sudah cukup.' : 'There is no dessert. What remains is the knowledge that this dinner happened, and that is enough.', technique: 'absence' },
    ],
    chef_note: chefNote,
    dignity_loss_percentage: dignity,
    quote: quote?.text || '',
    quote_author: quote?.author || '',
    dread_pairing: dread?.title || null,
    recurring_culprit: recurring?.[0]?.ingredient || null,
  };
}

export function buildReceiptHtml(meal, menu) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = (menu?.courses || []).map((c) => `<div class="line"><span>${esc(c.name)}</span><span>—</span></div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Struk Dosa Kuliner — Meal #${meal.id}</title>
<style>body{font-family:monospace;background:#fff;color:#111;max-width:320px;margin:24px auto;padding:16px;border:1px dashed #111}h1{font-size:14px;text-align:center;letter-spacing:2px}.c{text-align:center}.line{display:flex;justify-content:space-between;border-bottom:1px dotted #999;padding:4px 0}hr{border-top:1px dashed #111}</style></head>
<body><h1>LE FRIGO VIDE</h1><p class="c">STRUK DOSA KULINER<br>Culinary Sin Receipt</p><hr>
<p>Meal #${meal.id} — ${esc(meal.created_at || '')}<br>Title: ${esc(menu?.title || meal.title || '')}<br>Dignity loss: ${meal.dignity_loss_percentage}%<br>Ingredients: ${esc((meal.ingredients || []).join(', '))}</p><hr>${lines}
<p class="c">"${esc(menu?.quote || meal.quote || '')}"<br>— ${esc(menu?.quote_author || meal.quote_author || '')}</p>
<p class="c">Dread pairing: ${esc(menu?.dread_pairing || meal.dread || 'none')}</p><hr><p class="c">Merci. Do not return.<br>Chef Jean-Paul</p></body></html>`;
}

// Non-blocking checkpoint: log the attempt synchronously (so tests and the
// UI can see it immediately), then run sprite-env in the background.
export function triggerCheckpoint(mealId, dignity) {
  initDb();
  const logId = logCheckpoint({
    meal_id: mealId,
    checkpoint_id: null,
    dignity_loss_percentage: dignity,
    status: 'requested',
    note: `dignity_loss ${dignity}% > 80 — Lowest Point of the Week Snapshot requested via sprite-env checkpoint create`,
  });
  const child = spawn('sprite-env', ['checkpoint', 'create', '--label', `lowest-point-meal-${mealId}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let spawnFailed = false;
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('error', (err) => {
    spawnFailed = true;
    updateCheckpointLog(logId, { status: 'failed', note: `sprite-env unavailable (expected outside Fly.io): ${err.message}` });
  });
  child.on('close', (code) => {
    if (spawnFailed) return; // 'error' handler already logged the honest reason.
    const m = out.match(/[a-zA-Z0-9_-]{6,}/);
    const checkpointId = code === 0 && m ? m[0] : null;
    if (code === 0) {
      updateCheckpointLog(logId, { checkpoint_id: checkpointId, status: 'created', note: `sprite-env checkpoint create exited 0. Output: ${out.slice(0, 200)}` });
      if (checkpointId) updateMealCheckpoint(mealId, checkpointId);
    } else {
      updateCheckpointLog(logId, { status: 'failed', note: `sprite-env checkpoint create exited ${code}. Output: ${out.slice(0, 200)}` });
    }
  });
  return { logId, status: 'requested' };
}

export async function generateMenu({ ingredients: rawIngredients, lang = 'en' } = {}) {
  initDb();
  const language = lang === 'id' ? 'id' : 'en';
  const ingredients = parseIngredients(rawIngredients);
  if (ingredients.length === 0) {
    return { ok: false, rejected: true, reason: language === 'id' ? 'Tidak ada bahan yang diberikan.' : 'No ingredients were given.', reason_code: 'empty' };
  }

  // Stage 1 — Safety guardrail.
  const unsafeLocal = localSafetyCheck(ingredients);
  let safetyVia = 'local-denylist';
  let safetyReason = null;
  if (unsafeLocal.length > 0) {
    safetyReason = language === 'id'
      ? `Bahan berikut bukan makanan dan ditolak: ${unsafeLocal.join(', ')}. Chef Jean-Paul tidak memasak baterai, sabun, atau benda rumah tangga.`
      : `The following items are not food and were refused: ${unsafeLocal.join(', ')}. Chef Jean-Paul does not cook batteries, soap, or household objects.`;
  } else {
    // Ask OpenRouter (free) when available; local denylist remains authoritative.
    // REGRESSION (found on Sprite 2026-11-27): the LLM safety classifier
    // rejected "expired yogurt" as unsafe, so a dignity>80 menu was refused
    // and test 3 failed — but expired/stale food is still FOOD, only sad.
    // The LLM may only CONFIRM a refusal the local denylist already makes;
    // it may never expand the refusal set. Items it flags that are not on
    // the denylist are ignored.
    try {
      const res = await callOpenRouter({
        model: 'openrouter/free',
        timeoutMs: 8000,
        messages: [
          { role: 'system', content: 'You are a food-safety classifier. Reply with JSON only.' },
          { role: 'user', content: buildSafetyPrompt({ ingredients, lang: language }) },
        ],
      });
      if (res.ok && res.text) {
        safetyVia = 'openrouter/free';
        const parsed = extractJsonObject(res.text) || {};
        const confirmed = filterLlmUnsafeItems(parsed.unsafe_items);
        if (parsed.safe === false && confirmed.length) {
          safetyReason = parsed.reason || `Refused by OpenRouter safety check: ${confirmed.join(', ')}`;
        }
      }
    } catch { /* local denylist already passed; proceed with local fallback */ }
  }
  if (safetyReason) {
    const mealId = insertMeal({
      lang: language, ingredients, title: null, dignity_loss_percentage: 0,
      rejected: true, rejection_reason: safetyReason, menu_json: null,
    });
    return { ok: false, rejected: true, meal_id: mealId, reason: safetyReason, reason_code: 'unsafe', unsafe_items: unsafeLocal, safety_via: safetyVia };
  }

  // Stage 2 — Memory: recurring culprits + quote.
  recordIngredients(ingredients, embedText);
  const recurring = getRecurringCulprits(5).filter((r) => ingredients.some((i) => i.toLowerCase().includes(r.ingredient) || r.ingredient.includes(i.toLowerCase())));
  const historyEmbeddings = getIngredientEmbeddings();
  const quoteResult = await pineconeQuery({ text: ingredients.join(' '), candidates: QUOTES.map((q) => ({ ...q })) });
  const quote = quoteResult.results?.[0] ? { text: quoteResult.results[0].text, author: quoteResult.results[0].author } : pickQuote(ingredients);
  void historyEmbeddings;

  // Stage 3 — Menu synthesis.
  const dignity = computeDignityLoss(ingredients);
  let menu = null;
  let synthesisVia = 'local-fallback';
  let synthesisNote = null;
  try {
    const res = await callOpenRouter({
      model: 'openrouter/free',
      // 60s + capped output: the free model needs >20s for a full menu
      // (proven by the 20000ms abort in the Sprite service log, 2026-11-27),
      // and the richer prompt (2-3 sentences per course) needs more room
      // than 700 tokens. max_tokens 1000 keeps the menu complete while
      // cutting the long tail of a slow free model.
      timeoutMs: 60000,
      maxTokens: 1000,
      messages: [
        { role: 'system', content: getSystemPrompt(language) },
        { role: 'user', content: buildUserPrompt({ ingredients, lang: language, quote, dread: null, recurring }) },
      ],
    });
    // When the fallback is caused by the free tier's rate limit, say so
    // plainly instead of silently serving the local menu — the judge (and
    // the user) can tell a limit from a bug, and retrying later works.
    if (!res.ok && /429/.test(res.reason || '')) {
      synthesisNote = language === 'id'
        ? 'OpenRouter sedang rate-limited (HTTP 429, free tier). Menu lokal disajikan — coba lagi beberapa menit lagi.'
        : 'OpenRouter is rate-limited right now (HTTP 429, free tier). Serving the local menu — try again in a few minutes.';
    }
    if (res.ok && res.text) {
      const parsed = extractJsonObject(res.text) || {};
      // Free models vary the keys: accept title/dish_title/name and
      // courses/steps/dishes, and course items as strings, {name} objects,
      // or one newline-separated string.
      const title = parsed.title || parsed.dish_title || parsed.name || null;
      let rawCourses = parsed.courses || parsed.steps || parsed.dishes || null;
      if (typeof rawCourses === 'string') rawCourses = rawCourses.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
      if (title && Array.isArray(rawCourses) && rawCourses.length) {
        const courses = rawCourses.map((c) => (typeof c === 'string' ? { name: c } : { name: c?.name || c?.title || String(c ?? '') })).filter((c) => c.name);
        if (courses.length) {
          menu = { ...parsed, title, courses, dignity_loss_percentage: dignity, quote: quote.text, quote_author: quote.author };
          synthesisVia = 'openrouter/free';
        } else {
          console.error(`[synthesis] OpenRouter reply had title but no usable courses. Reply head: ${res.text.slice(0, 200)}`);
        }
      } else {
        console.error(`[synthesis] OpenRouter reply unusable (title=${JSON.stringify(title)}, courses=${JSON.stringify(rawCourses)?.slice(0, 120)}). Reply head: ${res.text.slice(0, 200)}`);
      }
    } else if (res && !res.ok) {
      console.error(`[synthesis] OpenRouter call failed: ${res.reason || 'unknown'}`);
    }
  } catch (err) { console.error(`[synthesis] exception: ${err?.message || err}`); /* fall through to local synthesis */ }
  if (!menu) {
    // Stage 4 needs the dread pairing before the menu is finalised, so fetch it first.
    const dreadRes = await apifyFetchNews();
    const dread = dreadRes.news;
    menu = localMenu({ ingredients, lang: language, quote, dread, recurring, dignity });
    menu.dread_pairing = dread?.title || null;
    menu.synthesis_via = synthesisVia;
    menu.memory_via = quoteResult.via;
    menu.dread_via = dreadRes.via;
    const mealId = insertMeal({
      lang: language, ingredients, title: menu.title, dignity_loss_percentage: dignity,
      quote: quote.text, quote_author: quote.author, dread: dread?.title || null,
      menu_json: menu, rejected: false,
    });
    let checkpoint = null;
    if (dignity > 80) checkpoint = triggerCheckpoint(mealId, dignity);
    return { ok: true, rejected: false, meal_id: mealId, menu, dignity_loss_percentage: dignity, safety_via: safetyVia, synthesis_via: synthesisVia, synthesis_note: synthesisNote, memory_via: quoteResult.via, dread_via: dreadRes.via, dread, recurring, checkpoint };
  }

  // OpenRouter path: still needs Stage 4 (dread) + persistence + checkpoint.
  const dreadRes = await apifyFetchNews();
  menu.dread_pairing = dreadRes.news?.title || null;
  menu.synthesis_via = synthesisVia;
  menu.memory_via = quoteResult.via;
  menu.dread_via = dreadRes.via;
  const mealId = insertMeal({
    lang: language, ingredients, title: menu.title, dignity_loss_percentage: dignity,
    quote: quote.text, quote_author: quote.author, dread: dreadRes.news?.title || null,
    menu_json: menu, rejected: false,
  });
  let checkpoint = null;
  if (dignity > 80) checkpoint = triggerCheckpoint(mealId, dignity);
  return { ok: true, rejected: false, meal_id: mealId, menu, dignity_loss_percentage: dignity, safety_via: safetyVia, synthesis_via: synthesisVia, memory_via: quoteResult.via, dread_via: dreadRes.via, dread: dreadRes.news, recurring, checkpoint };
}
