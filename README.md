# Le Frigo Vide

<img src="public/logo.svg" alt="Le Frigo Vide logo" width="200">

## *The fridge is empty. The chef is not impressed.*

A personal culinary agent that turns forgotten fridge ingredients into existentialist fine-dining experiences.

![Fly.io Hacksgiving 2026](https://img.shields.io/badge/Fly.io-Hacksgiving%202026-blue) ![Node.js >= 22.13.0](https://img.shields.io/badge/Node.js-%3E%3D22.13.0-green) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow) ![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

## The Experience

**Try it live: https://le-frigo-vide-b6zkb.sprites.app**

No sign-up, no key, no install. Open the link, tell Chef Jean-Paul what is left in your fridge, and he will compose a menu — with a full existential crisis, free of charge.

## What is Le Frigo Vide?

Your fridge is full of forgotten ingredients. Your culinary ambitions have seen better days. Le Frigo Vide closes the gap between the two: it takes whatever remains — the cold rice, the wilted lettuce, the one sad pickle — and turns it into a fine-dining menu, complete with an aura analysis, a world context, a sommelier pairing, and a dignity score.

It is personal because it remembers. Every fridge check is logged, so the ingredients you keep forgetting become recurring culprits, and the ones that linger become ghosts with their own investigation. And it is honest about what it does not know: there is no lab here, and no dish is ever claimed to be verified safe.

It runs on a Fly.io Sprite with zero API keys and zero npm dependencies. Every outbound call goes through the Sprites Gateway, and every connector that is not live says so plainly.

## Meet Chef Jean-Paul

Chef Jean-Paul is a deadpan existentialist French bistro chef. He does not use emoji. He does not flatter you. He remembers everything, judges quietly, and cooks reluctantly — because cooking properly is the only small rebellion left.

*"The fridge does not lie: the spinach waited too long, and I cooked it properly, because cooking properly is the only small rebellion left."*

## Signature Features

- **Fridge Aura Analysis** — a reading of your fridge's emotional state, in two or three sentences and one absurd philosophical line.
- **Ingredient Chronicle** — an event-sourced bulletin of everything that has passed through your fridge, with ghosts and a Chef's Verdict.
- **Dignity Meter** — a score for how far your fridge has fallen, from 5 to 97.
- **Culinary Sin Receipt** — a thermal receipt for every meal, printable and archivable to Box.
- **Chef's Verdict** — an investigation of the most forgotten ingredient, with a suspect, a victim, and a verdict.

## How It Works

1. **Tell him what remains.** Type your leftover ingredients, in English. When a condition is unclear, he asks rather than guessing.
2. **Safety.** Every ingredient passes a food-safety guardrail — non-food is refused, spoiled food is excluded from the recipe, raw food gets a thermometer step.
3. **Memory.** Your fridge history is consulted: recurring culprits and an existential quote, matched locally from your own SQLite history.
4. **Dread pairing.** A fictional global headline is drawn, so the menu knows what the world is doing while you sauté.
5. **The menu.** OpenRouter (free model) composes the four-section menu; when it is unavailable, a full local menu is served instead — never an error page.

## Fly.io Sprites Architecture

Le Frigo Vide runs as a managed service on a Fly.io Sprite (`node src/server.mjs`, port 8080), with SQLite persistence and zero API keys. Every outbound call first checks the Sprites Gateway; nothing is ever reported as connected unless the gateway actually lists it.

| Connector | Status | What actually happens |
|---|---|---|
| OpenRouter (`openrouter/free`) | **Live** via the gateway | Food-safety guardrail + menu synthesis. Proven live on the Sprite 2026-11-27. Deterministic local fallback on 429/offline. |
| Pinecone | Local fallback | No Pinecone index is configured and no query is ever sent. Matching is local cosine similarity over SQLite ingredient history. |
| Apify | Local fallback | No Actor is configured and no run is ever started. The Global Dread Pairing serves fictional headlines from a local cache. |
| Box | **Live** via the gateway — multipart upload verified on the Sprite 2026-11-28 | Multipart upload of the Culinary Sin Receipt via `POST /upload/files/content`. Receipt offered as a local download when not installed. |

`GET /connected` (or `?format=json`) proves `rawApiKeysInEnv: 0` and the real status of every connector.

## Quick Start

Prerequisites: Node.js >= 22.13.0. No `npm install` — there are no third-party dependencies.

```bash
git clone https://github.com/0xrard/le-frigo-vide.git
cd le-frigo-vide
npm test    # full suite: safety, Chronicle, API, connectors
npm start   # http://localhost:8080
```

To deploy on a Sprite: `bash scripts/setup-sprite.sh le-frigo-vide`, then attach the free-tier connectors (OpenRouter, Pinecone, Apify, Box) in the Sprites dashboard. Without them the app still works — every connector has an honest local fallback.

## Language Support

Le Frigo Vide currently supports English ingredient names and descriptions. Other languages are not supported in this MVP. An unrecognised or ambiguous input is never assumed safe: a bare animal product gets a Raw / Already cooked question, and a raw item gets the thermometer step — the app asks rather than guessing.

## Food Safety & Privacy

The label is always `FOOD CATEGORY: PASSED | SAFETY: NOT VERIFIED (Entertainment Only)` — this app has no lab and never claims a dish was verified safe. Spoiled food is excluded from the recipe, raw food is cooked through with a food thermometer, and an ambiguous protein combination blocks the recipe entirely. Your data stays in your own session (one per browser, stored in SQLite on the Sprite); the demo session is read-only. Full rules: [docs/FOOD_SAFETY.md](docs/FOOD_SAFETY.md).

## Documentation & API

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Sprite architecture and the pipeline flow.
- [docs/FOOD_SAFETY.md](docs/FOOD_SAFETY.md) — the ingredient classifier, cooking rules, and LLM validation.
- [docs/CHRONICLE.md](docs/CHRONICLE.md) — event sourcing, the observation lifecycle, migration, and sessions.
- [docs/CONNECTORS.md](docs/CONNECTORS.md) — gateway discovery, each connector's real status and fallback, `/connected`.
- [docs/API.md](docs/API.md) — every API endpoint with request/response examples.

## License

MIT (declared in `package.json`).
