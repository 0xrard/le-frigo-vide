import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { QUOTES } from './quotes.mjs';
import { getSystemPrompt, buildUserPrompt, buildSafetyPrompt } from './prompts.mjs';
import { callOpenRouter, pineconeQuery, apifyFetchNews, embedText, cosineSimilarity, extractJsonObject } from './connectors.mjs';
import { initDb, insertMeal, updateMealCheckpoint, logCheckpoint, updateCheckpointLog, recordIngredients, getRecurringCulprits, getIngredientEmbeddings, logIngredientEvent, hasIngredientEvents, nextObservationEventType } from './db.mjs';
import { buildChronicle } from './chronicle.mjs';
// Ingredient condition is decided in exactly ONE place:
// shared/ingredient-classifier.mjs — the same module the browser
// frontend imports. Every food-safety decision in this file is derived
// from its structured results; no condition regex lives here anymore.
import { classifyIngredient, classifyIngredients, coreIdentity, mainIngredientPart, proteinSubjectPart, primaryProteins, separateProteins, normalizeIdentityText } from '../shared/ingredient-classifier.mjs';
// Re-exported so the tests (and any caller) can prove the backend and
// the frontend call the same classifier module — the same function
// object, not a copy.
export { classifyIngredient, classifyIngredients, coreIdentity, mainIngredientPart, proteinSubjectPart, primaryProteins, separateProteins, singularize, normalizeIdentityWord, normalizeIdentityText } from '../shared/ingredient-classifier.mjs';

// Pipeline — 4 stages:
//  1. Food-Safety Guardrail (OpenRouter openrouter/free + deterministic local denylist)
//  2. Local Memory — SQLite ingredient history + cosine similarity
//     (recurring culprits + existential quote). Pinecone integration is
//     discovered but not yet configured for live queries.
//  3. Fictional Global Dread Pairing (Local Fallback) — no Apify Actor
//     is configured, so the dread headline is a seeded fictional one
//     from the local news_cache (4s timeout) — fetched BEFORE synthesis
//     so the LLM can write world_context from the headline.
//  4. Menu synthesis: OpenRouter openrouter/free + honest local fallback, then
//     persistence + async `sprite-env checkpoint create` when
//     dignity_loss_percentage > 80.
// Menu contract (both paths): title, subtitle, existential_dread,
// food_safety, aura_analysis, world_context, preparation[3-4],
// sommelier, chef_note, dignity_loss_percentage, quote, quote_author.

// Real foods that contain a scary-looking word. The allowlist wins: if an
// ingredient names one of these, no denylist pattern may refuse it.
// (Audit 2026-11-27: the old broad \bglass\b / \bpaper\b patterns refused
// "glass noodles", "rice paper" and "paper-thin beef" — all real food.)
export const FOOD_EXCEPTIONS = [
  /\brice\s+paper\b/i,
  /\bglass\s+noodles?\b/i,
  /\brice\s+noodles?\b/i,
  /\bpaper[-\s]thin\b/i,
  /\bsponge\s+cake\b/i,
];

// Specific non-food objects only — word-boundary patterns for things that
// are never food. Bare "glass" or "paper" alone is still refused (a
// drinking glass is not food); the food names above are the only escape.
export const UNSAFE_PATTERNS = [
  /\baa\s*batter(y|ies)\b/i, /\bAA\b/, /\balkaline\s*batter(y|ies)\b/i,
  /\bbatter(y|ies)\b/i, /\blithium\b/i, /\bcharger\b/i, /\bcable\b/i, /\bremote\b/i,
  /\bbleach\b/i, /\bdetergent\b/i, /\bdish\s*soap\b/i, /\bsoap\b/i,
  /\bshampoo\b/i, /\btoothpaste\b/i, /\bcleaner\b/i, /\bdisinfectant\b/i,
  /\bbroken\s+glass\b/i, /\bshattered\s+glass\b/i, /\bglass\b/i,
  /\bplastic\b/i, /\bmetal\b/i, /\bnail\b/i, /\bpoison\b/i,
  /\bpaint\b/i, /\bglue\b/i, /\bsponge\b/i, /\bpaper\b/i,
];

// Raw animal products: food, but never to be eaten raw — the dish must
// cook them thoroughly. (Kept separate from spoilage on purpose: raw
// chicken is normal fridge food, not something to throw away.)
// The condition rules live in shared/ingredient-classifier.mjs now.
// The three checks below are thin wrappers over its structured
// results — they exist so the tests and generateMenu can ask for one
// list at a time, not so the rules can live in two places.

// Parse + normalize + DEDUPLICATE (audit v14 P2-E): 'spinach, spinach'
// is one ingredient, not two. Every entry point (generate, fridge
// check) goes through here, so the event log and the aggregate history
// can never disagree about how many times an ingredient appeared.
export function parseIngredients(input) {
  const list = Array.isArray(input)
    ? input.map((s) => String(s).trim())
    : typeof input === 'string'
      ? input.split(/[,;\n]+/).map((s) => s.trim())
      : [];
  const seen = new Set();
  return list.filter(Boolean).map((s) => s.toLowerCase()).filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export function localSafetyCheck(ingredients) {
  const unsafe = [];
  for (const ing of ingredients) {
    if (FOOD_EXCEPTIONS.some((re) => re.test(ing))) continue;
    if (UNSAFE_PATTERNS.some((re) => re.test(ing))) unsafe.push(ing);
  }
  return unsafe;
}

// Spoiled / rotten food: still food (never a refusal), but it must
// NEVER be presented as edible. The chef orders it thrown away.
export function localSpoilageCheck(ingredients) {
  return (ingredients || []).filter((ing) => classifyIngredient(ing).spoilage);
}

// Raw animal products: the dish must cook them thoroughly. An entry
// that says "raw" AND names an animal product is raw risk, whatever
// else it says — so an unclassifiable "raw wagyu beef" never silently
// passes as safe. An explicit "raw" beats the processed exemption:
// a guest who writes "raw pork sausage" has told us it is raw.
// The lists are derived from the classifier's RECIPE DECISION
// (recipeAction), not from the condition label: a "raw meat" is raw
// but its recipe decision is "ask for protein clarification", so it
// is not raw risk — it is in the clarification list below.
export function localRawRiskCheck(ingredients) {
  return (ingredients || []).filter((ing) => classifyIngredient(ing).recipeAction === 'cook_through');
}

// A raw (or partially cooked) protein whose type or form is unknown:
// the recipe cannot be made until the guest says which protein it is
// and whether it is ground or a whole cut. Asking Raw or Cooked is
// not enough — the temperature depends on the answer.
export function localNeedsProteinClarificationCheck(ingredients) {
  return (ingredients || []).filter((ing) => classifyIngredient(ing).needsProteinClarification);
}

// More than one primary protein in one entry ("raw chicken with raw
// fish", "chicken and beef"): one entry, one primary protein. The
// guest must separate them — the system refuses to guess which
// temperature belongs to whom.
export function localAmbiguousProteinsCheck(ingredients) {
  return (ingredients || []).filter((ing) => classifyIngredient(ing).ambiguousProteins);
}

// Words that mark an ingredient as non-English (audit v19 P1-B).
// English-only MVP: the app cannot reason about these, so it refuses
// the input with a hint instead of silently treating it as safe.
// Each word maps to its English equivalent, for the hint.
const NON_ENGLISH_WORDS = {
  ayam: 'chicken', mentah: 'raw', ikan: 'fish', telur: 'egg',
  sapi: 'beef', babi: 'pork', domba: 'lamb', bebek: 'duck',
  udang: 'shrimp', nasi: 'rice', daging: 'meat', kulkas: 'fridge',
  basi: 'stale', kadaluarsa: 'expired', jamuran: 'moldy',
  goreng: 'fried', rebus: 'boiled', panggang: 'roasted', bakar: 'grilled',
  kukus: 'steamed', giling: 'ground', cincang: 'minced',
  layu: 'wilted', dingin: 'cold', tengik: 'stale', sisa: 'leftover',
  keju: 'cheese', kentang: 'potato', acar: 'pickle', timun: 'cucumber',
};
export function detectUnsupportedLanguage(ingredients) {
  const found = [];
  for (const ing of ingredients || []) {
    for (const [word, en] of Object.entries(NON_ENGLISH_WORDS)) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(ing)) found.push({ word, en, ingredient: ing });
    }
  }
  return found;
}
export function unsupportedLanguageReason(unsupported) {
  const hints = [...new Set(unsupported.map((u) => `'${u.word}' → '${u.en}'`))].join(', ');
  return `Le Frigo Vide supports English ingredient names only. The input uses non-English words (${hints}) — please use English names, e.g. 'raw chicken' instead of 'ayam mentah'.`;
}

