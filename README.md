# Le Frigo Vide

A personal culinary agent with an existentialist French bistro chef persona
(**Chef Jean-Paul**) that turns sad fridge leftovers into fine-dining menus
full of existential crisis. Built for **Fly.io Hacksgiving 2026**.

## Language Support

**English supported.**

Le Frigo Vide currently supports English ingredient names and descriptions.
Other languages are not supported in this MVP. An unrecognised or ambiguous
input is never assumed safe: a bare animal product gets a Raw / Already
cooked question, and a raw item gets the thermometer step — the app asks
rather than guessing.

## Run

```bash
node --version   # >= 22.13.0
npm test         # full suite: safety, Chronicle events/sessions/demo, API, connectors
npm start        # http://localhost:8080
```

Zero third-party npm dependencies. Only Node built-ins:
`node:http`, `node:sqlite`, `node:test`, `node:child_process`.

## Zero-key Sprites Connectors

No `.env`, no hardcoded API key. Every outbound call first checks the
Fly Sprites Gateway (`GET https://api.sprites.dev/v1/gateway/list`,
see https://sprites.dev) and falls back honestly when a connector is
not installed. The gateway list returns
`{ available: [...], connections: [{ provider, gateway_base_url, ... }] }`
with no Authorization header; per-connector calls go to
`<gateway_base_url>/v1/chat/completions` etc. (proven live on Sprite
le-frigo-vide, 2026-11-27; the old `localhost:43123` address was wrong —
nothing listens there on a Sprite):

| Connector | Free-tier use | What actually happens |
|---|---|---|
| OpenRouter (`openrouter/free`) | Food-safety guardrail + menu synthesis | **Live** via the gateway: `POST <gateway_base_url>/v1/chat/completions` (proven on Sprite 2026-11-27). Deterministic local denylist + local menu synthesis on 429/offline. |
| Pinecone | Recurring-culprit history + existential quotes | **Wired (local-fallback active):** the gateway connection exists, but no Pinecone index is configured and no query is ever sent — matching runs locally (cosine similarity over SQLite). `feature_execution` is always `local-fallback`. |
| Apify | 1 grim headline, 4s timeout | **Wired (local-fallback active):** the gateway connection exists, but no Actor is configured and no run is ever started — the Global Dread Pairing serves the local `news_cache` (seeded FICTIONAL headlines, no live scrape). `feature_execution` is always `local-fallback`. |

`/connected` reports availability, mode and last result separately per
connector: `gateway_connected` (the gateway lists it),
`feature_execution` (the MODE the feature is configured for — `live`
only when the operation is wired to genuinely use the service, otherwise
`local-fallback`; a live mode is NOT a successful call),
`fallback_reason` (why the mode is a fallback — configuration), and
`last_execution` (what the most recent operation actually did in this
process: `{ at, ok, via, reason }`, null until the feature runs once).
`via` mirrors `feature_execution`. Pinecone and Apify are never `live`.
| Box | Archive "Culinary Sin Receipt" via `POST /upload/files/content` | **Live** when connected (multipart upload). The gateway path was proven by a real HTTP 415 from Box on 2026-11-27 (a raw body was rejected, which is how the multipart fix was found); a successful gateway upload is still to be verified on the Sprite. Receipt offered as a local download when not installed. |

`GET /connected` (or `?format=json`) proves `rawApiKeysInEnv: 0` and the
real status of every connector. Nothing is ever reported as connected
unless the gateway actually lists it, and a wired connector whose live
query is not configured says so — `wired (local-fallback active)`.

## Pipeline (4 stages)

1. **Safety** — OpenRouter free model + local denylist (batteries, soap, …).
   Real foods that look scary (`rice paper`, `glass noodles`,
   `paper-thin beef`) are allowlisted. Spoiled food (`moldy`, `rotten`,
   `spoiled`, `expired`) is never refused as non-food, but it is
   EXCLUDED from the recipe entirely — the menu is built from safe
   ingredients only, and carries a hard `SPOILAGE WARNING: DO NOT
   CONSUME` (an LLM menu that still names a spoiled ingredient is
   discarded for the safe local menu). If NOTHING is safe, Chef
   Jean-Paul refuses to cook at all. Raw risk is computed from the
   SAFE subset only — a spoiled raw item ("moldy raw chicken") is
   reported as SPOILED and never reaches the recipe, so the kitchen
   never orders the guest to cook the very item it told them to throw
   away. Raw meat/fish carries `RAW RISK: COOK THOROUGHLY, NEVER EAT
   RAW`, and the recipe gets a DETERMINISTIC cook-through step naming
   a food thermometer and the internal temperature for the cut —
   poultry 74°C (165°F), ground meat 71°C (160°F), whole cuts and fish
   63°C (145°F, rest 3 min), eggs until the white and yolk are firm
   (CDC/FDA). Classification is protein-first: ground salmon is fish
   (63°C), ground chicken is poultry (74°C) — the form (ground) only
   matters for red meat. Colour and clear juices are NOT proof of
   doneness, so the recipe never cites them as proof, and an LLM menu
   that proves doneness only by colour is discarded too. The LLM gate
   is PER ITEM, in the instruction that names that item: every item
   must prove itself (thermometer + temperature for its cut, rest for
   whole cuts) — a chicken given 63°C and a salmon given 74°C
   (swapped) is discarded, a chicken+turkey menu that only proves the
   chicken is discarded, and a "raw meat" with a thermometer showing
   0°C is discarded (0°C is not a cooking temperature; an
   unclassifiable item needs a real one). The spoiled check is by
   IDENTITY, not by exact name: the LLM may drop the modifier and
   write "Add the bread" for a "moldy bread" — the modifier must not
   be the only way the system recognises the item. A bare core mention
   is only proof when no SAFE item shares the core: when "moldy
   bread" and "fresh bread" appear together, the menu's "bread" may
   mean the safe one (the LLM only ever saw the safe list), so it is
   not rejected — but an explicit "moldy bread" is always rejected.
   The identity is normalised for singular/plural and US/UK spelling
   ("tomatoes" is "tomato", "eggs" is "egg", "strawberries" is
   "strawberry", "yoghurt" is "yogurt", with a small explicit alias
   table — aubergine/eggplant, courgette/zucchini, chilli/chili,
   prawn/shrimp, coriander/cilantro), so the LLM cannot slip past the
   check by changing the word's form. Temperatures have numeric
   boundaries: 74°C does not match inside 174°C, 63°C inside 163°C,
   74°F inside 274°F, and only an exact integer (or a .0 decimal) is
   accepted — 74.5°C is not matched, and the menu is discarded for the
   safe local fallback. And a temperature must belong to THAT item:
   each temperature in a step is assigned to the items mentioned since
   the previous temperature in the same step, so "Cook raw chicken to
   63°C and raw salmon to 74°C" is discarded (the chicken's
   temperature is 63°C, the salmon's is 74°C) while "Cook raw chicken
   to 74°C and raw salmon to 63°C" passes — and two items of the same
   cut sharing one temperature still pass. The deterministic
   cook-through step is ALWAYS present in the final menu — even on an
   LLM menu that passed the gate — because regex validation of LLM
   narrative is never a complete guarantee: the correct instruction
   for every raw / unknown-condition item is attached verbatim, before
   the plating step. An item whose cut cannot be classified gets the
   reference table, not a single temperature claim. Processed
   products are not the animal itself: egg noodles, fish sauce,
   chicken broth, shrimp paste and beef jerky get no raw-risk warning,
   no condition question and no thermometer step. Two exceptions: an
   explicit "raw" beats the processed exemption ("raw pork sausage"
   is raw risk), and the check looks at the MAIN part of the entry
   only ("raw chicken in sauce" is a raw chicken that happens to sit
   in sauce). A sausage is ground meat by definition, so a fresh pork
   sausage is cooked to the ground-meat temperature (71°C) — and a
   bare "pork sausage" is asked about, never assumed cooked. Smoking,
   curing and pickling do NOT mean cooked (cold-smoked fish is not
   cooked — FDA/CDC), so a "cold smoked salmon" is asked about too.
   Descriptors between "raw" and the protein are recognised ("raw 93%
   lean ground beef", "raw organic free-range chicken"), and the
   safety net says an entry that says "raw" AND names an animal
   product is raw risk, whatever else it says — so an unclassifiable
   "raw wagyu beef" never silently passes as safe. The condition
   belongs to the MAIN ingredient, not the side dish: "chicken with
   fried rice" and "chicken with boiled potatoes" are unknown
   chickens — the fried rice does not cook the chicken. A negation
   ("not cooked", "never cooked", "not fully cooked") or a partial
   condition ("partially cooked", "half-cooked") is NOT cooked: the
   item still needs a full cook-through and the guest is asked, while
   an affirmative "fully cooked chicken" stays cooked. The negation
   allows up to three adverb/auxiliary words between the negation and
   "cooked" ("not yet cooked", "not properly cooked", "not
   sufficiently cooked", "chicken not properly cooked", "chicken
   hasn't been cooked", "chicken has not yet been properly cooked")
   — the words between are what the cook is denying, and no fixed
   list of adverbs covers them all. All of these rules — and the
   cooking temperatures — live in exactly one place,
   `shared/ingredient-classifier.mjs`, imported by the Node backend
   and by the browser frontend, so the server and the picker can
   never disagree about the same entry. The condition belongs to the
   PROTEIN SUBJECT, the phrase that holds the animal protein — not
   to the whole entry and not to the first phrase. "cooked chicken
   with raw salad" is a cooked chicken (the "raw" belongs to the
   salad); "rice with cooked chicken" is a cooked chicken; "fried
   rice with uncooked chicken" is an unknown chicken (the "fried"
   belongs to the rice). Condition evidence beats the processed
   exemption: "partially cooked chicken nuggets" is unknown, not a
   ready-to-eat product — only a compound with no condition evidence
   at all is treated as ready-to-eat. And a raw protein whose type
   or form is unknown ("raw meat") gets no temperature at all: the
   guest is asked which protein it is and whether it is ground or
   a whole cut, because a temperature for an unknown protein is a
   guess. A negated "raw" ("not raw chicken", "chicken isn't raw")
   is neither cooked nor explicit raw: the honest label is unknown.
   One entry holds one primary protein OCCURRENCE with one
   consistent condition and cooking form: "raw chicken with raw
   fish" or "chicken and beef" BLOCKS the recipe — no menu is made,
   not even the local fallback, until the guest separates them into
   one entry per protein. The system refuses to guess which
   temperature belongs to whom, and a warning inside a recipe that
   already cooked the mixture would be a contradiction. Two
   occurrences of the same species are two items when their
   condition disagrees ("cooked chicken with raw chicken") or their
   cooking rule disagrees ("ground beef with beef steak") — and one
   item when they agree ("raw chicken with raw chicken", "shrimp
   and prawn"). Every detected protein becomes an explicit
   occurrence — none silently disappears: "&" is "and" written
   short, and "/" between two foods is a choice or a mixture, never
   a guess, so "chicken & turkey" and "chicken/turkey" are both
   separated; a sub-phrase with no separator at all ("chicken
   turkey") still lists both proteins. The identity is the species,
   the category is the cooking group, and they are never conflated:
   two species that share a temperature are still two proteins
   ("chicken and turkey", "beef and pork", "salmon and tuna"), and
   only a verified exact synonym collapses ("shrimp and prawn"). A
   cut word is not a second animal ("beef steak" is one protein,
   beef). A compound is recognised by an exact phrase ("fish sauce",
   "beef broth"), never by a broad word ("sauce", "broth"), and it
   never hides the protein next to it: "fish sauce with raw beef"
   is a condiment AND a primary protein — the beef is found, its
   condition is read, and it cooks at the beef's temperature. The
   condition is read from the protein component alone, so a cooking
   word that belongs to the rice, the salad, or the sauce never
   changes the protein's condition. A bare animal
   product ("chicken", "one egg") has an UNKNOWN condition: the
   recipe treats it as raw (fail safe) while the warning says plainly
   that the condition is unknown, and the UI offers a Raw / Already
   cooked choice per item (unanswered = treated as raw). Ingredients
   are split on comma, semicolon and newline on both the server and
   the client, and the picker keeps the original separators when it
   rewrites an item. When spoilage AND raw risk are both present,
   BOTH warnings are shown (label and warning text are built from
   parts, never first-only). Non-English input is refused with a hint
   ("ayam mentah" → "use English names, e.g. 'raw chicken'") instead
   of being silently treated as safe; the UI also shows "English
   ingredient names only" under the input.
   The label is always `FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED
   (Entertainment Only)` — this app has no lab and never claims a dish
   was verified safe.
2. **Memory** — Pinecone recurring culprits + Camus / Nietzsche / Kafka / Cioran quote.
3. **Synthesis** — OpenRouter free model, local template fallback.
4. **Dread pairing** — Apify news + persistence. When
   `dignity_loss_percentage > 80`, `sprite-env checkpoints create` runs
   non-blocking and the checkpoint is logged as the
   "Lowest Point of the Week Snapshot" in `checkpoints_log`.

## Fridge observations, sessions & the Chronicle

The Chronicle is event-sourced (`ingredient_events`), one session per
browser. The client keeps a stable id in `localStorage` and sends it as
`X-Frigo-Session`; without it the session is `default`.

- **Log Fridge Check** (`POST /api/fridge-check`) — a NEW observation:
  each ingredient logs `added` (first sighting) or
  `confirmed_present`. This is the ONLY call that records ingredients.
- **Ask Chef Jean-Paul** (`POST /api/generate`) — a menu only. It logs
  nothing, so re-generating the same menu can never manufacture a Ghost.
  A Ghost is an active ingredient seen in ≥ 2 separate observations.
- **Fates** (`POST /api/ingredients/:name/status`, `rescued`/`discarded`)
  are events too. Status and appearances are computed on the CURRENT
  CYCLE only: a fresh sighting after a fate starts a new instance
  (`added`), so a re-bought spinach is `active` again with 1 appearance
  in its new cycle. Older cycles stay in the log but no longer decide
  the status.
- **Demo data** lives ONLY in the `demo` session, seeded once at first
  boot (spinach the Ghost, cold rice, rescued stale bread, departed
  wilted lettuce). Your own session starts empty; the UI's
  **Sample Chronicle (Demo)** tab shows the demo with a `DEMO DATA`
  badge. The demo is read-only ENFORCED BY THE SERVER: `POST
  /api/fridge-check`, `POST /api/ingredients/:name/status` and `POST
  /api/generate` for session `demo` all return `403 Forbidden`.
- **Legacy migration:** a database from before event sourcing (v12
  aggregates in `ingredient_history`) is migrated once at boot: one
  synthetic event per recorded sighting (labelled `legacy_migration`,
  old fates preserved), so the old history shows up in the Chronicle.
  History rows are never deleted. The migration is PER-INGREDIENT:
  a v13 database that already has events keeps them, and only the
  history no event represents is synthesized (count minus the distinct
  observations already logged).
- **Meals, checkpoints, receipts and Box archives are scoped by
  session** (`session_id` on `meals` and `checkpoints_log`). Another
  session's meal id returns `404` on the receipt and archive endpoints.
  The session UUID is browser isolation, not authentication.

## API

- `GET /healthz` — liveness
- `GET /connected` / `?format=json` — gateway + connector truth
- `GET /api/state` — meals, checkpoints, recurring culprits, latest news
- `POST /api/generate` — `{ ingredients }` (+ `X-Frigo-Session`); a `lang` field is accepted and ignored — the menu is always English
- `POST /api/fridge-check` — `{ ingredients }` (+ `X-Frigo-Session`) → `{ observation_id, ingredients, chronicle }`
- `GET /api/chronicle?session=demo` — the bulletin for a session (`?session` overrides the header; `demo` is the sample)
- `POST /api/ingredients/:name/status` — `{ status: "rescued" | "discarded" }` (+ `X-Frigo-Session`)
- `POST /api/meals/:id/archive-box` — Box upload or local-download fallback
- `GET /api/meals/:id/receipt` — thermal receipt HTML

## Sprite setup

```bash
bash scripts/setup-sprite.sh le-frigo-vide
# sprite-env services create le-frigo-vide --cmd node --args src/server.mjs --http-port 8080
```

Attach the free-tier connectors (OpenRouter, Pinecone, Apify, Box) in the
Sprites dashboard. Without them the app still works — every connector
has an honest local fallback.
