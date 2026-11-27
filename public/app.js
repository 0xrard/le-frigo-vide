// Le Frigo Vide — frontend. IDs must match index.html exactly.
// State: currentMealId, chronicleView ('mine' | 'demo'). English-only UI (v18.1).
// Session isolation: one stable id per browser (localStorage), sent as
// X-Frigo-Session so every judge gets their own fridge. The demo bulletin
// is a separate, read-only 'demo' session — never mixed with real data.
// Ingredient condition is decided in exactly ONE place —
// shared/ingredient-classifier.mjs, the same module the Node backend
// imports. The picker below asks the classifier; it never keeps its
// own copy of the rules. The browser is not the safety authority: the
// choice is written back into the textarea as text ("raw chicken"),
// and the server re-derives the condition from that text itself.
import { classifyIngredient, applyConditionOverride, separateProteins } from '../shared/ingredient-classifier.mjs';

let currentMealId = null;
let chronicleView = 'mine';

const $ = (id) => document.getElementById(id);

function getSessionId() {
  try {
    let id = localStorage.getItem('frigo-session');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      localStorage.setItem('frigo-session', id);
    }
    return id;
  } catch { return `s-${Date.now()}`; }
}
const sessionId = getSessionId();
const sessionHeaders = () => ({ 'X-Frigo-Session': sessionId });

const I18N = {
  en: {
    tagline: 'A personal culinary agent. The fridge is empty. The chef is not impressed.',
    menuKicker: 'Bistro · Paris · Depuis le frigo',
    menuSubtitle: 'Tell the chef what is left. He will do the rest, reluctantly.',
    ingredientsLabel: 'What is in the fridge?',
    conditionTitle: 'Before the chef cooks — raw or already cooked?',
    conditionRaw: 'Raw',
    conditionCooked: 'Already cooked',
    conditionNote: 'Unanswered items are treated as raw, to be safe.',
    // The Raw / Already Cooked buttons only answer one question (the
    // condition). A protein nobody identified and a combination of
    // proteins need a different action, so they get a note instead of
    // buttons — the buttons cannot answer them.
    conditionIdentify: 'Identify the protein and the cut — type it, e.g. "raw chicken".',
    conditionSeparate: 'Separate into one entry per protein, e.g. ',
    generate: 'Ask Chef Jean-Paul',
    generating: 'The chef is thinking. Slowly.',
    recurringLabel: 'Recurring culprit:',
    receiptTitle: 'Culinary Sin Receipt',
    dignityLabel: 'Dignity loss',
    archive: 'Archive receipt to Box',
    xrayTitle: 'Gateway X-Ray',
    rawKeysLabel: 'Raw API keys in env:',
    gatewayLabel: 'Sprites Gateway:',
    historyTitle: 'Recent meals',
    rejectionTitle: 'Refused.',
    printReceipt: 'Print receipt',
    auraHeading: 'Fridge Aura Analysis',
    worldHeading: 'Outside World Context',
    prepHeading: 'Preparation (With Quiet Resignation)',
    sommelierHeading: 'Sommelier Pairing',
    dreadScoreLabel: 'Existential Crisis Score',
    safetyLabel: 'Food Safety Status',
    tonightLabel: "Tonight's Menu",
    archiveHint: 'Box upload runs only when the Box connector is installed; otherwise the receipt downloads locally.',
    noMeals: 'No meals yet.',
    checkpoint: (id) => `Dignity loss above 80%. A checkpoint was requested: Lowest Point of the Week Snapshot (log #${id}).`,
    chronicleTitle: 'The Living Fridge Chronicle',
    colSurvivors: 'The Survivors',
    colRescued: 'The Rescued',
    colDeparted: 'The Departed',
    colGhosts: 'The Ghosts',
    cookedBtn: '✓ Cooked',
    discardedBtn: '✕ Thrown Out',
    sessions: (n) => `${n} session${n === 1 ? '' : 's'}`,
    days: (n) => `${n} day${n === 1 ? '' : 's'}`,
    fateRescued: (d) => `rescued ${d}`,
    fateDiscarded: (d) => `departed ${d}`,
    ghostNote: '0 cooking events — unresolved',
    dossierNone: '—',
    emptyBulletin: 'The fridge is empty — no dossiers yet. Log a fridge check with what is inside, then decide each ingredient’s fate.',
    dateline: (d) => `Paris — ${d}`,
    fridgeCheck: 'Log Fridge Check',
    fridgeCheckLogged: (n, obs) => `Fridge check logged: ${n} ingredient${n === 1 ? '' : 's'} (observation ${obs.slice(0, 8)}…).`,
    myFridge: 'My Fridge',
    sampleDemo: 'Sample Chronicle (Demo)',
    demoNote: 'Sample data — log your own fridge check to decide fates. Nothing here is yours.',
  },
};

