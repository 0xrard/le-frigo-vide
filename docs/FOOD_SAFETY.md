# Food Safety — Le Frigo Vide

The honest label, always:

```
FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)
```

This app has no lab and no inspector. It can only say the items
passed the food-category gate; it never claims a dish was verified
safe to eat. When risks are present, the label is built from parts —
never first-only — so spoilage and raw risk are both shown when both
are present:

- `SPOILAGE WARNING: DO NOT CONSUME`
- `RAW RISK: COOK THOROUGHLY, NEVER EAT RAW`
- `CONDITION UNKNOWN: VERIFY BEFORE EATING`
- `PROTEIN UNKNOWN: CLARIFY BEFORE COOKING`
- `AMBIGUOUS PROTEIN COMBINATION: SEPARATE BEFORE COOKING`

## The shared classifier

Every food-safety decision comes from exactly one place:
`shared/ingredient-classifier.mjs`. The Node backend imports it, and
the browser frontend imports the same file (served at
`/shared/ingredient-classifier.mjs`). The module is pure — no Node
builtins, no DOM, no I/O, no randomness — so the same input always
gives the same result on the server and in the browser. The server
never trusts a client-sent condition: it re-derives the condition
from the submitted text itself.

`classifyIngredient(input, userConditionOverride)` returns a
structured decision: `canonicalName`, `foodCategory`, `condition`
(`raw` | `partially_cooked` | `cooked` | `unknown` |
`not_applicable`), `spoilage`, `requiresConfirmation`,
`cookingRule`, `recipeAction` (`include` | `cook_through` |
`ask_user` | `exclude`), plus `proteinIdentity`, `components`,
`needsProteinClarification`, and `ambiguousProteins`.

## Precedence

The non-food gate runs first (in the pipeline, Stage 1), then the
classifier. Inside the classifier, in order:

1. Non-food → the request is refused (local denylist, pipeline).
2. Spoiled / expired → excluded from the recipe, whatever the
   condition is. Spoilage is never a reason to cook harder.
3. Explicit user condition selection → used, unless spoilage
   requires exclusion. The guest knows their fridge.
