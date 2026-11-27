import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The real public/app.js, loaded in node as a REAL ES module against a
// minimal fake DOM, so the Raw / Cooked picker logic (audit v16 P1-C,
// v17 P1/P2) is tested as written — not as a copy — including its
// import of the shared classifier (the same module the backend uses).
// vm.SourceTextModule needs --experimental-vm-modules (see
// package.json). Load-time network calls are stubbed; their failures
// are swallowed by the app's own try/catch blocks.
async function loadApp() {
  class El {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.listeners = {};
      this.value = ''; this.textContent = ''; this.hidden = false;
      this.className = ''; this.dataset = {}; this.style = {};
      this.classList = { toggle: () => {}, add: () => {}, remove: () => {} };
    }
    append(...nodes) { this.children.push(...nodes); return this; }
    appendChild(n) { this.children.push(n); return n; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    set innerHTML(v) { this.children = []; }
    get innerHTML() { return ''; }
  }
  const elements = new Map();
  const document = {
    documentElement: { lang: '' },
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new El());
      return elements.get(id);
    },
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
  };
  const store = new Map();
  const context = vm.createContext({
    document,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, meals: [], gateway: { available: false, connectors: [] }, connectors: {} }) }),
    window: { open: () => {} },
    console, setTimeout, clearTimeout,
  });
  const appUrl = new URL('../public/app.js', import.meta.url);
  const classifierUrl = new URL('../shared/ingredient-classifier.mjs', import.meta.url);
  const classifierMod = new vm.SourceTextModule(readFileSync(classifierUrl, 'utf8'), { context, identifier: classifierUrl.href });
  const appMod = new vm.SourceTextModule(readFileSync(appUrl, 'utf8'), { context, identifier: appUrl.href });
  await classifierMod.link(async () => { throw new Error('the classifier has no imports'); });
  await appMod.link(async (specifier, referencingModule) => {
    const resolved = new URL(specifier, referencingModule.identifier).href;
    if (resolved === classifierUrl.href) return classifierMod;
    throw new Error(`unexpected import in app.js: ${specifier}`);
  });
  await appMod.evaluate();
  return { app: appMod.namespace, input: document.getElementById('ingredients-input'), row: document.getElementById('condition-row') };
}

function chips(row) {
  return row.children.filter((c) => c.className === 'condition-chip');
}
function chipLabel(chip) {
  return chip.children[0].textContent;
}
function clickButton(chip, index) {
  chip.children[index].listeners.click[0]();
}

// Audit v17 P2: the picker must work when ingredients are separated by
// newlines or semicolons — not just commas — and the choice must keep
// the original separators.
test('condition picker works with newline and semicolon separators', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'chicken\ncold rice\ncheese';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'one chip for the bare chicken');
  assert.equal(chipLabel(chips(row)[0]), 'chicken');
  clickButton(chips(row)[0], 1); // Raw
  assert.equal(input.value, 'raw chicken\ncold rice\ncheese', 'the newlines are preserved');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'the resolved chicken no longer asks');

  input.value = 'chicken; salmon; rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 2, 'both bare items get a chip');
  clickButton(chips(row)[1], 2); // Cooked, for the salmon
  assert.equal(input.value, 'chicken; cooked salmon; rice', 'the semicolons are preserved');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'only the chicken still asks');
  assert.equal(chipLabel(chips(row)[0]), 'chicken');
});

// Audit v17 P1: processed products never get a Raw / Cooked question.
test('condition picker ignores processed products', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'egg noodles, fish sauce, chicken broth, shrimp paste, beef jerky';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'no chip for any processed product');
  input.value = 'fish sauce, raw salmon';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'the sauce asks nothing; the raw salmon is already qualified');
});

// Audit v18 B/C/E: a bare sausage is asked about (a fresh sausage can be
// raw), a cold smoked salmon is asked about (smoking is not cooking),
// and a chicken in sauce is a chicken — the sauce does not hide it.
test('condition picker asks about sausage, smoked salmon and chicken in sauce', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'pork sausage, cold smoked salmon, chicken in sauce';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 3, 'all three get a chip');
  assert.deepEqual(chips(row).map(chipLabel).sort(),
    ['chicken in sauce', 'cold smoked salmon', 'pork sausage'].sort());
  input.value = 'raw pork sausage, smoked salmon';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the raw sausage is already qualified; the smoked salmon still asks');
  assert.equal(chipLabel(chips(row)[0]), 'smoked salmon');
});

// Audit v20 P0-A: the picker and the server must agree — "not cooked
// chicken" and "chicken with fried rice" get a chip, "fried chicken"
// and "fully cooked chicken" do not.
test('condition picker asks about not cooked and chicken with fried rice', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'not cooked chicken, partially cooked chicken, chicken with fried rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 3, 'all three get a chip');
  assert.deepEqual(chips(row).map(chipLabel).sort(),
    ['not cooked chicken', 'partially cooked chicken', 'chicken with fried rice'].sort());
  input.value = 'fried chicken, fully cooked chicken';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'a cooked chicken asks nothing');
  // Audit v20.2 P0-A: the negation allows adverbs, and the server and
  // the picker use the same regex.
  input.value = 'not yet cooked chicken, chicken not properly cooked';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 2, 'both negation variants get a chip');
  assert.deepEqual(chips(row).map(chipLabel).sort(),
    ['not yet cooked chicken', 'chicken not properly cooked'].sort());
  // Audit v20.3: three words between the negation and "cooked".
  input.value = 'chicken has not yet been properly cooked';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the long negation gets a chip');
  assert.equal(chipLabel(chips(row)[0]), 'chicken has not yet been properly cooked');
});

