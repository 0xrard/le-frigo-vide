import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DB per test file, before any pipeline import.
const dir = mkdtempSync(join(tmpdir(), 'le-frigo-vide-safety-'));
process.env.LE_FRIGO_DB = join(dir, 'safety.sqlite');

const { initDb } = await import('../src/db.mjs');
const {
  localSafetyCheck, localSpoilageCheck, localRawRiskCheck,
  filterLlmUnsafeItems, foodSafetyLabel, generateMenu,
} = await import('../src/pipeline.mjs');

test.before(() => { initDb(); });

test('real foods with scary-looking words pass the food-category gate', () => {
  for (const food of ['rice paper', 'glass noodles', 'rice noodles', 'paper-thin beef', 'sponge cake']) {
    assert.deepEqual(localSafetyCheck([food]), [], `${food} must not be refused`);
  }
});

test('non-food objects are still refused', () => {
  for (const bad of ['2 AA batteries', 'dish soap', 'bleach', 'detergent', 'broken glass', 'shattered glass', 'glass', 'paper']) {
    assert.equal(localSafetyCheck([bad]).length, 1, `${bad} must be refused`);
  }
  // The trap preset still refuses as a whole.
  assert.deepEqual(localSafetyCheck(['2 AA batteries', 'cold rice', 'dish soap']).sort(), ['2 AA batteries', 'dish soap']);
});

test('spoilage is detected, never treated as non-food', () => {
  for (const bad of ['moldy bread', 'expired yogurt', 'rotten tomato', 'spoiled milk']) {
    assert.deepEqual(localSpoilageCheck([bad]), [bad], `${bad} is spoiled`);
    assert.deepEqual(localSafetyCheck([bad]), [], `${bad} is still food — not a refusal`);
  }
  assert.deepEqual(localSpoilageCheck(['cold rice', 'cheese']), [], 'fresh food is not spoiled');
});

test('raw animal products are flagged for cooking, not for disposal', () => {
  assert.deepEqual(localRawRiskCheck(['raw chicken']), ['raw chicken']);
  assert.deepEqual(localRawRiskCheck(['raw pork']), ['raw pork']);
  assert.deepEqual(localRawRiskCheck(['roast chicken', 'rice']), [], 'cooked chicken is fine');
  assert.deepEqual(localSpoilageCheck(['raw chicken']), [], 'raw is not spoiled');
});

test('the LLM may never expand the refusal set to spoiled food (regression)', () => {
  assert.deepEqual(filterLlmUnsafeItems(['expired yogurt'], ['expired yogurt']), []);
  assert.deepEqual(filterLlmUnsafeItems(['expired yogurt', 'cold rice'], ['expired yogurt', 'cold rice']), []);
  assert.deepEqual(filterLlmUnsafeItems(['2 AA batteries'], ['2 AA batteries']).length, 1);
  assert.deepEqual(filterLlmUnsafeItems(['battery'], ['cold rice']), [], 'a hallucinated battery does not reject safe food');
});

test('labels are honest: never "Technically Edible (Verified)"', () => {
  assert.match(foodSafetyLabel({}), /FOOD CATEGORY: PASSED \| SAFETY: NOT VERIFIED \(Entertainment Only\)/);
  assert.match(foodSafetyLabel({ spoiled: ['moldy bread'] }), /SPOILAGE WARNING: DO NOT CONSUME/);
  assert.match(foodSafetyLabel({ rawRisk: ['raw chicken'] }), /RAW RISK: COOK THOROUGHLY, NEVER EAT RAW/);
  // English-only MVP (v18.1): a lang parameter is accepted and ignored.
  assert.match(foodSafetyLabel({ lang: 'id' }), /FOOD CATEGORY: PASSED \| SAFETY: NOT VERIFIED \(Entertainment Only\)/);
});

test('a spoiled menu is generated (entertainment) but carries DO NOT CONSUME', async () => {
  const result = await generateMenu({ ingredients: 'moldy bread, cheese', lang: 'en', sessionId: 'safety-spoil' });
  assert.equal(result.ok, true, 'spoiled food is not refused');
  assert.equal(result.rejected, false);
  assert.equal(result.spoilage_warning, true);
  assert.deepEqual(result.spoiled_items, ['moldy bread']);
  assert.match(result.menu.food_safety, /SPOILAGE WARNING: DO NOT CONSUME/);
  assert.match(result.menu.safety_warning, /DO NOT eat it/);
  // P0-A: the recipe itself must never cook the spoiled ingredient.
  const recipe = [result.menu.title, ...result.menu.preparation].join('\n').toLowerCase();
  assert.ok(!recipe.includes('moldy bread'), `recipe must not name the spoiled item, got: ${recipe.slice(0, 200)}`);
  assert.ok(result.menu.preparation.some((s) => /cheese/i.test(s)), 'the safe ingredient is cooked');
  assert.match(result.menu.aura_analysis, /set aside for the bin/, 'the aura says the spoiled item was set aside');
});

test('when NOTHING is safe, the chef refuses to cook — no menu at all', async () => {
  const result = await generateMenu({ ingredients: 'moldy bread, expired yogurt', lang: 'en', sessionId: 'safety-all-spoiled' });
  assert.equal(result.ok, false, 'all-spoiled is a refusal');
  assert.equal(result.rejected, true);
  assert.equal(result.reason_code, 'spoiled');
  assert.equal(result.menu, undefined, 'no menu is produced');
  assert.match(result.reason, /refuses to cook/);
});

