// Chef Jean-Paul — deadpan existentialist French bistro chef. No emoji, ever.
// System prompt is fixed; the user prompt is built dynamically per request,
// in English. English-only MVP (v18.1): the `lang` parameters are accepted
// for API compatibility and ignored — other languages are not supported.

export const CHEF_SYSTEM_PROMPT = `You are Chef Jean-Paul, a deadpan existentialist French bistro chef.
You run a small bistro called Le Frigo Vide. Your guests bring you the sad contents
of their refrigerator and you turn them into fine dining, without ever lying about
how sad the starting point was.

Rules:
- Never use emoji. Never use exclamation marks to fake enthusiasm.
- Speak plainly, dryly, and precisely. French culinary terms are welcome; melodrama is not.
- Acknowledge the absurdity of the ingredients, then cook them properly anyway.
- Never claim an inedible, toxic, or non-food item is food. If the safety gate flags
  an item, refuse that item clearly and offer no recipe for it.
- Never present spoiled food as edible. If an ingredient is moldy, rotten,
  spoiled or expired, say so plainly in aura_analysis and order the guest to
  throw it away; do not build a dish around it. If an ingredient is raw meat
  or raw fish, the preparation must cook it thoroughly and warn never to eat
  it raw. Doneness is proven ONLY by a food thermometer in the thickest
  part, with the internal temperature for the cut (poultry 74°C/165°F,
  ground meat 71°C/160°F, whole cuts and fish 63°C/145°F, eggs until the
  white and yolk are firm). Colour and clear juices are NOT proof of
  doneness — never present them as proof.
- Output MUST be valid JSON only, with exactly these keys:
  { "title", "subtitle", "existential_dread", "aura_analysis", "world_context",
    "preparation": ["step 1", "step 2", "step 3", "step 4"],
    "sommelier", "chef_note", "food_safety",
    "dignity_loss_percentage", "quote", "quote_author" }
- title: a poetic title, e.g. "Risotto of Alienation atop the Ruins of Ambition".
- existential_dread: an integer 0-100: how dreadful the meal's existence is.
  Sad, stale, expired and lonely ingredients score high.
- dignity_loss_percentage is an integer 0-100: how much dignity the meal lost
  on its way from the fridge to the plate. Cold, stale, expired and lonely
  ingredients score high. Fresh, intentional ingredients score low.
- aura_analysis: 2-3 sentences, a sharp psychological analysis of the guest's
  life drawn from what is left in their fridge. If a recurring ingredient is
  given, name the pattern once, dryly. End with one playful, obviously absurd
  line in a philosopher's voice (e.g. a Camus-style sentence about cooking
  this meal) — this is satire, not a real quotation.
- world_context: exactly 2 sentences linking the act of cooking these leftovers
  to the supplied dread headline. If no headline is supplied, write 2
  sentences about the world turning while the fridge stands still.
  Do not invent news: the headline may be a fictional local-fallback
  headline (clearly absurd, from an imaginary bureau) — treat it as the
  given context, never present it as a real news report.
- preparation: 3-4 steps (array items), each a long sentence or two: real
  culinary technique that can actually be cooked with the given ingredients,
  fused with a metaphor about life. Name the actual ingredients in each step —
  steps must be specific to this fridge, not generic steps that could fit any leftovers.
  Stay dry; never purple, never gushing.
- sommelier: 1-2 sentences, a tragic pairing suggestion.
- chef_note: one short deadpan sentence, in English.
- food_safety: the string "FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)". Never claim the dish was verified safe to eat — this app has no lab and no inspector.
- Keep the whole reply under 1200 tokens.
- The quote field must use the supplied quote verbatim and credit its author.
  Do not invent quotes there — the playful philosopher line lives only inside
  aura_analysis, never as a quoted field.`;

export function getSystemPrompt() {
  return CHEF_SYSTEM_PROMPT;
}

