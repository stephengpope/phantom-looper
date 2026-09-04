#!/bin/sh
# ============================================================================
# phantom-looper server installer (Linux)
# ============================================================================
# One-liner install / update:
#
#   curl -fsSL https://raw.githubusercontent.com/stephengpope/phantom-looper/main/scripts/install.sh | sh
#
# Options (append: | sh -s -- --address=fs.example.com --cert-email=you@x.com --yes):
#   --address=HOST     A domain name, or this server's public IP. Empty (the
#                      default) = this server's public IP, looked up once here.
#                      Either gets a real Let's Encrypt certificate (IP
#                      certificates are short-lived and auto-renewed by Caddy).
#                      Works on a RE-RUN too, to add a domain later.
#   --cert-email=ADDR  Where Let's Encrypt sends expiry warnings.
#   --tls=internal     Use Caddy's own CA instead of Let's Encrypt (for an
#                      address Let's Encrypt cannot reach). Clients then trust
#                      the one root certificate `phantom-backend ca` prints.
#   --yes              Non-interactive: no prompts, install docker if missing.
#   --no-firewall      Skip the ufw setup.
#
# What it does:
#   1. Installs docker (via get.docker.com) if missing.
#   2. Sets up ufw: deny inbound, allow SSH + 80/443 (skippable, see above).
#   3. Pulls the api image and copies the host files out of it (compose file,
#      Caddyfile, updater scripts, the `phantom-backend` command) into /opt/phantom-looper.
#      They ship in the image, so they always match the server they configure
#      and there is no file list to go stale.
#   4. Generates .env secrets on first run (never overwritten after that), and
#      records this server's address as PHANTOM_BACKEND_ADDRESS.
#   5. docker compose up -d  — pulls the images from ghcr.io.
#   6. Waits for /health, then runs `phantom-backend check` — which tests the address,
#      certificate and API key a client will actually use.
#   7. Prints the server URL and API key.
#   8. Installs the `phantom-backend` command on PATH (status, logs, check, version,
#      update, key, ca).
#
# Re-running is the update path AND the recovery path: it pulls `latest`,
# refreshes the host files from it, releases any PHANTOM_BACKEND_TAG a remote upgrade
# pinned, and recreates changed containers. Data lives on named volumes.
# Secrets are never regenerated; only flags you pass are updated.
# ============================================================================

set -eu

# The image is the whole release: the server, and the host files this script
# unpacks into $DIR. Overridable for testing (point IMAGE at a locally built
# name, DIR at a temp dir).
IMAGE="${PHANTOM_BACKEND_IMAGE:-ghcr.io/stephengpope/phantom-backend}"
DIR="${PHANTOM_BACKEND_DIR:-/opt/phantom-looper}"

# Empty = not passed. A re-run only overwrites what was actually given, so
# `--address=` on an update adds a domain to an existing install without
# touching the generated secrets.
ADDRESS=""
ADDRESS_SET=0
CERT_EMAIL=""
CERT_EMAIL_SET=0
TLS=""
ASSUME_YES=0
NO_FIREWALL=0
for arg in "$@"; do
  case "$arg" in
    --address=*)    ADDRESS="${arg#--address=}"; ADDRESS_SET=1 ;;
    --cert-email=*) CERT_EMAIL="${arg#--cert-email=}"; CERT_EMAIL_SET=1 ;;
    --tls=*)        TLS="${arg#--tls=}" ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --no-firewall)  NO_FIREWALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done
case "$TLS" in ""|public|internal) ;; *) echo "--tls must be public or internal" >&2; exit 1 ;; esac

