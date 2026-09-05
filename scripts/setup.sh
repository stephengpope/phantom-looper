#!/usr/bin/env bash
# First-boot setup: configures everything it can, idempotently.
#   - generates .env with fresh secrets (only if .env does not exist)
#   - picks a free port if the default is taken
#   - builds the workspace image locally under the name the default setting
#     expects (a published registry image will replace this seamlessly)
#   - brings the stack up and waits for /health
#   - seats the url + key in .phantom-cli/settings.json, the cli's home for a
#     source run (phantom-cli/config.ts), so `npm run phantom-cli` connects
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  PORT=8080
  while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
API_KEY=$(openssl rand -hex 24)
ENCRYPTION_KEY=$(openssl rand -base64 32)
PHANTOM_BACKEND_PORT=$PORT
ENV
  echo "wrote .env (port $PORT)"
else
  echo ".env exists — keeping it"
fi
# shellcheck disable=SC1091
source .env

# The default container_image setting names this tag; building it locally makes
# the default work with no registry involved.
docker build -q -t ghcr.io/stephengpope/phantom-backend-fs:latest build/workspace

docker compose up -d --build

echo -n "waiting for api"
for _ in $(seq 1 60); do
  if curl -sf -H "authorization: Bearer $API_KEY" "http://127.0.0.1:${PHANTOM_BACKEND_PORT:-8080}/health" >/dev/null 2>&1; then echo; break; fi
  echo -n "."; sleep 1
done

BASE="http://127.0.0.1:${PHANTOM_BACKEND_PORT:-8080}"
curl -sf -H "authorization: Bearer $API_KEY" "$BASE/health" >/dev/null || { echo "api did not come up — docker compose logs api"; exit 1; }

# The cli running from source keeps everything under <repo>/.phantom-cli
# (gitignored) — never ~/.phantom-cli, which belongs to an installed build.
# Merge the connection into its settings.json; other local keys survive.
mkdir -p .phantom-cli
node -e '
  const fs = require("node:fs"); const p = ".phantom-cli/settings.json";
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  cur.server_url = process.argv[1]; cur.server_key = process.argv[2];
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);
' "http://localhost:${PHANTOM_BACKEND_PORT:-8080}" "$API_KEY"

cat <<DONE

  phantom-looper is up on $BASE.

  api key:    $API_KEY   (also written to .phantom-cli/settings.json)

  next: npm run phantom-cli — already connected; add a workspace, paste model
  keys on /keys, and drop a supervised card into plan to watch the looper.
DONE