function t() { return I18N.en; }

function applyLang() {
  const s = t();
  document.documentElement.lang = 'en';
  $('tagline').textContent = s.tagline;
  $('menu-kicker').textContent = s.menuKicker;
  $('menu-subtitle').textContent = s.menuSubtitle;
  $('ingredients-label').textContent = s.ingredientsLabel;
  $('generate-btn').textContent = s.generate;
  $('recurring-label').textContent = s.recurringLabel;
  $('receipt-title').textContent = s.receiptTitle;
  $('dignity-label').textContent = s.dignityLabel;
  $('archive-btn').textContent = s.archive;
  $('xray-title').textContent = s.xrayTitle;
  $('raw-keys-label').textContent = s.rawKeysLabel;
  $('gateway-label').textContent = s.gatewayLabel;
  $('history-title').textContent = s.historyTitle;
  $('rejection-title').textContent = s.rejectionTitle;
  $('print-receipt-btn').textContent = s.printReceipt;
  $('section-aura-heading').textContent = s.auraHeading;
  $('section-world-heading').textContent = s.worldHeading;
  $('section-prep-heading').textContent = s.prepHeading;
  $('section-sommelier-heading').textContent = s.sommelierHeading;
  $('menu-tonight-label').textContent = s.tonightLabel;
  $('archive-hint').textContent = s.archiveHint;
  $('fridge-check-btn').textContent = s.fridgeCheck;
  $('view-mine-btn').textContent = s.myFridge;
  $('view-demo-btn').textContent = s.sampleDemo;
  $('chronicle-title').textContent = s.chronicleTitle;
  $('col-survivors-heading').textContent = s.colSurvivors;
  $('col-rescued-heading').textContent = s.colRescued;
  $('col-departed-heading').textContent = s.colDeparted;
  $('col-ghosts-heading').textContent = s.colGhosts;
}

async function refreshConnected() {
  try {
    const res = await fetch('/connected?format=json');
    const data = await res.json();
    $('raw-keys').textContent = String(data.rawApiKeysInEnv);
    $('gateway-status').textContent = data.gateway.available
      ? `available (${data.gateway.connectors.join(', ') || 'no connectors listed'})`
      : `unavailable — ${data.gateway.error || 'gateway list not reachable'}`;
    const list = $('connector-list');
    list.innerHTML = '';
    for (const c of Object.values(data.connectors)) {
      const li = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = c.connected ? 'ok' : 'off';
      badge.textContent = c.connected ? 'CONNECTED' : 'NOT INSTALLED';
      li.append(document.createTextNode(`${c.name} — `), badge);
      const small = document.createElement('small');
      // `via` is the configured MODE, not a success claim: the last
      // execution (when one happened) says what actually ran.
      let text = `${c.via} · ${c.note}`;
      if (c.last_execution) {
        const last = c.last_execution;
        const when = last.at ? new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const reason = last.reason ? ` — ${String(last.reason).slice(0, 80)}` : '';
        text += ` · Last${when ? ` ${when}` : ''}: ${last.ok ? 'ok' : 'failed'} via ${last.via || '—'}${reason}`;
      }
      small.textContent = text;
      li.append(small);
      list.append(li);
    }
  } catch (err) {
    $('gateway-status').textContent = `error: ${err.message}`;
  }
}

async function refreshState() {
  try {
    const res = await fetch('/api/state', { headers: sessionHeaders() });
    const data = await res.json();
    const list = $('history-list');
    list.innerHTML = '';
    if (!data.meals || data.meals.length === 0) {
      const li = document.createElement('li');
      li.textContent = t().noMeals;
      list.append(li);
    } else {
      for (const m of data.meals) {
        const li = document.createElement('li');
        li.textContent = m.rejected
          ? `#${m.id} — refused (${m.dignity_loss_percentage}%)`
          : `#${m.id} — ${m.title || 'Untitled'} (${m.dignity_loss_percentage}%)`;
        list.append(li);
      }
    }
  } catch { /* state is best-effort */ }
}