// Bare animal products whose condition is UNKNOWN (audit v16 P1-C):
// the guest typed "chicken", not "raw chicken" and not
// "cooked chicken". The app has no information about the condition,
// so it must not assume the item is cooked — but it must not claim
// it IS raw either. These items are treated as raw for the RECIPE
// (fail safe: the thermometer step covers them) while the warning
// says plainly that the condition is unknown. The UI offers a
// Raw / Cooked choice per item so the guest can resolve it.
// A "partially cooked" item is unknown in the same sense: it still
// needs a full cook-through, and the guest is asked.
// Items that need PROTEIN clarification ("raw meat") are not here —
// their condition is known, their protein is not — they live in
// localNeedsProteinClarificationCheck. Neither are ambiguous
// combinations ("raw chicken with raw fish") — they live in
// localAmbiguousProteinsCheck.
export function localUnknownConditionCheck(ingredients) {
  return (ingredients || []).filter((ing) => {
    const c = classifyIngredient(ing);
    return c.recipeAction === 'ask_user' && !c.needsProteinClarification && !c.ambiguousProteins;
  });
}

// Honest food-safety label. The app has no lab and no inspector: it can
// only say the items passed the food-category gate. It never claims the
// dish was verified safe to eat.
// Both warnings are COMBINED when both risks are present (audit v14
// P0-B): showing only the spoilage warning silently dropped the raw-meat
// one. The label and the warning are built from parts, never first-only.
// English-only MVP (v18.1): the `lang` parameter is accepted for API
// compatibility and ignored — every label, warning and recipe is in
// English. Other languages are not supported in this MVP.
export function foodSafetyLabel({ spoiled = [], rawRisk = [], unknownCondition = [], needsProteinClarification = [], ambiguousProteins = [] } = {}) {
  const parts = [];
  if (spoiled.length) parts.push('SPOILAGE WARNING: DO NOT CONSUME');
  if (rawRisk.length) parts.push('RAW RISK: COOK THOROUGHLY, NEVER EAT RAW');
  if (unknownCondition.length) parts.push('CONDITION UNKNOWN: VERIFY BEFORE EATING');
  if (needsProteinClarification.length) parts.push('PROTEIN UNKNOWN: CLARIFY BEFORE COOKING');
  if (ambiguousProteins.length) parts.push('AMBIGUOUS PROTEIN COMBINATION: SEPARATE BEFORE COOKING');
  if (parts.length) return parts.join(' | ');
  return 'FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)';
}

// The core identity of an ingredient ("moldy bread" -> "bread") lives
// in shared/ingredient-classifier.mjs (coreIdentity), so the spoiled
// check and the classifier can never disagree about what an item is.

// Does an LLM-written menu name a spoiled ingredient — in its title or
// any preparation step? If so the whole menu is discarded for the safe
// local fallback (audit v13 P0-A: the LLM must not be trusted to obey
// the disposal instruction on its own). The check is by IDENTITY, not
// by exact name (audit v20 P1-B): the LLM may drop the modifier and
// write "Add the bread" for a "moldy bread" — the modifier must not be
// the only way the system recognises the item. A bare core mention is
// only proof when no SAFE item shares the core: when "moldy bread"
// and "fresh bread" appear together, the menu's "bread" may mean the
// safe one (the LLM only ever saw the safe list), so it is not rejected.
export function menuNamesSpoiled(menu, spoiled, safe = []) {
  if (!spoiled?.length) return false;
  const rawHay = [menu?.title, ...(menu?.preparation || [])].filter(Boolean).join('\n').toLowerCase();
  // The core check runs on the NORMALISED text, so "tomatoes" matches
  // a "rotten tomato" and "yoghurt" matches an "expired yogurt".
  const hay = normalizeIdentityText(rawHay);
  const safeCores = new Set((safe || []).map((s) => coreIdentity(s)).filter(Boolean));
  return spoiled.some((s) => {
    if (!s) return false;
    const full = String(s).toLowerCase();
    if (rawHay.includes(full)) return true;
    const core = coreIdentity(s);
    if (!core || safeCores.has(core)) return false;
    return new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay);
  });
}

