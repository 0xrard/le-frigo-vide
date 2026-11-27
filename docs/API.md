# API — Le Frigo Vide

Base URL (live): `https://le-frigo-vide-b6zkb.sprites.app`.
Local: `http://localhost:8080` (`npm start`).

All responses are JSON unless noted. Request bodies are JSON, max
1 MB; invalid JSON returns `400 { ok: false, error: "invalid JSON
body" }`.

## Sessions

Every browser gets its own session. The client keeps a stable id in
`localStorage` and sends it as the `X-Frigo-Session` header. A
validated `?session=` query parameter overrides the header (used
only for the read-only `demo` sample); with neither, the session is
`default`. A meal or receipt from another session returns `404`,
never a hint that it exists. Mutations against the `demo` session
return `403 { ok: false, error: "demo session is read-only" }`.

## `GET /healthz`

Liveness.

```json
{ "ok": true, "service": "le-frigo-vide", "status": "alive", "uptime_seconds": 123, "time": "2026-11-28T00:00:00.000Z" }
```

## `GET /connected`

Gateway + connector truth. HTML by default; JSON with
`?format=json`. See [CONNECTORS.md](CONNECTORS.md) for the field
semantics.

```json
{
  "service": "le-frigo-vide",
  "rawApiKeysInEnv": 0,
  "rawApiKeyNames": [],
  "gateway": { "available": true, "source": "https://api.sprites.dev/v1/gateway/list", "docs": "https://sprites.dev", "connectors": ["openrouter", "pinecone", "apify", "box"], "connections": { "openrouter": { "baseUrl": "https://api.sprites.dev/v1/gateway/openrouter/<id>", "id": "<id>", "provider": "openrouter" } }, "availableProviders": ["slack", "slack_bot", "github", "discourse", "neon", "link", "box", "apify", "browserbase", "pinecone", "temporal", "agentmail", "blotato", "composio", "era", "kagi", "keenable", "lemonslice", "mnemom", "supabase", "gigapipe", "usable", "depot", "digitalocean", "upstash", "exa", "firecrawl", "linkup", "steel", "parasail", "fireworks", "huggingface", "deepgram", "elevenlabs", "vocalbridge", "ollama", "meta", "openai", "typesafe", "anthropic", "gemini", "resend", "nebius_jobs", "s3_object_store", "senselab", "tigris", "custom_api", "assemblyai", "granola", "linear", "notion", "nscale", "pushover", "sentry", "stripe", "tavily", "zerogpu"], "error": null },
  "connectors": {
    "openrouter": { "name": "openrouter", "connected": true, "gateway_connected": true, "feature_execution": "live", "via": "sprites-gateway", "fallback_reason": null, "last_execution": null, "note": "OpenRouter reachable via Sprites Gateway (free model openrouter/free).", "model": "openrouter/free", "baseUrl": "https://api.sprites.dev/v1/gateway/openrouter/<id>" },
    "pinecone": { "name": "pinecone", "connected": true, "gateway_connected": true, "feature_execution": "local-fallback", "via": "local-fallback", "fallback_reason": "no Pinecone index configured — matching is local cosine over SQLite", "last_execution": null, "note": "Pinecone wired (local-fallback active): reachable via Sprites Gateway, but no Pinecone index is configured, so matching runs locally — cosine similarity over SQLite ingredient_history + quotes seed.", "baseUrl": "https://api.sprites.dev/v1/gateway/pinecone/<id>" },
    "apify": { "name": "apify", "connected": true, "gateway_connected": true, "feature_execution": "local-fallback", "via": "local-fallback", "fallback_reason": "no Apify Actor configured — headlines are local (fictional fallback)", "last_execution": null, "note": "Apify wired (local-fallback active): reachable via Sprites Gateway, but no Actor is configured, so the Global Dread Pairing serves the local news_cache (seeded fictional headlines, no live scrape).", "timeoutMs": 4000, "baseUrl": "https://api.sprites.dev/v1/gateway/apify/<id>" },
    "box": { "name": "box", "connected": true, "gateway_connected": true, "feature_execution": "live", "via": "sprites-gateway", "fallback_reason": null, "last_execution": null, "note": "Box reachable via Sprites Gateway (POST /upload/files/content).", "uploadPath": "/upload/files/content", "baseUrl": "https://api.sprites.dev/v1/gateway/box/<id>" }
  },
  "timestamp": "2026-11-28T00:00:00.000Z"
}
```