test('menuNamesSpoiled catches an LLM menu that cooks a spoiled ingredient', async () => {
  const { menuNamesSpoiled } = await import('../src/pipeline.mjs');
  assert.equal(menuNamesSpoiled({ title: 'The Moldy Bread, Absolute', preparation: ['Add the cheese.'] }, ['moldy bread']), true, 'spoiled title');
  assert.equal(menuNamesSpoiled({ title: 'A Safe Dish', preparation: ['Add the moldy bread as a metaphor.'] }, ['moldy bread']), true, 'spoiled step');
  // Audit v20 P1-B: the check is by identity, not by exact name — the
  // LLM may drop the modifier and write "Add the bread" for a "moldy
  // bread", and that bread can only be the moldy one.
  assert.equal(menuNamesSpoiled({ title: 'A Safe Dish', preparation: ['Add the cheese.', 'Add the bread.'] }, ['moldy bread']), true, 'a bare core mention is the spoiled item when no safe one shares the core');
  // ...unless a safe item shares the core: the LLM only ever saw the
  // safe list, so its "bread" may mean the fresh one.
  assert.equal(menuNamesSpoiled({ title: 'A Safe Dish', preparation: ['Add the cheese.', 'Add the bread.'] }, ['moldy bread'], ['fresh bread']), false, 'moldy + fresh bread together: the menu may mean the safe one');
  assert.equal(menuNamesSpoiled({ title: 'A Safe Dish', preparation: ['Add the fresh bread.'] }, ['moldy bread'], ['fresh bread']), false, 'an explicit fresh mention is safe');
  assert.equal(menuNamesSpoiled({ title: 'A Safe Dish', preparation: [] }, []), false, 'no spoiled items');
});

test('rice paper and glass noodles get a normal menu, no warning', async () => {
  const result = await generateMenu({ ingredients: 'rice paper, glass noodles', lang: 'en', sessionId: 'safety-ok' });
  assert.equal(result.ok, true);
  assert.equal(result.spoilage_warning, false);
  assert.equal(result.menu.safety_warning, null);
  assert.match(result.menu.food_safety, /FOOD CATEGORY: PASSED/);
});

test('raw chicken gets the cook-thoroughly warning, not a disposal order', async () => {
  const result = await generateMenu({ ingredients: 'raw chicken, rice', lang: 'en', sessionId: 'safety-raw' });
  assert.equal(result.ok, true);
  assert.equal(result.spoilage_warning, false, 'raw is not spoilage');
  assert.match(result.menu.food_safety, /RAW RISK: COOK THOROUGHLY/);
  assert.match(result.menu.safety_warning, /never eat it raw/);
});

// Audit v14 P0-B + v15 P1: "cook for two minutes" is not a doneness
// guarantee — and neither are "no pink flesh" or "clear juices" (CDC).
// The local fallback must name a food thermometer and the internal
// temperature for the cut (poultry 74°C / 165°F).
test('raw chicken gets a deterministic cook-through step, not just a warning', async () => {
  const result = await generateMenu({ ingredients: 'raw chicken, rice', lang: 'en', sessionId: 'safety-raw-step' });
  assert.equal(result.ok, true);
  const steps = result.menu.preparation.join('\n');
  assert.match(steps, /food thermometer/, 'the recipe names a thermometer');
  assert.match(steps, /74°C \(165°F\)/, 'the recipe names the poultry temperature');
  assert.match(steps, /not proof/, 'the recipe says colour and juices are not proof');
  assert.ok(!/no pink flesh/.test(steps), 'no pink flesh is no longer cited as proof');
  assert.ok(!/juices run clear/.test(steps), 'clear juices are no longer cited as proof');
});

// The raw-risk pattern must catch the common names AND ground/minced
// forms — a "raw salmon" that slips through is silently treated as
// safe (found by a smoke test of the thermometer step, 2026-11-27).
test('raw risk detection catches salmon, turkey, shrimp and ground forms', async () => {
  const { localRawRiskCheck } = await import('../src/pipeline.mjs');
  const found = localRawRiskCheck(['raw salmon', 'raw turkey', 'raw shrimp', 'raw ground beef', 'paper-thin beef', 'rice paper']);
  assert.deepEqual(found.sort(), ['raw ground beef', 'raw salmon', 'raw shrimp', 'raw turkey'].sort(), 'all raw animal products flagged');
  assert.ok(!found.includes('paper-thin beef'), 'paper-thin beef is still an allowlisted food, not raw risk');
});

test('raw ground beef and raw salmon get their own temperatures in the recipe', async () => {
  const result = await generateMenu({ ingredients: 'raw ground beef, raw salmon, rice', lang: 'en', sessionId: 'safety-raw-mixed' });
  assert.equal(result.ok, true);
  const steps = result.menu.preparation.join('\n');
  assert.match(steps, /71°C \(160°F\)/, 'ground beef 71°C');
  assert.match(steps, /63°C \(145°F\)/, 'salmon 63°C');
  assert.match(steps, /food thermometer/, 'thermometer named');
});

// Audit v16 P0-A: a spoiled raw item must never reach the recipe. The
// old code computed rawRisk from the FULL list, so the thermometer
// step told the guest to cook the very item the warning told them to
// throw away ("moldy raw chicken"). Raw risk now comes from the safe
// subset only; the spoiled item is reported as SPOILED, not as raw.
test('moldy raw chicken is reported as spoiled, never as a cooking instruction', async () => {
  const result = await generateMenu({ ingredients: 'moldy raw chicken, cheese', lang: 'en', sessionId: 'safety-spoiled-raw' });
  assert.equal(result.ok, true, 'the cheese is still cookable');
  assert.deepEqual(result.raw_risk_items, [], 'no raw risk left once the spoiled item is excluded');
  assert.deepEqual(result.spoiled_items, ['moldy raw chicken'], 'the spoiled item is still reported');
  assert.equal(result.menu.food_safety, 'SPOILAGE WARNING: DO NOT CONSUME', 'the label is spoilage only — no RAW RISK part');
  const recipe = [result.menu.title, ...result.menu.preparation].join('\n').toLowerCase();
  assert.ok(!recipe.includes('moldy raw chicken'), 'the recipe never cooks the spoiled item');
  assert.ok(!recipe.includes('thermometer'), 'no thermometer step for an item that must be thrown away');
  assert.match(result.menu.safety_warning, /throw (it|them) away/i, 'the warning still orders it thrown away');
});

