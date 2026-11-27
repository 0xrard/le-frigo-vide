import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// Isolated DB per test file, before any pipeline import.
const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-classifier-'));
process.env.LE_FRIGO_DB = join(dir, 'classifier.sqlite');

const classifier = await import('../shared/ingredient-classifier.mjs');
const { classifyIngredient, applyConditionOverride, proteinSubjectPart, primaryProteins, separateProteins, parseComponents, proteinOccurrences, occurrencesConflict } = classifier;
const pipeline = await import('../src/pipeline.mjs');
const { initDb } = await import('../src/db.mjs');

test.before(() => { initDb(); });

// --- The brief's table-driven regression cases ---------------------------
// One table, one expected decision per input. The condition, the
// category, the spoilage flag, the confirmation flag, the cooking rule
// and the recipe action are all asserted together, so a change to any
// of them fails the row it belongs to.
const TABLE = [
  // input, condition, foodCategory, spoilage, requiresConfirmation, ruleKind, ruleTempsC, recipeAction
  ['raw chicken', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['fully cooked chicken', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['not cooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken has not yet been properly cooked', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['partially cooked beef', 'partially_cooked', 'red_meat', false, true, 'whole', [63], 'ask_user'],
  ['chicken with fried rice', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken in sauce', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['fish sauce', 'not_applicable', 'processed', false, false, null, null, 'include'],
  ['egg noodles', 'not_applicable', 'processed', false, false, null, null, 'include'],
  ['raw pork sausage', 'raw', 'red_meat', false, false, 'ground', [71], 'cook_through'],
  ['moldy raw chicken', 'raw', 'poultry', true, false, 'poultry', [74], 'exclude'],
  ['fresh bread', 'not_applicable', 'other', false, false, null, null, 'include'],
  ['moldy bread', 'not_applicable', 'other', true, false, null, null, 'exclude'],
  // The same table, extended: the cases the earlier audits earned.
  // Audit v22: a raw protein whose type or form is unknown ("raw
  // meat") asks for protein clarification instead of offering three
  // temperatures — no cooking rule, recipe decision ask_user. A bare
  // "meat" is different: its CONDITION is the first question, so it
  // is asked about the condition, not the protein.
  ['raw meat', 'raw', 'unknown_meat', false, true, null, null, 'ask_user', true],
  ['meat', 'unknown', 'unknown_meat', false, true, null, null, 'ask_user', false],
  ['partially cooked meat', 'partially_cooked', 'unknown_meat', false, true, null, null, 'ask_user', true],
  // Audit v22, the protein-subject cases: the condition belongs to
  // the phrase that holds the protein, never to the accompaniment.
  // "partially cooked chicken nuggets" is partially cooked — the
  // audit's "Unknown" is the outcome (ask the guest, cook it through),
  // not the label: the condition is partially_cooked and the recipe
  // decision is ask_user, the pipeline's unknown-condition bucket.
  ['partially cooked chicken nuggets', 'partially_cooked', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['not fully cooked canned chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['uncooked chicken nuggets', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['partially cooked beef stew', 'partially_cooked', 'red_meat', false, true, 'whole', [63], 'ask_user'],
  ['not yet cooked canned chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['cooked chicken with raw salad', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['fried chicken with raw vegetables', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['rice with cooked chicken', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['rice with raw chicken', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['fried rice with uncooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  // The ground form is read from the protein subject, not the whole
  // entry: the "ground" in "ground rice with chicken" does not make
  // the chicken ground meat.
  ['ground rice with chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['rice with ground beef', 'unknown', 'red_meat', false, true, 'ground', [71], 'ask_user'],
  // A bare nugget has no condition evidence at all, so the processed
  // exemption still applies — it is the condition evidence, not the
  // word "nuggets", that makes the cases above unknown.
  ['chicken nuggets', 'not_applicable', 'processed', false, false, null, null, 'include'],
  // Audit v23: a negated "raw" is neither cooked nor explicit raw.
  ['not raw chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken is not raw', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ["chicken isn't raw", 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['not actually raw beef', 'unknown', 'red_meat', false, true, 'whole', [63], 'ask_user'],
  ['not raw beef', 'unknown', 'red_meat', false, true, 'whole', [63], 'ask_user'],
  // Audit v23: more than one primary protein in one entry asks for
  // separation — no cooking rule, recipe decision ask_user. A
  // processed compound never counts ("chicken with fish sauce" is
  // one protein, the chicken). A cut word is not a second animal:
  // "beef steak" is one protein (beef), not two.
  ['raw chicken with raw fish', 'raw', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['chicken and beef', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  // v25: the category follows the SUBJECT (the first protein
  // candidate, the beef) — the old "fish" came from a category
  // priority that no longer exists.
  ['beef and salmon', 'unknown', 'red_meat', false, true, null, null, 'ask_user', false, true],
  ['chicken with fish sauce', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['raw beef steak', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  // v26: the entry's condition is the condition ALL occurrences
  // agree on. The chicken is cooked and the beef is unknown, so
  // there is no single condition — the first component's "cooked"
  // must never stand for the beef.
  ['cooked chicken and beef', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  // Audit v26: the same species twice is two occurrences, not one
  // identity. A different condition (or a different cooking rule)
  // is a conflict — the entry is separated, and the first
  // component's condition never stands for the others. A repeated
  // occurrence that agrees on identity, condition, and rule merges.
  ['cooked chicken with raw chicken', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['cooked chicken with partially cooked chicken', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['cooked beef with raw ground beef', 'unknown', 'red_meat', false, true, null, null, 'ask_user', false, true],
  ['raw chicken with cooked chicken', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['raw chicken with raw chicken', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['ground beef with beef steak', 'unknown', 'red_meat', false, true, null, null, 'ask_user', false, true],
  ['ground chicken with chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  // Audit v26: beef broth is a stock, like chicken broth — the exact
  // compound, not a broad "broth" word.
  ['beef broth with raw chicken', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['raw chicken with beef broth', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['chicken with beef broth and raw turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  // Audit v27: "&" is "and" written short, and "/" between two
  // foods is a choice or a mixture — never a guess. Both cut a
  // sub-phrase, so the proteins on either side are found as
  // separate occurrences and the entry is asked to choose or
  // separate. A verified synonym still merges, and a condiment
  // next to a protein is still only the protein.
  ['chicken & turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['chicken/turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['raw chicken/raw turkey', 'raw', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['raw chicken & cooked turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['shrimp & prawn', 'unknown', 'seafood', false, true, 'fish', [63], 'ask_user'],
  ['fish sauce & raw beef', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  // Audit v27: a sub-phrase with no separator at all can still hold
  // two proteins — both are listed, and the entry is separated.
  ['chicken turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  // Audit v24: a processed compound never hides the protein next to
  // it. The sub-phrase after the compound is read on its own.
  ['chicken with fish sauce and raw beef', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['chicken with shrimp paste and raw pork', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  // Audit v24: two words for one ingredient count once — the guest
  // is not asked to separate synonyms or a generic from its species.
  // v25 (architecture correction): that rule is REVERSED for
  // everything except verified exact synonyms. Only shrimp/prawn
  // collapse. A generic and its species (fish/salmon,
  // chicken/poultry) are two identities, and so are chicken/turkey
  // — they share a temperature, not an identity, and the spec says
  // never to deduplicate for sharing one.
  ['shrimp and prawn', 'unknown', 'seafood', false, true, 'fish', [63], 'ask_user'],
  ['fish and salmon', 'unknown', 'fish', false, true, null, null, 'ask_user', false, true],
  ['chicken and poultry', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['chicken and turkey', 'unknown', 'poultry', false, true, null, null, 'ask_user', false, true],
  ['beef and pork', 'unknown', 'red_meat', false, true, null, null, 'ask_user', false, true],
  ['salmon and tuna', 'unknown', 'fish', false, true, null, null, 'ask_user', false, true],
  // v25: a condiment is not a protein, so the subject is the beef —
  // and the beef is found, not hidden. The order does not matter.
  ['fish sauce with raw beef', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  ['raw beef with fish sauce', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  ['chicken broth with raw pork', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  ['raw 93% lean ground beef', 'raw', 'red_meat', false, false, 'ground', [71], 'cook_through'],
  ['raw ground salmon', 'raw', 'fish', false, false, 'fish', [63], 'cook_through'],
  ['raw ground chicken', 'raw', 'poultry', false, false, 'poultry', [74], 'cook_through'],
  ['raw wagyu beef', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
  // v25: "raw fish sauce" is a condiment, not a protein — there is
  // no protein to be raw, so the "raw" is ignored and the item is
  // ready-to-eat. (The old "raw"/fish/63°C came from the first
  // protein word in the raw input, which the correction forbids.)
  ['raw fish sauce', 'not_applicable', 'processed', false, false, null, null, 'include'],
  ['pork sausage', 'unknown', 'red_meat', false, true, 'ground', [71], 'ask_user'],
  ['sausage', 'unknown', 'red_meat', false, true, 'ground', [71], 'ask_user'],
  ['cold smoked salmon', 'unknown', 'fish', false, true, 'fish', [63], 'ask_user'],
  ['fried chicken', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['roast chicken', 'cooked', 'poultry', false, false, null, null, 'include'],
  ['chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['one egg', 'unknown', 'egg', false, true, 'egg', [], 'ask_user'],
  ['raw egg', 'raw', 'egg', false, false, 'egg', [], 'cook_through'],
  ['cold rice', 'not_applicable', 'other', false, false, null, null, 'include'],
  ['not yet cooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken not properly cooked', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['not yet been fully cooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken has not been sufficiently cooked', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['not fully cooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['never cooked chicken', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['half-cooked chicken', 'partially_cooked', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['chicken with boiled potatoes', 'unknown', 'poultry', false, true, 'poultry', [74], 'ask_user'],
  ['rotten tomato', 'not_applicable', 'other', true, false, null, null, 'exclude'],
  ['expired yogurt', 'not_applicable', 'other', true, false, null, null, 'exclude'],
  ['moldy strawberries', 'not_applicable', 'other', true, false, null, null, 'exclude'],
  ['raw beef steak', 'raw', 'red_meat', false, false, 'whole', [63], 'cook_through'],
];

test('table-driven regression: every case classifies to its structured decision', () => {
  for (const [input, condition, foodCategory, spoilage, requiresConfirmation, ruleKind, ruleTempsC, recipeAction, needsProteinClarification = false, ambiguousProteins = false] of TABLE) {
    const r = classifyIngredient(input);
    assert.equal(r.condition, condition, `${input}: condition`);
    assert.equal(r.foodCategory, foodCategory, `${input}: foodCategory`);
    assert.equal(r.spoilage, spoilage, `${input}: spoilage`);
    assert.equal(r.requiresConfirmation, requiresConfirmation, `${input}: requiresConfirmation`);
    assert.equal(r.recipeAction, recipeAction, `${input}: recipeAction`);
    assert.equal(r.needsProteinClarification, needsProteinClarification, `${input}: needsProteinClarification`);
    assert.equal(r.ambiguousProteins, ambiguousProteins, `${input}: ambiguousProteins`);
    // Audit v24: the three clarification types are distinct, so the
    // frontend can show the right interaction for each. The
    // condition question is the only one the Raw / Cooked buttons
    // answer; a protein question and a separation question get a
    // note instead.
    const expectsCondition = !spoilage && !ambiguousProteins && !needsProteinClarification
      && (condition === 'unknown' || condition === 'partially_cooked');
    assert.equal(r.requiresConditionConfirmation, expectsCondition, `${input}: requiresConditionConfirmation`);
    assert.equal(r.requiresSeparation, !spoilage && ambiguousProteins, `${input}: requiresSeparation`);
    assert.equal(r.originalInput, input, `${input}: originalInput is preserved`);
    if (ruleKind === null) {
      assert.equal(r.cookingRule, null, `${input}: no cooking rule`);
    } else {
      assert.equal(r.cookingRule.kind, ruleKind, `${input}: rule kind`);
      assert.deepEqual(r.cookingRule.temperaturesC, ruleTempsC, `${input}: rule temperatures`);
    }
  }
});

// Audit v23: primaryProteins counts animals, not cut words — and a
// processed compound contributes nothing.
// Audit v25 (architecture correction): the identity is the SPECIES,
// not the cooking category. Only verified exact synonyms collapse
// (shrimp/prawn). Two species that share a temperature are still
// two proteins — chicken/turkey, beef/pork, salmon/tuna,
// fish/salmon, chicken/poultry — so the guest is asked to separate
// them. A condiment, a stock, or a prepared staple contributes
// nothing; a prepared dish contributes its protein (it can be
// undercooked).
test('primaryProteins counts distinct species, not categories', () => {
  assert.deepEqual(primaryProteins('raw chicken with raw fish'), ['chicken', 'fish']);
  assert.deepEqual(primaryProteins('chicken and beef'), ['chicken', 'beef']);
  assert.deepEqual(primaryProteins('beef and salmon'), ['beef', 'salmon']);
  assert.deepEqual(primaryProteins('chicken with fish sauce'), ['chicken']);
  assert.deepEqual(primaryProteins('fish sauce'), []);
  assert.deepEqual(primaryProteins('raw beef steak'), ['beef'], 'a steak is a cut of beef, not a second animal');
  assert.deepEqual(primaryProteins('pork sausage'), ['pork'], 'a sausage is a form of pork, not a second animal');
  assert.deepEqual(primaryProteins('chicken'), ['chicken']);
  assert.deepEqual(primaryProteins('cold rice'), []);
  assert.deepEqual(primaryProteins('shrimp and prawn'), ['shrimp'], 'the one verified exact synonym');
  assert.deepEqual(primaryProteins('fish and salmon'), ['fish', 'salmon'], 'a generic and its species are two identities');
  assert.deepEqual(primaryProteins('chicken and poultry'), ['chicken', 'poultry'], 'a species and its category are two identities');
  assert.deepEqual(primaryProteins('chicken and turkey'), ['chicken', 'turkey'], 'two species, one temperature, still two proteins');
  assert.deepEqual(primaryProteins('beef and pork'), ['beef', 'pork']);
  assert.deepEqual(primaryProteins('salmon and tuna'), ['salmon', 'tuna']);
  assert.deepEqual(primaryProteins('chicken with fish sauce and raw beef'), ['chicken', 'beef'], 'the sauce does not hide the beef');
  assert.deepEqual(primaryProteins('chicken with shrimp paste and raw pork'), ['chicken', 'pork'], 'the paste does not hide the pork');
  assert.deepEqual(primaryProteins('fish sauce with raw beef'), ['beef'], 'the condiment is not a protein');
  assert.deepEqual(primaryProteins('chicken broth'), [], 'a stock is not a protein');
  assert.deepEqual(primaryProteins('egg noodles'), [], 'a prepared staple is not a protein');
  assert.deepEqual(primaryProteins('chicken nuggets'), ['chicken'], 'a prepared dish keeps its protein — it can be undercooked');
});

// Audit v24: separateProteins suggests one entry per distinct
// protein, so the guest can copy them straight into the input.
test('separateProteins suggests one entry per distinct protein', () => {
  assert.deepEqual(separateProteins('raw chicken with raw fish'), ['raw chicken', 'raw fish']);
  assert.deepEqual(separateProteins('chicken with fish sauce and raw beef'), ['chicken', 'raw beef']);
  assert.deepEqual(separateProteins('chicken and beef'), ['chicken', 'beef']);
  assert.deepEqual(separateProteins('shrimp and prawn'), ['shrimp'], 'one entry for one protein, even under two names');
  assert.deepEqual(separateProteins('fish sauce'), [], 'a compound alone suggests nothing');
  assert.deepEqual(separateProteins('fish sauce with raw beef'), ['raw beef'], 'the condiment suggests nothing — the beef does');
});

// --- Architecture correction v25: the invariants ----------------------
// The spec's five invariants. Each one is a property that must hold
// for every input of its shape, not a single example — so each test
// runs the same assertion over a small family of inputs.

// 1. Identity separation: two species that share a temperature are
// still two proteins. Only the verified exact synonym (shrimp/prawn)
// collapses. The identity is the species, the category is the
// cooking group, and they are never conflated.
test('invariant: identity separation — a shared temperature is not a shared identity', () => {
  const { parseComponents } = classifier;
  const two = [
    ['chicken and turkey', ['chicken', 'turkey']],
    ['beef and pork', ['beef', 'pork']],
    ['salmon and tuna', ['salmon', 'tuna']],
    ['fish and salmon', ['fish', 'salmon']],
    ['chicken and poultry', ['chicken', 'poultry']],
    ['raw chicken with raw fish', ['chicken', 'fish']],
  ];
  for (const [input, identities] of two) {
    const r = classifyIngredient(input);
    assert.deepEqual(primaryProteins(input), identities, `${input}: two identities`);
    assert.equal(r.ambiguousProteins, true, `${input}: ambiguous`);
    assert.equal(r.requiresSeparation, true, `${input}: requires separation`);
    assert.equal(r.cookingRule, null, `${input}: no rule — two proteins, two temperatures`);
    assert.equal(r.recipeAction, 'ask_user', `${input}: ask, never guess`);
    // The identity and the category are separate fields, and the
    // category follows the subject's identity — not the other way.
    assert.equal(r.proteinIdentity, identities[0], `${input}: the identity is the first species`);
    assert.equal(r.foodCategory, { chicken: 'poultry', beef: 'red_meat', salmon: 'fish', fish: 'fish' }[identities[0]], `${input}: the category follows the identity`);
  }
  // The one exception: the verified exact synonym.
  const one = classifyIngredient('shrimp and prawn');
  assert.deepEqual(primaryProteins('shrimp and prawn'), ['shrimp']);
  assert.equal(one.ambiguousProteins, false, 'shrimp/prawn is one protein');
  assert.equal(one.proteinIdentity, 'shrimp');
  assert.equal(one.cookingRule.protein, 'shrimp', 'the rule carries the identity it belongs to');
  assert.equal(one.cookingRule.kind, 'fish');
});

// 2. Condiment neutrality: a compound is a role, not a protein — and
// it never hides the protein next to it, and never steals the
// subject. The beef is found, its condition is read, and its
// temperature is the beef's.
test('invariant: condiment neutrality — a compound is a role, not a protein', () => {
  const { parseComponents } = classifier;
  // The compound is identified, and the protein is identified too.
  const r = classifyIngredient('fish sauce with raw beef');
  assert.deepEqual(r.components, [
    { text: 'fish sauce', role: 'condiment', protein: null, proteins: [] },
    { text: 'raw beef', role: 'primary_protein', protein: 'beef', proteins: ['beef'] },
  ]);
  assert.equal(r.proteinIdentity, 'beef', 'the protein is the beef, not the fish in the sauce');
  assert.equal(r.foodCategory, 'red_meat');
  assert.equal(r.condition, 'raw');
  assert.equal(r.cookingRule.protein, 'beef');
  assert.equal(r.cookingRule.kind, 'whole');
  assert.deepEqual(r.cookingRule.temperaturesC, [63]);
  // The same compound, three ways: the protein is always the beef.
  for (const input of ['fish sauce with raw beef', 'raw beef with fish sauce', 'chicken broth with raw pork']) {
    const x = classifyIngredient(input);
    assert.equal(x.proteinIdentity, input.includes('pork') ? 'pork' : 'beef', `${input}: the protein is the meat, not the flavour`);
    assert.equal(x.condition, 'raw', `${input}: the condition is the meat's`);
  }
  // A bare compound has no protein at all — and no condition.
  for (const input of ['fish sauce', 'soy sauce', 'chicken broth', 'egg noodles']) {
    const x = classifyIngredient(input);
    assert.equal(x.proteinIdentity, null, `${input}: no protein`);
    assert.equal(x.condition, 'not_applicable', `${input}: no condition to classify`);
    assert.equal(x.foodCategory, 'processed', `${input}: a compound, not an animal`);
  }
});

// 3. Order invariance: the classification does not depend on which
// phrase comes first. The subject is the first PRIMARY protein
// candidate — and a condiment is never a candidate, wherever it sits.
// For a single protein, the whole classification is identical. For
// a combination, the SET of proteins is identical (the subject is
// the first candidate, so its identity follows the order — that is
// the subject, not the classification).
test('invariant: order invariance — the classification does not depend on phrase order', () => {
  const single = [
    ['fish sauce with raw beef', 'raw beef with fish sauce'],
    ['cooked chicken with raw salad', 'raw salad with cooked chicken'],
    ['rice with cooked chicken', 'cooked chicken with rice'],
    ['chicken with fish sauce', 'fish sauce with chicken'],
  ];
  for (const [a, b] of single) {
    const ra = classifyIngredient(a);
    const rb = classifyIngredient(b);
    assert.equal(ra.proteinIdentity, rb.proteinIdentity, `${a} vs ${b}: the same protein`);
    assert.equal(ra.condition, rb.condition, `${a} vs ${b}: the same condition`);
    assert.equal(ra.foodCategory, rb.foodCategory, `${a} vs ${b}: the same category`);
    assert.equal(ra.ambiguousProteins, rb.ambiguousProteins, `${a} vs ${b}: the same ambiguity`);
    assert.equal(ra.recipeAction, rb.recipeAction, `${a} vs ${b}: the same decision`);
    assert.deepEqual(ra.cookingRule, rb.cookingRule, `${a} vs ${b}: the same rule`);
  }
  // A combination: the set of proteins is the same, whichever order
  // they are written in — and both are blocked the same way.
  for (const [a, b] of [['chicken and beef', 'beef and chicken'], ['raw chicken with raw fish', 'raw fish with raw chicken']]) {
    assert.deepEqual([...primaryProteins(a)].sort(), [...primaryProteins(b)].sort(), `${a} vs ${b}: the same set of proteins`);
    const ra = classifyIngredient(a);
    const rb = classifyIngredient(b);
    assert.equal(ra.ambiguousProteins, rb.ambiguousProteins, `${a} vs ${b}: the same ambiguity`);
    assert.equal(ra.recipeAction, rb.recipeAction, `${a} vs ${b}: the same decision`);
    assert.equal(ra.cookingRule, null, `${a}: no rule`);
    assert.equal(rb.cookingRule, null, `${b}: no rule`);
  }
});

// 4. Condition locality: a cooking word that belongs to an
// accompaniment never changes the protein's condition. The condition
// is read from the protein component alone.
test('invariant: condition locality — an accompaniment never cooks the protein', () => {
  const cases = [
    ['fried rice with uncooked chicken', 'unknown', 'the "fried" belongs to the rice'],
    ['cooked rice with chicken', 'unknown', 'the "cooked" belongs to the rice'],
    ['raw salad with cooked chicken', 'cooked', 'the "raw" belongs to the salad'],
    ['chicken with boiled potatoes', 'unknown', 'the "boiled" belongs to the potatoes'],
    ['ground rice with chicken', 'unknown', 'the "ground" belongs to the rice'],
    ['chicken with fried rice', 'unknown', 'the "fried" belongs to the rice'],
  ];
  for (const [input, condition, why] of cases) {
    const r = classifyIngredient(input);
    assert.equal(r.condition, condition, `${input}: ${why}`);
    assert.equal(r.proteinIdentity, 'chicken', `${input}: the protein is the chicken`);
  }
  // And the ground form is read from the protein component alone:
  // the ground in the rice does not make the chicken ground meat,
  // and the ground in the beef does.
  assert.equal(classifyIngredient('ground rice with chicken').cookingRule.kind, 'poultry');
  assert.equal(classifyIngredient('rice with ground beef').cookingRule.kind, 'ground');
});

// 6. Repeated occurrences (audit v26): two occurrences of the same
// species are two items when their condition or their cooking rule
// disagrees — and one item when they agree. The first component's
// condition never stands for the others, and the entry's condition
// is the condition all occurrences agree on (or unknown, when they
// do not).
test('invariant: repeated occurrences — the same name is not the same item', () => {
  const { proteinOccurrences, occurrencesConflict } = classifier;
  // Same species, different condition -> conflict.
  for (const input of [
    'cooked chicken with raw chicken',
    'cooked chicken with partially cooked chicken',
    'cooked beef with raw ground beef',
    'raw chicken with cooked chicken',
  ]) {
    assert.equal(occurrencesConflict(input), true, `${input}: the conditions disagree`);
    const r = classifyIngredient(input);
    assert.equal(r.ambiguousProteins, true, `${input}: ambiguous`);
    assert.equal(r.requiresSeparation, true, `${input}: separate`);
    assert.equal(r.condition, 'unknown', `${input}: no single condition`);
    assert.equal(r.cookingRule, null, `${input}: no rule — two items, two states`);
    assert.equal(r.recipeAction, 'ask_user', `${input}: ask, never guess`);
    assert.equal(separateProteins(input).length, 2, `${input}: two entries to separate into`);
  }
  // Same species, same condition, different rule -> conflict (two cooks).
  assert.equal(occurrencesConflict('ground beef with beef steak'), true, 'a ground beef and a whole beef are two cooks');
  assert.deepEqual(separateProteins('ground beef with beef steak'), ['ground beef', 'beef steak']);
  // Same species, same condition, same rule -> merge.
  for (const input of ['raw chicken with raw chicken', 'ground chicken with chicken', 'shrimp and prawn']) {
    assert.equal(occurrencesConflict(input), false, `${input}: the occurrences agree`);
    assert.equal(classifyIngredient(input).ambiguousProteins, false, `${input}: one protein`);
    assert.equal(separateProteins(input).length, 1, `${input}: one entry`);
  }
  // The occurrences themselves carry identity + condition + rule.
  assert.deepEqual(
    proteinOccurrences('cooked chicken with raw chicken').map((o) => [o.identity, o.condition]),
    [['chicken', 'cooked'], ['chicken', 'raw']],
  );
  assert.deepEqual(
    proteinOccurrences('raw chicken with raw chicken').map((o) => [o.identity, o.condition]),
    [['chicken', 'raw'], ['chicken', 'raw']],
  );
});

// Audit v26: the repeated-occurrence cases are tested through
// generateMenu(), not only the classifier — the blocker is the
// point, and the blocker lives in generateMenu.
test('invariant: repeated occurrences block the recipe at generateMenu level', async () => {
  const { generateMenu } = pipeline;
  const blocked = [
    'cooked chicken with raw chicken, cold rice',
    'cooked chicken with partially cooked chicken, cold rice',
    'cooked beef with raw ground beef, cold rice',
    'raw chicken with cooked chicken, cold rice',
    'ground beef with beef steak, cold rice',
  ];
  for (const ingredients of blocked) {
    const res = await generateMenu({ ingredients, lang: 'en', sessionId: 'invariant-repeat' });
    assert.equal(res.ok, false, `${ingredients}: no recipe`);
    assert.equal(res.rejected, true, `${ingredients}: rejected`);
    assert.equal(res.reason_code, 'ambiguous_protein', `${ingredients}: the blocker`);
    assert.equal(res.menu, undefined, `${ingredients}: there is no menu to warn inside of`);
    assert.match(res.reason, /more than one animal protein/, `${ingredients}: the reason names the conflict`);
  }
  // And the consistent repeats are NOT blocked — they are one
  // protein, cooked at its own temperature.
  const consistent = await generateMenu({ ingredients: 'raw chicken with raw chicken, cold rice', lang: 'en', sessionId: 'invariant-consistent' });
  assert.equal(consistent.ok, true, 'a raw chicken written twice is one raw chicken');
  assert.match(consistent.menu.preparation.join('\n'), /74°C \(165°F\)/, 'the chicken gets the chicken temperature');
  const synonym = await generateMenu({ ingredients: 'shrimp and prawn, cold rice', lang: 'en', sessionId: 'invariant-synonym' });
  assert.equal(synonym.ok, true, 'a verified synonym merges');
});

// Audit v26: beef broth is a stock — the exact compound, not a broad
// "broth" word. The chicken is the only protein, in either order,
// and a second protein next to it is still found.
test('beef broth is a stock, and the chicken next to it is the only protein', async () => {
  const { generateMenu } = pipeline;
  const broth = { text: 'beef broth', role: 'stock', protein: null, proteins: [] };
  const chicken = { text: 'raw chicken', role: 'primary_protein', protein: 'chicken', proteins: ['chicken'] };
  assert.deepEqual(parseComponents('beef broth with raw chicken'), [broth, chicken]);
  assert.deepEqual(parseComponents('raw chicken with beef broth'), [chicken, broth]);
  for (const input of ['beef broth with raw chicken', 'raw chicken with beef broth']) {
    const r = classifyIngredient(input);
    assert.deepEqual(primaryProteins(input), ['chicken'], `${input}: only the chicken is a protein`);
    assert.equal(r.ambiguousProteins, false, `${input}: one protein`);
    assert.equal(r.proteinIdentity, 'chicken', `${input}: the protein is the chicken, not the beef in the broth`);
    const res = await generateMenu({ ingredients: `${input}, cold rice`, lang: 'en', sessionId: 'invariant-broth' });
    assert.equal(res.ok, true, `${input}: a recipe is made`);
    assert.match(res.menu.preparation.join('\n'), /74°C \(165°F\)/, `${input}: the chicken gets the chicken temperature`);
  }
  // A second protein next to the broth is still found.
  const r = classifyIngredient('chicken with beef broth and raw turkey');
  assert.deepEqual(primaryProteins('chicken with beef broth and raw turkey'), ['chicken', 'turkey']);
  assert.equal(r.ambiguousProteins, true, 'the turkey is found, not hidden by the broth');
  const res = await generateMenu({ ingredients: 'chicken with beef broth and raw turkey, cold rice', lang: 'en', sessionId: 'invariant-broth-turkey' });
  assert.equal(res.ok, false, 'two proteins plus a stock is blocked');
  assert.equal(res.reason_code, 'ambiguous_protein');
});

// 7. No protein disappears (audit v27): every detected identity
// becomes an explicit occurrence. "&" and "/" cut a sub-phrase the
// way "and" does, and a sub-phrase with no separator at all still
// lists every protein it holds. The classifier and the preflight
// gate must agree — a protein the parser finds cannot be missing
// from the occurrence model.
test('invariant: no detected protein disappears — every identity becomes an occurrence', () => {
  // The audit's cases: "&" and "/" are separators, and the entry
  // is separated (or the user is asked to choose).
  for (const input of ['chicken & turkey', 'chicken/turkey', 'raw chicken/raw turkey', 'raw chicken & cooked turkey']) {
    assert.equal(occurrencesConflict(input), true, `${input}: two identities, one entry`);
    const r = classifyIngredient(input);
    assert.equal(r.ambiguousProteins, true, `${input}: ambiguous`);
    assert.equal(r.requiresSeparation, true, `${input}: separate or choose`);
    assert.equal(r.cookingRule, null, `${input}: no rule`);
    assert.equal(r.recipeAction, 'ask_user', `${input}: ask`);
    assert.equal(separateProteins(input).length, 2, `${input}: two entries to separate into`);
  }
  // The parser and the occurrence model agree: the identities the
  // parser finds are exactly the identities in the occurrences.
  for (const input of ['chicken/turkey', 'chicken & turkey', 'chicken turkey', 'chicken with fish sauce and raw beef', 'fish sauce & raw beef', 'shrimp & prawn']) {
    const parsed = parseComponents(input).flatMap((c) => c.proteins);
    const occurred = proteinOccurrences(input).map((o) => o.identity);
    assert.deepEqual(occurred, parsed, `${input}: the occurrences are exactly the parsed proteins`);
    assert.deepEqual(primaryProteins(input), [...new Set(parsed)], `${input}: the primary proteins agree too`);
  }
  // A sub-phrase with no separator at all still lists both.
  assert.deepEqual(parseComponents('chicken turkey'), [
    { text: 'chicken turkey', role: 'primary_protein', protein: 'chicken', proteins: ['chicken', 'turkey'] },
  ]);
  assert.deepEqual(separateProteins('chicken turkey'), ['chicken', 'turkey'], 'the suggestion names the identities, not the ambiguous phrase');
  // A verified synonym still merges, even written with "&".
  assert.equal(occurrencesConflict('shrimp & prawn'), false, 'shrimp & prawn is one protein');
  assert.deepEqual(separateProteins('shrimp & prawn'), ['shrimp']);
  // A condiment next to a protein is still only the protein.
  assert.deepEqual(primaryProteins('fish sauce & raw beef'), ['beef']);
  assert.equal(classifyIngredient('fish sauce & raw beef').ambiguousProteins, false);
});

// Audit v27: the "&" and "/" cases are tested through generateMenu(),
// not only the classifier — the blocker is the point, and the
// blocker lives in generateMenu.
test('invariant: & and / combinations block the recipe at generateMenu level', async () => {
  const { generateMenu } = pipeline;
  const blocked = [
    'chicken & turkey, cold rice',
    'chicken/turkey, cold rice',
    'raw chicken/raw turkey, cold rice',
    'raw chicken & cooked turkey, cold rice',
    'chicken turkey, cold rice',
  ];
  for (const ingredients of blocked) {
    const res = await generateMenu({ ingredients, lang: 'en', sessionId: 'invariant-sep' });
    assert.equal(res.ok, false, `${ingredients}: no recipe`);
    assert.equal(res.rejected, true, `${ingredients}: rejected`);
    assert.equal(res.reason_code, 'ambiguous_protein', `${ingredients}: the blocker`);
    assert.equal(res.menu, undefined, `${ingredients}: there is no menu to warn inside of`);
  }
  // The audit's exact reproduction: "chicken/turkey, rice" must not
  // make a menu.
  const repro = await generateMenu({ ingredients: 'chicken/turkey, rice', lang: 'en', sessionId: 'invariant-repro' });
  assert.equal(repro.ok, false, 'the audit reproduction is blocked');
  assert.equal(repro.reason_code, 'ambiguous_protein');
  // And the merged cases are NOT blocked.
  const synonym = await generateMenu({ ingredients: 'shrimp & prawn, cold rice', lang: 'en', sessionId: 'invariant-sep-synonym' });
  assert.equal(synonym.ok, true, 'a verified synonym merges');
  const condiment = await generateMenu({ ingredients: 'fish sauce & raw beef, cold rice', lang: 'en', sessionId: 'invariant-sep-condiment' });
  assert.equal(condiment.ok, true, 'a condiment next to a protein is one protein');
  assert.match(condiment.menu.preparation.join('\n'), /63°C \(145°F\)/, 'the beef gets the beef temperature');
});

// 5. Fail-safe blocking: an ambiguous entry never produces a recipe
// — not even the local fallback — and a compound never hides a
// protein from the blocker.
test('invariant: fail-safe blocking — an ambiguous entry never produces a recipe', async () => {
  const { generateMenu } = pipeline;
  const blocked = [
    'raw chicken with raw fish, cold rice',
    'chicken and turkey, cold rice',
    'beef and pork, cold rice',
    'chicken with fish sauce and raw beef, cold rice',
    'salmon and tuna, cold rice',
  ];
  for (const ingredients of blocked) {
    const res = await generateMenu({ ingredients, lang: 'en', sessionId: 'invariant-blocked' });
    assert.equal(res.ok, false, `${ingredients}: no recipe`);
    assert.equal(res.rejected, true, `${ingredients}: rejected`);
    assert.equal(res.reason_code, 'ambiguous_protein', `${ingredients}: the blocker, not a warning`);
    assert.equal(res.menu, undefined, `${ingredients}: there is no menu to warn inside of`);
  }
  // And the compound that used to hide the beef no longer does: the
  // beef is found, so the entry is blocked — not cooked at the
  // chicken's temperature.
  const hidden = await generateMenu({ ingredients: 'chicken with fish sauce and raw beef, cold rice', lang: 'en', sessionId: 'invariant-hidden' });
  assert.equal(hidden.ok, false);
  assert.match(hidden.reason, /"chicken" and "raw beef"/, 'the suggestion names the beef');
  // A single protein next to a compound is NOT blocked — it is
  // cooked at its own temperature.
  const single = await generateMenu({ ingredients: 'fish sauce with raw beef, cold rice', lang: 'en', sessionId: 'invariant-single' });
  assert.equal(single.ok, true, 'one protein plus a condiment is a recipe');
  assert.match(single.menu.preparation.join('\n'), /63°C \(145°F\)/, 'the beef gets the beef temperature');
});

// Audit v22: the protein subject is the phrase that holds the protein.
// Every condition check reads this phrase alone.
// Audit v25: the subject is resolved from the full candidate list
// (the components), never by scanning the raw input for the first
// protein word. A condiment is not a protein, so "fish sauce with
// raw beef" is a raw beef — and a bare "fish sauce" has no subject
// at all.
test('proteinSubjectPart identifies the phrase that holds the protein', () => {
  assert.equal(proteinSubjectPart('cooked chicken with raw salad'), 'cooked chicken');
  assert.equal(proteinSubjectPart('rice with cooked chicken'), 'cooked chicken');
  assert.equal(proteinSubjectPart('fried rice with raw chicken'), 'raw chicken');
  assert.equal(proteinSubjectPart('chicken in sauce'), 'chicken');
  assert.equal(proteinSubjectPart('chicken with fried rice'), 'chicken');
  assert.equal(proteinSubjectPart('fish sauce'), null, 'a condiment is not a protein — no subject');
  assert.equal(proteinSubjectPart('fish sauce with raw beef'), 'raw beef', 'the condiment does not steal the subject');
  assert.equal(proteinSubjectPart('raw beef with fish sauce'), 'raw beef');
  assert.equal(proteinSubjectPart('partially cooked chicken nuggets'), 'partially cooked chicken nuggets');
  assert.equal(proteinSubjectPart('cold rice'), null, 'no protein, no subject');
  assert.equal(proteinSubjectPart('rice with chicken'), 'chicken');
});

// --- Normalization ------------------------------------------------------
// NFKC, lowercase, whitespace, apostrophes, hyphens — the same input
// in different clothing classifies the same way.
test('normalization: case, spacing, apostrophes and hyphens do not change the decision', () => {
  assert.equal(classifyIngredient('RAW  CHICKEN').condition, 'raw');
  assert.equal(classifyIngredient('  raw   chicken  ').condition, 'raw');
  assert.equal(classifyIngredient('Raw Chicken').condition, 'raw');
  assert.equal(classifyIngredient('CHICKEN').condition, 'unknown');
  assert.equal(classifyIngredient('chicken’s').condition, 'unknown', 'a curly apostrophe is normalised');
  assert.equal(classifyIngredient('paper‐thin beef').condition, 'unknown', 'a unicode hyphen is normalised');
  assert.equal(classifyIngredient('raw\tchicken').condition, 'raw', 'a tab is whitespace');
});

// --- The word "cooked" is never proof on its own ------------------------
test('the word cooked alone never proves a cooked condition', () => {
  for (const input of [
    'not cooked chicken', 'chicken not cooked', 'not yet cooked chicken',
    'chicken has not yet been properly cooked', 'not fully cooked chicken',
    'chicken is not cooked', 'never cooked chicken',
  ]) {
    const r = classifyIngredient(input);
    assert.notEqual(r.condition, 'cooked', `${input} must not be cooked`);
    assert.equal(r.condition, 'unknown', `${input} is unknown`);
    assert.equal(r.recipeAction, 'ask_user', `${input} asks the guest`);
  }
  for (const input of ['partially cooked chicken', 'half-cooked beef', 'partly cooked salmon']) {
    assert.notEqual(classifyIngredient(input).condition, 'cooked', `${input} must not be cooked`);
  }
});

// --- User overrides -----------------------------------------------------
// The guest's explicit selection beats the text — but never spoilage.
test('explicit user condition beats the text, never spoilage', () => {
  assert.equal(classifyIngredient('chicken', 'raw').condition, 'raw');
  assert.equal(classifyIngredient('chicken', 'raw').recipeAction, 'cook_through');
  assert.equal(classifyIngredient('chicken', 'cooked').condition, 'cooked');
  assert.equal(classifyIngredient('chicken', 'cooked').recipeAction, 'include');
  assert.equal(classifyIngredient('raw chicken', 'cooked').condition, 'cooked', 'the guest corrects the text');
  assert.equal(classifyIngredient('fried chicken', 'raw').condition, 'raw', 'the guest corrects the text');
  const spoiled = classifyIngredient('moldy chicken', 'cooked');
  assert.equal(spoiled.condition, 'cooked', 'the selection is recorded');
  assert.equal(spoiled.recipeAction, 'exclude', 'but spoilage still excludes it');
  assert.equal(spoiled.spoilage, true);
  // An override on something with no condition to resolve is ignored.
  assert.equal(classifyIngredient('rice', 'raw').condition, 'not_applicable');
  assert.equal(classifyIngredient('fish sauce', 'cooked').condition, 'not_applicable');
  assert.equal(classifyIngredient('chicken', null).condition, 'unknown');
  assert.equal(classifyIngredient('chicken', 'maybe').condition, 'unknown', 'an invalid override is ignored');
});

// The override rewrite: the condition expression is removed first, so
// the choice resolves instead of piling up next to the negation.
test('applyConditionOverride rewrites the text the server re-derives', () => {
  assert.equal(applyConditionOverride('chicken', 'raw'), 'raw chicken');
  assert.equal(applyConditionOverride('not cooked chicken', 'cooked'), 'cooked chicken');
  assert.equal(applyConditionOverride('chicken has not yet been properly cooked', 'raw'), 'raw chicken');
  assert.equal(applyConditionOverride('chicken with fried rice', 'cooked'), 'cooked chicken with fried rice');
  assert.equal(applyConditionOverride('93% lean ground beef', 'raw'), 'raw 93% lean ground beef');
  assert.equal(applyConditionOverride('cold smoked salmon', 'cooked'), 'cooked salmon');
  assert.equal(applyConditionOverride('partially cooked beef', 'raw'), 'raw beef');
  assert.equal(applyConditionOverride('fried chicken', 'raw'), 'raw chicken');
  // Audit v23: a negated "raw" is removed too, so the choice resolves
  // instead of piling up next to the negation.
  assert.equal(applyConditionOverride('not raw chicken', 'cooked'), 'cooked chicken');
  assert.equal(applyConditionOverride('not raw chicken', 'raw'), 'raw chicken');
  assert.equal(applyConditionOverride('chicken is not raw', 'cooked'), 'cooked chicken');
  assert.equal(applyConditionOverride("chicken isn't raw", 'raw'), 'raw chicken');
  // Audit v22: the choice is written into the PROTEIN SUBJECT, not
  // the first phrase — the buttons change the chicken's condition,
  // not the rice's.
  assert.equal(applyConditionOverride('rice with chicken', 'raw'), 'rice with raw chicken', 'Raw changes the chicken, not the rice');
  assert.equal(applyConditionOverride('rice with chicken', 'cooked'), 'rice with cooked chicken', 'Cooked changes the chicken, not the rice');
  assert.equal(applyConditionOverride('cooked chicken with raw salad', 'raw'), 'raw chicken with raw salad', 'the salad keeps its own condition');
  assert.equal(applyConditionOverride('fried rice with uncooked chicken', 'cooked'), 'fried rice with cooked chicken', 'the rice keeps its fried');
  // The rewritten text classifies to the choice — the server, which
  // only ever sees this text, derives the same condition.
  for (const [input, choice] of [['chicken', 'raw'], ['not cooked chicken', 'cooked'], ['chicken has not yet been properly cooked', 'raw'], ['chicken with fried rice', 'cooked'], ['rice with chicken', 'raw'], ['rice with chicken', 'cooked']]) {
    const rewritten = applyConditionOverride(input, choice);
    assert.equal(classifyIngredient(rewritten).condition, choice, `${rewritten} must classify as ${choice}`);
  }
});

// --- One module, both sides ---------------------------------------------
// The backend and the frontend call the SAME classifier module: the
// pipeline re-exports the shared module's function object, and the
// frontend imports the same file. If either side ever kept its own
// copy, these fail.
test('backend and frontend call the same classifier module', () => {
  assert.strictEqual(pipeline.classifyIngredient, classifier.classifyIngredient, 'the pipeline re-exports the shared classifyIngredient');
  assert.strictEqual(pipeline.classifyIngredients, classifier.classifyIngredients, 'the pipeline re-exports the shared classifyIngredients');
  assert.strictEqual(pipeline.coreIdentity, classifier.coreIdentity, 'the pipeline re-exports the shared coreIdentity');
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /from ['"]\.\.\/shared\/ingredient-classifier\.mjs['"]/, 'app.js imports the shared classifier');
  assert.match(appJs, /classifyIngredient\(/, 'app.js calls classifyIngredient');
  assert.doesNotMatch(appJs, /SPECIES_WORDS|COMPOUND_LEXICON|CONDITION_QUALIFIERS|NOT_COOKED_RE|NOT_RAW_RE|PARTIALLY_COOKED_RE/, 'app.js keeps no copy of the classification rules');
  const pipelineJs = readFileSync(new URL('../src/pipeline.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(pipelineJs, /RAW_RISK_PATTERNS|COOKED_QUALIFIER_RE|NOT_COOKED_RE|NOT_RAW_RE|PARTIALLY_COOKED_RE|PROCESSED_PRODUCT_RE|ANIMAL_PRODUCT_RE|COMPOUND_LEXICON/, 'pipeline.mjs keeps no copy of the classification regexes');
});

// The picker and the backend agree on the same inputs: the chip appears
// exactly when the classifier says the item requires confirmation.
test('frontend picker and backend classifier agree on the same inputs', async () => {
  const { classifyIngredient: classify } = classifier;
  const inputs = [
    'raw chicken', 'fully cooked chicken', 'not cooked chicken',
    'chicken has not yet been properly cooked', 'partially cooked beef',
    'chicken with fried rice', 'chicken in sauce', 'fish sauce',
    'egg noodles', 'raw pork sausage', 'moldy raw chicken',
    'fresh bread', 'moldy bread', 'pork sausage', 'cold smoked salmon',
    'fried chicken', 'chicken', 'one egg',
  ];
  for (const input of inputs) {
    // The picker's rule is exactly requiresConfirmation (see
    // bareAnimalItems in public/app.js); assert the classifier's
    // answer for each input, so a drift between the two fails here.
    const r = classify(input);
    assert.equal(typeof r.requiresConfirmation, 'boolean', `${input}: requiresConfirmation is a boolean`);
  }
  // And the spoiled disambiguation the audit earned still holds at the
  // classifier level: a safe item sharing the core does not condemn
  // the menu, and a lone spoiled item does.
  const { menuNamesSpoiled } = pipeline;
  assert.equal(menuNamesSpoiled({ title: 'Bread', preparation: ['Add the bread.'] }, ['moldy bread'], ['fresh bread']), false, 'fresh bread disambiguates');
  assert.equal(menuNamesSpoiled({ title: 'Bread', preparation: ['Add the bread.'] }, ['moldy bread'], []), true, 'a lone moldy bread is caught');
});

// --- Fail safe ----------------------------------------------------------
// An unknown condition is treated as raw for the recipe (the
// thermometer step covers it), and the warning says the condition is
// unknown. A menu that never proves the item was cooked through is
// discarded for the safe local menu — including a two-minute
// instruction with no temperature.
test('unknown conditions fail safely end to end', async () => {
  const { generateMenu } = pipeline;
  const unknown = await generateMenu({ ingredients: 'chicken has not yet been properly cooked, rice', lang: 'en', sessionId: 'classifier-unknown' });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.unknown_condition_items, ['chicken has not yet been properly cooked']);
  assert.match(unknown.menu.food_safety, /CONDITION UNKNOWN/);
  assert.match(unknown.menu.preparation.join('\n'), /74°C \(165°F\)/, 'the recipe still cooks it through');
  assert.match(unknown.menu.safety_warning, /does not know whether/);

  const partial = await generateMenu({ ingredients: 'partially cooked beef, rice', lang: 'en', sessionId: 'classifier-partial' });
  assert.deepEqual(partial.unknown_condition_items, ['partially cooked beef']);
  assert.match(partial.menu.preparation.join('\n'), /63°C \(145°F\)/, 'a partially cooked whole cut still gets its temperature');

  // A bare animal product never gets a plain two-minute instruction
  // without the thermometer step.
  const bare = await generateMenu({ ingredients: 'chicken, rice', lang: 'en', sessionId: 'classifier-bare' });
  assert.deepEqual(bare.unknown_condition_items, ['chicken']);
  assert.match(bare.menu.preparation.join('\n'), /food thermometer/, 'the thermometer step is present');
});

// Audit v22: a raw protein whose type is unknown ("raw meat") asks
// for protein clarification instead of a temperature. The recipe
// never offers 74/71/63 for it, the label says the protein is
// unknown, and the deterministic step tells the guest to identify
// the protein first.
test('raw meat requires protein clarification, never a temperature', async () => {
  const { generateMenu, rawCookthroughStep, menuMentionsRawCookthrough } = pipeline;
  const res = await generateMenu({ ingredients: 'raw meat, cold rice', lang: 'en', sessionId: 'classifier-raw-meat' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.raw_risk_items, [], 'a raw meat is not raw risk — its protein is unknown');
  assert.deepEqual(res.unknown_condition_items, [], 'a raw meat is not a condition question');
  assert.deepEqual(res.needs_protein_clarification_items, ['raw meat']);
  assert.match(res.menu.food_safety, /PROTEIN UNKNOWN/);
  assert.match(res.menu.safety_warning, /does not know which protein raw meat is/);
  const prep = res.menu.preparation.join('\n');
  assert.match(prep, /identify the raw meat before cooking it/, 'the step asks for the protein first');
  assert.doesNotMatch(prep, /74°C|71°C|63°C/, 'no temperature is claimed for an unidentified protein');
  // The deterministic step gives the identification clause, not the
  // reference table, and no LLM temperature can prove an unidentified
  // protein — the gate must reject every temperature for it.
  assert.match(rawCookthroughStep(['raw meat']), /identify the raw meat/);
  assert.doesNotMatch(rawCookthroughStep(['raw meat']), /74°C|71°C|63°C/);
  assert.equal(menuMentionsRawCookthrough({ title: 'Meat', preparation: ['Cook the raw meat until a food thermometer reads 71°C (160°F).'] }, ['raw meat']), false, 'a real temperature still proves nothing for an unknown protein');
});

// Audit v23: more than one primary protein in one entry asks for
// separation. The recipe never offers one temperature for two
// proteins, the label says the combination is ambiguous, and the
// deterministic step tells the guest to separate them first.
// Audit v24: the combination is a PREFLIGHT BLOCKER — no recipe is
// made at all, not even the local fallback, until the guest
// separates them. A warning in the middle of a recipe that already
// cooked the mixture is a contradiction.
test('an ambiguous protein combination blocks the recipe, never a menu', async () => {
  const { generateMenu, rawCookthroughStep, menuMentionsRawCookthrough } = pipeline;
  const res = await generateMenu({ ingredients: 'raw chicken with raw fish, cold rice', lang: 'en', sessionId: 'classifier-ambiguous' });
  assert.equal(res.ok, false, 'no recipe is made for an ambiguous combination');
  assert.equal(res.rejected, true);
  assert.equal(res.reason_code, 'ambiguous_protein');
  assert.deepEqual(res.ambiguous_protein_items, ['raw chicken with raw fish']);
  assert.equal(res.menu, undefined, 'there is no menu to warn inside of');
  assert.match(res.reason, /more than one animal protein in raw chicken with raw fish/);
  assert.match(res.reason, /"raw chicken" and "raw fish"/, 'the reason suggests the split, ready to copy');
  assert.match(res.reason, /refuses to guess which temperature belongs to whom/);
  // The same compound that hid the beef in v24 is blocked too.
  const hidden = await generateMenu({ ingredients: 'chicken with fish sauce and raw beef, cold rice', lang: 'en', sessionId: 'classifier-hidden' });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason_code, 'ambiguous_protein');
  assert.deepEqual(hidden.ambiguous_protein_items, ['chicken with fish sauce and raw beef']);
  assert.match(hidden.reason, /"chicken" and "raw beef"/, 'the sauce is not in the suggestion');
  // The deterministic step still gives the separation clause (it is
  // the fallback's last line of defence), and no LLM temperature
  // can prove a combination — the gate must reject it.
  assert.match(rawCookthroughStep(['raw chicken with raw fish']), /separate the raw chicken with raw fish/);
  assert.doesNotMatch(rawCookthroughStep(['raw chicken with raw fish']), /74°C|71°C|63°C/);
  assert.equal(menuMentionsRawCookthrough({ title: 'Surf and Turf', preparation: ['Cook the raw chicken and raw fish until a food thermometer reads 74°C (165°F).'] }, ['raw chicken with raw fish']), false, 'one temperature for two proteins proves nothing');
  // But the exemption holds: a processed compound is not a second
  // protein, so "chicken with fish sauce" is an unknown chicken and
  // the menu IS made.
  const sauce = await generateMenu({ ingredients: 'chicken with fish sauce, cold rice', lang: 'en', sessionId: 'classifier-sauce' });
  assert.equal(sauce.ok, true, 'a compound alone does not block');
  assert.deepEqual(sauce.ambiguous_protein_items, []);
  assert.deepEqual(sauce.unknown_condition_items, ['chicken with fish sauce']);
  assert.match(sauce.menu.preparation.join('\n'), /74°C \(165°F\)/, 'the chicken still gets its temperature');
  // And a synonym pair is not a combination at all: the menu is made.
  const synonym = await generateMenu({ ingredients: 'shrimp and prawn, cold rice', lang: 'en', sessionId: 'classifier-synonym' });
  assert.equal(synonym.ok, true, 'two words for one ingredient do not block');
  assert.deepEqual(synonym.ambiguous_protein_items, []);
});

// Spoiled ingredients are excluded from every recipe path — the local
// fallback, the LLM menu (via the gate), and the deterministic step.
test('spoiled ingredients are excluded from every recipe path', async () => {
  const { generateMenu } = pipeline;
  const res = await generateMenu({ ingredients: 'moldy raw chicken, cold rice', lang: 'en', sessionId: 'classifier-spoiled' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.spoiled_items, ['moldy raw chicken']);
  assert.deepEqual(res.raw_risk_items, [], 'a spoiled raw item is reported as spoiled, never as raw risk');
  assert.deepEqual(res.unknown_condition_items, [], 'a spoiled item is never asked about');
  assert.doesNotMatch(res.menu.preparation.join('\n'), /moldy raw chicken/, 'the recipe never names the spoiled item');
  assert.match(res.menu.food_safety, /SPOILAGE WARNING/);

  const allSpoiled = await generateMenu({ ingredients: 'moldy bread, expired yogurt', lang: 'en', sessionId: 'classifier-all-spoiled' });
  assert.equal(allSpoiled.ok, false, 'nothing left worth cooking is a refusal');
  assert.equal(allSpoiled.reason_code, 'spoiled');
});

// The backend validates an override by re-deriving it from the text:
// there is no client-sent condition field, and the classification
// comes only from the submitted ingredients.
test('the backend derives the condition from the submitted text alone', async () => {
  const { generateMenu } = pipeline;
  const bare = await generateMenu({ ingredients: 'chicken, rice', lang: 'en', sessionId: 'classifier-derive-1' });
  assert.deepEqual(bare.unknown_condition_items, ['chicken'], 'a bare chicken is unknown');
  const cooked = await generateMenu({ ingredients: 'cooked chicken, rice', lang: 'en', sessionId: 'classifier-derive-2' });
  assert.deepEqual(cooked.unknown_condition_items, [], 'the same chicken, submitted as cooked, is cooked');
  assert.deepEqual(cooked.raw_risk_items, [], 'and it is not raw risk either');
  const raw = await generateMenu({ ingredients: 'raw chicken, rice', lang: 'en', sessionId: 'classifier-derive-3' });
  assert.deepEqual(raw.raw_risk_items, ['raw chicken'], 'submitted as raw, it is raw risk');
});