## `GET /api/state`

Connected status, recent meals, checkpoints, recurring culprits,
latest news — all scoped to the session.

```json
{
  "connected": { "...": "see /connected" },
  "meals": [ { "id": 1, "created_at": "2026-11-28 00:00:00", "session_id": "default", "lang": "en", "ingredients": ["cold rice"], "title": "Le Frigo Vide, Réinventé", "dignity_loss_percentage": 73, "quote": "…", "quote_author": "Albert Camus", "dread": "…", "menu_json": { "...": "the menu" }, "rejected": false, "rejection_reason": null, "checkpoint_id": null, "archived_box": false } ],
  "checkpoints": [ { "id": 1, "meal_id": 1, "session_id": "default", "checkpoint_id": "v3", "dignity_loss_percentage": 97, "created_at": "2026-11-28 00:00:00", "status": "created", "note": "…" } ],
  "recurring_culprits": [ { "ingredient": "spinach", "count": 3, "last_seen": "2026-11-28 00:00:00" } ],
  "latest_news": { "id": 1, "title": "…", "source": "local-fallback (fictional headline — no live news)", "fetched_at": "2026-11-28 00:00:00", "payload": null }
}
```

Meals and checkpoints are limited to 10, recurring culprits to 5.

## `GET /api/chronicle`

The bulletin for a session. `?session=demo` shows the sample
bulletin. See [CHRONICLE.md](CHRONICLE.md).

```json
{
  "ok": true, "lang": "en", "session_id": "default", "demo": false, "generated_at": "2026-11-28T00:00:00.000Z",
  "totals": { "tracked": 3, "sessions": 5 },
  "survivors": [ { "ingredient": "spinach", "appearances": 3, "first_seen": "2026-11-25T00:00:00.000Z", "last_seen": "2026-11-27T00:00:00.000Z", "days": 3, "status": "active", "status_at": null, "source": "live" } ],
  "rescued": [], "departed": [],
  "ghosts": [ { "ingredient": "spinach", "appearances": 3, "...": "…" } ],
  "investigation": { "ingredient": "spinach", "title": "THE CASE OF THE FORGOTTEN SPINACH", "suspect": "Suspect: The Owner", "victim": "Victim: 3 appearances in the fridge", "evidence": "Evidence: 0 confirmed cooking events", "verdictLabel": "Chef's Verdict:", "verdict": "You do not have a spinach shortage, Monsieur. You have a commitment problem." }
}
```

## `POST /api/fridge-check`

Log a new observation — the ONLY call that records ingredients. One
call = one `observation_id`. `lang` is accepted and ignored (English
only).

Request:

```json
{ "ingredients": ["cold rice", "expired yogurt", "one sad pickle"] }
```

Response (200):

```json
{
  "ok": true,
  "observation_id": "550e8400-e29b-41d4-a716-446655440000",
  "ingredients": ["cold rice", "expired yogurt", "one sad pickle"],
  "session_id": "default",
  "chronicle": { "...": "see /api/chronicle" }
}
```

No ingredients → `400 { ok: false, reason: "No ingredients were
given." }`. Non-English input → `400 { ok: false, reason: "Le Frigo
Vide supports English ingredient names only. …", reason_code:
"unsupported_language", unsupported_words: [{ "word": "ayam", "en":
"chicken", "ingredient": "ayam mentah" }] }`.

## `POST /api/ingredients/:name/status`

Record a fate. `status` must be `rescued` or `discarded` (anything
else → `400`). Returns `404` when the ingredient was never observed
in this session.

Request:

```json
{ "status": "rescued" }
```

Response (200):

```json
{ "ok": true, "ingredient": "spinach", "status": "rescued", "event_id": 42 }
```

## `POST /api/generate`

A menu only — it logs nothing, so re-generating the same menu can
never manufacture a Ghost. `lang` is accepted and ignored.

Request:

```json
{ "ingredients": ["cold rice", "expired yogurt", "one sad pickle"] }
```

Response (200, menu made):

