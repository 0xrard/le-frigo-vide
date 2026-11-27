// Ingredient classifier — the SINGLE source of truth for ingredient
// condition (audit v20.3 refactor, 2026-11-27; architecture
// correction v25, 2026-11-28).
//
// The condition rules used to live in two places — src/pipeline.mjs and
// public/app.js — each with its own copy of the regexes
// (RAW_RISK_PATTERNS, COOKED_QUALIFIER_RE, NOT_COOKED_RE,
// PARTIALLY_COOKED_RE, PROCESSED_PRODUCT_RE and the frontend's
// bareAnimalItems). Every audit round patched one copy and the other
// drifted. This module is the only place the rules live: the Node
// backend imports it, and the browser frontend imports the same file
// (served at /shared/ingredient-classifier.mjs). If the two ever
// disagree, the module — not a patch — is wrong.
//
// The module is PURE: no Node builtins, no DOM, no I/O, no randomness.
// The same input always gives the same result, on the server and in
// the browser.
//
// The architecture correction (v25): an entry is parsed into
// COMPONENTS, one per sub-phrase, each with an explicit ROLE
// (primary_protein, condiment, stock, prepared_staple, prepared_dish,
// other) and a CANONICAL protein identity. Three separations that the
// earlier versions blurred:
//   * identity vs cooking category. The identity is the species
//     (chicken, turkey, beef, salmon); the category is the cooking
//     group (poultry, red_meat, fish). Two species can share a
//     temperature and still be two proteins — they are never
//     deduplicated for sharing one. Only VERIFIED exact synonyms
//     collapse (shrimp/prawn).
//   * a compound vs the protein next to it. A compound is recognised
//     by an exact, longest-match lexicon phrase ("fish sauce"), not
//     by a broad word ("sauce"). Recognising one never stops the
//     scan of the rest of the entry: "fish sauce with raw beef" is a
//     condiment AND a primary protein.
//   * the protein subject vs the first protein word. All primary
//     protein candidates are resolved FIRST (from the components),
//     and the subject is the phrase of the first candidate — never
//     the first protein word in the raw input. "fish sauce with raw
//     beef" is a raw beef, never a fish sauce.
//
// The protein subject: an entry is a little sentence, and the
// condition belongs to the PHRASE that holds the animal protein —
// not to the whole entry, and not to the first phrase. "cooked
// chicken with raw salad" is a cooked chicken (the "raw" belongs to
// the salad); "rice with cooked chicken" is a cooked chicken (the
// chicken is the second phrase); "fried rice with uncooked chicken"
// is an unknown chicken (the "fried" belongs to the rice).
// proteinSubjectPart() finds that phrase, and every condition check
// below runs on it alone. The spoilage check is the exception: a
// spoiled accompaniment spoils the dish, so it still reads the whole
// entry.
//
// Deterministic precedence (enforced by generateMenu in pipeline.mjs,
// which applies the non-food gate first, then this classifier):
//   1. non-food -> the request is refused (localSafetyCheck, pipeline
//      Stage 1 — this classifier assumes the input passed that gate).
//   2. spoiled / expired -> EXCLUDE from the recipe, whatever the
//      condition is. Spoilage is never a reason to cook harder.
//   3. explicit user condition selection -> use the selection, unless
//      spoilage requires exclusion. The user knows their fridge.
//   4. a negated "raw" (in the subject) -> unknown: "not raw
//      chicken" says what the chicken is NOT. It is neither cooked
//      nor explicit raw. Evaluated before the raw check, or the bare
//      word "raw" would win.
//   5. explicit raw (in the protein subject) -> raw (cook through).
//   6. negated, uncooked or partial cooking (in the subject) ->
//      unknown / partially_cooked: the item still needs a full
//      cook-through, and the guest is asked.
//   7. positively and unambiguously cooked protein subject -> cooked.
//   8. recognised ready-to-eat compound (a role, not a word) ->
//      not_applicable (fish sauce, egg noodles — nobody asks if fish
//      sauce is raw). The exemption only fires when there is NO
//      condition evidence: "partially cooked chicken nuggets" is
//      unknown, not processed.
//   9. animal protein with no reliable condition -> unknown (ask).
//  10. anything else -> not_applicable.
//  11. a raw protein whose type or form is unknown ("raw meat") ->
//      ask for protein clarification before any recipe is made. No
//      temperature can be claimed for a protein nobody identified,
//      so the cooking rule is null and the validator accepts no
//      temperature for it.
//  12. more than one primary protein OCCURRENCE in one entry —
//      where an occurrence is an identity + a condition + a cooking
//      rule. Different identities ("raw chicken with raw fish",
//      "chicken and beef", "chicken and turkey") conflict, and so
//      does the SAME identity with a different condition ("cooked
//      chicken with raw chicken") or a different cooking rule
//      ("ground beef with beef steak"). One entry, one primary
//      protein occurrence with one consistent condition and cooking
//      form. A repeated occurrence that agrees on all three ("raw
//      chicken with raw chicken", "shrimp and prawn") is one protein
//      written twice — it merges. A condiment, a stock, or a
//      prepared staple never counts ("chicken with fish sauce" is
//      one protein, the chicken). No cooking rule — two items, two
//      states, one entry. The recipe is blocked (a preflight gate
//      in generateMenu), not warned about inside a menu. And the
//      entry's condition is the condition all occurrences agree on;
//      when they disagree, it is unknown — the first component's
//      condition never stands for the others.
//
// The one rule that matters most: the mere presence of the word
// "cooked" is NEVER proof of a cooked condition. A negation ("not
// cooked", "has not yet been properly cooked") or a partial condition
// ("partially cooked") is not cooked, and an ambiguous input returns
// unknown rather than guessing. When in doubt, the recipe cooks it
// through — or asks. Every unresolved ambiguity is reported, never
// guessed.

