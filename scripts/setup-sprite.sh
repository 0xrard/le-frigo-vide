#!/usr/bin/env bash
# Le Frigo Vide — Fly.io Sprite setup (Hacksgiving 2026).
# Zero-key: no .env, no API key is created or stored here. Connectors are
# attached in the Sprites dashboard (OpenRouter, Pinecone, Apify, Box — all
# free tier) and discovered at runtime via the Sprites Gateway.
# Usage:  bash scripts/setup-sprite.sh [sprite-name]
set -euo pipefail

SPRITE_NAME="${1:-le-frigo-vide}"
PORT="${PORT:-8080}"

echo "== Le Frigo Vide — Sprite setup =="
echo "Sprite: ${SPRITE_NAME}  HTTP port: ${PORT}"
echo "Runtime: Node.js >= 22.5, 0 third-party npm dependencies."
echo ""

command -v sprite-env >/dev/null 2>&1 || { echo "ERROR: sprite-env not found. Install the Fly.io Sprites CLI first (see https://sprites.dev)." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (need >= 22.5)." >&2; exit 1; }
node --version

echo ""
echo "-> Creating Sprite service (HTTP port ${PORT})..."
sprite-env services create --http-port "${PORT}" || echo "(service may already exist — continuing)"

echo ""
echo "-> Verifying zero-key posture (no .env, no raw keys in env)..."
if [ -f .env ]; then echo "WARNING: .env exists — this project must not use one. Remove it." >&2; else echo "OK: no .env file."; fi
if env | grep -qiE 'API_KEY|APIKEY|_TOKEN|_SECRET'; then echo "WARNING: key-like env vars are set in this shell; the app reports them honestly on GET /connected." >&2; else echo "OK: no key-like env vars in this shell."; fi

echo ""
echo "-> Starting the app (cold-boot check)..."
PORT="${PORT}" node src/server.mjs &
APP_PID=$!
sleep 2
curl -fsS "http://localhost:${PORT}/healthz" && echo ""
curl -fsS "http://localhost:${PORT}/connected?format=json" | head -c 600; echo ""
kill "${APP_PID}" 2>/dev/null || true

echo ""
echo "Done. Deploy with your Sprite workflow, then attach the free-tier"
echo "connectors in the Sprites dashboard: OpenRouter, Pinecone, Apify, Box."
echo "Without them the app still works — every connector has an honest local fallback."
echo "Verify live: GET /connected  (rawApiKeysInEnv must be 0)"