function fmtDate(iso, opts) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', opts);
  } catch { return iso || ''; }
}

function dossierItem(d, withActions) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'dossier-name';
  name.textContent = d.ingredient;
  const meta = document.createElement('span');
  meta.className = 'dossier-meta';
  meta.textContent = `${t().sessions(d.appearances)} · ${t().days(d.days)}`;
  li.append(name, meta);
  if (d.status === 'rescued' && d.status_at) {
    const fate = document.createElement('span');
    fate.className = 'dossier-meta';
    fate.textContent = t().fateRescued(fmtDate(d.status_at, { day: 'numeric', month: 'short' }));
    li.append(fate);
  }
  if (d.status === 'discarded' && d.status_at) {
    const fate = document.createElement('span');
    fate.className = 'dossier-meta';
    fate.textContent = t().fateDiscarded(fmtDate(d.status_at, { day: 'numeric', month: 'short' }));
    li.append(fate);
  }
  if (withActions) {
    const actions = document.createElement('div');
    actions.className = 'dossier-actions';
    for (const [status, label] of [['rescued', t().cookedBtn], ['discarded', t().discardedBtn]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dossier-btn';
      btn.textContent = label;
      btn.dataset.ingredient = d.ingredient;
      btn.dataset.status = status;
      btn.addEventListener('click', () => markFate(d.ingredient, status, actions));
      actions.append(btn);
    }
    li.append(actions);
  }
  return li;
}

function fillDossierList(id, items, withActions) {
  const list = $(id);
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'dossier-none';
    li.textContent = t().dossierNone;
    list.append(li);
    return;
  }
  for (const d of items) list.append(dossierItem(d, withActions));
}