```json
{
  "ok": true, "rejected": false, "meal_id": 7,
  "menu": {
    "title": "Risotto of Alienation atop the Ruins of Ambition",
    "subtitle": "A tasting menu from 3 leftover ingredients. Nothing is hidden.",
    "existential_dread": 48,
    "food_safety": "FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)",
    "safety_warning": null,
    "aura_analysis": "The fridge holds cold rice, expired yogurt, one sad pickle — …",
    "world_context": "While you sauté this cold rice, remember that …",
    "preparation": ["Heat a splash of oil …", "…", "…", "Plate it without garnish. …"],
    "sommelier": "Best enjoyed with lukewarm tap water …",
    "chef_note": "The fridge does not lie: …",
    "dignity_loss_percentage": 73,
    "quote": "…", "quote_author": "Albert Camus",
    "dread_pairing": "The International Bureau of Refrigerator Existentialism reports that …",
    "recurring_culprit": "spinach",
    "spoilage_warning": true,
    "synthesis_via": "openrouter/free",
    "memory_via": "local-fallback",
    "dread_via": "local-fallback"
  },
  "dignity_loss_percentage": 73,
  "safety_via": "local-denylist",
  "synthesis_via": "openrouter/free",
  "synthesis_note": null,
  "memory_via": "local-fallback",
  "dread_via": "local-fallback",
  "dread": { "title": "…", "source": "local-fallback (fictional headline — no live news)", "url": null },
  "recurring": [ { "ingredient": "spinach", "count": 3, "last_seen": "…" } ],
  "checkpoint": null,
  "spoilage_warning": true,
  "spoiled_items": ["expired yogurt"],
  "raw_risk_items": [],
  "unknown_condition_items": [],
  "needs_protein_clarification_items": [],
  "ambiguous_protein_items": []
}
```

`synthesis_via` is `openrouter/free` or `local-fallback`;
`synthesis_note` names the reason when the fallback was caused by
an OpenRouter 429. `checkpoint` is `{ logId, status: "requested" }`
when `dignity_loss_percentage > 80`, otherwise `null`.

Rejections (200, `ok: false`, `rejected: true`) — a `meal_id` is
still recorded:

| `reason_code` | Meaning |
|---|---|
| `empty` | No ingredients were given. |
| `unsupported_language` | Non-English input, refused with a hint (`unsupported_words` lists the per-word translations). |
| `unsafe` | Non-food items refused (`unsafe_items` lists them). |
| `spoiled` | Everything is spoiled — a cooking refusal, not a menu (`spoiled_items` lists them). |
| `ambiguous_protein` | More than one primary protein in one entry — separate first (`ambiguous_protein_items` lists them; `reason` suggests the split). |

```json
{ "ok": false, "rejected": true, "meal_id": 8, "reason": "Chef Jean-Paul has found more than one animal protein in raw chicken with raw fish — kindly separate them into one entry per protein. \"raw chicken with raw fish\" becomes \"raw chicken\" and \"raw fish\". He refuses to guess which temperature belongs to whom.", "reason_code": "ambiguous_protein", "ambiguous_protein_items": ["raw chicken with raw fish"], "safety_via": "local-denylist" }
```

## `POST /api/meals/:id/archive-box`

Archive the meal's Culinary Sin Receipt to Box, or hand it back for
a local download when Box is not installed or the upload fails.
Returns `404` when the meal belongs to another session.

Response (200):

```json
{
  "ok": true, "meal_id": 7, "filename": "culinary-sin-receipt-meal-7.html",
  "via": "sprites-gateway", "box_id": "123456789", "reason": null,
  "note": "Uploaded to Box via Sprites Gateway (POST /upload/files/content).",
  "receipt_html": null, "download_filename": "culinary-sin-receipt-meal-7.html"
}
```

When Box is not installed: `ok: false`, `via: "local-fallback"`,
`reason: "box connector not installed on this Sprite"`, and
`receipt_html` carries the receipt HTML for the browser to download.

## `GET /api/meals/:id/receipt`

The thermal receipt as HTML (`Culinary Sin Receipt — Meal #N`).
Returns `404` when the meal belongs to another session.

## `GET /shared/ingredient-classifier.mjs`

The shared ingredient classifier — the same ES module the browser
frontend imports. Only this exact file is served; the route never
exposes the `shared/` directory.

## Static files

`GET /` serves `public/index.html`; other paths serve files from
`public/` (`.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.ico`).
Unknown paths return `404` ("Not on the menu.").
