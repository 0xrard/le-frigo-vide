# Architecture — Le Frigo Vide

Le Frigo Vide is a single Node.js process with **zero third-party npm
dependencies** — only Node built-ins (`node:http`, `node:sqlite`,
`node:test`, `node:child_process`). It runs as a managed service on a
Fly.io Sprite and wakes on HTTP.

## The service

```
sprite-env services create le-frigo-vide --cmd node --args src/server.mjs --http-port 8080
```

`scripts/setup-sprite.sh` wraps that command (see
[Sprite setup](#sprite-setup) below). The server is
`src/server.mjs` (`createServer()`, port `8080` by default, overridable
with `PORT`). Static files come from `public/`; the only other file
served is the shared classifier at
`GET /shared/ingredient-classifier.mjs` (that exact file only — the
route never exposes the `shared/` directory).

## The pipeline — 4 stages

`generateMenu()` in `src/pipeline.mjs` runs, in order:

1. **Food-Safety Guardrail.** The local denylist is authoritative;
   OpenRouter (`openrouter/free`, 8s timeout) may only *confirm* a
   refusal the denylist already makes, and only for an ingredient the
   user actually sent (see [FOOD_SAFETY.md](FOOD_SAFETY.md)). Then the
   shared classifier derives the spoiled, raw-risk, unknown-condition,
   protein-clarification, and ambiguous-protein lists from one
   classification pass. If nothing is safe, the chef refuses to cook.
   If an entry holds more than one primary protein, the recipe is
   blocked here — before any OpenRouter call — so the LLM never sees
   the ambiguous entry.
2. **Local Memory.** Recurring culprits (the ingredients this session
   has seen most, from SQLite `ingredient_history`) and an existential
   quote, matched by local cosine similarity over hashed vectors.
   Pinecone integration is discovered but not yet configured for live
   queries, so no query is ever sent. A generate never records
   ingredients — only a fridge check does — so re-generating a menu
   cannot inflate appearances.
3. **Fictional Global Dread Pairing (Local Fallback).** A headline is
   drawn from the local `news_cache` (seeded fictional headlines, 1h
   TTL). No Apify Actor is configured and no run is ever started. The
   pairing is fetched *before* synthesis so the LLM can write
   `world_context` from the headline.
4. **Menu synthesis.** OpenRouter (`openrouter/free`, 60s timeout,
   `max_tokens` 1200) composes the four-section menu. If the reply is
   unusable, names a spoiled ingredient, or fails to prove every raw
   item was cooked through, it is discarded for the deterministic
   local menu — which is a full four-section menu, not a short
   template. The deterministic cook-through step is always attached
   to the final menu, even to an LLM menu that passed the gate.

Then persistence: the meal is inserted into SQLite, and when
`dignity_loss_percentage > 80` a checkpoint is requested
non-blocking via `sprite-env checkpoints create` (plural, no
`--label` flag) and logged in `checkpoints_log` as the "Lowest Point
of the Week Snapshot".

The menu contract (both paths): `title`, `subtitle`,
`existential_dread`, `food_safety`, `aura_analysis`, `world_context`,
`preparation` (3–4 steps), `sommelier`, `chef_note`,
`dignity_loss_percentage`, `quote`, `quote_author`. The response also
carries `synthesis_via`, `memory_via`, `dread_via`, `safety_via`,
`spoiled_items`, `raw_risk_items`, `unknown_condition_items`,
`needs_protein_clarification_items`, and `ambiguous_protein_items`.

## The server

`src/server.mjs` routes (see [API.md](API.md) for request/response
shapes):

- `GET /healthz` — liveness.
- `GET /connected` — gateway + connector truth (HTML, or JSON with
  `?format=json`).
- `GET /api/state` — connected status, recent meals, checkpoints,
  recurring culprits, latest news.
- `GET /api/chronicle` — the bulletin for a session.
- `POST /api/fridge-check` — log a new observation (the ONLY call
  that records ingredients).
- `POST /api/ingredients/:name/status` — record a fate
  (`rescued` / `discarded`).
- `POST /api/generate` — a menu only; logs nothing.
- `POST /api/meals/:id/archive-box` — Box upload or local-download
  fallback.
- `GET /api/meals/:id/receipt` — thermal receipt HTML.
- `GET /shared/ingredient-classifier.mjs` — the shared classifier.
- `GET /` and other static files from `public/`.

## Sessions

One session per browser. The client keeps a stable id in
`localStorage` and sends it as the `X-Frigo-Session` header; a
validated `?session=` query parameter overrides the header (used only
for the read-only `demo` sample); with neither, the session is
`default`. The session id is browser isolation, not authentication:
a meal or receipt from another session returns `404`, never a hint
that it exists. `meals` and `checkpoints_log` carry `session_id`;
the demo session's mutations are refused with `403` at the server
level (see [CHRONICLE.md](CHRONICLE.md)).

## Data — SQLite

`data/le-frigo-vide.sqlite` (WAL mode, `node:sqlite`), created by
`initDb()` in `src/db.mjs`:

| Table | Purpose |
|---|---|
| `meals` | Every menu and every refusal (rejected meals keep their reason), scoped by `session_id`. |
| `checkpoints_log` | Every checkpoint request, its status, and its note, scoped by `session_id`. |
| `news_cache` | The dread headlines (title, source, `fetched_at`, payload). |
| `ingredient_history` | Per-session aggregate counts + embeddings, keyed by `(session_id, ingredient)`. |
| `ingredient_events` | The event-sourced Chronicle log (the only thing the Chronicle reads). |

History rows are never deleted. A database from before event
sourcing is migrated once at boot (see
[CHRONICLE.md](CHRONICLE.md)).

## Sprite setup

```bash
bash scripts/setup-sprite.sh le-frigo-vide
# sprite-env services create le-frigo-vide --cmd node --args src/server.mjs --http-port 8080
```

Attach the free-tier connectors (OpenRouter, Pinecone, Apify, Box) in
the Sprites dashboard. Without them the app still works — every
connector has an honest local fallback (see
[CONNECTORS.md](CONNECTORS.md)). The setup script fails loudly on
anything except "service already exists": a failed create must never
be swallowed, or a broken deploy hides itself.

## Where the rules live

- Ingredient condition, cooking rules, roles, occurrences:
  `shared/ingredient-classifier.mjs` — the single source of truth,
  imported by the Node backend and by the browser frontend, so the
  server and the picker can never disagree. See
  [FOOD_SAFETY.md](FOOD_SAFETY.md).
- The LLM prompts: `src/prompts.mjs` (`getSystemPrompt`,
  `buildUserPrompt`, `buildSafetyPrompt`).
- The quotes: `src/quotes.mjs` (Camus, Nietzsche, Kafka, Cioran).
- The frontend: `public/app.js`, `public/index.html`,
  `public/style.css`, `public/logo.svg`.