// --- Normalization ------------------------------------------------------
// NFKC (compatibility characters, full-width letters), lowercase, one
// kind of apostrophe, one kind of hyphen, single spaces. "RAW  Chicken"
// and "raw chicken" are the same input after this; so are "chicken’s"
// (curly apostrophe) and "chicken's".
export function normalizeIngredientText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘‚‛`´]/g, "'")
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// The prepositions that separate a dish's phrases. The same split
// defines the main part (the first phrase) and the protein subject.
const PREPOSITION_RE = /\b(?:in|with|on|plus)\b|served\s+with|topped\s+with/i;

// The main ingredient, separately from its accompaniments: the part
// before the first preposition (in / with / on / plus / served with /
// topped with). "chicken in sauce" is a chicken that happens to sit in
// sauce; "chicken with fried rice" is a chicken — the fried rice does
// not cook it.
export function mainIngredientPart(item) {
  return normalizeIngredientText(item).split(PREPOSITION_RE)[0].trim();
}

// --- Vocabulary ---------------------------------------------------------
// Spoilage words: the item is still food, but it must never be cooked.
const SPOILAGE_WORDS = ['moldy', 'mouldy', 'rotten', 'spoiled', 'expired'];
const SPOILAGE_RE = new RegExp(`\\b(?:${SPOILAGE_WORDS.join('|')})\\b`, 'i');

// --- Canonical protein identity ---------------------------------------
// The identity is the SPECIES (chicken, turkey, beef, salmon), and the
// cooking category is the group it cooks in (poultry, red_meat,
// fish). They are separate fields, and they are never conflated: two
// species can share a temperature and still be two proteins. Only
// VERIFIED exact synonyms collapse — shrimp/prawn — and the table is
// deliberately one entry long. A new synonym needs evidence that the
// two words name the same animal, not just the same temperature.
// chicken/turkey, beef/pork, salmon/tuna, fish/salmon and
// chicken/poultry are separate identities, full stop.
const PROTEIN_SYNONYMS = { prawn: 'shrimp' };
// The species words. "fish", "poultry" and "seafood" are generic
// identities (an unspecified fish, an unspecified poultry) — they are
// still identities, distinct from every species under them. "meat"
// is an unidentified protein.
const SPECIES_WORDS = [
  'fish', 'salmon', 'tuna',
  'shrimp', 'prawn', 'seafood',
  'chicken', 'turkey', 'duck', 'poultry',
  'egg',
  'beef', 'pork', 'lamb',
  'meat',
];
// Cut and form words. They are NOT identities: "beef steak" is one
// animal (beef) — the "steak" is the cut — and "pork sausage" is one
// animal (pork). On their own, with no species word, they are a
// protein of unknown species ("sausage" is ground red meat, "steak"
// is a whole cut) — so a bare sausage is still an animal product
// whose condition is unknown, and "raw pork sausage" is raw.
const FORM_WORDS = ['steak', 'sausage'];
// The cooking category for a canonical identity. Protein first, then
// form: ground salmon is still fish (63°C), ground chicken is still
// poultry (74°C) — the ground form only matters for red meat.
const PROTEIN_CATEGORY = {
  fish: 'fish', salmon: 'fish', tuna: 'fish',
  shrimp: 'seafood', seafood: 'seafood',
  chicken: 'poultry', turkey: 'poultry', duck: 'poultry', poultry: 'poultry',
  egg: 'egg',
  beef: 'red_meat', pork: 'red_meat', lamb: 'red_meat', steak: 'red_meat',
  sausage: 'red_meat',
  meat: 'unknown_meat',
};
const GROUND_FORM_RE = /\b(?:ground|minced|sausage)\b/i;

// The canonical protein identity of one word, or null. "prawn" is
// "shrimp"; every other species word is its own identity.
export function canonicalProtein(word) {
  const w = String(word || '').toLowerCase();
  if (!SPECIES_WORDS.includes(w)) return null;
  return PROTEIN_SYNONYMS[w] || w;
}

// All canonical protein identities named in a sub-phrase, in order.
// A species word wins over a form word ("pork sausage" is pork,
// "beef steak" is beef, "chicken sausage" is chicken); a form word
// on its own is a protein of unknown species.
function phraseProteins(phrase) {
  const words = String(phrase || '').split(/[^a-z]+/).filter(Boolean);
  const found = [];
  for (const word of words) {
    const identity = canonicalProtein(word);
    if (identity && !found.includes(identity)) found.push(identity);
  }
  if (found.length === 0) {
    for (const word of words) {
      if (FORM_WORDS.includes(word)) { found.push(word); break; }
    }
  }
  return found;
}

// --- The compound lexicon ---------------------------------------------
// Exact, longest-match compound phrases. A compound is recognised by
// its exact phrase — not by a broad word ("sauce" alone matches
// nothing, "broth" alone matches nothing) — and recognising one
// never stops the scan of the rest of the entry. The lexicon is the
// ONLY place a compound is defined: no word list, no separate regex.
// The entries are sorted longest-first, so "chicken broth" wins over
// a shorter phrase that is also present.
const COMPOUND_LEXICON = [
  // Condiments — a flavour, never a protein.
  ['fish sauce', 'condiment'],
  ['soy sauce', 'condiment'],
  ['oyster sauce', 'condiment'],
  ['shrimp paste', 'condiment'],
  ['hot sauce', 'condiment'],
  ['barbecue sauce', 'condiment'],
  ['bbq sauce', 'condiment'],
  ['chili sauce', 'condiment'],
  ['tomato sauce', 'condiment'],
  ['salad dressing', 'condiment'],
  ['ketchup', 'condiment'],
  ['mayonnaise', 'condiment'],
  ['mayo', 'condiment'],
  // Stocks — a flavour base, never a protein.
  ['chicken broth', 'stock'],
  ['beef broth', 'stock'],
  ['beef stock', 'stock'],
  ['chicken stock', 'stock'],
  ['vegetable stock', 'stock'],
  ['fish stock', 'stock'],
  ['bone broth', 'stock'],
  ['dashi', 'stock'],
  ['bouillon', 'stock'],
  // Prepared staples — ready to eat, no protein condition.
  ['egg noodles', 'prepared_staple'],
  ['rice noodles', 'prepared_staple'],
  ['glass noodles', 'prepared_staple'],
  ['instant ramen', 'prepared_staple'],
  ['ramen noodles', 'prepared_staple'],
  ['ramen', 'prepared_staple'],
  ['spaghetti', 'prepared_staple'],
  ['pasta', 'prepared_staple'],
  // Prepared dishes — ready to eat, but the protein inside can be
  // undercooked, so it still counts as a protein candidate.
  ['fried rice', 'prepared_dish'],
  ['chicken nuggets', 'prepared_dish'],
  ['beef stew', 'prepared_dish'],
  ['chicken curry', 'prepared_dish'],
  ['beef curry', 'prepared_dish'],
  ['chicken soup', 'prepared_dish'],
  ['tomato soup', 'prepared_dish'],
  ['vegetable soup', 'prepared_dish'],
  ['chicken stew', 'prepared_dish'],
  ['meatballs', 'prepared_dish'],
  // Processed meats — ready to eat.
  ['jerky', 'prepared_dish'],
  ['ham', 'prepared_dish'],
  ['bacon', 'prepared_dish'],
  ['salami', 'prepared_dish'],
  ['pepperoni', 'prepared_dish'],
];
const COMPOUND_LEXICON_SORTED = [...COMPOUND_LEXICON].sort((a, b) => b[0].length - a[0].length);
// A processed form: a form word + a protein word ("canned chicken",
// "dried beef") is a ready-to-eat product. The form words are part of
// the lexicon's matching, not a separate exclusion list.
const PROCESSED_FORM_WORDS = ['canned', 'dried'];

// The longest lexicon phrase that appears in a sub-phrase as a
// whole-word sequence, or null. A single word ("ramen", "ketchup")
// matches on its own. "chicken broth" wins over any shorter phrase
// that is also present, because the lexicon is sorted longest-first.
function matchCompound(phrase) {
  const text = ` ${normalizeIngredientText(phrase)} `;
  for (const [compound, role] of COMPOUND_LEXICON_SORTED) {
    if (text.includes(` ${compound} `)) return { phrase: compound, role };
  }
  const words = normalizeIngredientText(phrase).split(/[^a-z]+/).filter(Boolean);
  // The form word can sit behind condition words ("not yet cooked
  // canned chicken" is still a canned chicken) — it only has to
  // come before the protein it preserves.
  const formIndex = words.findIndex((w) => PROCESSED_FORM_WORDS.includes(w));
  if (formIndex >= 0 && words.slice(formIndex + 1).some((w) => SPECIES_WORDS.includes(w))) {
    return { phrase: words.slice(formIndex, formIndex + 2).join(' '), role: 'prepared_dish' };
  }
  return null;
}

// --- Components ---------------------------------------------------------
// The roles an ingredient component can have. A component is one
// sub-phrase of an entry.
export const INGREDIENT_ROLES = ['primary_protein', 'condiment', 'stock', 'prepared_staple', 'prepared_dish', 'other'];

// The sub-phrases of an entry: split on prepositions, then on
// conjunctions ("and" / "or"). "&" is "and" written short, and "/"
// between two foods is a choice or a mixture — never a guess — so
// both cut the same way: the proteins on either side are found as
// separate sub-phrases, and the entry is asked to choose or
// separate. A compound must never hide the protein next to it:
// "chicken with fish sauce and raw beef" is three sub-phrases —
// "chicken", "fish sauce", "raw beef" — so the beef is found even
// though the sauce is recognised.
//   "chicken with fish sauce and raw beef" -> ["chicken", "fish sauce", "raw beef"]
//   "chicken and beef"                     -> ["chicken", "beef"]
//   "chicken/turkey"                       -> ["chicken", "turkey"]
//   "raw chicken with raw fish"            -> ["raw chicken", "raw fish"]
export function ingredientSubPhrases(input) {
  const phrases = [];
  for (const seg of normalizeIngredientText(input).split(PREPOSITION_RE)) {
    for (const part of seg.split(/\b(?:and|or)\b|[&/]/i)) {
      const trimmed = part.trim();
      if (trimmed) phrases.push(trimmed);
    }
  }
  return phrases;
}

// Parse an entry into its components: one per sub-phrase, each with
// its role and EVERY canonical protein identity it holds (or none).
// The animal word inside a condiment, a stock, or a prepared staple
// is the flavour, not a protein — so its identities are empty. The
// protein inside a prepared dish DOES count (it can be undercooked).
// A sub-phrase with no compound and no protein is "other".
// `protein` is the first identity, kept for the subject;
// `proteins` is the whole list, and it is the contract: every
// detected identity must become an explicit occurrence, and no
// detected protein may silently disappear during parsing. A
// sub-phrase can hold two identities ("chicken turkey", with no
// separator at all) — they are both listed, and the occurrence
// model decides what to do with them.
//   "fish sauce with raw beef" -> [
//     { text: "fish sauce", role: "condiment", protein: null, proteins: [] },
//     { text: "raw beef", role: "primary_protein", protein: "beef", proteins: ["beef"] }]
export function parseComponents(input) {
  return ingredientSubPhrases(input).map((phrase) => {
    const compound = matchCompound(phrase);
    if (compound) {
      const role = compound.role;
      const proteins = role === 'prepared_dish' ? phraseProteins(phrase) : [];
      return { text: phrase, role, protein: proteins[0] || null, proteins };
    }
    const proteins = phraseProteins(phrase);
    return { text: phrase, role: proteins.length ? 'primary_protein' : 'other', protein: proteins[0] || null, proteins };
  });
}

// The condition of ONE protein component, from its own text alone.
// The same precedence as the entry-level condition, scoped to the
// component: a negation or a partial condition is not cooked, and
// the compound exemption only fires when there is no condition
// evidence. Null when the component holds no protein (a condiment,
// a stock, a prepared staple, or anything else without a protein).
//   "cooked chicken" -> "cooked"; "raw chicken" -> "raw";
//   "partially cooked chicken nuggets" -> "partially_cooked";
//   "chicken nuggets" -> "not_applicable" (ready to eat).
export function componentCondition(component) {
  if (!component || !component.protein) return null;
  const text = component.text;
  const isProcessed = component.role !== 'primary_protein' && component.role !== 'other';
  if (NOT_RAW_RE.test(text)) return 'unknown';
  if (RAW_RE.test(text)) return 'raw';
  if (UNCOOKED_RE.test(text) || NOT_COOKED_RE.test(text)) return 'unknown';
  if (PARTIALLY_COOKED_RE.test(text)) return 'partially_cooked';
  if (COOKED_RE.test(text)) return 'cooked';
  if (isProcessed) return 'not_applicable';
  return 'unknown';
}

// A protein occurrence: one component's protein, with the identity,
// the condition (from the component's own text), and the cooking
// rule (identity + form). One occurrence PER IDENTITY the component
// holds — never just the first. A sub-phrase that names two
// proteins ("chicken turkey", with no separator at all) is two
// occurrences, so the second one cannot silently disappear during
// parsing. Two occurrences of the same species are the same protein
// ONLY when their condition and their cooking rule agree —
// otherwise they are two different items that happen to share a
// name. "cooked chicken with raw chicken" is two chickens, not one;
// "raw chicken with raw chicken" is one chicken written twice. A
// verified synonym is one occurrence (shrimp/prawn share the
// identity "shrimp").
export function proteinOccurrences(input) {
  const occurrences = [];
  for (const component of parseComponents(input)) {
    const condition = componentCondition(component);
    for (const identity of component.proteins) {
      const rule = cookingRuleFor(identity, component.text);
      occurrences.push({
        identity,
        condition,
        // The cooking signature: the rule kind plus its temperatures
        // and rest. Two occurrences with the same identity and the
        // same condition but different signatures are two different
        // cooks (a ground beef and a whole beef).
        ruleSignature: rule ? `${rule.kind}:${rule.temperaturesC.join(',')}:${rule.restMinutes}` : null,
        text: component.text,
        // The suggested entry for the separation: the component's
        // text when it holds one protein, the identity itself when
        // it holds several (the component IS the ambiguity, so it
        // cannot be suggested as-is).
        suggestion: component.proteins.length > 1 ? identity : component.text,
        role: component.role,
      });
    }
  }
  return occurrences;
}

// Whether the protein occurrences in an entry conflict: more than
// one distinct identity, or the same identity with a different
// condition, or the same identity with a different cooking rule.
// A repeated occurrence that agrees on identity, condition, and
// rule is the same protein written twice — it merges, and the entry
// is not ambiguous.
export function occurrencesConflict(input) {
  const occurrences = proteinOccurrences(input);
  if (occurrences.length < 2) return false;
  if (new Set(occurrences.map((o) => o.identity)).size > 1) return true;
  if (new Set(occurrences.map((o) => o.condition)).size > 1) return true;
  if (new Set(occurrences.map((o) => o.ruleSignature)).size > 1) return true;
  return false;
}

// The distinct PRIMARY protein identities in an entry, in order of
// appearance. A condiment, a stock, or a prepared staple contributes
// nothing (the animal in it is the flavour). A prepared dish
// contributes its protein (it can be undercooked). Only verified
// exact synonyms collapse (shrimp/prawn); chicken/turkey, beef/
// pork, salmon/tuna, fish/salmon and chicken/poultry are separate
// identities — they share a temperature, not an identity.
//   "raw chicken with raw fish" -> ["chicken", "fish"]
//   "chicken and beef"          -> ["chicken", "beef"]
//   "chicken and turkey"        -> ["chicken", "turkey"]
//   "chicken with fish sauce"   -> ["chicken"]
//   "fish sauce"                -> []
//   "shrimp and prawn"          -> ["shrimp"]
// One entry, one primary protein: two or more is ambiguous, and the
// system must ask for separation instead of guessing which
// temperature belongs to whom.
export function primaryProteins(input) {
  const found = [];
  for (const phrase of ingredientSubPhrases(input)) {
    const compound = matchCompound(phrase);
    // The animal in a condiment, a stock, or a prepared staple is
    // the flavour — skip the whole sub-phrase. A prepared dish
    // keeps its protein (it can be undercooked).
    if (compound && compound.role !== 'prepared_dish') continue;
    for (const identity of phraseProteins(phrase)) {
      if (!found.includes(identity)) found.push(identity);
    }
  }
  return found;
}

// One suggested entry per DISTINCT protein occurrence, for the
// separation clarification: one per identity + condition + cooking
// rule, in order. Two occurrences of the same species with different
// conditions are two entries ("cooked chicken" and "raw chicken"),
// while a repeated occurrence that agrees on all three is one
// ("shrimp and prawn" suggests one entry, not two — they are the
// same protein, same condition, same rule).
//   "raw chicken with raw fish"            -> ["raw chicken", "raw fish"]
//   "chicken with fish sauce and raw beef" -> ["chicken", "raw beef"]
//   "cooked chicken with raw chicken"      -> ["cooked chicken", "raw chicken"]
// A condiment, a stock, or a prepared staple contributes no entry —
// the guest can add the sauce back to whichever entry they like.
export function separateProteins(input) {
  const seen = new Set();
  const entries = [];
  for (const occurrence of proteinOccurrences(input)) {
    const key = `${occurrence.identity}|${occurrence.condition}|${occurrence.ruleSignature}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(occurrence.suggestion);
    }
  }
  return entries;
}

