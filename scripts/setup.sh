#!/usr/bin/env bash
# First-boot setup: configures everything it can, idempotently.
#   - generates .env with fresh secrets (only if .env does not exist)
#   - picks free ports if the defaults are taken
#   - builds the workspace image locally under the name the default setting
#     expects (a published registry image will replace this seamlessly)
#   - brings the stack up — the SAME stack as an install: Caddy in front,
#     HTTPS on its own CA (BACKEND_TLS=internal, what a private-address
#     install runs), HTTP/2 to the cli. There is no plain-http dev mode: the
#     cli speaks one transport and dev runs it.
#   - saves Caddy's root certificate where the cli trusts it (provision.ts
#     caPathFor) and proves /health through it
#   - seats the url + key in .phantom-cli/settings.json, the cli's home for a
#     source run (phantom-cli/config.ts), so `npm run phantom-cli` connects
set -euo pipefail
cd "$(dirname "$0")/.."

free_port() { local p=$1; while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }

if [ ! -f .env ]; then
  PORT=$(free_port 8080)
  HTTPS_PORT=$(free_port 443)
  HTTP_PORT=$(free_port 80)
  # 0600 from the first byte: the file holds the service role key.
  (umask 077; cat > .env <<ENV
POSTGRES_USER=superuser
POSTGRES_PASSWORD=$(openssl rand -hex 16)
SERVICE_ROLE_KEY=ph_service_role_$(openssl rand -hex 24)
ENCRYPTION_KEY=$(openssl rand -base64 32)
BACKEND_PORT=$PORT
BACKEND_HTTPS_PORT=$HTTPS_PORT
BACKEND_HTTP_PORT=$HTTP_PORT
BACKEND_ADDRESS=localhost
BACKEND_TLS=internal
COMPOSE_PROFILES=https
ENV
  )
  echo "wrote .env (api :$PORT, https :$HTTPS_PORT)"
else
  echo ".env exists — keeping it"
fi
# shellcheck disable=SC1091
source .env
# The key rides into curl over stdin (-K -), never as an argument: an argument
# is in `ps` for every user on the machine.
authed_curl() { printf 'header = "authorization: Bearer %s"\n' "$SERVICE_ROLE_KEY" | curl -K - "$@"; }
[ "${BACKEND_TLS:-}" = internal ] && [ "${COMPOSE_PROFILES:-}" = https ] \
  || { echo ".env must have BACKEND_TLS=internal and COMPOSE_PROFILES=https — dev runs the https stack (delete .env to regenerate)"; exit 1; }

# The default container_image setting names this tag; building it locally makes
# the default work with no registry involved.
docker build -q -t ghcr.io/stephengpope/phantom-backend-session:latest build/session

docker compose up -d --build

echo -n "waiting for api"
for _ in $(seq 1 60); do
  if authed_curl -sf "http://127.0.0.1:${BACKEND_PORT:-8080}/api/health" >/dev/null 2>&1; then echo; break; fi
  echo -n "."; sleep 1
done

authed_curl -sf "http://127.0.0.1:${BACKEND_PORT:-8080}/api/health" >/dev/null \
  || { echo "api did not come up — docker compose logs api"; exit 1; }

# Caddy's root certificate: minted on its first start, the one file the cli
# trusts for this host (phantom-cli/provision.ts caPathFor). The cli running
# from source keeps everything under <repo>/.phantom-cli (gitignored) —
# never ~/.phantom-cli, which belongs to an installed build.
HTTPS_PORT=${BACKEND_HTTPS_PORT:-443}
BASE="https://localhost$([ "$HTTPS_PORT" = 443 ] || echo ":$HTTPS_PORT")"
CA=.phantom-cli/ca/localhost.pem
mkdir -p .phantom-cli/ca
echo -n "waiting for caddy's root certificate"
for _ in $(seq 1 30); do
  if docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$CA" 2>/dev/null && [ -s "$CA" ]; then echo; break; fi
  echo -n "."; sleep 1
done
[ -s "$CA" ] || { echo "could not read caddy's root certificate — docker compose logs caddy"; exit 1; }

# The path the cli takes, proven here: TLS on that root, HTTP/2, through Caddy.
authed_curl -sf --http2 --cacert "$CA" "$BASE/api/health" >/dev/null \
  || { echo "$BASE/health failed through caddy — docker compose logs caddy"; exit 1; }

# Merge the connection into the cli's settings.json; other local keys survive.
# The key reaches node through its environment, never an argument.
SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node -e '
  const fs = require("node:fs"); const p = ".phantom-cli/settings.json";
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  delete cur.server_key;
  cur.server_url = process.argv[1]; cur.service_role_key = process.env.SERVICE_ROLE_KEY;
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);
' "$BASE"

cat <<DONE

  phantom-looper is up on $BASE.

  service role key:  in .env (SERVICE_ROLE_KEY), seated in .phantom-cli/settings.json
  root cert:         $CA  (caddy's own CA — the cli trusts it for localhost)

  next: npm run phantom-cli — already connected; add a project, paste model
  keys on /keys, and drop a supervised card into plan to watch the looper.
DONE
