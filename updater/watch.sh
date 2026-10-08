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
HELPER_NAME=phantom-update-run

# The api runs as `node`; a fresh named volume is root-owned. Open it up so
# the api can write the trigger file (private volume, two containers).
chmod 1777 "$TRIGGER_DIR" 2>/dev/null || true

# One-time: the server's variables were PHANTOM_BACKEND_*; they are BACKEND_*.
# Rename the old lines in .env (an old line whose new name is already there
# is dropped). The compose file reads the old names for exactly this one
# upgrade, so nothing runs without its values in between.
rename_env() {
  [ -f "$1" ] && grep -q '^PHANTOM_BACKEND_' "$1" || return 0
  awk -F= 'NR == FNR { if ($1 ~ /^BACKEND_/) have[$1] = 1; next }
    $1 ~ /^PHANTOM_BACKEND_/ { name = substr($1, 9); if (name in have) next; sub(/^PHANTOM_/, "") }
    { print }' "$1" "$1" > "$1.tmp" && chmod 600 "$1.tmp" && mv "$1.tmp" "$1" \
    && echo "renamed the PHANTOM_BACKEND_* lines in $1 to BACKEND_*"
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