async function markFate(ingredient, status, actions) {
  for (const b of actions.querySelectorAll('button')) b.disabled = true;
  try {
    const res = await fetch(`/api/ingredients/${encodeURIComponent(ingredient)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refreshChronicle();
  } catch (err) {
    $('status-line').textContent = `Error: ${err.message}`;
    for (const b of actions.querySelectorAll('button')) b.disabled = false;
  }
}

async function refreshChronicle() {
  try {
    // 'mine' = this browser's session (header); 'demo' = the read-only
    // sample session, fetched explicitly and labelled DEMO DATA.
    const url = chronicleView === 'demo'
      ? `/api/chronicle?session=demo`
      : `/api/chronicle`;
    const res = await fetch(url, { headers: sessionHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    const isDemo = chronicleView === 'demo';
    $('demo-badge').hidden = !isDemo;
    $('chronicle-demo-note').hidden = !isDemo;
    if (isDemo) $('chronicle-demo-note').textContent = t().demoNote;
    $('view-mine-btn').classList.toggle('view-btn-active', !isDemo);
    $('view-demo-btn').classList.toggle('view-btn-active', isDemo);
    $('chronicle-dateline').textContent = t().dateline(fmtDate(data.generated_at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    const inv = $('investigation');
    if (data.investigation) {
      $('inv-title').textContent = data.investigation.title;
      $('inv-suspect').textContent = data.investigation.suspect;
      $('inv-victim').textContent = data.investigation.victim;
      $('inv-evidence').textContent = data.investigation.evidence;
      $('inv-verdict-label').textContent = data.investigation.verdictLabel;
      $('inv-verdict').textContent = data.investigation.verdict;
      inv.hidden = false;
    } else {
      inv.hidden = true;
    }
    const empty = data.totals.tracked === 0;
    $('chronicle-columns').hidden = empty;
    $('chronicle-empty').hidden = !empty;
    if (empty) {
      $('chronicle-empty').textContent = t().emptyBulletin;
      return;
    }
    // Demo view is read-only: no fate buttons on sample data.
    fillDossierList('survivors-list', data.survivors, !isDemo);
    fillDossierList('rescued-list', data.rescued, false);
    fillDossierList('departed-list', data.departed, false);
    const ghostList = $('ghosts-list');
    ghostList.innerHTML = '';
    if (!data.ghosts.length) {
      const li = document.createElement('li');
      li.className = 'dossier-none';
      li.textContent = t().dossierNone;
      ghostList.append(li);
    } else {
      for (const d of data.ghosts) {
        const li = dossierItem(d, false);
        const note = document.createElement('span');
        note.className = 'dossier-meta';
        note.textContent = t().ghostNote;
        li.append(note);
        ghostList.append(li);
      }
    }
  } catch { /* chronicle is best-effort */ }
}

function renderMenu(result) {
  const menu = result.menu;
  const s = t();
  // "MENU MALAM INI: "Title"" — the label appears above the quoted title.
  $('menu-tonight-label').hidden = false;
  $('menu-title').textContent = menu.title ? `"${menu.title}"` : 'Le Frigo Vide';
  $('menu-subtitle').textContent = menu.subtitle || '';
  // Header & status: Existential Crisis Score | Food Safety Status.
  // Dignity loss lives in the receipt panel (and the receipt), not here.
  const dreadScore = Number.isInteger(menu.existential_dread) ? menu.existential_dread : '—';
  // Spoilage / raw-risk warning: shown prominently, never buried in prose.
  const warn = $('safety-warning');
  if (menu.safety_warning) {
    warn.textContent = menu.safety_warning;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  $('score-line').textContent =
    `${s.dreadScoreLabel}: ${dreadScore}/100 | ${s.safetyLabel}: ${menu.food_safety || 'FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)'}`;
  $('aura-text').textContent = menu.aura_analysis || '';
  $('world-text').textContent = menu.world_context || '';
  // Preparation steps; a menu stored before this format carries courses
  // instead — map those to steps so old meals still render.
  let steps = Array.isArray(menu.preparation) ? menu.preparation : [];
  if (!steps.length && Array.isArray(menu.courses)) {
    steps = menu.courses.map((c) => (typeof c === 'string' ? c : `${c.name || ''} — ${c.description || ''}`.trim()));
  }
  const prep = $('prep-list');
  prep.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    prep.append(li);
  }
  $('sommelier-text').textContent = menu.sommelier || '';
  // No chef-note or dread line on the card: the headline already lives
  // inside world_context, and the closing line duplicated the sommelier.
  // (chef_note still ships in the menu data and is asserted in tests.)
  $('quote-text').textContent = menu.quote ? `"${menu.quote}"` : '';
  $('quote-author').textContent = menu.quote_author ? `— ${menu.quote_author}` : '';
  $('recurring-text').textContent = menu.recurring_culprit || (result.recurring?.[0]?.ingredient ?? '—');
  $('dignity-value').textContent = `${result.dignity_loss_percentage}%`;
  $('dignity-bar').style.width = `${result.dignity_loss_percentage}%`;
  $('menu-result').hidden = false;
  $('rejection-box').hidden = true;
  const cp = $('checkpoint-note');
  if (result.checkpoint) {
    cp.textContent = t().checkpoint(result.checkpoint.logId);
    cp.hidden = false;
  } else {
    cp.hidden = true;
  }
  $('receipt-content').textContent =
    `LE FRIGO VIDE\nCULINARY SIN RECEIPT\n----------------\nMeal #${result.meal_id}\n${menu.title}\nExistential Dread: ${dreadScore}/100 | Food Safety: ${menu.food_safety || 'FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)'}${menu.safety_warning ? `\nWARNING: ${menu.safety_warning}` : ''}\nDignity loss: ${result.dignity_loss_percentage}%\nQuote: "${menu.quote || ''}" — ${menu.quote_author || ''}\nDread: ${menu.dread_pairing || 'none'}\nSynthesis: ${result.synthesis_via || 'local-fallback'}\nMemory: ${result.memory_via || 'local-fallback'}\n----------------\nMerci. Do not return.`;
  currentMealId = result.meal_id;
  $('archive-btn').disabled = false;
  $('print-receipt-btn').disabled = false;
}

function renderRejection(result) {
  $('rejection-text').textContent = result.reason || 'Refused.';
  $('rejection-box').hidden = false;
  $('menu-result').hidden = true;
  $('menu-tonight-label').hidden = true;
  $('menu-title').textContent = 'Le Frigo Vide';
  $('dignity-value').textContent = '—';
  $('dignity-bar').style.width = '0%';
  $('receipt-content').textContent = `LE FRIGO VIDE\nREFUSED — Meal #${result.meal_id || '?'}\n${result.reason || ''}`;
  currentMealId = result.meal_id || null;
  $('archive-btn').disabled = true;
  $('print-receipt-btn').disabled = true;
  $('checkpoint-note').hidden = true;
}

// Log Fridge Check — a NEW observation. The only call that records
// ingredients; Ask Chef Jean-Paul never does.
async function fridgeCheck() {
  const btn = $('fridge-check-btn');
  const status = $('status-line');
  btn.disabled = true;
  try {
    const res = await fetch('/api/fridge-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify({ ingredients: $('ingredients-input').value }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || data.error || `HTTP ${res.status}`);
    status.textContent = t().fridgeCheckLogged(data.ingredients.length, data.observation_id);
    await refreshState();
    await refreshChronicle();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Ingredient condition (audit v16 P1-C): a bare animal product
// ("chicken", "one egg") has an unknown condition. The server treats it
// as raw (fail safe), but the guest can resolve it here — Raw rewrites
// the item to "raw chicken", Cooked to "cooked chicken" — and the choice
// sticks in the textarea itself, so no new API field is needed.
// The question is asked exactly when the shared classifier says the
// item requires confirmation (unknown or partially cooked). A spoiled
// item gets no chip: it is excluded from the recipe whatever the
// guest picks, so there is no condition to resolve.
// The same delimiters as the server's parseIngredients (audit v17 P2):
// comma, semicolon and newline — not just comma.
function splitIngredients(text) {
  return (text || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}
function bareAnimalItems(text) {
  return splitIngredients(text).filter((item) => classifyIngredient(item).requiresConfirmation);
}
function refreshConditionRow() {
  const row = $('condition-row');
  const items = bareAnimalItems($('ingredients-input').value);
  row.innerHTML = '';
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;
  const title = document.createElement('p');
  title.className = 'condition-title';
  title.textContent = t().conditionTitle;
  row.append(title);
  for (const item of items) {
    const chip = document.createElement('div');
    chip.className = 'condition-chip';
    const label = document.createElement('span');
    label.textContent = item;
    const c = classifyIngredient(item);
    // Three different questions, three different interactions. The
    // Raw / Already Cooked buttons only answer the condition
    // question; a protein nobody identified and a combination of
    // proteins get a note telling the guest what to do instead —
    // the buttons cannot answer them, and showing them would imply
    // they could.
    if (c.requiresConditionConfirmation) {
      const rawBtn = document.createElement('button');
      rawBtn.type = 'button';
      rawBtn.className = 'preset-btn';
      rawBtn.textContent = t().conditionRaw;
      rawBtn.addEventListener('click', () => resolveCondition(item, 'raw'));
      const cookedBtn = document.createElement('button');
      cookedBtn.type = 'button';
      cookedBtn.className = 'preset-btn';
      cookedBtn.textContent = t().conditionCooked;
      cookedBtn.addEventListener('click', () => resolveCondition(item, 'cooked'));
      chip.append(label, rawBtn, cookedBtn);
    } else if (c.needsProteinClarification) {
      const hint = document.createElement('span');
      hint.className = 'condition-hint';
      hint.textContent = t().conditionIdentify;
      chip.append(label, hint);
    } else if (c.requiresSeparation) {
      const hint = document.createElement('span');
      hint.className = 'condition-hint';
      const parts = separateProteins(item);
      hint.textContent = parts.length > 1
        ? `${t().conditionSeparate}${parts.map((p) => `"${p}"`).join(' and ')}.`
        : 'Separate into one entry per protein.';
      chip.append(label, hint);
    } else {
      chip.append(label);
    }
    row.append(chip);
  }
  const note = document.createElement('p');
  note.className = 'condition-note';
  note.textContent = t().conditionNote;
  row.append(note);
}
function resolveCondition(item, choice) {
  const input = $('ingredients-input');
  // The shared classifier rewrites the item with the chosen condition
  // — the condition expression is removed first, so "not cooked
  // chicken" + Cooked becomes "cooked chicken" (not "not cooked
  // cooked chicken", which the old prefix-the-animal rewrite produced
  // and which still matched the negation, so the chip never went
  // away). The form words are kept: "93% lean ground beef" + Raw
  // becomes "raw 93% lean ground beef", so the ground-meat
  // temperature still applies. The server then re-derives the
  // condition from this text itself.
  const replacement = applyConditionOverride(item, choice);
  // Split on the same delimiters as the server, KEEPING the separators,
  // so a newline-separated list stays newline-separated (audit v17 P2).
  // The part's own leading/trailing spaces are kept too: the split
  // keeps "; " as the separator ";" plus the part " salmon", so
  // replacing the whole part would eat the space after the semicolon.
  const parts = String(input.value || '').split(/([,;\n]+)/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].trim().toLowerCase() === item.toLowerCase()) {
      const leading = parts[i].match(/^\s*/)[0];
      const trailing = parts[i].match(/\s*$/)[0];
      parts[i] = `${leading}${replacement}${trailing}`;
      break;
    }
  }
  input.value = parts.join('');
  refreshConditionRow();
}

async function generate() {
  const btn = $('generate-btn');
  const status = $('status-line');
  btn.disabled = true;
  status.textContent = t().generating;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify({ ingredients: $('ingredients-input').value }),
    });
    const result = await res.json();
    if (result.rejected) renderRejection(result);
    else renderMenu(result);
    status.textContent = result.rejected
      ? ''
      : `via ${result.synthesis_via || 'local-fallback'} · memory ${result.memory_via || 'local-fallback'} · dread ${result.dread_via || 'local-fallback'}`;
    if (result.synthesis_note) status.textContent += ` — ${result.synthesis_note}`;
    await refreshState();
    await refreshChronicle();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function archiveReceipt() {
  if (!currentMealId) return;
  const btn = $('archive-btn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/meals/${currentMealId}/archive-box`, { method: 'POST', headers: sessionHeaders() });
    const data = await res.json();
    if (data.ok) {
      $('receipt-content').textContent = `Archived to Box.\nBox ID: ${data.box_id || '(not returned)'}\nFile: ${data.filename}`;
    } else if (data.receipt_html) {
      const blob = new Blob([data.receipt_html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.download_filename || `culinary-sin-receipt-meal-${currentMealId}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      $('receipt-content').textContent = `Box not installed (${data.reason || 'local fallback'}).\nReceipt downloaded locally as ${a.download}.`;
    } else {
      $('receipt-content').textContent = `Archive failed: ${data.reason || 'unknown error'}`;
    }
  } catch (err) {
    $('receipt-content').textContent = `Archive failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function printReceipt() {
  if (!currentMealId) return;
  // The receipt endpoint serves the printable HTML directly; the browser
  // tab it opens is where the user prints (Ctrl/Cmd+P). A new tab cannot
  // send the X-Frigo-Session header, so the session travels in the URL —
  // the receipt is scoped to that session on the server.
  window.open(`/api/meals/${currentMealId}/receipt?session=${encodeURIComponent(sessionId)}`, '_blank', 'noopener');
}

$('generate-btn').addEventListener('click', generate);
$('ingredients-input').addEventListener('input', refreshConditionRow);
$('fridge-check-btn').addEventListener('click', fridgeCheck);
$('archive-btn').addEventListener('click', archiveReceipt);
$('print-receipt-btn').addEventListener('click', printReceipt);
$('refresh-connected').addEventListener('click', refreshConnected);
$('view-mine-btn').addEventListener('click', () => { chronicleView = 'mine'; refreshChronicle(); });
$('view-demo-btn').addEventListener('click', () => { chronicleView = 'demo'; refreshChronicle(); });
for (const btn of document.querySelectorAll('.preset-btn')) {
  btn.addEventListener('click', () => {
    $('ingredients-input').value = btn.dataset.ingredients || '';
    refreshConditionRow();
    generate();
  });
}

applyLang();
refreshConditionRow();
refreshConnected();
refreshState();
refreshChronicle();

// Exported for the test harness (test/frontend.test.mjs loads this
// file as a real ES module in node): the browser never uses these
// exports, but the tests drive the picker through them.
export { refreshConditionRow, bareAnimalItems, resolveCondition, splitIngredients };