// Deterministic safety warning shown with the menu (UI + receipt), in the
// chef's voice. Null when there is nothing to warn about.
export function safetyWarningText({ spoiled = [], rawRisk = [], unknownCondition = [], needsProteinClarification = [], ambiguousProteins = [] } = {}) {
  const parts = [];
  if (spoiled.length) {
    parts.push(`Chef Jean-Paul's warning: ${spoiled.join(', ')} is spoiled — DO NOT eat it. Throw it away; do not cook with it.`);
  }
  if (rawRisk.length) {
    parts.push(`Chef Jean-Paul's warning: ${rawRisk.join(', ')} is raw — never eat it raw. Cook it through completely and verify with a food thermometer — colour and clear juices are not proof.`);
  }
  if (unknownCondition.length) {
    parts.push(`Chef Jean-Paul does not know whether ${unknownCondition.join(', ')} is raw or already cooked — if it is raw, never eat it raw; verify with a food thermometer.`);
  }
  if (needsProteinClarification.length) {
    parts.push(`Chef Jean-Paul does not know which protein ${needsProteinClarification.join(', ')} is — tell him whether it is poultry, fish, or a cut of red meat, and whether it is ground or a whole cut, before he can give you a temperature.`);
  }
  if (ambiguousProteins.length) {
    parts.push(`Chef Jean-Paul has found more than one animal protein in ${ambiguousProteins.join(', ')} — kindly separate them into one entry per protein. He refuses to guess which temperature belongs to whom.`);
  }
  return parts.length ? parts.join(' ') : null;
}

// Internal-temperature guide (CDC/FDA, audit v15 P1): colour and clear
// juices are NOT reliable doneness indicators — only a food thermometer
// in the thickest part is. The temperatures come from the classifier's
// cooking rules (shared/ingredient-classifier.mjs) — OpenRouter never
// determines them, and no temperature table lives here anymore.
// An item whose protein is unidentified (bare "raw meat") has NO
// cooking rule and gets NO temperature here — not even the reference
// table. The step tells the guest to identify the protein first: a
// temperature for an unknown protein is a guess, and this kitchen
// does not guess.
// The deterministic cook-through step for raw animal products: one
// clause per cooking rule present, each naming a thermometer and the
// internal temperature for that cut. Exported for testing.
export function rawCookthroughStep(rawRisk) {
  const byKind = new Map();
  const unknown = [];
  const ambiguous = [];
  for (const item of rawRisk || []) {
    const c = classifyIngredient(item);
    const rule = c.cookingRule;
    const kind = rule ? rule.kind : 'unknown';
    if (c.ambiguousProteins) ambiguous.push(item);
    else if (kind === 'unknown') unknown.push(item);
    else {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(item);
    }
  }
  const clause = (kind, items) => {
    const list = items.join(', ');
    return {
      poultry: `cook the ${list} until a food thermometer in the thickest part reads 74°C (165°F)`,
      ground: `cook the ${list} until a food thermometer reads 71°C (160°F) throughout`,
      fish: `cook the ${list} until a food thermometer reads 63°C (145°F) and the flesh flakes easily`,
      whole: `cook the ${list} until a food thermometer in the thickest part reads 63°C (145°F), then rest it for 3 minutes`,
      egg: `cook the ${list} until the white and yolk are both firm`,
    }[kind];
  };
  const clauses = [...byKind.entries()].map(([kind, items]) => clause(kind, items));
  if (unknown.length) {
    clauses.push(`identify the ${unknown.join(', ')} before cooking it — Chef Jean-Paul cannot give a temperature until he knows which protein it is and whether it is ground or a whole cut`);
  }
  if (ambiguous.length) {
    clauses.push(`separate the ${ambiguous.join(', ')} into one entry per protein before cooking — Chef Jean-Paul refuses to guess which temperature belongs to whom`);
  }
  const body = clauses.join('; ');
  return `Before you plate anything: ${body}. Colour and clear juices are not proof; the thermometer is the only witness that counts.`;
}

// Does an LLM-written menu prove the raw animal products were cooked
// through? The bar is a thermometer AND the temperature for the cut
// (audit v15 P1) — "no pink flesh" and "clear juices" are NOT proof of
// doneness (CDC), so they no longer count. And the check is PER ITEM,
// in the instruction that names that item (audit v17 P0): the v16
// per-category check still searched the WHOLE menu text, so a chicken
// given 63°C and a salmon given 74°C (swapped) passed — each
// temperature existed somewhere — and a chicken+turkey menu that only
// proved the chicken passed too, and a "raw meat" with a thermometer
// showing 0°C passed. Each item must prove itself in a step that
// names it; a menu that fails any item is discarded for the safe local
// menu, whose own step proves every item it covers.
//
// And the temperature must belong to THAT item (audit v19 P0-A): the
// v17 per-item check still read the whole STEP, so one step saying
// "Cook raw chicken to 63°C and raw salmon to 74°C" passed — both
// temperatures were visible to both checks. Now each temperature in a
// step is assigned to the items mentioned since the previous
// temperature (they share one instruction); an item with no
// temperature after its mention is unproven. A step that only names
// one item and one temperature is unambiguous; a step that names two
// items and one temperature proves both only if the temperature is
// right for both.
// A temperature, with NUMERIC BOUNDARIES (audit v18 P0-D): the old
// regex matched "74°C" inside "174°C" and "63°C" inside "163°C", so a
// chicken given 174°C passed. The lookbehind blocks a digit or decimal
// point before the number, the lookahead blocks a digit after the unit,
// and an optional ".0" is the only decimal accepted — 74.5°C is not
// matched (fail safe: the menu is discarded for the local fallback,
// which is always safe). A degree sign is optional; "74 C" matches.
// The egg's proof is the firm white and yolk, not a temperature.
const EGG_FIRM_RE = /white and yolk (?:are|is) (?:both )?firm/i;
// The words that identify an item in a step: the item's content words
// minus qualifiers ("raw"), quantities ("one", "half") and articles.
// "raw ground beef" -> ["ground", "beef"]; "one egg" -> ["egg"].
const ITEM_STOP_WORDS = new Set(['raw', 'cooked', 'one', 'two', 'three', 'four', 'five', 'half', 'a', 'an', 'some', 'the', 'fresh', 'frozen']);
export function rawItemKeyWords(item) {
  const words = String(item || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w && !ITEM_STOP_WORDS.has(w));
  return words.length ? words : [String(item || '').toLowerCase().trim()];
}
// All temperatures in a step, in order, normalised to °C (165°F is
// 74°C, 160°F is 71°C, 145°F is 63°C). A number that is not one of
// the three prescribed temperatures (174°C, 0°C, 100°C) is still an
// event — it just never matches a required temperature. A decimal
// other than .0 (74.5°C) is not an event at all (audit v18 P0-D).
function stepTemperatures(step) {
  const re = /(?<![0-9.])(\d+(?:\.0+)?)\s*°?\s*([CF])(?![0-9])/gi;
  const out = [];
  let m;
  while ((m = re.exec(step))) {
    const num = parseFloat(m[1]);
    out.push({ index: m.index, c: m[2].toUpperCase() === 'C' ? num : Math.round((num - 32) * 5 / 9) });
  }
  return out;
}

