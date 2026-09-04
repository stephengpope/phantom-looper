# The provisioning test rig: what the setup wizard sees when it is handed a
# blank Linux box — Ubuntu, sshd, and a docker daemon of its own (run it with
# --privileged). Docker is installed at IMAGE BUILD time via get.docker.com,
# the same path install.sh would take on a truly blank box, so the rig boots
# in seconds instead of re-downloading docker every run; install.sh then finds
# it present and moves on, which is also a real install path (a box that
# already has docker).
#
#   scripts/provision-rig.sh builds, boots and preloads this.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server curl ca-certificates iptables kmod \
 && curl -fsSL https://get.docker.com | sh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
COPY entry.sh /entry.sh
RUN chmod 755 /entry.sh
EXPOSE 22 80 443
ENTRYPOINT ["/entry.sh"]
