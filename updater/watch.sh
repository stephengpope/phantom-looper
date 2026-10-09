#!/bin/sh
# ============================================================================
# Updater sidecar — trigger watcher (runs in the `updater` compose service,
# image docker:27-cli).
#
# Waits for the api to write a release tag into $TRIGGER_DIR/request (a volume
# shared with the api container), then spawns a DETACHED one-shot helper
# container running apply.sh to perform the upgrade. Detached because
# `docker compose up -d` inside apply.sh may recreate THIS container (a compose
# change touching the updater service) — the helper's lifetime is independent,
# so the upgrade always completes.
#
# The trigger is a file, not an HTTP listener: this container holds the docker
# socket (host-root-equivalent) and must have zero network surface.
# ============================================================================
set -u

TRIGGER_DIR="${TRIGGER_DIR:-/trigger}"
BACKEND_DIR="${BACKEND_DIR:-/opt/phantom-looper}"
REQUEST="$TRIGGER_DIR/request"
# Per stack (a session runner on a server's daemon sets its own), so the api
# follows its helper and never another stack's.
HELPER_NAME="${HELPER_NAME:-phantom-update-run}"
# Which directory of the image holds this stack's files: the server's root,
# a session runner's session-runner/.
HOST_FILES_DIR="${HOST_FILES_DIR:-/host-files}"

# The api runs as `node`; a fresh named volume is root-owned. Open it up so
# the api can write the trigger file (private volume, two containers).
chmod 1777 "$TRIGGER_DIR" 2>/dev/null || true

# One-time renames of .env lines, each for exactly one upgrade (the compose
# file reads the old name too, so nothing runs without its value in between):
#   PHANTOM_BACKEND_*  ->  BACKEND_*
#   API_KEY            ->  SERVICE_ROLE_KEY, with the prefix every key now
#                          carries (ph_service_role_); a cli that holds the
#                          old value gives it the same prefix (local.ts), so
#                          the two still match.
# An old line whose new name is already there is dropped.
rename_env() {
  [ -f "$1" ] && grep -Eq '^(PHANTOM_BACKEND_|API_KEY=)' "$1" || return 0
  awk -F= 'NR == FNR { if ($1 ~ /^BACKEND_/ || $1 == "SERVICE_ROLE_KEY") have[$1] = 1; next }
    $1 ~ /^PHANTOM_BACKEND_/ { name = substr($1, 9); if (name in have) next; sub(/^PHANTOM_/, "") }
    $1 == "API_KEY" { if ("SERVICE_ROLE_KEY" in have) next; value = substr($0, 9); if (value !~ /^ph_service_role_/) value = "ph_service_role_" value; $0 = "SERVICE_ROLE_KEY=" value }
    { print }' "$1" "$1" > "$1.tmp" && chmod 600 "$1.tmp" && mv "$1.tmp" "$1" \
    && echo "renamed the old lines in $1 (PHANTOM_BACKEND_* -> BACKEND_*, API_KEY -> SERVICE_ROLE_KEY)"
}
rename_env "$BACKEND_DIR/.env"

echo "updater: watching $REQUEST (install dir: $BACKEND_DIR)"

while :; do
  if [ -f "$REQUEST" ]; then
    tag=$(head -c 64 "$REQUEST" | tr -d '[:space:]')
    rm -f "$REQUEST"
    if echo "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "updater: upgrade requested -> $tag"
      # One helper at a time; keep the previous run's container (and its logs)
      # until the next request so failures stay debuggable via `docker logs`.
      docker rm -f "$HELPER_NAME" >/dev/null 2>&1 || true
      docker run -d --name "$HELPER_NAME" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$BACKEND_DIR:$BACKEND_DIR" \
        -e BACKEND_DIR="$BACKEND_DIR" \
        -e HOST_FILES_DIR="$HOST_FILES_DIR" \
        -e BACKEND_API_IMAGE="${BACKEND_API_IMAGE:-}" \
        -e BACKEND_SESSION_IMAGE="${BACKEND_SESSION_IMAGE:-}" \
        docker:27-cli sh "$BACKEND_DIR/updater/apply.sh" "$tag" \
        || echo "updater: failed to spawn helper"
    else
      echo "updater: rejected invalid tag: $(echo "$tag" | head -c 32)"
    fi
  fi
  sleep 3
done
