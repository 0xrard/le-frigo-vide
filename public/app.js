// Le Frigo Vide — frontend. IDs must match index.html exactly.
// State: lang ('en' | 'id'), currentMealId.
let lang = 'en';
let currentMealId = null;

const $ = (id) => document.getElementById(id);

const I18N = {
  en: {
    tagline: 'A personal culinary agent. The fridge is empty. The chef is not impressed.',
    menuKicker: 'Bistro · Paris · Depuis le frigo',
    menuSubtitle: 'Tell the chef what is left. He will do the rest, reluctantly.',
    ingredientsLabel: 'What is in the fridge?',
    generate: 'Ask Chef Jean-Paul',
    generating: 'The chef is thinking. Slowly.',
    dreadLabel: 'Global Dread Pairing:',
    recurringLabel: 'Recurring culprit:',
    receiptTitle: 'Struk Dosa Kuliner',
    dignityLabel: 'Dignity loss',
    archive: 'Archive receipt to Box',
    xrayTitle: 'Gateway X-Ray',
    rawKeysLabel: 'Raw API keys in env:',
    gatewayLabel: 'Sprites Gateway:',
    historyTitle: 'Recent meals',
    rejectionTitle: 'Refused.',
    printReceipt: 'Print receipt',
    auraHeading: 'I. Fridge Aura Analysis',
    worldHeading: 'II. Outside World Context',
    prepHeading: 'III. Preparation — With Quiet Resignation',
    sommelierHeading: 'IV. Sommelier Pairing',
    dreadScoreLabel: 'Existential Dread',
    safetyLabel: 'Food Safety',
    dignityScoreLabel: 'Dignity Loss',
    archiveHint: 'Box upload runs only when the Box connector is installed; otherwise the receipt downloads locally.',
    noMeals: 'No meals yet.',
    checkpoint: (id) => `Dignity loss above 80%. A checkpoint was requested: Lowest Point of the Week Snapshot (log #${id}).`,
  },
  id: {
    tagline: 'Agen kuliner personal. Kulkasnya kosong. Kokinya tidak terkesan.',
    menuKicker: 'Bistro · Paris · Depuis le frigo',
    menuSubtitle: 'Beri tahu koki apa yang tersisa. Dia akan mengurus sisanya, dengan enggan.',
    ingredientsLabel: 'Apa isi kulkasnya?',
    generate: 'Tanya Chef Jean-Paul',
    generating: 'Koki sedang berpikir. Pelan-pelan.',
    dreadLabel: 'Global Dread Pairing:',
    recurringLabel: 'Pelaku berulang:',
    receiptTitle: 'Struk Dosa Kuliner',
    dignityLabel: 'Kehilangan martabat',
    archive: 'Arsipkan struk ke Box',
    xrayTitle: 'Gateway X-Ray',
    rawKeysLabel: 'API key mentah di env:',
    gatewayLabel: 'Sprites Gateway:',
    historyTitle: 'Hidangan terakhir',
    rejectionTitle: 'Ditolak.',
    printReceipt: 'Cetak struk',
    auraHeading: 'I. Analisis Aura Kulkas',
    worldHeading: 'II. Konteks Dunia Luar',
    prepHeading: 'III. Cara Pembuatan — Dengan Nada Pasrah',
    sommelierHeading: 'IV. Catatan Sommelier',
    dreadScoreLabel: 'Kecemasan Eksistensial',
    safetyLabel: 'Keamanan Pangan',
    dignityScoreLabel: 'Kehilangan Martabat',
    archiveHint: 'Upload Box hanya berjalan bila connector Box terpasang; jika tidak, struk diunduh secara lokal.',
    noMeals: 'Belum ada hidangan.',
    checkpoint: (id) => `Kehilangan martabat di atas 80%. Checkpoint diminta: Lowest Point of the Week Snapshot (log #${id}).`,
  },
};

function t() { return I18N[lang]; }

function applyLang() {
  const s = t();
  document.documentElement.lang = lang;
  $('tagline').textContent = s.tagline;
  $('menu-kicker').textContent = s.menuKicker;
  $('menu-subtitle').textContent = s.menuSubtitle;
  $('ingredients-label').textContent = s.ingredientsLabel;
  $('generate-btn').textContent = s.generate;
  $('dread-label').textContent = s.dreadLabel;
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
  $('archive-hint').textContent = s.archiveHint;
  $('lang-toggle').textContent = lang === 'en' ? 'EN / ID' : 'ID / EN';
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
      small.textContent = `${c.via} · ${c.note}`;
      li.append(small);
      list.append(li);
    }
  } catch (err) {
    $('gateway-status').textContent = `error: ${err.message}`;
  }
}