// The old rewrite prefixed the animal ("not cooked chicken" + Cooked
// became "not cooked cooked chicken"), which still matched the
// negation — so the chip never went away. The classifier's override
// removes the condition expression first, so the choice resolves.
test('condition picker resolves a negated item when Cooked is picked', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'not cooked chicken, rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the negated chicken gets a chip');
  clickButton(chips(row)[0], 2); // Cooked
  assert.equal(input.value, 'cooked chicken, rice', 'the negation is gone, the choice is written');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'the resolved chicken no longer asks');
});

// A spoiled item gets no chip: it is excluded from the recipe whatever
// the guest picks, so there is no condition to resolve.
test('condition picker asks nothing about a spoiled item', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'moldy chicken, expired yogurt, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'no chip for spoiled items');
});

// Audit v22: the choice is written into the protein subject. "rice
// with chicken" + Cooked becomes "rice with cooked chicken" — the
// buttons change the chicken's condition, not the rice's.
test('condition picker writes the choice into the protein subject', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'rice with chicken, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the chicken gets a chip, the rice does not');
  assert.equal(chipLabel(chips(row)[0]), 'rice with chicken');
  clickButton(chips(row)[0], 2); // Cooked
  assert.equal(input.value, 'rice with cooked chicken, cold rice', 'Cooked changes the chicken, not the rice');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'the resolved chicken no longer asks');

  input.value = 'rice with chicken, cold rice';
  app.refreshConditionRow();
  clickButton(chips(row)[0], 1); // Raw
  assert.equal(input.value, 'rice with raw chicken, cold rice', 'Raw changes the chicken, not the rice');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'a raw chicken asks nothing more');

  // A compound whose protein is already qualified asks nothing, and
  // a raw accompaniment does not make the chicken raw.
  input.value = 'cooked chicken with raw salad, fried rice with uncooked chicken';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'only the uncooked chicken asks');
  assert.equal(chipLabel(chips(row)[0]), 'fried rice with uncooked chicken');
  clickButton(chips(row)[0], 2); // Cooked
  assert.equal(input.value, 'cooked chicken with raw salad, fried rice with cooked chicken', 'the salad keeps its raw, the rice keeps its fried');
});

// Audit v22: a raw protein whose type is unknown ("raw meat") still
// gets a chip — it needs clarification.
// Audit v24: it gets a HINT, not the Raw / Cooked buttons. The
// buttons cannot answer "which protein is this" — they would imply
// a choice that does not resolve it. The guest resolves it by
// typing the protein ("raw chicken").
test('condition picker shows a hint, not buttons, for a raw meat', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'raw meat, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the raw meat asks for clarification');
  const chip = chips(row)[0];
  assert.equal(chip.children.length, 2, 'label plus hint, no buttons');
  assert.equal(chip.children[1].className, 'condition-hint');
  assert.match(chip.children[1].textContent, /Identify the protein and the cut/);
  assert.equal(chip.children[1].listeners.click, undefined, 'the hint is not a button');
  // Typing the protein resolves it — the chip goes away.
  input.value = 'raw chicken, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'a named raw chicken is raw risk, not a question');
});

// Audit v23: a negated "raw" is neither cooked nor explicit raw, so
// it gets a chip — and picking a choice removes the negation.
// Audit v24: an ambiguous combination gets a chip with a HINT, not
// buttons — the buttons cannot answer "separate them". The hint
// suggests the split, and the guest resolves it by editing the text.
test('condition picker asks about not raw and hints at an ambiguous combination', async () => {
  const { app, input, row } = await loadApp();
  input.value = 'not raw chicken, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'a negated raw gets a chip');
  assert.equal(chips(row)[0].children.length, 3, 'label plus two buttons for the condition question');
  clickButton(chips(row)[0], 2); // Cooked
  assert.equal(input.value, 'cooked chicken, cold rice', 'the negation is gone, the choice is written');
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'the resolved chicken no longer asks');

  input.value = 'raw chicken with raw fish, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 1, 'the ambiguous combination asks for clarification');
  const chip = chips(row)[0];
  assert.equal(chipLabel(chip), 'raw chicken with raw fish');
  assert.equal(chip.children.length, 2, 'label plus hint, no buttons');
  assert.equal(chip.children[1].className, 'condition-hint');
  assert.match(chip.children[1].textContent, /Separate into one entry per protein/);
  assert.match(chip.children[1].textContent, /"raw chicken" and "raw fish"/, 'the hint suggests the split');
  assert.equal(chip.children[1].listeners.click, undefined, 'the hint is not a button');
  // Separating the entries resolves it.
  input.value = 'raw chicken, raw fish, cold rice';
  app.refreshConditionRow();
  assert.equal(chips(row).length, 0, 'two separate entries are two raw risks, not a combination');
});