// The protein subject: the phrase of the FIRST primary protein
// candidate — resolved from the full candidate list (the components),
// never by scanning the raw input for the first protein word.
// "fish sauce with raw beef" is a raw beef (the fish sauce is a
// condiment, not a protein), never a fish sauce. Returns null when no
// component holds a protein.
//   "cooked chicken with raw salad" -> "cooked chicken"
//   "rice with cooked chicken"     -> "cooked chicken"
//   "fried rice with raw chicken"  -> "raw chicken"
//   "chicken in sauce"             -> "chicken"
//   "chicken with fried rice"      -> "chicken"
//   "fish sauce with raw beef"     -> "raw beef"
//   "fish sauce"                   -> null
export function proteinSubjectPart(input) {
  for (const component of parseComponents(input)) {
    if (component.protein) return component.text;
  }
  return null;
}


// Cooked qualifiers: English cooking verbs only. "smoked", "cured" and
// "pickled" are NOT here — cold-smoked fish is not cooked (FDA/CDC:
// cold smoking does not kill Listeria), so a "cold smoked salmon" is
// asked about, never assumed cooked. "roast" is here (a roast chicken
// is a cooked chicken); the participles cover the rest.
const COOKED_WORDS = ['cooked', 'fried', 'grilled', 'roast', 'roasted', 'boiled', 'baked', 'steamed'];
const COOKED_RE = new RegExp(`\\b(?:${COOKED_WORDS.join('|')})\\b`, 'i');

