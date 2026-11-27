# Connectors — Le Frigo Vide

Zero-key: no `.env`, no hardcoded API key anywhere in this repo.
Every outbound call first checks the Fly Sprites Gateway and falls
back honestly when a connector is not installed. A connector is never
reported as connected unless the gateway actually lists it.

## Gateway discovery

```
GET https://api.sprites.dev/v1/gateway/list
```

Documented at https://sprites.dev. The list is cached for 30s and
fetched with a 1200ms timeout. Proven live on Sprite `le-frigo-vide`,
2026-11-27, it returns HTTP 200 with:

```json
{
  "available": [
    { "provider": "openrouter", "...": "..." },
    { "provider": "pinecone", "...": "..." }
    // ... the full catalog (60+ providers) is returned live
  ],
  "connections": [
    { "provider": "openrouter",
      "gateway_base_url": "https://api.sprites.dev/v1/gateway/openrouter/<connection-id>",
      "id": "<connection-id>", "...": "..." }
  ]
}
```

`available` is the catalog — it never counts as connected.
`connections` is what is actually connected. Per-connector calls go
to `<gateway_base_url>/...` with **no Authorization header** — the
Sprite's network identity is injected by the gateway itself. Outside
a Sprite the same endpoint returns an error, which is treated as "no
gateway". (The old address `http://localhost:43123/v1/gateway/list`
was wrong on a Sprite: nothing listens on port 43123 there.)

## `/connected`

`GET /connected` (HTML) or `GET /connected?format=json` reports the
truth per connector, in separate fields — availability, mode, and
last result are never conflated:

| Field | Meaning |
|---|---|
| `connected` / `gateway_connected` | The gateway lists this connector. |
| `feature_execution` | The MODE the feature is configured for: `live` only when the operation is wired to genuinely use the service, otherwise `local-fallback`. A live mode is NOT a successful call. |
| `via` | Mirrors `feature_execution`: `sprites-gateway` or `local-fallback`. |
| `fallback_reason` | Why the mode is a fallback (configuration). |
| `last_execution` | What the most recent operation actually did in this process: `{ at, ok, via, reason }`. Null until the feature runs once. |
| `rawApiKeysInEnv` | Honest count of key-like variables in the environment. In a correct zero-key deployment this is `0` — the values are never read. |

## OpenRouter — live

- **Model:** `openrouter/free`.
- **Call:** `POST <gateway_base_url>/v1/chat/completions`, no
  Authorization header.
- **Use:** food-safety guardrail (8s timeout) and menu synthesis
  (60s timeout, `max_tokens` 1200 — the free model needs >20s for a
  full menu).
- **Retry:** once, after 15s, on HTTP 429 only. Other failures
  (timeout, 4xx/5xx) are not retried.
- **Proven live** on the Sprite 2026-11-27. On 429/offline the
  pipeline serves the deterministic local menu and says so plainly
  (`synthesis_note` names the 429).
- **Mode:** `live` when the gateway lists it, `local-fallback`
  otherwise.

## Pinecone — local fallback

- **Status:** wired (local-fallback active). The gateway connection
  exists, but **no Pinecone index is configured and no query is ever
  sent** — matching runs locally.
- **What actually happens:** `pineconeQuery` embeds the text with a
  deterministic 32-dimensional hashed embedding (`embedText`, FNV-1a
  over lowercase tokens, normalised) and ranks candidates by cosine
  similarity (`cosineSimilarity`) — over the SQLite
  `ingredient_history` and the quotes seed. `feature_execution` is
  always `local-fallback`, and `via` never claims `sprites-gateway`
  for this feature.
- **Correct wording:** "Local Memory — SQLite ingredient history and
  cosine similarity. Pinecone integration is discovered but not yet
  configured for live queries."

## Apify — local fallback (fictional headlines)

- **Status:** wired (local-fallback active). The gateway connection
  exists, but **no Actor is configured and no run is ever started**.
  The Sprites Apify gateway exposes Actors, not a generic "news"
  endpoint — the old `/v1/gateway/apify/news` URL never existed.
- **What actually happens:** the Fictional Global Dread Pairing
  serves the local `news_cache` — a cached headline while it is
  fresh, otherwise a fresh random seed from `FALLBACK_NEWS`. The
  cache TTL is 1 hour; a headline older than that is replaced (the
  old cache never expired, so the first headline ever cached was
  served forever).
- **The fallback headlines are clearly fictional**, in Chef
  Jean-Paul's voice — a committee of very serious cheeses, the
  Ministry of Leftover Affairs, the Department of Expired Yoghurt.
  No fallback headline may ever read like a real report, because the
  LLM is told to write `world_context` from it. A live Apify Actor
  would replace these with real, sourced headlines.
- **Mode:** `local-fallback`, always. Timeout 4s.

## Box — live via the gateway (upload verified 2026-11-28)

- **Call:** `POST <gateway_base_url>/upload/files/content`
  (15s timeout).
- **Format:** hand-built `multipart/form-data` — an `attributes`
  JSON part (`{"name": filename, "parent": {"id": "0"}}`, root folder)
  and a `file` part. A raw body is rejected with HTTP 415 (proven
  live 2026-11-27, right after the Box connector was linked — that
  is how the multipart fix was found).
- **Status label:** "Live via the gateway." The multipart upload was
  verified on the Sprite 2026-11-28: `POST /api/meals/:id/archive-box`
  returned `via: "sprites-gateway"` with a Box file id.
- **Fallback:** when Box is not installed, or an upload fails, the
  receipt is offered as a local download instead
  (`receipt_html` + `download_filename` in the archive response).
  `feature_execution` is `live` when the gateway lists Box,
  `local-fallback` otherwise.
