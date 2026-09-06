#!/bin/sh
# ============================================================================
# Updater helper — performs one upgrade to the given release tag. Runs in a
# detached one-shot docker:27-cli container spawned by watch.sh, with the
# docker socket and $PHANTOM_BACKEND_DIR (the install dir) mounted at the SAME path as
# on the host — compose hands bind-mount paths to dockerd, which resolves them
# on the host, so the paths must be identical.
#
#   sh apply.sh v1.2.3
#
# Steps (each aborts the upgrade and leaves the running stack untouched):
#   1. Pull the tag's api image. Nothing on disk changes until it is on the
#      box, so a failed pull can't leave .env pinned to an image that doesn't
#      exist. The workspace image at the same tag is pulled too, best-effort:
#      the api pulls it on demand if this misses, so it is a warm-up, not a
#      requirement.
#   2. Copy the host files OUT of the api image into a staging dir.
#   3. mv them into place (rename — never cp: this very script is one of the
#      files, and an in-place overwrite would corrupt the copy the shell is
#      still reading; rename swaps the inode, our fd keeps the old one).
#   4. Persist PHANTOM_BACKEND_TAG=<tag> in .env, then docker compose up -d.
#
# THERE IS NO FILE LIST HERE, and that is the point. A list lives in whatever
# copy of this script the box happens to hold — the release it LAST installed —
# so deleting a runtime file from the repo would make every older box fail
# forever, with the step that replaces this script downstream of the failure.
# Taking the files from the image means the set comes from the release being
# INSTALLED, nothing on the server can be stale, the host files can never
# disagree with the image they configure, and upgrading needs no GitHub.
#
# PHANTOM_BACKEND_API_IMAGE / PHANTOM_BACKEND_SESSION_IMAGE override the image names for testing
# (e.g. locally built tags).
# ============================================================================
set -eu

TAG="${1:?usage: apply.sh <tag>}"
PHANTOM_BACKEND_DIR="${PHANTOM_BACKEND_DIR:-/opt/phantom-looper}"
API_IMAGE="${PHANTOM_BACKEND_API_IMAGE:-ghcr.io/stephengpope/phantom-backend-api}"
SESSION_IMAGE="${PHANTOM_BACKEND_SESSION_IMAGE:-ghcr.io/stephengpope/phantom-backend-session}"
# Where the image keeps the host files (Dockerfile). Mirrors the install
# directory's layout, so extraction is a straight copy.
IMAGE_HOST_DIR=/host-files

# Second line of defense (the api validates too; watch.sh again): the tag lands
# in an image reference and in .env — nothing but a plain version tag may pass.
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "apply: invalid tag"; exit 1; }

ENV_FILE="$PHANTOM_BACKEND_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "apply: no .env at $ENV_FILE — aborting"; exit 1; }

echo "apply: upgrading to $TAG (image: $API_IMAGE:$TAG)"

# ── 1. Pull the new images (disk still untouched) ───────────────────────────
# A failed pull is tolerated only when the image is ALREADY on the box (pulled
# by hand, or a registry blip on a re-run); otherwise nothing has changed and
# nothing will.
if docker pull "$API_IMAGE:$TAG"; then
  echo "apply: api image pulled"
elif docker image inspect "$API_IMAGE:$TAG" >/dev/null 2>&1; then
  echo "apply: pull failed but $API_IMAGE:$TAG is already present — using it"
else
  echo "apply: image pull failed and $API_IMAGE:$TAG is not on this machine — aborting, nothing changed"; exit 1
fi
docker pull "$SESSION_IMAGE:$TAG" \
  && echo "apply: workspace image pulled" \
  || echo "apply: workspace image pull failed — the api will pull it on first use"

# ── 2. Copy the host files out of the api image ─────────────────────────────
# The staging dir sits INSIDE the install dir on purpose: step 3 has to be a
# rename to avoid rewriting this running script in place, and rename only works
# within one filesystem. $PHANTOM_BACKEND_DIR is a bind mount, so a staging dir in the
# container's own /tmp would make every `mv` a cross-device copy — which opens
# the destination and truncates it, exactly the corruption the rename avoids.
STAGE=$(mktemp -d "$PHANTOM_BACKEND_DIR/.upgrade-XXXXXX")
CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1
  rm -rf "$STAGE"
}
trap cleanup EXIT

CID=$(docker create "$API_IMAGE:$TAG") \
  || { echo "apply: could not create a container from the image — aborting, nothing changed"; exit 1; }
docker cp "$CID:$IMAGE_HOST_DIR/." "$STAGE/" \
  || { echo "apply: image has no $IMAGE_HOST_DIR (released before this mechanism?) — aborting, nothing changed"; exit 1; }
echo "apply: host files extracted"

# ── 3. Move them into place ─────────────────────────────────────────────────
# Discovered from what the image actually shipped, never from a list here.
STAGED=$(cd "$STAGE" && find . -type f | sed 's|^\./||')
[ -n "$STAGED" ] || { echo "apply: $IMAGE_HOST_DIR is empty — aborting, nothing changed"; exit 1; }
for rel in $STAGED; do
  mkdir -p "$PHANTOM_BACKEND_DIR/$(dirname "$rel")"
  mv "$STAGE/$rel" "$PHANTOM_BACKEND_DIR/$rel"
done
# `docker cp` preserves the mode it was built with, so the dispatcher arrives
# executable already. Asserted anyway — /usr/local/bin/phantom-backend is a symlink to
# it, and a file that lands 644 is a command that reports "permission denied"
# with nothing to say why.
chmod 755 "$PHANTOM_BACKEND_DIR/host/phantom-backend"

# ── 4. Pin the tag in .env + restart ────────────────────────────────────────
grep -v '^PHANTOM_BACKEND_TAG=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
echo "PHANTOM_BACKEND_TAG=$TAG" >> "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "apply: PHANTOM_BACKEND_TAG=$TAG pinned"
docker compose --project-directory "$PHANTOM_BACKEND_DIR" -f "$PHANTOM_BACKEND_DIR/docker-compose.yml" up -d --remove-orphans
echo "apply: done — phantom-looper is on $TAG"