say()  { printf '\033[0;36m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# Prompt via /dev/tty so it works under `curl | sh` (stdin is the script).
ask() { # ask "question" -> $ANSWER ('' when non-interactive)
  ANSWER=''
  if [ "$ASSUME_YES" -eq 1 ] || ! [ -r /dev/tty ]; then return 0; fi
  printf '%s' "$1" > /dev/tty
  IFS= read -r ANSWER < /dev/tty || ANSWER=''
}

[ "$(uname -s)" = "Linux" ] || fail "Linux only (got $(uname -s)). On macOS use the repo: ./scripts/setup.sh"
command -v curl >/dev/null 2>&1 || fail "curl is required"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run as root, or install sudo"
  SUDO="sudo"
  say "Some steps need root — sudo will prompt if needed."
fi

# ── Docker ──────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && $SUDO docker info >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //;s/,.*//') found"
else
  if [ "$ASSUME_YES" -ne 1 ]; then
    ask "Docker not found — install it via get.docker.com? [Y/n] "
    case "$ANSWER" in n|N|no|NO) fail "docker is required" ;; esac
  fi
  say "Installing docker..."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO docker info >/dev/null 2>&1 || fail "docker installed but the daemon isn't responding"
  ok "docker installed"
fi
$SUDO docker compose version >/dev/null 2>&1 || fail "docker compose plugin missing (docker too old — get.docker.com installs it)"

# ── Firewall (ufw) ──────────────────────────────────────────────────────────
# Defense in depth for the HOST: default-deny inbound, allow SSH + 80/443.
# phantom-looper's own surface is unchanged (caddy on 80/443, api is
# localhost-bound, postgres unmapped) — this guards sshd and whatever else
# lands on the box later. Idempotent; re-runs are safe.
if [ "$NO_FIREWALL" -ne 1 ]; then
  WANT_FW=y
  if [ "$ASSUME_YES" -ne 1 ]; then
    ask "Enable ufw firewall (deny inbound; allow SSH + 80/443)? [Y/n] "
    case "$ANSWER" in n|N|no|NO) WANT_FW=n ;; esac
  fi
  if [ "$WANT_FW" = y ]; then
    if ! command -v ufw >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        say "Installing ufw..."
        { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq ufw; } \
          || say "ufw install failed — skipping firewall"
      else
        say "No ufw and no apt-get — skipping firewall (set up firewalld/nftables manually)"
      fi
    fi
    if command -v ufw >/dev/null 2>&1; then
      # Never lock ourselves out: allow every configured sshd port BEFORE enabling.
      SSH_PORTS=$(grep -rhsE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null | awk '{print $2}' | sort -u)
      [ -n "$SSH_PORTS" ] || SSH_PORTS=22
      for p in $SSH_PORTS; do $SUDO ufw allow "$p/tcp" >/dev/null; done
      $SUDO ufw allow 80/tcp >/dev/null
      $SUDO ufw allow 443/tcp >/dev/null
      $SUDO ufw default deny incoming >/dev/null
      $SUDO ufw default allow outgoing >/dev/null
      $SUDO ufw --force enable >/dev/null
      ok "Firewall on (inbound allowed: SSH [$SSH_PORTS], 80, 443)"
    fi
  fi
fi

# ── Runtime files ───────────────────────────────────────────────────────────
# They come OUT OF THE IMAGE, not off GitHub. A release is one artifact, so the
# compose file, Caddyfile, updater scripts and `phantom-backend` command are always the
# ones built alongside the server they configure — and there is no file list
# anywhere for a release to outgrow. See the Dockerfile.
#
# Always `latest`, and any PHANTOM_BACKEND_TAG pin is cleared below: re-running this
# script is the documented update path and the recovery path, so it has to
# move a box forward rather than rebuild it at whatever tag it was stuck on.
say "Pulling phantom-looper image..."
# `docker pull` of a local-only image fails — tolerated when the image is
# already present (apply.sh has the same rule), which is what lets a test rig
# preload a locally built image and run this script unchanged.
$SUDO docker pull "$IMAGE:latest" \
  || $SUDO docker image inspect "$IMAGE:latest" >/dev/null 2>&1 \
  || fail "could not pull $IMAGE:latest"

say "Extracting host files into $DIR ..."
$SUDO mkdir -p "$DIR"
CID=$($SUDO docker create "$IMAGE:latest") || fail "could not create a container from $IMAGE:latest"
$SUDO docker cp "$CID:/host-files/." "$DIR/" || {
  $SUDO docker rm "$CID" >/dev/null 2>&1 || true
  fail "image has no /host-files — is $IMAGE:latest older than this installer?"
}
$SUDO docker rm "$CID" >/dev/null 2>&1 || true
ok "Files installed from $IMAGE:latest"

