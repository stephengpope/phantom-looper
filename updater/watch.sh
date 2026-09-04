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
PHANTOM_BACKEND_DIR="${PHANTOM_BACKEND_DIR:-/opt/phantom-looper}"
REQUEST="$TRIGGER_DIR/request"
HELPER_NAME=phantom-update-run

# The api runs as `node`; a fresh named volume is root-owned. Open it up so
# the api can write the trigger file (private volume, two containers).
chmod 1777 "$TRIGGER_DIR" 2>/dev/null || true

echo "updater: watching $REQUEST (install dir: $PHANTOM_BACKEND_DIR)"

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
        -v "$PHANTOM_BACKEND_DIR:$PHANTOM_BACKEND_DIR" \
        -e PHANTOM_BACKEND_DIR="$PHANTOM_BACKEND_DIR" \
        -e PHANTOM_BACKEND_IMAGE="${PHANTOM_BACKEND_IMAGE:-}" \
        -e PHANTOM_BACKEND_FS_IMAGE="${PHANTOM_BACKEND_FS_IMAGE:-}" \
        docker:27-cli sh "$PHANTOM_BACKEND_DIR/updater/apply.sh" "$tag" \
        || echo "updater: failed to spawn helper"
    else
      echo "updater: rejected invalid tag: $(echo "$tag" | head -c 32)"
    fi
  fi
  sleep 3
done