4. A negated "raw" in the subject ("not raw chicken", "chicken
   isn't raw") → unknown. It says what the chicken is NOT — neither
   cooked nor explicit raw.
5. Explicit raw in the protein subject → raw (cook through).
6. Negated, uncooked, or partial cooking in the subject → unknown /
   partially_cooked. The item still needs a full cook-through.
7. Positively and unambiguously cooked protein subject → cooked.
8. Recognised ready-to-eat compound (a role, not a word) →
   not_applicable. The exemption only fires when there is NO
   condition evidence: "partially cooked chicken nuggets" is unknown,
   not processed.
9. Animal protein with no reliable condition → unknown (ask).
10. Anything else → not_applicable.
11. A raw protein whose type or form is unknown ("raw meat") → ask
    for protein clarification before any recipe is made. No
    temperature can be claimed for a protein nobody identified, so
    the cooking rule is null.
12. More than one primary protein occurrence in one entry → the
    recipe is blocked (see [Occurrences](#occurrences)).

The one rule that matters most: the mere presence of the word
"cooked" is NEVER proof of a cooked condition. A negation ("not
cooked", "has not yet been properly cooked") or a partial condition
("partially cooked") is not cooked, and an ambiguous input returns
unknown rather than guessing. When in doubt, the recipe cooks it
through — or asks.

## Non-food and spoilage

**Non-food** is refused outright. The local denylist
(`UNSAFE_PATTERNS` in `src/pipeline.mjs`) names specific non-food
objects only — batteries, soap, bleach, detergent, cleaner, glass,
plastic, metal, paint, glue, poison — and a small allowlist
(`FOOD_EXCEPTIONS`) wins over it for real foods that look scary:
rice paper, glass noodles, rice noodles, paper-thin beef, sponge
cake.

**Spoilage** (`moldy`, `mouldy`, `rotten`, `spoiled`, `expired`) is
never a refusal — spoiled food is still food — but it is excluded
from the recipe entirely. The menu is built from safe ingredients
only, and carries a hard `SPOILAGE WARNING: DO NOT CONSUME`. Raw
risk is computed from the safe subset only: a spoiled raw item
("moldy raw chicken") is reported as spoiled and never reaches the
recipe, so the kitchen never orders the guest to cook the very item
it told them to throw away. If nothing is safe, Chef Jean-Paul
refuses to cook at all (`reason_code: 'spoiled'`).

## Identity vs cooking category

The identity is the species (chicken, turkey, beef, salmon); the
category is the cooking group (poultry, red_meat, fish). They are
separate fields and never conflated: two species can share a
temperature and still be two proteins — they are never deduplicated
for sharing one.

Species words: fish, salmon, tuna, shrimp, prawn, seafood, chicken,
turkey, duck, poultry, egg, beef, pork, lamb, meat. "Fish",
"poultry", and "seafood" are generic identities (an unspecified fish,
an unspecified poultry) — still identities, distinct from every
species under them. "Meat" is an unidentified protein. Cut and form
words are NOT identities: "beef steak" is one animal (beef), "pork
sausage" is one animal (pork). On their own, a form word is a protein
of unknown species ("sausage" is ground red meat, "steak" is a whole
cut).

**Only one verified exact synonym collapses: shrimp/prawn.**
Chicken/turkey, beef/pork, salmon/tuna, fish/salmon, and
chicken/poultry are separate identities, full stop. A new synonym
needs evidence that the two words name the same animal, not just
the same temperature.

## Roles and the compound lexicon

An entry is parsed into components, one per sub-phrase, each with an
explicit role and a canonical protein identity:

| Role | Meaning | Holds a protein? |
|---|---|---|
| `primary_protein` | The animal the dish is about | Yes |
| `condiment` | A flavour (fish sauce, soy sauce, …) | No — the animal in it is the flavour |
| `stock` | A flavour base (chicken broth, beef stock, …) | No |
| `prepared_staple` | Ready to eat (egg noodles, ramen, pasta, …) | No |
| `prepared_dish` | Ready to eat, but the protein inside can be undercooked (chicken nuggets, beef stew, …) | Yes |
| `other` | Anything else | No |

A compound is recognised by an **exact, longest-match lexicon
phrase** — never by a broad word ("sauce" alone matches nothing,
"broth" alone matches nothing) — and recognising one never stops the
scan of the rest of the entry. The lexicon is the only place a
compound is defined.

- **Condiments:** fish sauce, soy sauce, oyster sauce, shrimp paste,
  hot sauce, barbecue sauce, bbq sauce, chili sauce, tomato sauce,
  salad dressing, ketchup, mayonnaise, mayo.
- **Stocks:** chicken broth, beef broth, beef stock, chicken stock,
  vegetable stock, fish stock, bone broth, dashi, bouillon.
- **Prepared staples:** egg noodles, rice noodles, glass noodles,
  instant ramen, ramen noodles, ramen, spaghetti, pasta.
- **Prepared dishes:** fried rice, chicken nuggets, beef stew,
  chicken curry, beef curry, chicken soup, tomato soup, vegetable
  soup, chicken stew, meatballs, jerky, ham, bacon, salami,
  pepperoni.
- **Form rule:** a form word + a protein word ("canned chicken",
  "dried beef") is a ready-to-eat product. The form word can sit
  behind condition words ("not yet cooked canned chicken" is still a
  canned chicken).

"Fish sauce with raw beef" is a condiment AND a primary protein —
the beef is found, its condition is read, and it cooks at the beef's
temperature.

## The protein subject

The condition belongs to the phrase that holds the animal protein —
not to the whole entry, and not to the first phrase. "Cooked chicken
with raw salad" is a cooked chicken (the "raw" belongs to the salad);
"rice with cooked chicken" is a cooked chicken; "fried rice with
uncooked chicken" is an unknown chicken (the "fried" belongs to the
rice). The spoilage check is the exception: a spoiled accompaniment
spoils the dish, so it still reads the whole entry.

## Occurrences

One entry holds one primary protein **occurrence** with one
consistent condition and cooking form — not just one identity. An
occurrence is an identity + a condition + a cooking rule. Two
occurrences conflict when:

- their identities differ ("raw chicken with raw fish", "chicken
  and beef", "chicken and turkey"), or
- the same identity has a different condition ("cooked chicken with
  raw chicken"), or
- the same identity has a different cooking rule ("ground beef with
  beef steak" — two cooks).

A repeated occurrence that agrees on all three ("raw chicken with
raw chicken", "shrimp and prawn", "ground chicken with chicken" —
both poultry 74°C) is one protein written twice and merges. Every
detected protein becomes an explicit occurrence — none silently
disappears: "&" is "and" written short, and "/" between two foods is
a choice or a mixture, never a guess, so "chicken & turkey" and
"chicken/turkey" are both separated; a sub-phrase with no separator
at all ("chicken turkey") still lists both proteins.

When occurrences conflict, there is no cooking rule and the recipe
is **blocked** — no menu is made, not even the local fallback — until
the guest separates them into one entry per protein
(`reason_code: 'ambiguous_protein'`, with a suggested split, e.g.
`"raw chicken with raw fish" becomes "raw chicken" and "raw fish"`).
A warning inside a recipe that already cooked the mixture would be a
contradiction. The entry's condition is the condition all
occurrences agree on; when they disagree, it is unknown — the first
component's condition never stands for the others.

## Cooking rules and temperatures

The rule is computed from the canonical identity **plus** the form —
never the identity alone, never the category alone. The identity
decides the cooking group; the form decides the variant inside it.
The rule carries the identity it was computed for, so a temperature
is always traceable to the protein it belongs to.

| Rule | Temperature | Rest | Proof |
|---|---|---|---|
| Poultry | 74°C (165°F) | — | Food thermometer in the thickest part |
| Ground (red meat) | 71°C (160°F) | — | Food thermometer, throughout |
| Fish & seafood | 63°C (145°F) | — | Food thermometer; flesh flakes easily |
| Whole cut (red meat) | 63°C (145°F) | 3 minutes | Food thermometer in the thickest part |
| Egg | — | — | White and yolk both firm |

Classification is protein-first: ground salmon is fish (63°C),
ground chicken is poultry (74°C) — the ground form only matters for
red meat. A sausage counts as ground for red meat. Smoking, curing,
and pickling do NOT mean cooked (cold-smoked salmon is not cooked).
Colour and clear juices are NOT proof of doneness, so the recipe
never cites them as proof.

There is deliberately no "unknown" rule: an unidentified protein
("raw meat") gets no cooking rule at all, so no temperature can be
claimed for it and the validator accepts none.

A bare animal product ("chicken", "one egg") has an unknown
condition: the recipe treats it as raw (fail safe) while the warning
says plainly that the condition is unknown, and the UI offers a
Raw / Already cooked choice per item (unanswered = treated as raw).
The choice is written back as text, so the server re-derives it —
the browser is never the safety authority.

## LLM validation

The LLM is an advisor, never the authority. Every LLM menu is
checked before it is served, and discarded for the safe local menu
when it fails:

- **Spoiled ingredients, by identity.** A menu that names a spoiled
  ingredient — in its title or any preparation step — is discarded.
  The check is by core identity, not exact name: the LLM may drop
  the modifier and write "Add the bread" for a "moldy bread". A bare
  core mention is only proof when no safe item shares the core (when
  "moldy bread" and "fresh bread" appear together, "bread" may mean
  the safe one). Identity is normalised for singular/plural and
  US/UK spelling, so the LLM cannot slip past by changing the word's
  form.
- **Raw cook-through, per item.** Every raw / unknown-condition item
  must prove itself in a step that names it: a food thermometer AND
  the temperature for its cut (eggs: firm white and yolk). Evidence
  is never borrowed across steps or items. Each temperature in a step
  is assigned to the items mentioned since the previous temperature,
  so "Cook raw chicken to 63°C and raw salmon to 74°C" is discarded
  (swapped) while the correct assignment passes. Temperatures have
  numeric boundaries: 74°C does not match inside 174°C, and only an
  exact integer (or a `.0` decimal) is accepted — 74.5°C is not
  matched. A whole cut must also rest for 3 minutes.
- **The deterministic cook-through step is always attached** to the
  final menu — even to an LLM menu that passed the gate — because
  regex validation of LLM narrative is never a complete guarantee.
  The correct instruction for every raw / unknown-condition item is
  attached verbatim, before the plating step.

**The LLM safety check may only confirm a refusal.** In Stage 1,
OpenRouter may flag items, but `filterLlmUnsafeItems` keeps a flagged
item only when it BOTH matches the local denylist AND matches an
ingredient the user actually sent (by shared words, either way —
"battery" matches "2 aa batteries", "dish soap" matches "dish soap").
A flagged name that matches no user ingredient is a hallucination,
never a reason to reject the whole input — the model could return
"battery" for a fridge that holds only cold rice, and the old code
rejected the rice. Expired/stale/sad food is still food: the LLM may
never expand the refusal set beyond the denylist.

## English-only

Le Frigo Vide currently supports English ingredient names and
descriptions. Other languages are not supported in this MVP.
Non-English input is refused with a hint
(`reason_code: 'unsupported_language'`, per-word translations, e.g.
'ayam' → 'chicken', 'mentah' → 'raw') instead of being silently
treated as safe. The `lang` parameter is accepted everywhere for API
compatibility and ignored — every label, warning, and recipe is in
English. The UI also shows "English ingredient names only" under
the input.