# Warm the workspace image at the SAME version as the api, so the first session
# does not wait on a pull. Best-effort: the api pulls it on demand otherwise.
API_VERSION=$($SUDO docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE:latest" 2>/dev/null | sed -n 's/^APP_VERSION=//p' | head -1)
if [ -n "$API_VERSION" ] && [ "$API_VERSION" != dev ]; then
  FS_IMAGE="${PHANTOM_BACKEND_FS_IMAGE:-ghcr.io/stephengpope/phantom-backend-fs}"
  $SUDO docker pull "$FS_IMAGE:$API_VERSION" >/dev/null 2>&1 && ok "Workspace image $API_VERSION present" \
    || say "workspace image pull failed — the api will pull it when the first session starts"
fi

# ── Public address ──────────────────────────────────────────────────────────
# Resolved HERE, once, and written to .env. Caddy issues the certificate for
# exactly this address, and the URL printed below must be the same string.
PUBLIC_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
case "$PUBLIC_IP" in
  *[0-9].[0-9]*) ;;
  *) PUBLIC_IP="" ;;
esac

# ── .env — secrets generated once; passed flags update in place ──────────────
ENV_FILE="$DIR/.env"

env_get() { $SUDO sh -c "grep '^$1=' '$ENV_FILE' 2>/dev/null" | head -1 | cut -d= -f2- || true; }
env_set() {
  $SUDO sh -c "umask 077; grep -v '^$1=' '$ENV_FILE' > '$ENV_FILE.tmp' 2>/dev/null || true; \
               printf '%s=%s\n' '$1' '$2' >> '$ENV_FILE.tmp'; \
               mv '$ENV_FILE.tmp' '$ENV_FILE'"
}

if $SUDO test -f "$ENV_FILE"; then
  ok ".env exists — secrets kept (delete $ENV_FILE to regenerate)"
  API_KEY_SHOWN="(unchanged — phantom-backend key)"
  [ "$ADDRESS_SET" -eq 1 ] && env_set PHANTOM_BACKEND_ADDRESS "$ADDRESS"
  [ "$CERT_EMAIL_SET" -eq 1 ] && env_set PHANTOM_BACKEND_CERT_EMAIL "$CERT_EMAIL"
  [ -n "$TLS" ] && env_set PHANTOM_BACKEND_TLS "$TLS"
  env_set PHANTOM_BACKEND_DIR "$DIR"
  # The address is a domain someone chose, or an IP this script recorded. Only
  # refresh an IP (server moved) — never replace a domain with one.
  CUR=$(env_get PHANTOM_BACKEND_ADDRESS)
  case "$CUR" in
    ""|[0-9]*.[0-9]*.[0-9]*.[0-9]*)
      if [ -n "$PUBLIC_IP" ] && [ "$CUR" != "$PUBLIC_IP" ] && [ "$ADDRESS_SET" -ne 1 ]; then
        env_set PHANTOM_BACKEND_ADDRESS "$PUBLIC_IP"; say "Recorded new public address: $PUBLIC_IP"
      fi ;;
  esac
  # Release the tag a previous remote upgrade pinned. Compose reads
  # ${PHANTOM_BACKEND_TAG:-latest}, so an empty value IS `latest` — and the files just
  # unpacked came from `latest`, so leaving an old pin would run one release's
  # server under another release's compose file. This is what makes re-running
  # the installer a real recovery.
  if [ -n "$(env_get PHANTOM_BACKEND_TAG)" ]; then
    env_set PHANTOM_BACKEND_TAG ""
    say "Unpinned PHANTOM_BACKEND_TAG — this install runs latest"
  fi
else
  if [ "$ADDRESS_SET" -ne 1 ]; then
    ask "Domain for this server (Enter = none, use its public IP ${PUBLIC_IP:-?}): "
    ADDRESS="$ANSWER"
  fi
  [ -n "$ADDRESS" ] || ADDRESS="$PUBLIC_IP"
  [ -n "$ADDRESS" ] || fail "could not determine this server's public address, and no --address was given"
  if [ -z "$CERT_EMAIL" ] && [ "$CERT_EMAIL_SET" -ne 1 ] && [ "$TLS" != internal ]; then
    ask "Email for Let's Encrypt expiry warnings (Enter = skip): "
    CERT_EMAIL="$ANSWER"
  fi
  rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  API_KEY_SHOWN=$(rand_hex 24)
  $SUDO sh -c "umask 077; cat > '$ENV_FILE'" <<EOF
