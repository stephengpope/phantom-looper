#!/bin/sh
# Rig boot: a docker daemon of its own, then sshd in the foreground.
# RIG_AUTHORIZED_KEY (an ssh public key) becomes root's login — passed as an
# env var at `docker run` so the rig needs no bind mounts (macOS bind-mount
# roots must live under /private/tmp; an env var sidesteps all of it).
set -eu

if [ -n "${RIG_AUTHORIZED_KEY:-}" ]; then
  mkdir -p /root/.ssh
  printf '%s\n' "$RIG_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
fi
# Key-only root login: the rig never has a password to guess.
printf 'PermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/rig.conf

# The inner daemon. iptables-legacy: the nft shim needs kernel modules the
# host may not have loaded for a container netns.
update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
dockerd > /var/log/dockerd.log 2>&1 &
i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "inner dockerd did not come up — /var/log/dockerd.log:" >&2; tail -50 /var/log/dockerd.log >&2; exit 1; }
  sleep 1
done

# The rig must BOOT BLANK, like the box it stands in for. /var/lib/docker is
# a volume (image cache across reboots — preloading is the slow step), but
# that also persists last run's containers: with restart:unless-stopped they
# come back the moment dockerd does, and docker recreates their missing
# bind-mount sources as DIRECTORIES — /opt/phantom-looper/caddy/Caddyfile
# became one, and the next install's docker cp refused to overwrite it.
# Containers and volumes go; images stay.
CONTAINERS=$(docker ps -aq)
[ -z "$CONTAINERS" ] || docker rm -f $CONTAINERS >/dev/null 2>&1 || true
docker volume prune -af >/dev/null 2>&1 || docker volume prune -f >/dev/null 2>&1 || true
# ...and the directories docker already recreated for their bind mounts at
# dockerd start (removing the containers does not remove those): a fresh rig
# has no install directory at all.
rm -rf /opt/phantom-looper

echo "rig ready: dockerd up, sshd starting"

exec /usr/sbin/sshd -D -e