// The earliest position at which an item is mentioned in a step
// (any of its key words), or -1.
function mentionIndex(step, item) {
  let best = -1;
  for (const w of rawItemKeyWords(item)) {
    const i = step.search(new RegExp(`\\b${w}\\b`, 'i'));
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

// Walk one step once: mentions and temperatures in order. A temperature
// is assigned to every item mentioned since the previous temperature
// (they share one instruction). Returns item -> °C.
function assignTemperatures(step, rawRisk) {
  const events = [];
  for (const item of rawRisk) {
    const idx = mentionIndex(step, item);
    if (idx >= 0) events.push({ type: 'item', index: idx, item });
  }
  for (const t of stepTemperatures(step)) events.push({ type: 'temp', index: t.index, c: t.c });
  events.sort((a, b) => a.index - b.index);
  const assigned = new Map();
  let pending = [];
  for (const e of events) {
    if (e.type === 'item') pending.push(e.item);
    else {
      for (const item of pending) if (!assigned.has(item)) assigned.set(item, e.c);
      pending = [];
    }
  }
  return assigned;
}

export function menuMentionsRawCookthrough(menu, rawRisk) {
  if (!rawRisk?.length) return true;
  const steps = (menu?.preparation || []).filter(Boolean).map(String);
  if (!steps.length) return false;
  for (const item of rawRisk) {
    // The required proof comes from the classifier's cooking rule for
    // this item — the gate never keeps its own temperature table.
    const rule = classifyIngredient(item).cookingRule;
    // The item is proven if ANY single step proves it: the step must
    // name the item AND carry its proof. Evidence is never borrowed
    // from another step (audit v17 P0). An item with no cooking rule
    // cannot be proven — fail safe.
    const proven = steps.some((step) => {
      if (mentionIndex(step, item) < 0) return false;
      if (!rule) return false;
      if (rule.proof === 'firm') return EGG_FIRM_RE.test(step);
      if (!/thermometer/i.test(step)) return false;
      const assigned = assignTemperatures(step, rawRisk);
      const c = assigned.get(item);
      if (c === undefined) return false;
      // The assigned temperature must be one of the rule's
      // temperatures. An unclassifiable item accepts any real cooking
      // temperature (74, 71 or 63); a classified one accepts only its
      // own.
      if (!rule.temperaturesC.includes(c)) return false;
      // A whole cut must also rest for 3 minutes after reaching 63°C.
      if (rule.restMinutes > 0 && !(/rest/i.test(step) && /3\s*min|three\s*min/i.test(step))) return false;
      return true;
    });
    if (!proven) return false;
  }
  return true;
}

// The deterministic cook-through step, always present in the final
// result (audit v19 P0-A): regex validation of LLM narrative can never
// be a complete guarantee, so the correct instruction for every raw /
// unknown-condition item is attached verbatim from rawCookthroughStep
// — even to an LLM menu that already passed the gate. It is inserted
// before the last step (plating), the same place the local fallback
// puts it, so the menu never ends with "Before you plate anything".
export function attachDeterministicStep(menu, rawRisk = [], unknownCondition = [], needsProteinClarification = [], ambiguousProteins = []) {
  const cookable = [...(rawRisk || []), ...(unknownCondition || []), ...(needsProteinClarification || []), ...(ambiguousProteins || [])];
  if (!cookable.length || !Array.isArray(menu?.preparation) || !menu.preparation.length) return menu;
  const step = rawCookthroughStep(cookable);
  menu.preparation = [...menu.preparation];
  menu.preparation.splice(menu.preparation.length - 1, 0, step);
  return menu;
}

// Keep only the LLM-flagged items that the local denylist also flags
// AND that match an ingredient the user actually sent. The LLM is an
// advisor, never the authority: expired/stale/sad food is still food.
// And a flagged name that matches no user ingredient is a
// hallucination, never a reason to reject the whole input — the
// model could return "battery" for a fridge that holds only cold
// rice, and the old code rejected the rice. So a flagged item is
// kept only when it BOTH matches the denylist AND its canonical
// identity shares its words with an ingredient the user sent (a
// subset either way — "battery" matches "2 aa batteries", "dish
// soap" matches "dish soap"). A brand name the denylist does not
// know is a denylist gap, not a reason to trust the model.
// Returns [] for non-array input.
export function filterLlmUnsafeItems(items, ingredients = []) {
  if (!Array.isArray(items)) return [];
  const inputWordSets = (Array.isArray(ingredients) ? ingredients : [])
    .map((ing) => new Set(coreIdentity(ing).split(' ').filter(Boolean)));
  return items.filter((it) => {
    const item = String(it);
    if (localSafetyCheck([item]).length === 0) return false;
    const flagWords = coreIdentity(item).split(' ').filter(Boolean);
    if (!flagWords.length) return false;
    const flagSet = new Set(flagWords);
    return inputWordSets.some((ingWords) => {
      if (!ingWords.size) return false;
      const flagInIng = flagWords.every((w) => ingWords.has(w));
      const ingInFlag = [...ingWords].every((w) => flagSet.has(w));
      return flagInIng || ingInFlag;
    });
  });
}

const SADNESS = [
  [/expired/i, 25],
  [/wilted/i, 20],
  [/cold/i, 15],
  [/stale/i, 15],
  [/\bsingle\b|\bone\b|lonely/i, 12],
  [/leftover/i, 12],
  [/sad|depress/i, 10],
  [/old/i, 8],
  [/forgotten/i, 14],
  [/half/i, 6],
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

// Existential dread tracks dignity, plus a little for each extra ingredient
// waiting in the dark. Capped at 100: a fridge is never more than fully
// dreadful. Used by the local fallback; the LLM reports its own score.
export function computeExistentialDread(dignity, ingredientCount) {
  return Math.max(0, Math.min(100, Math.round(dignity + 3 * Math.min(ingredientCount, 4))));
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
  [/rice/i, 'Risotto of Alienation atop the Ruins of Ambition'],
  [/egg/i, 'The Solitary Egg, Patiently Waiting'],
  [/chicken/i, 'The Repentant Chicken in the Pan'],
  [/potato/i, 'The Resigned Potato at the Knife’s Edge'],
  [/bread/i, 'Bread Lost, Then Found Again'],
  [/cheese/i, 'The Cheese That Waited in the Dark'],
  [/yogurt|yoghurt/i, 'The Expired Yogurt, Absolute'],
  [/pickle/i, 'The Last Pickle Standing'],
];

// The local fallback carries the FULL four-section narrative, not a short
// template: when OpenRouter is rate-limited or slow, the menu on screen
// must still be long, metaphor-rich, and structured — the fallback is a
// different voice, not a lesser menu.
export function localMenu({ ingredients, quote, dread, recurring, dignity, safetyVia = 'local-denylist', spoiled = [], rawRisk = [], unknownCondition = [], needsProteinClarification = [], ambiguousProteins = [] }) {
  const joined = ingredients.join(' ');
  const titleEntry = TITLE_BY_KEYWORD.find(([re]) => re.test(joined));
  const title = titleEntry ? titleEntry[1] : 'Le Frigo Vide, Réinventé';
  const main = ingredients[0] || 'whatever remained';
  const second = ingredients[1] || null;
  const subtitle = `A tasting menu from ${ingredients.length} leftover ingredients. Nothing is hidden.`;
  const recurringTop = recurring?.[0] || null;

  // I. Fridge Aura Analysis — 2-3 sentences, closing with one playful,
  // obviously absurd line in a philosopher's voice (satire, not a real
  // quotation — the quote field itself stays verbatim from the quotes DB).
  const recurringCount = recurringTop ? (recurringTop.count === 1 ? 'once' : `${recurringTop.count} times`) : null;
  const auraBase = `The fridge holds ${ingredients.join(', ')} — a portrait of someone who shops with optimism and cooks with postponement. The ${main} has been waiting longer than you admit, and the ${second ? `${second} has learned to wait quietly beside it` : 'silence on the bottom shelf has learned to wait with it'}. ${recurringTop ? `This is not the first time: ${recurringTop.ingredient} has appeared ${recurringCount} before, and the pattern is no longer an accident.` : 'Nothing here was bought for tonight. Everything was bought for a version of you that never arrived.'}`;
  // The spoiled items were set aside for the bin, not the pan — say so
  // in the chef's voice, so the menu never silently cooks them.
  const setAside = spoiled.length
    ? ` The ${spoiled.join(', ')} was set aside for the bin, not the pan — even existentialism has limits.`
    : '';
  const auraAnalysis = auraBase + setAside + ` As Camus might have put it, "The only truly serious philosophical question is whether to cook this ${main} now, or let it rot as a form of resistance against capitalism."`;

  // II. Outside World Context — exactly 2 sentences, from the dread headline
  // (a clearly fictional local-fallback headline when no live news exists).
  // The headline is embedded mid-sentence, so strip its trailing period and
  // lowercase its first letter ("remember that The world..." is wrong).
  const headline = (dread?.title || '').replace(/[.!?]+$/, '').trim();
  const headlineInline = headline ? headline.charAt(0).toLowerCase() + headline.slice(1) : '';
  const worldContext = headlineInline
    ? `While you sauté this ${main}, remember that ${headlineInline}. At least your skillet is warm.`
    : `While the world kept turning, your fridge stood still. Your ${main} asks for nothing more than heat, salt, and a witness.`;

  // III. Preparation — 3-4 real steps, each fused with a metaphor and
  // naming the actual ingredient it uses. Step 3 uses the third
  // ingredient when one exists (e.g. the sachet sauce as held-back anger);
  // otherwise it is the low-heat softening step. When raw animal products
  // are present, a DETERMINISTIC cook-through step is inserted before
  // plating (audit v14 P0-B, v15 P1): a food thermometer and the internal
  // temperature for the cut — colour and clear juices are NOT proof of
  // doneness (CDC), so the step never cites them as proof.
  const third = ingredients[2] || null;
  const preparation = [
    `Heat a splash of oil in the widest pan you own. Add the ${main} — as rigid as your heart facing family expectations at Thanksgiving dinner — and let the heat do what time refused to do.`,
    `Add the ${second || 'whatever else remains'} and stir quickly, before it realizes its fate — just like your plans from the start of the year, which are now nowhere to be found.`,
    third
      ? `Add the ${third} as a metaphor for the anger you have been holding back. Stir until it is evenly distributed, then serve it on your favorite cracked plate.`
      : `Lower the heat and let everything soften together for two minutes. Do not rush it; the fridge waited days, it can wait two more minutes.`,
    `Plate it without garnish. There is nothing to hide and nothing to celebrate — only a meal, served warm, which is more than nothing.`,
  ];
  // The cook-through step covers explicit raw items AND bare animal
  // products whose condition is unknown (fail safe: a "chicken" that
  // turns out to be raw gets the thermometer step; a cooked one merely
  // gets reheated to 74°C, which is safe advice either way). An item
  // whose protein is unidentified gets the identification clause
  // instead of a temperature — no temperature is claimed for it — and
  // an ambiguous combination gets the separation clause.
  const cookableRaw = [...rawRisk, ...unknownCondition, ...needsProteinClarification, ...ambiguousProteins];
  if (cookableRaw.length) {
    preparation.splice(preparation.length - 1, 0, rawCookthroughStep(cookableRaw));
  }

  // IV. Sommelier Pairing — 1-2 sentences; a second one when dignity is high.
  const sommelier = dignity > 80
    ? `Best enjoyed with lukewarm tap water while staring at a blank wall for four minutes without checking your phone. If you have wine, save it — this meal does not deserve it, and neither do you, tonight.`
    : `Best enjoyed with lukewarm tap water while staring at a blank wall for four minutes without checking your phone.`;

  const chefNote = `The fridge does not lie: the ${main} waited too long, and I cooked it properly, because cooking properly is the only small rebellion left.`;

  return {
    title,
    subtitle,
    existential_dread: computeExistentialDread(dignity, ingredients.length),
    food_safety: foodSafetyLabel({ spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins }),
    safety_warning: safetyWarningText({ spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins }),
    aura_analysis: auraAnalysis,
    world_context: worldContext,
    preparation,
    sommelier,
    chef_note: chefNote,
    dignity_loss_percentage: dignity,
    quote: quote?.text || '',
    quote_author: quote?.author || '',
    dread_pairing: dread?.title || null,
    recurring_culprit: recurringTop?.ingredient || null,
  };
}

export function buildReceiptHtml(meal, menu) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // New contract: numbered preparation steps; old menus (courses) fall back
  // to their course names so an archived old meal still prints.
  const steps = Array.isArray(menu?.preparation) && menu.preparation.length
    ? menu.preparation
    : (menu?.courses || []).map((c) => `${c.name} — ${c.description || ''}`);
  const lines = steps.map((s, i) => `<p>${i + 1}. ${esc(s)}</p>`).join('');
  const warningLine = menu?.safety_warning ? `<p><strong>WARNING:</strong> ${esc(menu.safety_warning)}</p>` : '';
  const section = (label, text) => text ? `<p><strong>${label}</strong><br>${esc(text)}</p>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Culinary Sin Receipt — Meal #${meal.id}</title>
<style>body{font-family:monospace;background:#fff;color:#111;max-width:420px;margin:24px auto;padding:16px;border:1px dashed #111}h1{font-size:14px;text-align:center;letter-spacing:2px}.c{text-align:center}hr{border-top:1px dashed #111}</style></head>
<body><h1>LE FRIGO VIDE</h1><p class="c">CULINARY SIN RECEIPT</p><hr>
<p>Meal #${meal.id} — ${esc(meal.created_at || '')}<br>Title: ${esc(menu?.title || meal.title || '')}<br>Existential Dread: ${menu?.existential_dread ?? '—'}/100 | Food Safety: ${esc(menu?.food_safety || 'FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)')}<br>Dignity loss: ${meal.dignity_loss_percentage}%<br>Ingredients: ${esc((meal.ingredients || []).join(', '))}</p>${warningLine}<hr>
${section('I. Fridge Aura Analysis', menu?.aura_analysis)}
${section('II. Outside World Context', menu?.world_context)}
<p><strong>III. Preparation — With Quiet Resignation</strong></p>${lines}
${section('IV. Sommelier Pairing', menu?.sommelier)}
<p class="c">"${esc(menu?.quote || meal.quote || '')}"<br>— ${esc(menu?.quote_author || meal.quote_author || '')}</p>
<p class="c">Dread pairing: ${esc(menu?.dread_pairing || meal.dread || 'none')}</p><hr><p class="c">Merci. Do not return.<br>Chef Jean-Paul</p></body></html>`;
}

// Non-blocking checkpoint: log the attempt synchronously (so tests and the
// UI can see it immediately), then run sprite-env in the background.
export function triggerCheckpoint(mealId, dignity, sessionId = 'default') {
  initDb();
  const logId = logCheckpoint({
    meal_id: mealId,
    session_id: sessionId,
    checkpoint_id: null,
    dignity_loss_percentage: dignity,
    status: 'requested',
    note: `dignity_loss ${dignity}% > 80 — Lowest Point of the Week Snapshot requested via sprite-env checkpoints create`,
  });
  // In-Sprite checkpoint command, per the official docs (docs.fly.io,
  // "Checkpoints", and the in-Sprite help quoted 2026-01-09):
  //   sprite-env checkpoints create
  // Plural "checkpoints", NO --label flag — the earlier singular form with
  // --label was wrong (audit 2026-11-27) and would have failed on the
  // Sprite. IDs are versioned v0, v1, v2…; the meal id stays in the log
  // note, which is where the meaning lives. Non-blocking either way.
  const child = spawn('sprite-env', ['checkpoints', 'create'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const m = out.match(/\bv\d+\b/);
    const checkpointId = code === 0 && m ? m[0] : null;
    if (code === 0) {
      updateCheckpointLog(logId, { checkpoint_id: checkpointId, status: 'created', note: `sprite-env checkpoints create exited 0. Output: ${out.slice(0, 200)}` });
      if (checkpointId) updateMealCheckpoint(mealId, checkpointId);
    } else {
      updateCheckpointLog(logId, { status: 'failed', note: `sprite-env checkpoints create exited ${code}. Output: ${out.slice(0, 200)}` });
    }
  });
  return { logId, status: 'requested' };
}

// Log Fridge Check — a NEW observation, the only thing that records
// ingredients. One call = one observation_id; each ingredient logs
// `added` (first sighting in this session) or `confirmed_present`.
// A menu generate never calls this, so re-generating the same menu
// cannot inflate appearances or manufacture a Ghost.
export function logFridgeCheck({ ingredients: rawIngredients, sessionId = 'default', lang = 'en' } = {}) {
  initDb();
  const ingredients = parseIngredients(rawIngredients);
  if (ingredients.length === 0) {
    return { ok: false, reason: 'No ingredients were given.' };
  }
  // English-only MVP (audit v19 P1-B): refuse a non-English entry with
  // a hint instead of recording an ingredient the app cannot reason about.
  const unsupported = detectUnsupportedLanguage(ingredients);
  if (unsupported.length) {
    return { ok: false, reason: unsupportedLanguageReason(unsupported), reason_code: 'unsupported_language', unsupported_words: unsupported };
  }
  const observationId = randomUUID();
  for (const ing of ingredients) {
    // A sighting after a fate is a NEW instance ('added'), not a
    // confirmation of the old one — that is what revives the ingredient.
    logIngredientEvent({ sessionId, ingredient: ing, eventType: nextObservationEventType(sessionId, ing), observationId });
  }
  recordIngredients(ingredients, embedText, sessionId);
  return { ok: true, observation_id: observationId, ingredients, session_id: sessionId, chronicle: buildChronicle(lang, sessionId) };
}

export async function generateMenu({ ingredients: rawIngredients, lang = 'en', sessionId = 'default' } = {}) {
  initDb();
  // English-only MVP (v18.1): `lang` is accepted and ignored.
  const language = 'en';
  const ingredients = parseIngredients(rawIngredients);
  if (ingredients.length === 0) {
    return { ok: false, rejected: true, reason: 'No ingredients were given.', reason_code: 'empty' };
  }
  // English-only MVP (audit v19 P1-B): refuse a non-English entry with
  // a hint instead of silently treating it as safe.
  const unsupported = detectUnsupportedLanguage(ingredients);
  if (unsupported.length) {
    return { ok: false, rejected: true, reason: unsupportedLanguageReason(unsupported), reason_code: 'unsupported_language', unsupported_words: unsupported };
  }

  // Stage 1 — Safety guardrail.
  const unsafeLocal = localSafetyCheck(ingredients);
  let safetyVia = 'local-denylist';
  let safetyReason = null;
  if (unsafeLocal.length > 0) {
    safetyReason = `The following items are not food and were refused: ${unsafeLocal.join(', ')}. Chef Jean-Paul does not cook batteries, soap, or household objects.`;
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
        const confirmed = filterLlmUnsafeItems(parsed.unsafe_items, ingredients);
        if (parsed.safe === false && confirmed.length) {
          safetyReason = parsed.reason || `Refused by OpenRouter safety check: ${confirmed.join(', ')}`;
        }
      }
    } catch { /* local denylist already passed; proceed with local fallback */ }
  }
  if (safetyReason) {
    const mealId = insertMeal({
      session_id: sessionId, lang: language, ingredients, title: null, dignity_loss_percentage: 0,
      rejected: true, rejection_reason: safetyReason, menu_json: null,
    });
    return { ok: false, rejected: true, meal_id: mealId, reason: safetyReason, reason_code: 'unsafe', unsafe_items: unsafeLocal, safety_via: safetyVia };
  }

  // Spoilage / raw-risk: still food (never a refusal), but the menu must
  // carry a hard DO NOT CONSUME / cook-thoroughly warning (audit 2026-11-27:
  // the old "Technically Edible" label blessed moldy bread and expired
  // yogurt). Computed locally, never left to the LLM's discretion.
  // Every decision below comes from ONE classification pass
  // (classifyIngredients) — the spoiled, raw-risk and unknown lists
  // are derived from the structured results, not from a second,
  // independent regex classification.
  const classified = classifyIngredients(ingredients);
  const spoiled = classified.filter((c) => c.spoilage).map((c) => c.originalInput);
  // A red warning is not enough if the recipe right below it says
  // "Add the moldy bread..." (audit v13 P0-A). Spoiled ingredients are
  // EXCLUDED from the recipe entirely — only safe ones are cooked.
  // The meal record still keeps the full fridge contents (the truth of
  // what was given); the menu is built from the safe subset only.
  const spoiledSet = new Set(spoiled.map((s) => s.toLowerCase()));
  const safeIngredients = ingredients.filter((i) => !spoiledSet.has(i.toLowerCase()));
  const safeClassified = classified.filter((c) => !c.spoilage);
  // Raw risk is computed from the SAFE subset only (audit v16 P0-A):
  // a spoiled raw item ("moldy raw chicken") is reported as SPOILED
  // (do not consume) and must never reach the recipe — the old code
  // computed rawRisk from the full list, so the thermometer step told
  // the guest to cook the very item the warning told them to throw away.
  // The three lists are the classifier's RECIPE DECISIONS
  // (recipeAction), not the condition labels: a "raw meat" is raw but
  // its decision is "ask for protein clarification", so it is not raw
  // risk — it is in the clarification list, and it gets no temperature.
  const rawRisk = safeClassified.filter((c) => c.recipeAction === 'cook_through').map((c) => c.originalInput);
  // Bare animal products ("chicken") whose condition nobody
  // stated: treated as raw for the recipe (fail safe) while the
  // warning says the condition is unknown (audit v16 P1-C).
  const unknownCondition = safeClassified
    .filter((c) => c.recipeAction === 'ask_user' && !c.needsProteinClarification && !c.ambiguousProteins)
    .map((c) => c.originalInput);
  const needsProteinClarification = safeClassified
    .filter((c) => c.needsProteinClarification)
    .map((c) => c.originalInput);
  // More than one primary protein in one entry: the guest must
  // separate them into one entry per protein before any recipe is
  // made. A processed compound never counts ("chicken with fish
  // sauce" is one protein, the chicken).
  const ambiguousProteins = safeClassified
    .filter((c) => c.ambiguousProteins)
    .map((c) => c.originalInput);
  if (safeIngredients.length === 0) {
    // Nothing left worth cooking: a cooking refusal, not a menu.
    const reason = `Everything in this fridge is spoiled: ${spoiled.join(', ')}. Chef Jean-Paul refuses to cook with it — throw it away.`;
    const mealId = insertMeal({
      session_id: sessionId, lang: language, ingredients, title: null, dignity_loss_percentage: computeDignityLoss(ingredients),
      rejected: true, rejection_reason: reason, menu_json: null,
    });
    return { ok: false, rejected: true, meal_id: mealId, reason, reason_code: 'spoiled', spoiled_items: spoiled, safety_via: safetyVia };
  }

  // Preflight blocker: more than one primary protein in one entry.
  // No recipe is made — not even the local fallback — until the guest
  // separates them into one entry per protein. A warning in the
  // middle of a recipe that already cooked the mixture is a
  // contradiction: the guest was told to cook it and to separate it,
  // in the same menu. This runs BEFORE any OpenRouter call, so the
  // LLM never sees the ambiguous entry either.
  if (ambiguousProteins.length > 0) {
    const suggestions = ambiguousProteins.map((item) => {
      const parts = separateProteins(item);
      return parts.length > 1 ? `"${item}" becomes ${parts.map((p) => `"${p}"`).join(' and ')}` : null;
    }).filter(Boolean);
    const suggestionText = suggestions.length ? ` ${suggestions.join('; ')}.` : '';
    const reason = `Chef Jean-Paul has found more than one animal protein in ${ambiguousProteins.join(', ')} — kindly separate them into one entry per protein.${suggestionText} He refuses to guess which temperature belongs to whom.`;
    const mealId = insertMeal({
      session_id: sessionId, lang: language, ingredients, title: null, dignity_loss_percentage: computeDignityLoss(ingredients),
      rejected: true, rejection_reason: reason, menu_json: null,
    });
    return { ok: false, rejected: true, meal_id: mealId, reason, reason_code: 'ambiguous_protein', ambiguous_protein_items: ambiguousProteins, safety_via: safetyVia };
  }

  // Stage 2 — Memory: recurring culprits + quote, scoped to this session.
  // NOTE: a generate does NOT record ingredients (only a fridge check
  // does), so re-generating the same menu cannot inflate appearances.
  // The recipe is built from SAFE ingredients only (spoiled ones are set
  // aside for the bin). Dignity still counts the whole fridge — it IS
  // that sad — but nothing spoiled is cooked, quoted, or named as a
  // recurring pattern in the dish.
  const recurring = getRecurringCulprits(5, sessionId).filter((r) => safeIngredients.some((i) => i.toLowerCase().includes(r.ingredient) || r.ingredient.includes(i.toLowerCase())));
  const historyEmbeddings = getIngredientEmbeddings(sessionId);
  const quoteResult = await pineconeQuery({ text: safeIngredients.join(' '), candidates: QUOTES.map((q) => ({ ...q })) });
  const quote = quoteResult.results?.[0] ? { text: quoteResult.results[0].text, author: quoteResult.results[0].author } : pickQuote(safeIngredients);
  void historyEmbeddings;

  // Stage 3 — Global Dread Pairing, fetched BEFORE synthesis so the LLM
  // can write world_context from the real headline (not a placeholder).
  const dreadRes = await apifyFetchNews();
  const dread = dreadRes.news;

  // Stage 4 — Menu synthesis.
  const dignity = computeDignityLoss(ingredients);
  const foodSafety = foodSafetyLabel({ lang: language, spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins });
  const safetyWarning = safetyWarningText({ lang: language, spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins });
  let menu = null;
  let synthesisVia = 'local-fallback';
  let synthesisNote = null;
  try {
    const res = await callOpenRouter({
      model: 'openrouter/free',
      // 60s + capped output: the free model needs >20s for a full menu
      // (proven by the 20000ms abort in the Sprite service log, 2026-11-27),
      // and the four-section narrative is longer than the old 2-course menu.
      // max_tokens 1200 fits aura + world + 3-4 long steps + sommelier.
      timeoutMs: 60000,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: getSystemPrompt(language) },
        { role: 'user', content: buildUserPrompt({ ingredients: safeIngredients, lang: language, quote, dread, recurring, spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins }) },
      ],
    });
    // When the fallback is caused by the free tier's rate limit, say so
    // plainly instead of silently serving the local menu — the judge (and
    // the user) can tell a limit from a bug, and retrying later works.
    if (!res.ok && /429/.test(res.reason || '')) {
      synthesisNote = 'OpenRouter is rate-limited right now (HTTP 429, free tier). Serving the local menu — try again in a few minutes.';
    }
    if (res.ok && res.text) {
      const parsed = extractJsonObject(res.text) || {};
      // Free models vary the keys: accept title/dish_title/name and
      // preparation/steps/instructions — or the old courses shape, mapped
      // to steps ("name — description"). Steps may be strings, {step} /
      // {text} / {description} objects, or one newline-separated string.
      const title = parsed.title || parsed.dish_title || parsed.name || null;
      let rawPrep = parsed.preparation || parsed.steps || parsed.instructions || null;
      if (typeof rawPrep === 'string') rawPrep = rawPrep.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      let preparation = Array.isArray(rawPrep)
        ? rawPrep.map((s) => (typeof s === 'string' ? s : s?.step || s?.text || s?.instruction || s?.description || '')).map((s) => String(s).trim()).filter(Boolean)
        : [];
      if (!preparation.length && Array.isArray(parsed.courses)) {
        preparation = parsed.courses
          .map((c) => (typeof c === 'string' ? c : `${c?.name || ''} — ${c?.description || ''}`.trim()))
          .map((s) => s.replace(/^—\s*|\s*—$/, '').trim()).filter(Boolean);
      }
      if (title && preparation.length >= 2) {
        if (menuNamesSpoiled({ title, preparation }, spoiled, safeIngredients)) {
          console.error(`[synthesis] LLM menu named a spoiled ingredient (${spoiled.join(', ')}); discarding it for the safe local menu.`);
        } else if (!menuMentionsRawCookthrough({ title, preparation }, [...rawRisk, ...unknownCondition, ...needsProteinClarification, ...ambiguousProteins])) {
          console.error(`[synthesis] LLM menu never proved the raw ${[...rawRisk, ...unknownCondition, ...needsProteinClarification, ...ambiguousProteins].join(', ')} was cooked through; discarding it for the safe local menu.`);
        } else {
          const dreadScore = Number.isInteger(parsed.existential_dread) && parsed.existential_dread >= 0 && parsed.existential_dread <= 100
            ? parsed.existential_dread
            : computeExistentialDread(dignity, safeIngredients.length);
          menu = {
            ...parsed,
            title,
            preparation,
            existential_dread: dreadScore,
            food_safety: foodSafety,
            safety_warning: safetyWarning,
            spoilage_warning: spoiled.length > 0,
            dignity_loss_percentage: dignity,
            quote: quote.text,
            quote_author: quote.author,
          };
          // The deterministic cook-through step is always present in the
          // final result (audit v19 P0-A) — even on an LLM menu that
          // passed the gate, because regex validation of LLM narrative
          // is never a complete guarantee.
          attachDeterministicStep(menu, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins);
          synthesisVia = 'openrouter/free';
        }
      } else {
        console.error(`[synthesis] OpenRouter reply unusable (title=${JSON.stringify(title)}, preparation steps=${preparation.length}). Reply head: ${res.text.slice(0, 200)}`);
      }
    } else if (res && !res.ok) {
      console.error(`[synthesis] OpenRouter call failed: ${res.reason || 'unknown'}`);
    }
  } catch (err) { console.error(`[synthesis] exception: ${err?.message || err}`); /* fall through to local synthesis */ }
  if (!menu) {
    menu = localMenu({ ingredients: safeIngredients, lang: language, quote, dread, recurring, dignity, safetyVia, spoiled, rawRisk, unknownCondition, needsProteinClarification, ambiguousProteins });
    menu.spoilage_warning = spoiled.length > 0;
    menu.dread_pairing = dread?.title || null;
    menu.synthesis_via = synthesisVia;
    menu.memory_via = quoteResult.via;
    menu.dread_via = dreadRes.via;
    const mealId = insertMeal({
      session_id: sessionId, lang: language, ingredients, title: menu.title, dignity_loss_percentage: dignity,
      quote: quote.text, quote_author: quote.author, dread: dread?.title || null,
      menu_json: menu, rejected: false,
    });
    let checkpoint = null;
    if (dignity > 80) checkpoint = triggerCheckpoint(mealId, dignity, sessionId);
    return { ok: true, rejected: false, meal_id: mealId, menu, dignity_loss_percentage: dignity, safety_via: safetyVia, synthesis_via: synthesisVia, synthesis_note: synthesisNote, memory_via: quoteResult.via, dread_via: dreadRes.via, dread, recurring, checkpoint, spoilage_warning: spoiled.length > 0, spoiled_items: spoiled, raw_risk_items: rawRisk, unknown_condition_items: unknownCondition, needs_protein_clarification_items: needsProteinClarification, ambiguous_protein_items: ambiguousProteins };
  }

  // OpenRouter path: persistence + checkpoint (dread already attached).
  menu.dread_pairing = dread?.title || null;
  menu.synthesis_via = synthesisVia;
  menu.memory_via = quoteResult.via;
  menu.dread_via = dreadRes.via;
  const mealId = insertMeal({
    session_id: sessionId, lang: language, ingredients, title: menu.title, dignity_loss_percentage: dignity,
    quote: quote.text, quote_author: quote.author, dread: dread?.title || null,
    menu_json: menu, rejected: false,
  });
  let checkpoint = null;
  if (dignity > 80) checkpoint = triggerCheckpoint(mealId, dignity, sessionId);
  return { ok: true, rejected: false, meal_id: mealId, menu, dignity_loss_percentage: dignity, safety_via: safetyVia, synthesis_via: synthesisVia, memory_via: quoteResult.via, dread_via: dreadRes.via, dread, recurring, checkpoint, spoilage_warning: spoiled.length > 0, spoiled_items: spoiled, raw_risk_items: rawRisk, unknown_condition_items: unknownCondition, needs_protein_clarification_items: needsProteinClarification, ambiguous_protein_items: ambiguousProteins };
}