// A negated "raw" ("not raw", "isn't raw") is NOT cooked — and it
// is not explicit raw either. The guest said what the item is NOT,
// so the honest label is unknown. Evaluated BEFORE RAW_RE, or the
// bare word "raw" in "not raw chicken" would win and the item would
// be called raw.
const NOT_RAW_RE = /\b(?:not|never|isn'?t|ain'?t|hasn'?t|haven'?t|wasn'?t|weren'?t|didn'?t)\s+(?:[a-z-]+\s+){0,3}raw\b/i;

// A negation ("not cooked") or a partial condition ("partially
// cooked") is NOT cooked: the item still needs a full cook-through.
// The negation allows up to three adverb/auxiliary words between the
// negation and "cooked" ("not yet cooked", "not properly cooked",
// "not sufficiently cooked", "chicken has not yet been properly
// cooked", "not yet been fully cooked"). Three is the bound: a longer
// natural sentence needs three, and a fourth would only come from a
// sentence no guest writes as an ingredient. The pattern is
// deliberately NOT a fixed list of adverbs — the words between the
// negation and "cooked" are what the cook is denying, and no fixed
// list covers them all.
const NOT_COOKED_RE = /\b(?:not|never|isn'?t|ain'?t|hasn'?t|haven'?t|wasn'?t|weren'?t|didn'?t)\s+(?:[a-z-]+\s+){0,3}cooked\b/i;
const PARTIALLY_COOKED_RE = /\b(?:partially|partly|half)[- ]cooked\b/i;
// "uncooked" and "undercooked" are negations in one word: the item is
// not cooked (enough). They are unknown, never cooked — the same
// verdict the word-boundary logic gave them before this module existed.
const UNCOOKED_RE = /\b(?:uncooked|undercooked)\b/i;
const RAW_RE = /\braw\b/i;

// Words stripped when the food identity is computed (below). A word
// that only describes the item — spoilage, condition, freshness, form,
// quantity, descriptors — is not the food.
export const IDENTITY_STOP_WORDS = new Set([
  'moldy', 'mouldy', 'rotten', 'spoiled', 'expired',
  'raw', 'cooked', 'fried', 'grilled', 'roast', 'roasted', 'boiled', 'baked', 'steamed',
  'smoked', 'cured', 'pickled',
  'uncooked', 'undercooked', 'partially', 'partly', 'half', 'fully', 'completely',
  'not', 'never', 'yet', 'properly', 'sufficiently', 'thoroughly', 'still', 'quite', 'really', 'very',
  'has', 'have', 'had', 'is', 'was', 'were', 'been', 'be',
  'fresh', 'frozen', 'cold', 'wilted', 'stale', 'sad', 'leftover',
  'old', 'half-eaten', 'ground', 'minced', 'diced', 'sliced', 'chopped', 'whole',
  'one', 'two', 'three', 'four', 'five', 'a', 'an', 'some', 'few', 'several',
  'lean', 'extra', 'free-range', 'organic', 'grass-fed', 'boneless', 'skinless',
]);
// Singular/plural and US/UK spelling normalisation for identity
// matching: "tomatoes" is "tomato", "eggs" is "egg", "strawberries"
// is "strawberry", "yoghurt" is "yogurt". A small, explicit table —
// no NLP, no semantic matching.
const IDENTITY_ALIASES = {
  yoghurt: 'yogurt', aubergine: 'eggplant', courgette: 'zucchini',
  chilli: 'chili', prawn: 'shrimp', coriander: 'cilantro',
};
export function singularize(word) {
  const w = String(word || '').toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('oes')) return w.slice(0, -2);
  if (/(?:ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
export function normalizeIdentityWord(word) {
  const s = singularize(word);
  return IDENTITY_ALIASES[s] || s;
}
// Normalise every word of a longer text (an LLM-written menu) the same
// way, so "tomatoes" in the menu matches a "rotten tomato" and
// "yoghurt" matches an "expired yogurt".
export function normalizeIdentityText(text) {
  return String(text || '').toLowerCase().replace(/[a-z0-9%]+/g, (w) => normalizeIdentityWord(w));
}

// The core identity of an ingredient: the protein subject when there
// is one (so "rice with moldy chicken" is a chicken, not a rice),
// otherwise the main part — minus every modifier word. "moldy bread"
// -> "bread", "moldy raw chicken" -> "chicken", "one egg" -> "egg",
// "93% lean ground beef" -> "beef", "fish sauce" -> "fish sauce".
// Empty when nothing is left.
export function coreIdentity(item) {
  const part = proteinSubjectPart(item) || mainIngredientPart(item);
  const words = part.split(/[^a-z0-9%]+/).filter(Boolean)
    .filter((w) => !IDENTITY_STOP_WORDS.has(w) && !/^\d+%?$/.test(w))
    .map((w) => normalizeIdentityWord(w));
  return words.join(' ');
}

// --- Cooking rules ------------------------------------------------------
// The deterministic cooking-rule engine: the ONLY source of required
// temperatures and preparation instructions. OpenRouter may write
// culinary prose, but it must not determine a temperature or override
// an exclusion — the pipeline builds the cook-through step from these
// rules, and the doneness gate validates the LLM's menu against them.
// Temperatures are CDC/FDA internal temperatures, verified with a food
// thermometer in the thickest part; colour and clear juices are not
// proof. `temperaturesC` is the set of temperatures that prove the
// item (an unclassifiable cut accepts any of the three); `restMinutes`
// is the rest after reaching temperature (whole cuts only); `proof`
// is 'thermometer' or 'firm' (eggs: the white and yolk must be firm).
export const COOKING_RULES = {
  poultry: { kind: 'poultry', temperaturesC: [74], temperaturesF: [165], restMinutes: 0, proof: 'thermometer' },
  ground: { kind: 'ground', temperaturesC: [71], temperaturesF: [160], restMinutes: 0, proof: 'thermometer' },
  fish: { kind: 'fish', temperaturesC: [63], temperaturesF: [145], restMinutes: 0, proof: 'thermometer' },
  whole: { kind: 'whole', temperaturesC: [63], temperaturesF: [145], restMinutes: 3, proof: 'thermometer' },
  egg: { kind: 'egg', temperaturesC: [], temperaturesF: [], restMinutes: 0, proof: 'firm' },
};
// There is deliberately no 'unknown' rule: an unidentified protein
// ("raw meat") gets no cooking rule at all, so no temperature can be
// claimed for it and the validator accepts none.

// The cooking rule for a canonical protein identity plus the
// ingredient's form — never the identity alone, never the category
// alone. The identity decides the cooking group (a salmon is fish,
// a chicken is poultry); the form decides the variant inside it (a
// ground red meat cooks to 71°C, a whole cut to 63°C and rests 3
// minutes). The rule carries the identity it was computed for, so a
// temperature is always traceable to the protein it belongs to.
// Null when no cooking is required (cooked, processed, or not an
// animal at all) — and null for an UNIDENTIFIED protein ("raw meat"):
// no temperature can be claimed for a protein nobody identified, so
// the classifier offers none and the validator accepts none. The
// form words are read from the subject, not the whole entry, so the
// "ground" in "ground rice with chicken" does not make the chicken
// ground meat.
function cookingRuleFor(identity, subject) {
  if (!identity) return null;
  if (identity === 'meat') return null; // unknown_meat
  const category = PROTEIN_CATEGORY[identity];
  if (!category) return null;
  if (category === 'egg') return { ...COOKING_RULES.egg, protein: identity };
  if (category === 'fish' || category === 'seafood') return { ...COOKING_RULES.fish, protein: identity };
  if (category === 'poultry') return { ...COOKING_RULES.poultry, protein: identity };
  // Red meat: the ground form (ground / minced / sausage) cooks to
  // 71°C; a whole cut cooks to 63°C and rests 3 minutes.
  const rule = GROUND_FORM_RE.test(subject || '') ? COOKING_RULES.ground : COOKING_RULES.whole;
  return { ...rule, protein: identity };
}

// --- The classifier -----------------------------------------------------
// classifyIngredient(input, userConditionOverride) -> a structured
// decision. `userConditionOverride` is 'raw' or 'cooked' (or null):
// the guest's explicit selection from the frontend's Raw / Already
// Cooked controls. The override beats the text — the guest knows
// their fridge — but it never beats spoilage: a spoiled item is
// excluded whatever the guest picks. The backend validates an override
// by re-classifying the submitted text itself; the browser is never
// the safety authority (the server never trusts a client-sent
// condition, only the text it receives).
export function classifyIngredient(input, userConditionOverride = null) {
  const originalInput = String(input ?? '');
  const normalized = normalizeIngredientText(originalInput);
  // The components, resolved first: every decision below reads them,
  // never the raw input. The subject is the phrase of the first
  // component that holds a protein — so "fish sauce with raw beef"
  // is a raw beef, never a fish sauce.
  const components = parseComponents(originalInput);
  const subjectComponent = components.find((c) => c.protein) || null;
  // The protein subject: every condition check below reads THIS
  // phrase, and only this phrase — never the whole entry, never the
  // main part alone. A "raw" in the salad and a "fried" in the rice
  // are not the chicken's condition.
  const subject = subjectComponent ? subjectComponent.text : null;
  // The canonical identity and its cooking category, kept separate:
  // the identity is the species, the category is the cooking group.
  const proteinIdentity = subjectComponent ? subjectComponent.protein : null;
  const category = proteinIdentity ? PROTEIN_CATEGORY[proteinIdentity] : null;
  // Spoilage reads the WHOLE entry: a spoiled accompaniment spoils
  // the dish ("chicken with moldy bread" cannot be cooked), so the
  // mould in the bread still excludes the chicken.
  const spoilage = SPOILAGE_RE.test(normalized);
  // A compound subject (a prepared dish, a condiment) is recognised
  // from the subject's component role — not from a broad word list.
  // The sauce in "chicken in sauce" is the accompaniment, not the
  // food, so it is not the subject at all.
  const isProcessed = subjectComponent ? (subjectComponent.role !== 'primary_protein' && subjectComponent.role !== 'other') : false;
  // The protein occurrences, resolved first: every occurrence is
  // an identity + a condition + a cooking rule. One entry holds one
  // primary protein OCCURRENCE with one consistent condition and
  // cooking form — not just one identity. "cooked chicken with raw
  // chicken" is two chickens (the conditions disagree), "raw
  // chicken with raw chicken" is one chicken written twice (they
  // agree), and "ground beef with beef steak" is two cooks (the
  // rules disagree). A condiment, a stock, or a prepared staple
  // never counts ("chicken with fish sauce" is one protein, the
  // chicken).
  const occurrences = proteinOccurrences(originalInput);
  const ambiguousProteins = occurrencesConflict(originalInput);

  // The condition from the text alone, before any override — the
  // subject component's condition, computed by the same helper the
  // occurrence analysis uses (one place, not two). The order is the
  // point: condition evidence beats the processed exemption.
  // "partially cooked chicken nuggets" is unknown — the nuggets do
  // not make the partial cooking go away — and only a compound with
  // NO condition evidence at all ("chicken nuggets", "fish sauce")
  // is treated as ready-to-eat.
  let condition = subjectComponent ? componentCondition(subjectComponent) : 'not_applicable';
  // The entry's condition is the condition ALL occurrences agree
  // on. If they disagree, there is no single condition — the first
  // component's condition must never stand for the others. "cooked
  // chicken with raw chicken" is not a cooked chicken; its
  // condition is not determinable, and the guest is asked to
  // separate it. (When they agree — "raw chicken with raw fish" —
  // the shared condition stands.)
  if (occurrences.length >= 2 && new Set(occurrences.map((o) => o.condition)).size > 1) {
    condition = 'unknown';
  }

  // The override, validated: it beats the text — the guest knows
  // their fridge — but only when there IS a condition to resolve. An
  // override on "rice" or "fish sauce" means nothing, so it is
  // ignored, not guessed. (Spoilage is applied below, not here: an
  // override never beats an exclusion.)
  if ((userConditionOverride === 'raw' || userConditionOverride === 'cooked') && condition !== 'not_applicable') {
    condition = userConditionOverride;
  }

  // The food category for the result: a compound subject is
  // 'processed' (not the animal it is named after); anything without
  // a protein is 'processed' when the entry is a compound (fish
  // sauce, egg noodles) and 'other' otherwise.
  const isCompound = components.some((c) => c.role !== 'primary_protein' && c.role !== 'other');
  const foodCategory = !category
    ? (isCompound ? 'processed' : 'other')
    : (condition === 'not_applicable' && isProcessed ? 'processed' : category);

  // The cooking rule applies when the item needs cooking: raw,
  // unknown, or partially cooked. A cooked item needs none; a
  // processed or non-animal item needs none either. An unidentified
  // protein ("raw meat") gets NO rule at all — no temperature can be
  // claimed for it — and neither does an ambiguous combination: two
  // proteins, two temperatures, one entry, no single rule. (For a
  // spoiled item the rule is still computed — it describes the item
  // — but the recipeAction below is 'exclude', so the rule is never
  // used.) The rule is computed from the canonical identity plus the
  // form, and it carries the identity it belongs to.
  const needsCooking = condition === 'raw' || condition === 'unknown' || condition === 'partially_cooked';
  const cookingRule = ambiguousProteins ? null : (needsCooking ? cookingRuleFor(proteinIdentity, subject) : null);

  // A raw (or partially cooked) protein whose type or form is
  // unknown: the recipe cannot be made until the guest says which
  // protein it is and whether it is ground or a whole cut. Asking
  // Raw or Cooked is not enough — the temperature depends on the
  // answer. A bare "meat" is different: its CONDITION is the first
  // question, so it is asked about the condition, not the protein.
  const needsProteinClarification = category === 'unknown_meat'
    && (condition === 'raw' || condition === 'partially_cooked');

  let recipeAction;
  if (spoilage) recipeAction = 'exclude';
  else if (ambiguousProteins) recipeAction = 'ask_user';
  else if (needsProteinClarification) recipeAction = 'ask_user';
  else if (condition === 'raw') recipeAction = 'cook_through';
  else if (condition === 'unknown' || condition === 'partially_cooked') recipeAction = 'ask_user';
  else recipeAction = 'include';

  // Three different questions, three different actions — the Raw /
  // Already Cooked buttons only answer one of them. The frontend
  // shows the right interaction for each:
  //   condition unknown  -> Raw / Already Cooked buttons.
  //   protein unknown    -> identify the protein and the cut (type
  //                         it, e.g. "raw chicken"); the buttons
  //                         cannot answer it.
  //   combination        -> separate into one entry per protein
  //                         (edit the text); the buttons cannot
  //                         answer it either.
  const requiresConditionConfirmation = !spoilage && !ambiguousProteins && !needsProteinClarification
    && (condition === 'unknown' || condition === 'partially_cooked');
  const requiresSeparation = !spoilage && ambiguousProteins;
  // requiresConfirmation is the union, kept for callers that only
  // need to know the item asks something (the picker's chip list).
  const requiresConfirmation = !spoilage && recipeAction === 'ask_user';

  return {
    originalInput,
    canonicalName: coreIdentity(originalInput),
    // The canonical protein identity (the species) and its cooking
    // category (the group), kept separate: two species can share a
    // temperature and still be two proteins.
    proteinIdentity,
    foodCategory,
    condition,
    spoilage,
    requiresConfirmation,
    requiresConditionConfirmation,
    needsProteinClarification,
    requiresSeparation,
    ambiguousProteins,
    // The parsed components (one per sub-phrase, with its role and
    // its protein identity), so the roles are visible and testable
    // instead of hidden inside the classifier.
    components,
    cookingRule,
    recipeAction,
  };
}

// Classify a list of ingredients. The pipeline calls this once per
// request and derives every food-safety decision from the results —
// no second, independent regex classification later in the pipeline.
export function classifyIngredients(inputs) {
  return (inputs || []).map((input) => classifyIngredient(input));
}

// Apply a guest's condition choice to an ingredient's text, so the
// frontend can write the choice back into the textarea and the server
// can re-derive it from the text alone (the browser is not the safety
// authority). The choice is written into the PROTEIN SUBJECT — the
// phrase that holds the protein — not into the first phrase. "rice
// with chicken" + Cooked becomes "rice with cooked chicken", never
// "cooked rice with chicken": the buttons change the chicken's
// condition, not the rice's. The condition expression is REMOVED
// first — the negation ("not cooked", "has not yet been properly
// cooked"), the partial phrase, any cooked/raw qualifier and the
// stray auxiliaries — and the choice is written in front of what is
// left. The form words are kept: "93% lean ground beef" + Raw ->
// "raw 93% lean ground beef", so the ground-meat temperature (71°C)
// still applies.
const OVERRIDE_STRIP_WORDS = [
  'raw', 'cooked', 'fried', 'grilled', 'roast', 'roasted', 'boiled', 'baked', 'steamed',
  'uncooked', 'undercooked', 'smoked', 'cured', 'pickled', 'cold',
  'has', 'have', 'had', 'is', 'was', 'were', 'been', 'be',
];
const OVERRIDE_STRIP_RE = new RegExp(`\\b(?:${OVERRIDE_STRIP_WORDS.join('|')})\\b`, 'gi');
export function applyConditionOverride(input, choice) {
  if (choice !== 'raw' && choice !== 'cooked') return String(input ?? '');
  const normalized = normalizeIngredientText(input);
  // Split into phrases, KEEPING the preposition separators, so the
  // choice lands in the phrase that holds the protein and the rest
  // of the entry is untouched. Phrases sit at even indices, the
  // separators at odd ones.
  const parts = normalized.split(/(\b(?:in|with|on|plus)\b|served\s+with|topped\s+with)/i);
  // The target is the phrase that holds the PROTEIN SUBJECT — the
  // first component with a protein, resolved from the components,
  // never the first protein word in the raw input. The fish sauce in
  // "fish sauce with raw beef" is a condiment, so the choice goes
  // into the beef, never the sauce.
  const subject = proteinSubjectPart(input);
  let target = -1;
  if (subject) {
    for (let i = 0; i < parts.length; i += 2) {
      if (normalizeIngredientText(parts[i]).includes(subject)) { target = i; break; }
    }
  }
  // No protein anywhere: fall back to the first phrase, as before.
  if (target < 0) target = 0;
  const segment = parts[target];
  const leading = segment.match(/^\s*/)[0];
  const trailing = segment.match(/\s*$/)[0];
  let cleaned = segment
    .replace(NOT_COOKED_RE, ' ')
    .replace(NOT_RAW_RE, ' ')
    .replace(PARTIALLY_COOKED_RE, ' ')
    .replace(UNCOOKED_RE, ' ')
    .replace(OVERRIDE_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) cleaned = coreIdentity(input) || normalized;
  parts[target] = `${leading}${choice} ${cleaned}${trailing}`;
  return parts.join('').trim();
}