// Audit v16 P1-D: ground salmon is fish (63°C), not ground meat (71°C);
// ground chicken is poultry (74°C). Classification is protein-first.
test('rawCookthroughStep classifies ground fish and ground poultry by protein', async () => {
  const { rawCookthroughStep } = await import('../src/pipeline.mjs');
  assert.match(rawCookthroughStep(['raw ground salmon'], 'en'), /63°C \(145°F\)/, 'ground salmon is fish, 63°C');
  assert.ok(!/71°C/.test(rawCookthroughStep(['raw ground salmon'], 'en')), 'ground salmon is NOT 71°C');
  assert.match(rawCookthroughStep(['raw ground chicken'], 'en'), /74°C \(165°F\)/, 'ground chicken is poultry, 74°C');
  assert.match(rawCookthroughStep(['raw ground beef'], 'en'), /71°C \(160°F\)/, 'ground beef is ground meat, 71°C');
});

// Audit v16 P1-C: a bare animal product ("chicken", "one egg") has an
// unknown condition. The server must not assume it is cooked — but
// must not claim it IS raw either. It is treated as raw for the recipe
// (fail safe) while the warning says the condition is unknown.
test('bare chicken gets the thermometer step with an honest unknown-condition warning', async () => {
  const { localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localUnknownConditionCheck(['chicken', 'raw chicken', 'cooked chicken', 'fried salmon', 'one egg', 'cold rice']).sort(),
    ['chicken', 'one egg'].sort(), 'only the unqualified animal products are unknown');
  const result = await generateMenu({ ingredients: 'chicken, cold rice', lang: 'en', sessionId: 'safety-unknown' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, [], 'a bare chicken is not claimed raw');
  assert.deepEqual(result.unknown_condition_items, ['chicken'], 'it is reported as unknown condition');
  assert.match(result.menu.food_safety, /CONDITION UNKNOWN/, 'the label says the condition is unknown');
  assert.match(result.menu.safety_warning, /does not know whether chicken is raw or already cooked/, 'the warning is honest about what is unknown');
  const steps = result.menu.preparation.join('\n');
  assert.match(steps, /food thermometer/, 'the recipe still verifies with a thermometer (fail safe)');
  assert.match(steps, /74°C \(165°F\)/, 'with the poultry temperature');
});

// Audit v17 P1: processed products are not the animal itself. Egg
// noodles, fish sauce, chicken broth, shrimp paste and beef jerky must
// get NO raw-risk warning, NO unknown-condition question and NO
// thermometer step — and neither must a smoked salmon (cured/cooked).
test('processed products are not flagged as raw or unknown-condition', async () => {
  const { localRawRiskCheck, localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  const processed = ['egg noodles', 'fish sauce', 'chicken broth', 'shrimp paste', 'beef jerky', 'chicken soup', 'canned tuna'];
  assert.deepEqual(localRawRiskCheck(processed), [], 'no processed product is raw risk');
  assert.deepEqual(localUnknownConditionCheck(processed), [], 'no processed product asks for a Raw / Cooked choice');
  const result = await generateMenu({ ingredients: 'egg noodles, fish sauce, chicken broth', lang: 'en', sessionId: 'safety-processed' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, [], 'the menu has no raw risk for processed products');
  assert.deepEqual(result.unknown_condition_items, [], 'and no unknown condition either');
  assert.equal(result.menu.safety_warning, null, 'nothing to warn about');
  assert.ok(!/thermometer/.test(result.menu.preparation.join('\n')), 'no thermometer step for a sauce or noodles');
  // And a real animal product next to them is still caught.
  const mixed = await generateMenu({ ingredients: 'fish sauce, raw salmon', lang: 'en', sessionId: 'safety-processed-mixed' });
  assert.deepEqual(mixed.raw_risk_items, ['raw salmon'], 'the real raw fish is still flagged');
});

// Audit v18 P0-B: an explicit "raw" beats the processed exemption.
// A fresh sausage can be raw, so "raw pork sausage" is raw risk — and
// a bare "pork sausage" is ASKED about, never assumed cooked.
test('explicit raw beats the processed exemption; a bare sausage is asked about', async () => {
  const { localRawRiskCheck, localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localRawRiskCheck(['raw pork sausage', 'raw chicken sausage']).sort(),
    ['raw chicken sausage', 'raw pork sausage'].sort(), 'explicit raw sausage is raw risk');
  assert.deepEqual(localUnknownConditionCheck(['pork sausage', 'chicken sausage']).sort(),
    ['chicken sausage', 'pork sausage'].sort(), 'a bare sausage gets a Raw / Cooked question');
  const result = await generateMenu({ ingredients: 'raw pork sausage, rice', lang: 'en', sessionId: 'safety-sausage' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, ['raw pork sausage']);
  assert.match(result.menu.preparation.join('\n'), /food thermometer/, 'the sausage gets its thermometer step');
  assert.match(result.menu.preparation.join('\n'), /71°C \(160°F\)/, 'ground pork temperature');
});

// Audit v18 P1-C: "raw chicken in sauce" is a raw chicken that happens
// to sit in sauce, not a sauce. The processed check looks at the main
// part of the entry only.
test('chicken in sauce is still a chicken', async () => {
  const { localRawRiskCheck, localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localRawRiskCheck(['raw chicken in sauce', 'raw chicken with sauce']).sort(),
    ['raw chicken in sauce', 'raw chicken with sauce'].sort(), 'the chicken in sauce is raw risk');
  assert.deepEqual(localUnknownConditionCheck(['chicken in sauce', 'chicken with sauce']).sort(),
    ['chicken in sauce', 'chicken with sauce'].sort(), 'the bare chicken in sauce is asked about');
  assert.deepEqual(localUnknownConditionCheck(['fish sauce']), [], 'a fish sauce is still just a sauce');
});

// Audit v18 P0-D: temperature regexes need numeric boundaries — 74°C
// must not match inside 174°C, 63°C inside 163°C, 74°F inside 274°F.
test('temperature evidence rejects numbers that merely contain the target', async () => {
  const { menuMentionsRawCookthrough } = await import('../src/pipeline.mjs');
  const at174 = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 174°C.'] };
  const at163 = { title: 'Salmon', preparation: ['Cook the raw salmon until a food thermometer reads 163°C.'] };
  const at274F = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 274°F.'] };
  const at745 = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 74.5°C.'] };
  const at740 = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 74.0°C.'] };
  const at74 = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 74°C.'] };
  assert.equal(menuMentionsRawCookthrough(at174, ['raw chicken']), false, '174°C is not 74°C');
  assert.equal(menuMentionsRawCookthrough(at163, ['raw salmon']), false, '163°C is not 63°C');
  assert.equal(menuMentionsRawCookthrough(at274F, ['raw chicken']), false, '274°F is not 165°F');
  assert.equal(menuMentionsRawCookthrough(at745, ['raw chicken']), false, '74.5°C is not matched (fail safe: the menu is discarded)');
  assert.equal(menuMentionsRawCookthrough(at740, ['raw chicken']), true, '74.0°C is 74°C');
  assert.equal(menuMentionsRawCookthrough(at74, ['raw chicken']), true, '74°C passes');
});

// Audit v18 P1-E: smoked/cured/pickled do not mean cooked. Cold-smoked
// fish is not cooked (FDA/CDC: cold smoking does not kill Listeria),
// so a cold smoked salmon is asked about, never assumed cooked.
test('cold smoked salmon is asked about, never assumed cooked', async () => {
  const { localRawRiskCheck, localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localRawRiskCheck(['cold smoked salmon', 'smoked salmon']), [], 'smoked salmon is not claimed raw');
  assert.deepEqual(localUnknownConditionCheck(['cold smoked salmon', 'smoked salmon']).sort(),
    ['cold smoked salmon', 'smoked salmon'].sort(), 'smoked salmon gets a Raw / Cooked question');
  const result = await generateMenu({ ingredients: 'cold smoked salmon, rice', lang: 'en', sessionId: 'safety-smoked' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknown_condition_items, ['cold smoked salmon']);
  assert.match(result.menu.food_safety, /CONDITION UNKNOWN/);
});

// The user's v18.1 regression table, end to end.
test('v18.1 regression table: English cases, one language, one rule set', async () => {
  const { localRawRiskCheck, localSpoilageCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localRawRiskCheck(['raw chicken', 'raw ground chicken', 'raw beef', 'raw salmon']).sort(),
    ['raw beef', 'raw chicken', 'raw ground chicken', 'raw salmon'].sort(), 'the four raw cases warn');
  assert.deepEqual(localSpoilageCheck(['moldy bread']), ['moldy bread'], 'moldy bread is spoilage');
  assert.deepEqual(localRawRiskCheck(['fish sauce', 'egg noodles']), [], 'sauce and noodles are not raw fish or raw egg');
  // Note: "raw ground chicken" is poultry (74°C), not ground meat — the
  // protein-first rule (v16 P1-D). Ground meat (71°C) needs a red-meat
  // item, so the menu uses raw ground beef here.
  const r = await generateMenu({ ingredients: 'raw chicken, raw ground beef, raw beef, raw salmon', lang: 'en', sessionId: 'safety-table' });
  assert.equal(r.ok, true);
  assert.equal(r.raw_risk_items.length, 4, 'all four raw items are reported');
  assert.match(r.menu.preparation.join('\n'), /74°C \(165°F\)/, 'poultry temperature present');
  assert.match(r.menu.preparation.join('\n'), /71°C \(160°F\)/, 'ground temperature present');
  assert.match(r.menu.preparation.join('\n'), /63°C \(145°F\)/, 'fish temperature present');
});

// Audit v19 P0-A: a temperature must belong to THAT item. One step
// saying "Cook raw chicken to 63°C and raw salmon to 74°C" passed the
// v17 per-item check — both temperatures were visible to both checks.
// Now each temperature is assigned to the items mentioned since the
// previous temperature in the same step.
test('menuMentionsRawCookthrough assigns each temperature to its own item', async () => {
  const { menuMentionsRawCookthrough } = await import('../src/pipeline.mjs');
  const swappedOneStep = { title: 'Surf and Turf', preparation: ['Cook raw chicken to 63°C and raw salmon to 74°C, using a food thermometer.'] };
  assert.equal(menuMentionsRawCookthrough(swappedOneStep, ['raw chicken', 'raw salmon']), false, 'swapped temperatures in one step are rejected');
  const correctOneStep = { title: 'Surf and Turf', preparation: ['Cook raw chicken to 74°C and raw salmon to 63°C, using a food thermometer.'] };
  assert.equal(menuMentionsRawCookthrough(correctOneStep, ['raw chicken', 'raw salmon']), true, 'correct temperatures in one step pass');
  const unlinked = { title: 'Surf and Turf', preparation: ['Cook the raw chicken and raw salmon.', 'Use a food thermometer until it reads 74°C.'] };
  assert.equal(menuMentionsRawCookthrough(unlinked, ['raw chicken', 'raw salmon']), false, 'a temperature in a step that names neither item proves nothing');
  const separate = { title: 'Surf and Turf', preparation: ['Cook the raw chicken until a food thermometer reads 74°C (165°F).', 'Cook the raw salmon until a food thermometer reads 63°C (145°F).'] };
  assert.equal(menuMentionsRawCookthrough(separate, ['raw chicken', 'raw salmon']), true, 'each item with its own instruction passes');
  const shared = { title: 'Poultry', preparation: ['Cook the raw chicken and raw turkey until a food thermometer reads 74°C (165°F).'] };
  assert.equal(menuMentionsRawCookthrough(shared, ['raw chicken', 'raw turkey']), true, 'one temperature shared by two items of the same cut still proves both');
});

// Audit v19 P0-A: the deterministic cook-through step is always present
// in the final result — even on an LLM menu that passed the gate —
// because regex validation of LLM narrative is never a complete guarantee.
test('attachDeterministicStep puts the correct instruction on any menu', async () => {
  const { attachDeterministicStep } = await import('../src/pipeline.mjs');
  const menu = { title: 'Surf and Turf', preparation: ['Cook the raw chicken and raw salmon.', 'Plate it.'] };
  attachDeterministicStep(menu, ['raw chicken', 'raw salmon'], []);
  assert.equal(menu.preparation.length, 3, 'one step added');
  assert.match(menu.preparation[1], /Before you plate anything/, 'inserted before plating');
  assert.match(menu.preparation[1], /raw chicken.*74°C \(165°F\)/, 'the chicken gets 74°C');
  assert.match(menu.preparation[1], /raw salmon.*63°C \(145°F\)/, 'the salmon gets 63°C');
  const clean = { title: 'Rice', preparation: ['Heat the rice.', 'Plate it.'] };
  attachDeterministicStep(clean, [], []);
  assert.equal(clean.preparation.length, 2, 'nothing to attach when nothing is raw');
});

// Audit v19 P1-B: descriptor words between "raw" and the protein, and
// the safety net — an entry that says "raw" AND names an animal product
// is raw risk, whatever else it says.
test('raw descriptors and the raw+animal safety net', async () => {
  const { localRawRiskCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localRawRiskCheck(['raw 93% lean ground beef']), ['raw 93% lean ground beef'], '93% lean ground beef is raw risk');
  assert.deepEqual(localRawRiskCheck(['raw organic free-range chicken']), ['raw organic free-range chicken'], 'free-range chicken is raw risk');
  assert.deepEqual(localRawRiskCheck(['raw wagyu beef']), ['raw wagyu beef'], 'an unclassifiable raw animal is still raw risk (safety net)');
  const result = await generateMenu({ ingredients: 'raw 93% lean ground beef, rice', lang: 'en', sessionId: 'safety-lean' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, ['raw 93% lean ground beef']);
  assert.match(result.menu.preparation.join('\n'), /71°C \(160°F\)/, 'ground beef temperature');
});

// Audit v19 P1-B: non-English input is refused with a hint, never
// silently treated as safe.
test('non-English input is refused with an English hint', async () => {
  const { logFridgeCheck } = await import('../src/pipeline.mjs');
  const result = await generateMenu({ ingredients: 'ayam mentah, nasi', lang: 'en', sessionId: 'safety-lang' });
  assert.equal(result.ok, false, 'the menu is refused');
  assert.equal(result.reason_code, 'unsupported_language');
  assert.match(result.reason, /English ingredient names only/, 'the reason says English only');
  assert.match(result.reason, /'ayam' → 'chicken'/, 'the hint translates the offending word');
  assert.match(result.reason, /'mentah' → 'raw'/, 'and the condition word too');
  const check = logFridgeCheck({ ingredients: 'ayam mentah', sessionId: 'safety-lang-check' });
  assert.equal(check.ok, false, 'the fridge check refuses it too');
  assert.equal(check.reason_code, 'unsupported_language');
  const english = await generateMenu({ ingredients: 'raw chicken, cold rice', lang: 'en', sessionId: 'safety-lang-en' });
  assert.equal(english.ok, true, 'English input is unaffected');
});

// Audit v20 P0-A: the condition belongs to the MAIN ingredient, not
// the side dish — and a negation or a partial condition is NOT cooked.
test('not cooked, partially cooked and side dishes are unknown, never safe', async () => {
  const { localUnknownConditionCheck } = await import('../src/pipeline.mjs');
  assert.deepEqual(localUnknownConditionCheck(['not cooked chicken']), ['not cooked chicken'], 'not cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['never cooked chicken']), ['never cooked chicken'], 'never cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['not fully cooked chicken']), ['not fully cooked chicken'], 'not fully cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['partially cooked chicken']), ['partially cooked chicken'], 'partially cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['half-cooked chicken']), ['half-cooked chicken'], 'half-cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['chicken with fried rice']), ['chicken with fried rice'], 'the fried rice does not cook the chicken');
  assert.deepEqual(localUnknownConditionCheck(['chicken with boiled potatoes']), ['chicken with boiled potatoes'], 'the boiled potatoes do not cook the chicken');
  assert.deepEqual(localUnknownConditionCheck(['fully cooked chicken']), [], 'fully cooked stays cooked');
  assert.deepEqual(localUnknownConditionCheck(['fried chicken']), [], 'fried chicken stays cooked');
  assert.deepEqual(localUnknownConditionCheck(['uncooked chicken']), ['uncooked chicken'], 'uncooked is still unknown');
  assert.deepEqual(localUnknownConditionCheck(['undercooked chicken']), ['undercooked chicken'], 'undercooked is still unknown');
  // Audit v20.2 P0-A: the negation allows up to two adverb words
  // between the negation and "cooked" — a fixed list of adverbs never
  // covers them all.
  assert.deepEqual(localUnknownConditionCheck(['not yet cooked chicken']), ['not yet cooked chicken'], 'not yet cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['chicken not properly cooked']), ['chicken not properly cooked'], 'a negation after the animal is unknown');
  assert.deepEqual(localUnknownConditionCheck(['not sufficiently cooked chicken']), ['not sufficiently cooked chicken'], 'not sufficiently cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['chicken hasn\'t been cooked']), ['chicken hasn\'t been cooked'], 'hasn\'t been cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['not yet fully cooked chicken']), ['not yet fully cooked chicken'], 'two adverbs are unknown');
  assert.deepEqual(localUnknownConditionCheck(['not thoroughly cooked chicken']), ['not thoroughly cooked chicken'], 'not thoroughly cooked is unknown');
  // Audit v20.3: three words between the negation and "cooked" — the
  // v20.2 bound of two was one short. These are the final negation
  // regression cases; after this the food-safety layer is frozen.
  assert.deepEqual(localUnknownConditionCheck(['chicken has not yet been properly cooked']), ['chicken has not yet been properly cooked'], 'has not yet been properly cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['not yet been fully cooked chicken']), ['not yet been fully cooked chicken'], 'not yet been fully cooked is unknown');
  assert.deepEqual(localUnknownConditionCheck(['chicken has not been sufficiently cooked']), ['chicken has not been sufficiently cooked'], 'has not been sufficiently cooked is unknown');
  const longNegation = await generateMenu({ ingredients: 'chicken has not yet been properly cooked, rice', lang: 'en', sessionId: 'safety-long-negation' });
  assert.equal(longNegation.ok, true);
  assert.deepEqual(longNegation.unknown_condition_items, ['chicken has not yet been properly cooked']);
  assert.match(longNegation.menu.food_safety, /CONDITION UNKNOWN/, 'the warning is shown');
  assert.match(longNegation.menu.preparation.join('\n'), /74°C \(165°F\)/, 'the recipe still cooks it through');
  // The audit's exact scenario: before v20.1 this passed silently with
  // no warning at all and a two-minute instruction.
  const result = await generateMenu({ ingredients: 'not cooked chicken, rice', lang: 'en', sessionId: 'safety-not-cooked' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, [], 'not cooked is not raw risk');
  assert.deepEqual(result.unknown_condition_items, ['not cooked chicken']);
  assert.match(result.menu.food_safety, /CONDITION UNKNOWN/, 'the warning is shown');
  assert.match(result.menu.preparation.join('\n'), /74°C \(165°F\)/, 'the recipe still cooks it through');
});

// Audit v20 P1-B: the spoiled check is by core identity.
test('menuNamesSpoiled catches a dropped modifier, without false alarms', async () => {
  const { menuNamesSpoiled, coreIdentity } = await import('../src/pipeline.mjs');
  assert.equal(coreIdentity('moldy bread'), 'bread');
  assert.equal(coreIdentity('moldy raw chicken'), 'chicken');
  assert.equal(coreIdentity('one egg'), 'egg');
  assert.equal(coreIdentity('fish sauce'), 'fish sauce');
  assert.equal(coreIdentity('93% lean ground beef'), 'beef');
  const bare = (prep) => ({ title: 'A Dish', preparation: prep });
  assert.equal(menuNamesSpoiled(bare(['Add the bread and cheese to the pan.']), ['moldy bread']), true, 'the audit case: the LLM dropped "moldy"');
  assert.equal(menuNamesSpoiled(bare(['Add the yogurt.']), ['expired yogurt']), true, 'expired yogurt, bare core');
  assert.equal(menuNamesSpoiled(bare(['Add the chicken.']), ['moldy raw chicken']), true, 'moldy raw chicken, bare core');
  assert.equal(menuNamesSpoiled(bare(['Add the cheese.']), ['moldy bread']), false, 'a menu that never mentions bread');
  assert.equal(menuNamesSpoiled(bare(['Add the bread.']), ['moldy bread'], ['fresh bread', 'cheese']), false, 'the safe bread disambiguates');
  assert.equal(menuNamesSpoiled(bare(['Add the moldy bread.']), ['moldy bread'], ['fresh bread']), true, 'an explicit moldy mention is always rejected');
});

// Audit v20.2 P1-B: singular/plural and spelling normalisation. A
// small, explicit table — no NLP, no semantic matching.
test('menuNamesSpoiled normalises plurals and spellings', async () => {
  const { menuNamesSpoiled, coreIdentity, singularize, normalizeIdentityWord } = await import('../src/pipeline.mjs');
  assert.equal(singularize('tomatoes'), 'tomato');
  assert.equal(singularize('potatoes'), 'potato');
  assert.equal(singularize('strawberries'), 'strawberry');
  assert.equal(singularize('eggs'), 'egg');
  assert.equal(singularize('dishes'), 'dish');
  assert.equal(singularize('cheese'), 'cheese', 'cheese is not a plural');
  assert.equal(singularize('fish'), 'fish', 'fish is not a plural');
  assert.equal(normalizeIdentityWord('yoghurt'), 'yogurt');
  assert.equal(normalizeIdentityWord('aubergine'), 'eggplant');
  assert.equal(coreIdentity('rotten tomato'), 'tomato');
  assert.equal(coreIdentity('expired eggs'), 'egg');
  assert.equal(coreIdentity('moldy strawberries'), 'strawberry');
  assert.equal(coreIdentity('expired yogurt'), 'yogurt');
  const bare = (prep) => ({ title: 'A Dish', preparation: prep });
  assert.equal(menuNamesSpoiled(bare(['Add the tomatoes.']), ['rotten tomato']), true, 'the audit case: tomatoes for a rotten tomato');
  assert.equal(menuNamesSpoiled(bare(['Add the egg.']), ['expired eggs']), true, 'egg for expired eggs');
  assert.equal(menuNamesSpoiled(bare(['Add the strawberry.']), ['moldy strawberries']), true, 'strawberry for moldy strawberries');
  assert.equal(menuNamesSpoiled(bare(['Add the yoghurt.']), ['expired yogurt']), true, 'yoghurt for expired yogurt');
  // The disambiguation still holds, with plurals on both sides.
  assert.equal(menuNamesSpoiled(bare(['Add the tomatoes.']), ['rotten tomato'], ['fresh tomatoes']), false, 'fresh tomatoes disambiguate');
  assert.equal(menuNamesSpoiled(bare(['Add the eggs.']), ['expired eggs'], ['fresh eggs']), false, 'fresh eggs disambiguate');
});

test('cooked chicken needs no thermometer step and no warning', async () => {
  const result = await generateMenu({ ingredients: 'cooked chicken, cold rice', lang: 'en', sessionId: 'safety-cooked' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw_risk_items, [], 'cooked is not raw');
  assert.deepEqual(result.unknown_condition_items, [], 'cooked is not unknown either');
  assert.equal(result.menu.safety_warning, null, 'nothing to warn about');
  assert.ok(!/thermometer/.test(result.menu.preparation.join('\n')), 'no thermometer step for cooked food');
});

// Audit v15 P1: the temperature depends on the cut — poultry 74°C,
// ground meat 71°C, whole cuts and fish 63°C, eggs until firm.
// Audit v22: an unidentified protein ("raw meat") gets NO temperature
// at all — not even the reference table. The step tells the guest to
// identify the protein first, because a temperature for an unknown
// protein is a guess, and this kitchen does not guess.
test('rawCookthroughStep gives the right temperature per cut', async () => {
  const { rawCookthroughStep } = await import('../src/pipeline.mjs');
  assert.match(rawCookthroughStep(['raw chicken'], 'en'), /74°C \(165°F\)/, 'poultry 74°C');
  assert.match(rawCookthroughStep(['raw ground beef'], 'en'), /71°C \(160°F\)/, 'ground meat 71°C');
  assert.match(rawCookthroughStep(['raw salmon'], 'en'), /63°C \(145°F\)/, 'fish 63°C');
  assert.match(rawCookthroughStep(['raw beef steak'], 'en'), /63°C \(145°F\)/, 'whole cut 63°C');
  assert.match(rawCookthroughStep(['raw beef steak'], 'en'), /rest it for 3 minutes/, 'whole cut rests 3 minutes');
  assert.match(rawCookthroughStep(['raw egg'], 'en'), /white and yolk are both firm/, 'egg until firm');
  const unknown = rawCookthroughStep(['raw meat'], 'en');
  assert.match(unknown, /identify the raw meat before cooking it/, 'an unidentified protein gets the identification clause');
  assert.doesNotMatch(unknown, /74°C|71°C|63°C/, 'no temperature is claimed for an unidentified protein');
  assert.match(rawCookthroughStep(['raw chicken']), /food thermometer/, 'the step names the thermometer');
  assert.match(rawCookthroughStep(['raw chicken']), /74°C \(165°F\)/, 'the step names the temperature');
});

// Audit v14 P0-B: combined risks must BOTH be shown — the old code
// returned only the first warning and silently dropped the raw one.
test('spoiled + raw together show BOTH warnings (label and text)', async () => {
  const result = await generateMenu({ ingredients: 'moldy bread, raw chicken, rice', lang: 'en', sessionId: 'safety-both' });
  assert.equal(result.ok, true, 'the safe ingredients still make a menu');
  assert.deepEqual(result.spoiled_items, ['moldy bread']);
  assert.deepEqual(result.raw_risk_items, ['raw chicken']);
  assert.match(result.menu.food_safety, /SPOILAGE WARNING: DO NOT CONSUME/);
  assert.match(result.menu.food_safety, /RAW RISK: COOK THOROUGHLY/);
  assert.match(result.menu.safety_warning, /DO NOT eat it/);
  assert.match(result.menu.safety_warning, /never eat it raw/);
  // And the recipe still excludes the spoiled item while proving the raw one.
  const recipe = [result.menu.title, ...result.menu.preparation].join('\n').toLowerCase();
  assert.ok(!recipe.includes('moldy bread'), 'recipe never cooks the spoiled item');
  assert.match(result.menu.preparation.join('\n'), /food thermometer/, 'raw chicken is verified with a thermometer');
  assert.match(result.menu.preparation.join('\n'), /74°C \(165°F\)/, 'with the poultry temperature');
});

// Audit v15 P1: the LLM gate now requires a thermometer or a
// temperature. "No pink flesh" and "clear juices" are NOT proof (CDC),
// so a menu that cites only those is discarded.
test('menuMentionsRawCookthrough gates the LLM menu on thermometer/temperature', async () => {
  const { menuMentionsRawCookthrough } = await import('../src/pipeline.mjs');
  const vague = { title: 'Chicken, Patiently', preparation: ['Add the raw chicken.', 'Cook for two minutes.', 'Serve.'] };
  const colorOnly = { title: 'Chicken, Patiently', preparation: ['Add the raw chicken.', 'Cook until no pink remains and the juices run clear.', 'Serve.'] };
  // Audit v17 P0: the evidence must live in a step that NAMES the item —
  // a thermometer in a step that never mentions the chicken proves nothing.
  const proven = { title: 'Chicken, Patiently', preparation: ['Add the raw chicken.', 'Cook the raw chicken until a food thermometer in the thickest part reads 74°C (165°F).', 'Serve.'] };
  const unnamed = { title: 'Chicken, Patiently', preparation: ['Add the raw chicken.', 'Cook until a food thermometer in the thickest part reads 74°C (165°F).', 'Serve.'] };
  assert.equal(menuMentionsRawCookthrough(vague, ['raw chicken']), false, '"cook for two minutes" proves nothing');
  assert.equal(menuMentionsRawCookthrough(colorOnly, ['raw chicken']), false, 'colour and clear juices are not proof');
  assert.equal(menuMentionsRawCookthrough(proven, ['raw chicken']), true, 'thermometer + temperature in a step naming the chicken passes');
  assert.equal(menuMentionsRawCookthrough(unnamed, ['raw chicken']), false, 'a thermometer in a step that never names the chicken proves nothing');
  assert.equal(menuMentionsRawCookthrough(vague, []), true, 'no raw risk, no gate');
});

// Audit v16 P0-B: the gate is PER CATEGORY, not a global regex. A raw
// chicken given 63°C must fail; a chicken+salmon menu that only proves
// the chicken must fail; a whole cut without the 3-minute rest must fail.
test('menuMentionsRawCookthrough validates every category, not just any temperature', async () => {
  const { menuMentionsRawCookthrough } = await import('../src/pipeline.mjs');
  const chicken63 = { title: 'Chicken', preparation: ['Cook the raw chicken until a food thermometer reads 63°C (145°F).'] };
  assert.equal(menuMentionsRawCookthrough(chicken63, ['raw chicken']), false, '63°C is the wrong temperature for poultry');
  const chickenOnly = { title: 'Surf and Turf', preparation: ['Cook the raw chicken until a food thermometer reads 74°C (165°F).', 'Add the raw salmon and cook it.'] };
  assert.equal(menuMentionsRawCookthrough(chickenOnly, ['raw chicken', 'raw salmon']), false, 'the salmon has no temperature of its own');
  const both = { title: 'Surf and Turf', preparation: ['Cook the raw chicken until a food thermometer reads 74°C (165°F).', 'Cook the raw salmon until the thermometer reads 63°C (145°F).'] };
  assert.equal(menuMentionsRawCookthrough(both, ['raw chicken', 'raw salmon']), true, 'both categories prove themselves');
  const wholeNoRest = { title: 'Steak', preparation: ['Cook the raw beef steak until a food thermometer reads 63°C (145°F).'] };
  assert.equal(menuMentionsRawCookthrough(wholeNoRest, ['raw beef steak']), false, 'a whole cut without the rest fails');
  const wholeRest = { title: 'Steak', preparation: ['Cook the raw beef steak until a food thermometer reads 63°C (145°F), then rest it for 3 minutes.'] };
  assert.equal(menuMentionsRawCookthrough(wholeRest, ['raw beef steak']), true, 'a whole cut with the rest passes');
  const eggFirm = { title: 'Egg', preparation: ['Cook the raw egg until the white and yolk are both firm.'] };
  assert.equal(menuMentionsRawCookthrough(eggFirm, ['raw egg']), true, 'a firm egg needs no thermometer');
  const eggVague = { title: 'Egg', preparation: ['Warm the raw egg gently.'] };
  assert.equal(menuMentionsRawCookthrough(eggVague, ['raw egg']), false, 'a vague egg fails');
});

// Audit v17 P0: the audit's own counter-examples. A chicken given 63°C
// and a salmon given 74°C (swapped) must fail; a chicken+turkey menu
// that only proves the chicken must fail; a "raw meat" with a
// thermometer showing 0°C must fail — 0°C is not a cooking temperature.
// Audit v22: a "raw meat" with a REAL temperature must fail too — no
// temperature can prove an unidentified protein, because nobody knows
// which protein the temperature is for. The protein has to be
// identified first.
test('menuMentionsRawCookthrough rejects swapped temperatures and 0°C', async () => {
  const { menuMentionsRawCookthrough } = await import('../src/pipeline.mjs');
  const swapped = { title: 'Surf and Turf', preparation: ['Cook raw chicken until a food thermometer reads 63°C (145°F).', 'Cook raw salmon until the thermometer reads 74°C (165°F).'] };
  assert.equal(menuMentionsRawCookthrough(swapped, ['raw chicken', 'raw salmon']), false, 'swapped temperatures are not proof');
  const turkeyMissing = { title: 'Poultry', preparation: ['Cook the raw chicken until a food thermometer reads 74°C (165°F).', 'Add the raw turkey to the plate.'] };
  assert.equal(menuMentionsRawCookthrough(turkeyMissing, ['raw chicken', 'raw turkey']), false, 'the turkey has no instruction of its own');
  const turkeyCovered = { title: 'Poultry', preparation: ['Cook the raw chicken and raw turkey until a food thermometer reads 74°C (165°F).'] };
  assert.equal(menuMentionsRawCookthrough(turkeyCovered, ['raw chicken', 'raw turkey']), true, 'one step naming both items covers both');
  const zeroDegrees = { title: 'Meat', preparation: ['Cook the raw meat until a food thermometer reads 0°C.'] };
  assert.equal(menuMentionsRawCookthrough(zeroDegrees, ['raw meat']), false, '0°C is not a cooking temperature');
  const unknownValid = { title: 'Meat', preparation: ['Cook the raw meat until a food thermometer reads 71°C (160°F).'] };
  assert.equal(menuMentionsRawCookthrough(unknownValid, ['raw meat']), false, 'a real temperature still proves nothing for an unknown protein');
});
