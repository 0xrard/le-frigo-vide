# Le Frigo Vide

A personal culinary agent with an existentialist French bistro chef persona
(**Chef Jean-Paul**) that turns sad fridge leftovers into fine-dining menus
full of existential crisis. Built for **Fly.io Hacksgiving 2026**.

## Run

```bash
node --version   # >= 22.5
npm test         # 4 scenarios: normal, trap, dignity>80 checkpoint, ID toggle
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

| Connector | Free-tier use | Fallback when not installed |
|---|---|---|
| OpenRouter (`openrouter/free`) | Food-safety guardrail + menu synthesis | Deterministic local denylist + local menu synthesis |
| Pinecone | Recurring-culprit history + existential quotes | Local cosine similarity over SQLite |
| Apify | 1 grim real-world headline, 4s timeout | Local `news_cache` / seeded headline |
| Box | Archive "Struk Dosa Kuliner" via `POST /upload/files/content` | Receipt offered as a local download |

`GET /connected` (or `?format=json`) proves `rawApiKeysInEnv: 0` and the
real status of every connector. Nothing is ever reported as connected
unless the gateway actually lists it.

## Pipeline (4 stages)

1. **Safety** — OpenRouter free model + local denylist (batteries, soap, …).
2. **Memory** — Pinecone recurring culprits + Camus / Nietzsche / Kafka / Cioran quote.
3. **Synthesis** — OpenRouter free model, local template fallback.
4. **Dread pairing** — Apify news + persistence. When
   `dignity_loss_percentage > 80`, `sprite-env checkpoint create` runs
   non-blocking and the checkpoint is logged as the
   "Lowest Point of the Week Snapshot" in `checkpoints_log`.

## API

- `GET /healthz` — liveness
- `GET /connected` / `?format=json` — gateway + connector truth
- `GET /api/state` — meals, checkpoints, recurring culprits, latest news
- `POST /api/generate` — `{ ingredients, lang: "en" | "id" }`
- `POST /api/meals/:id/archive-box` — Box upload or local-download fallback
- `GET /api/meals/:id/receipt` — thermal receipt HTML

## Sprite setup

```bash
bash scripts/setup-sprite.sh le-frigo-vide
# sprite-env services create --http-port 8080
```

Attach the free-tier connectors (OpenRouter, Pinecone, Apify, Box) in the
Sprites dashboard. Without them the app still works — every connector
has an honest local fallback.