POSTGRES_PASSWORD=$(rand_hex 16)
API_KEY=$API_KEY_SHOWN
ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
PHANTOM_BACKEND_ADDRESS=$ADDRESS
PHANTOM_BACKEND_CERT_EMAIL=$CERT_EMAIL
PHANTOM_BACKEND_TLS=${TLS:-public}
PHANTOM_BACKEND_DIR=$DIR
COMPOSE_PROFILES=https
EOF
  ok ".env created (secrets generated, chmod 600)"
fi

# ── The one command on PATH ─────────────────────────────────────────────────
# ONE symlink, to a file that ships with the release. Its target path never
# changes, so upgrades keep the command current by replacing that file — and
# never need to write outside $DIR, which they cannot do.
$SUDO chmod 755 "$DIR/host/phantom-backend"
$SUDO ln -sf "$DIR/host/phantom-backend" /usr/local/bin/phantom-backend
ok "Installed: phantom (try: phantom-backend status)"

# ── Up ──────────────────────────────────────────────────────────────────────
say "Pulling images + starting containers..."
cd "$DIR"
# Tolerate a failed pull when an image is already present locally (registry
# blip on an update run shouldn't take the install down with it).
$SUDO docker compose pull || say "pull failed — continuing with local images if present"
$SUDO docker compose up -d
ok "Containers started"

PORT=$(env_get PHANTOM_BACKEND_PORT); PORT="${PORT:-8080}"
say "Waiting for the api to come up..."
# /health requires the token like every other route (setup.sh learned this
# live; found again here by the provisioning rig). The key goes in over
# stdin (-K -), so it never appears in `ps`.
KEY=$(env_get API_KEY)
i=0
until printf 'header = "authorization: Bearer %s"\n' "$KEY" \
      | curl -fsS -K - "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && fail "api not healthy after 90s — check: phantom-backend logs api"
  sleep 2
done
ok "api is up"

# That loop only proves the api answers itself on a local port — not the
# address, certificate or key printed below. `phantom-backend check` tests those, and it
# matters most right here: Let's Encrypt issues AFTER `up -d` returns. Never
# fatal — a fresh install is still worth finishing, and the check names what
# to fix.
printf '\n'
say "Verifying what a client will use..."
$SUDO env PHANTOM_BACKEND_DIR="$DIR" phantom-backend check || true

# ── Done ────────────────────────────────────────────────────────────────────
ADDRESS=$(env_get PHANTOM_BACKEND_ADDRESS)
printf '\n\033[0;32m✓ Install complete.\033[0m\n\n'
printf '  Server URL:  https://%s\n' "$ADDRESS"
printf '  API key:     %s\n' "$API_KEY_SHOWN"
printf '\nNotes:\n'
printf '  - Ports 80 + 443 must be open (cloud firewall / security group).\n'
printf '  - The API docs are not served publicly. Reach them over a tunnel:\n'
printf '      ssh -L 8080:127.0.0.1:%s you@%s\n' "$PORT" "$ADDRESS"
if [ "$(env_get PHANTOM_BACKEND_TLS)" = internal ]; then
  printf '  - Clients must trust this server'"'"'s root certificate:  phantom-backend ca > phantom-root.crt\n'
  printf '    (curl --cacert phantom-root.crt …  /  NODE_EXTRA_CA_CERTS=phantom-root.crt)\n'
else
  printf '  - A bare IP gets a real Let'"'"'s Encrypt certificate too. To use a domain later:\n'
  printf '      re-run this script with --address=your-domain --cert-email=you@example.com\n'
fi
printf '  - Update later: phantom-backend update vX.Y.Z, POST /update, or re-run this script.\n'
printf '  - Logs: phantom-backend logs api\n\n'