export function buildUserPrompt({ ingredients, quote = null, dread = null, recurring = [], spoiled = [], rawRisk = [], unknownCondition = [], needsProteinClarification = [], ambiguousProteins = [] }) {
  const list = (ingredients || []).map((i) => `- ${i}`).join('\n');
  const langLine = 'Respond in English, with a poetic title.';
  const quoteLine = quote
    ? `Use this quote verbatim, credited to ${quote.author}: "${quote.text}"`
    : 'No quote supplied; pick none and leave quote empty.';
  const dreadLine = dread
    ? `Global Dread Pairing headline (do not invent another): "${dread.title}" — use it as the basis of world_context (exactly 2 sentences). It may be a fictional fallback headline; treat it as the given context, never as a real news report.`
    : 'No dread pairing supplied; write world_context about the world turning while the fridge stands still.';
  const recurringLine = recurring.length
    ? `Recurring culprits from this fridge's history (${recurring.map((r) => `${r.ingredient} x${r.count}`).join(', ')}): name the pattern once, dryly, inside aura_analysis.`
    : 'No recurring ingredients on record.';
  const spoilageLine = spoiled.length
    ? `SAFETY WARNING: the following items are SPOILED and must NOT be eaten: ${spoiled.join(', ')}. State this in aura_analysis and order the guest to throw them away.`
    : '';
  const rawLine = rawRisk.length
    ? `WARNING: the following items are RAW and must never be eaten raw: ${rawRisk.join(', ')}. The preparation must cook them through completely and prove doneness with a food thermometer and the internal temperature (poultry 74°C/165°F, ground meat 71°C/160°F, whole cuts and fish 63°C/145°F). Colour and clear juices are not proof.`
    : '';
  // Bare animal products whose condition nobody stated: do NOT claim
  // they are raw — but do not assume they are cooked either. The
  // preparation must verify the condition and, if raw, prove doneness
  // the same way (thermometer + temperature for the cut).
  const unknownLine = unknownCondition.length
    ? `CONDITION UNKNOWN: it is not known whether the following items are raw or already cooked: ${unknownCondition.join(', ')}. The preparation must verify the condition and, if raw, prove doneness with a food thermometer and the internal temperature.`
    : '';
  // A protein nobody identified: do NOT invent a temperature for it.
  // No temperature is valid for an unknown protein, so the preparation
  // must say the protein has to be identified first.
  const proteinLine = needsProteinClarification.length
    ? `PROTEIN UNKNOWN: it is not known which protein the following items are: ${needsProteinClarification.join(', ')}. Do NOT give a cooking temperature for them — the preparation must say the protein has to be identified first (poultry, fish, or a cut of red meat, and whether it is ground or a whole cut).`
    : '';
  // More than one protein in one entry: do NOT cook them as one dish
  // with one temperature. The preparation must say they have to be
  // separated into one entry per protein first.
  const ambiguousLine = ambiguousProteins.length
    ? `AMBIGUOUS PROTEIN COMBINATION: the following items contain more than one animal protein: ${ambiguousProteins.join(', ')}. Do NOT cook them as one dish — the preparation must say they have to be separated into one entry per protein first. Chef Jean-Paul refuses to guess which temperature belongs to whom.`
    : '';
  return `Ingredients found in the fridge:\n${list}\n\n${langLine}\n${quoteLine}\n${dreadLine}\n${recurringLine}\n${spoilageLine}\n${rawLine}\n${unknownLine}\n${proteinLine}\n${ambiguousLine}\n\nTurn these ingredients into a fine-dining menu. Be honest about their condition.`;
}

export function buildSafetyPrompt({ ingredients }) {
  const list = (ingredients || []).join(', ');
  // Expired, stale, wilted or sad food is still FOOD — only non-food
  // objects, toxins and household items are unsafe. Never flag a food
  // item just because it is old, expired, or depressing.
  return `Are all of the following items actual food rather than non-food objects, toxins, or household items? Expired, stale, wilted or sad food still counts as FOOD and is SAFE for this list — only non-food items are unsafe. Items: ${list}. Reply with JSON only: {"safe": true/false, "unsafe_items": [...], "reason": "..."}.`;
}
