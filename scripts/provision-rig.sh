#!/usr/bin/env bash
# The local provisioning rig: a privileged Ubuntu container with sshd and its
# own docker daemon — what the setup wizard sees when it is handed a blank
# Linux box. Boots the rig, preloads the locally built api + workspace images
# into the INNER daemon (ghcr has nothing to pull yet, and install.sh
# tolerates a failed pull when the image is present), and prints the exact
# command that runs the wizard against it.
#
#   ./scripts/provision-rig.sh          boot (or reboot) the rig
#   ./scripts/provision-rig.sh down     tear it down
#
# Inside the rig, Let's Encrypt can never issue (no public route), so the
# wizard is pointed at --tls=internal --address=localhost: Caddy's own CA
# issues for `localhost`, the wizard pulls that root over ssh, saves it under
# ~/.phantom-cli/ca/, and verifies https://localhost through the published 443.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=phantom-rig
RIG_DIR=/tmp/phantom-rig
API_IMAGE=ghcr.io/stephengpope/phantom-backend
FS_IMAGE=ghcr.io/stephengpope/phantom-backend-fs
SSH_PORT=2222

if [ "${1:-}" = down ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm phantom-rig-docker >/dev/null 2>&1 || true
  echo "rig removed"
  exit 0
fi

echo "→ building the rig image (first build installs docker via get.docker.com — a few minutes)"
docker build -q -t phantom-rig:latest build/testrig

echo "→ building the api + workspace images the installer will find preloaded"
docker build -q -t "$API_IMAGE:latest" .
docker build -q -t "$FS_IMAGE:latest" build/workspace

# A keypair for the rig alone, never a password: root login is key-only.
mkdir -p "$RIG_DIR"
[ -f "$RIG_DIR/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$RIG_DIR/id_ed25519"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# The inner daemon gets a real volume for /var/lib/docker: overlayfs cannot
# stack on the rig's own overlayfs (whiteout files fail to apply on image
# load), which is why every dind image declares this volume too.
docker run -d --privileged --name "$NAME" \
  -p "$SSH_PORT:22" -p 80:80 -p 443:443 \
  -v phantom-rig-docker:/var/lib/docker \
  -e RIG_AUTHORIZED_KEY="$(cat "$RIG_DIR/id_ed25519.pub")" \
  phantom-rig:latest >/dev/null

# A rebuilt rig has a fresh host key; drop the stale known_hosts entry so
# accept-new can record the new one instead of refusing.
ssh-keygen -R "[localhost]:$SSH_PORT" >/dev/null 2>&1 || true

echo -n "→ waiting for the rig's inner dockerd"
for _ in $(seq 1 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1; then echo; break; fi
  echo -n "."; sleep 1
done
docker exec "$NAME" docker info >/dev/null 2>&1 || { echo; echo "inner dockerd never came up — docker logs $NAME"; exit 1; }

echo "→ preloading the images into the rig (docker save | load — a minute or two)"
docker save "$API_IMAGE:latest" | docker exec -i "$NAME" docker load >/dev/null
docker save "$FS_IMAGE:latest" | docker exec -i "$NAME" docker load >/dev/null

cat <<DONE

  rig up. Run the wizard against it (delete server_key from
  ~/.phantom-cli/settings.json first if this machine is already paired):

    PHANTOM_CLI_INSTALL_FLAGS='--tls=internal --address=localhost --no-firewall' \\
    PHANTOM_CLI_SSH_ACCEPT_NEW=1 \\
    PHANTOM_CLI_SSH_IDENTITY=$RIG_DIR/id_ed25519 \\
    npm run phantom-cli

  target to type in:  root@localhost:$SSH_PORT

  Or headless, end to end:  npx tsx --tsconfig phantom-cli/tsconfig.json scripts/provision-e2e.ts
  Tear down:                ./scripts/provision-rig.sh down
DONE
