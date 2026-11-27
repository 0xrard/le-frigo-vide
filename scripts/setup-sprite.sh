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
echo "Runtime: Node.js >= 22.13.0, 0 third-party npm dependencies."
echo ""

command -v sprite-env >/dev/null 2>&1 || { echo "ERROR: sprite-env not found. Install the Fly.io Sprites CLI first (see https://sprites.dev)." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (need >= 22.13.0)." >&2; exit 1; }
node --version

echo ""
echo "-> Creating Sprite service ${SPRITE_NAME} (HTTP port ${PORT})..."
# Official form (docs.fly.io/sprites/concepts/services): a name, a binary
# in --cmd, arguments in --args (comma-separated), --http-port to route the
# Sprite URL and wake on request. Run from the project root so the
# relative --args path resolves to this checkout.
if ! sprite-env services create "${SPRITE_NAME}" --cmd node --args src/server.mjs --http-port "${PORT}"; then
  # A failed create is only ignorable when the service already exists.
  # Any other failure (bad flags, bad port, runtime error) must stop
  # the script — swallowing it hides a broken deploy.
  if sprite-env services get "${SPRITE_NAME}" >/dev/null 2>&1; then
    echo "(service ${SPRITE_NAME} already exists — continuing)"
  else
    echo "ERROR: could not create service ${SPRITE_NAME} (see the output above)." >&2
    exit 1
  fi
fi

echo ""
echo "-> Verifying zero-key posture (no .env, no raw keys in env)..."
if [ -f .env ]; then echo "WARNING: .env exists — this project must not use one. Remove it." >&2; else echo "OK: no .env file."; fi
if env | grep -qiE 'API_KEY|APIKEY|_TOKEN|_SECRET'; then echo "WARNING: key-like env vars are set in this shell; the app reports them honestly on GET /connected." >&2; else echo "OK: no key-like env vars in this shell."; fi

echo ""
echo "-> Cold-boot check: waiting for the MANAGED service to answer..."
# The managed service owns the process lifecycle — never start a second
# server by hand (the old script did, which would fight the service for
# the same port). Poll the service's own HTTP port until it answers.
UP=false
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then UP=true; break; fi
  sleep 1
done
if [ "${UP}" = true ]; then
  echo "OK: service ${SPRITE_NAME} answers /healthz"
  curl -fsS "http://localhost:${PORT}/connected?format=json" | head -c 600; echo ""
else
  echo "ERROR: service ${SPRITE_NAME} did not answer /healthz within 30s." >&2
  echo "Check: sprite-env services get ${SPRITE_NAME}  and  tail /.sprite/logs/services/${SPRITE_NAME}.log" >&2
  exit 1
fi

echo ""
echo "Done. Deploy with your Sprite workflow, then attach the free-tier"
echo "connectors in the Sprites dashboard: OpenRouter, Pinecone, Apify, Box."
echo "Without them the app still works — every connector has an honest local fallback."
echo "Verify live: GET /connected  (rawApiKeysInEnv must be 0)"