async function refreshState() {
  try {
    const res = await fetch('/api/state');
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

function renderMenu(result) {
  const menu = result.menu;
  const s = t();
  $('menu-title').textContent = menu.title || 'Le Frigo Vide';
  $('menu-subtitle').textContent = menu.subtitle || '';
  // Header & status: Existential Dread | Food Safety | Dignity Loss.
  const dreadScore = Number.isInteger(menu.existential_dread) ? menu.existential_dread : '—';
  $('score-line').textContent =
    `${s.dreadScoreLabel}: ${dreadScore}/100 | ${s.safetyLabel}: ${menu.food_safety || 'Technically Edible'} | ${s.dignityScoreLabel}: ${result.dignity_loss_percentage}%`;
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
  $('chef-note').textContent = menu.chef_note || '';
  $('quote-text').textContent = menu.quote ? `"${menu.quote}"` : '';
  $('quote-author').textContent = menu.quote_author ? `— ${menu.quote_author}` : '';
  $('dread-text').textContent = menu.dread_pairing || result.dread?.title || '—';
  $('dread-via').textContent = result.dread_via ? `(${result.dread_via})` : '';
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
    `LE FRIGO VIDE\nSTRUK DOSA KULINER\n----------------\nMeal #${result.meal_id}\n${menu.title}\nExistential Dread: ${dreadScore}/100 | Food Safety: ${menu.food_safety || 'Technically Edible'}\nDignity loss: ${result.dignity_loss_percentage}%\nQuote: "${menu.quote || ''}" — ${menu.quote_author || ''}\nDread: ${menu.dread_pairing || 'none'}\nSynthesis: ${result.synthesis_via || 'local-fallback'}\nMemory: ${result.memory_via || 'local-fallback'}\n----------------\nMerci. Do not return.`;
  currentMealId = result.meal_id;
  $('archive-btn').disabled = false;
  $('print-receipt-btn').disabled = false;
}

function renderRejection(result) {
  $('rejection-text').textContent = result.reason || 'Refused.';
  $('rejection-box').hidden = false;
  $('menu-result').hidden = true;
  $('dignity-value').textContent = '—';
  $('dignity-bar').style.width = '0%';
  $('receipt-content').textContent = `LE FRIGO VIDE\nREFUSED — Meal #${result.meal_id || '?'}\n${result.reason || ''}`;
  currentMealId = result.meal_id || null;
  $('archive-btn').disabled = true;
  $('print-receipt-btn').disabled = true;
  $('checkpoint-note').hidden = true;
}

async function generate() {
  const btn = $('generate-btn');
  const status = $('status-line');
  btn.disabled = true;
  status.textContent = t().generating;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ingredients: $('ingredients-input').value, lang }),
    });
    const result = await res.json();
    if (result.rejected) renderRejection(result);
    else renderMenu(result);
    status.textContent = result.rejected
      ? ''
      : `via ${result.synthesis_via || 'local-fallback'} · memory ${result.memory_via || 'local-fallback'} · dread ${result.dread_via || 'local-fallback'}`;
    if (result.synthesis_note) status.textContent += ` — ${result.synthesis_note}`;
    await refreshState();
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
    const res = await fetch(`/api/meals/${currentMealId}/archive-box`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      $('receipt-content').textContent = `Archived to Box.\nBox ID: ${data.box_id || '(not returned)'}\nFile: ${data.filename}`;
    } else if (data.receipt_html) {
      const blob = new Blob([data.receipt_html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.download_filename || `struk-dosa-kuliner-meal-${currentMealId}.html`;
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
  // tab it opens is where the user prints (Ctrl/Cmd+P).
  window.open(`/api/meals/${currentMealId}/receipt`, '_blank', 'noopener');
}

$('generate-btn').addEventListener('click', generate);
$('archive-btn').addEventListener('click', archiveReceipt);
$('print-receipt-btn').addEventListener('click', printReceipt);
$('refresh-connected').addEventListener('click', refreshConnected);
$('lang-toggle').addEventListener('click', () => {
  lang = lang === 'en' ? 'id' : 'en';
  applyLang();
  refreshState();
});
for (const btn of document.querySelectorAll('.preset-btn')) {
  btn.addEventListener('click', () => {
    $('ingredients-input').value = btn.dataset.ingredients || '';
    generate();
  });
}

applyLang();
refreshConnected();
refreshState();
