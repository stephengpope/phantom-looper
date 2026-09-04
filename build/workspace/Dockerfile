# Default workspace image — the agent's environment. Toolchain list ported from
# Shockwave's companion image: a bare base has tar and gzip and nothing else,
# and each absence is invisible until a turn needs it.
#
# ripgrep is a HARD requirement of the tool surface (grep/glob run `rg`).
# Custom container_image values must include it.
#
# Debian 13 (trixie): current stable — system python is 3.13, everything recent.
FROM debian:trixie-slim
ARG UID=1000

# Base toolchain. build-essential/pkg-config/libssl-dev/libffi-dev cover native
# builds (node-gyp needs make+g++; pip sdists need a compiler) — the biggest
# "invisible until a turn needs it" gap the lean image had.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates openssl sudo \
      curl wget jq ripgrep sqlite3 file less bc tree procps \
      unzip zip xz-utils bzip2 \
      build-essential pkg-config libssl-dev libffi-dev \
      python3 python3-pip python3-venv \
      openssh-client rsync patch \
      postgresql-client \
      dnsutils iputils-ping netcat-openbsd tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && git lfs install --system
ENV LANG=C.UTF-8
# Runtime execs are always Tty: false, so every agent-run apt install would spew
# debconf's tty-fallback warnings without this. The runtime IS noninteractive.
ENV DEBIAN_FRONTEND=noninteractive

# Same uid as the API image's `node` user: both write the shared volume, and one
# uid means ownership is never a question. Created early so build-time chowns
# below can name it.
RUN useradd -m -u ${UID} agent
# Passwordless sudo: the container is the boundary, the user is not. Without it
# the agent cannot apt-get anything and burns turns on ~-local workarounds.
# Caveat sudo does NOT lift: files under /workspace must stay uid ${UID} — the
# API process shares that volume and root-owned files break its git operations.
RUN echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

# Node 24 LTS from NodeSource's distro-independent repo; corepack so pnpm/yarn
# resolve via package.json `packageManager` (installed explicitly — Node is
# dropping the bundled copy).
RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && npm install -g corepack@latest && corepack enable \
  && rm -rf /var/lib/apt/lists/*

# gh from GitHub's own apt repo, not Debian's: Debian's lags years behind and
# the agent is the one using it. Same install GitHub documents.
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Docker, from Docker's own apt repo — the FULL engine (dockerd), not just the
# client: the agent runs its own daemon INSIDE this container (docker build/run/
# compose) when the workspace is created with `container_docker` on (privileged +
# a /var/lib/docker volume). Installed unconditionally: with the setting off the
# binaries just sit unused; the daemon can only start under privileged anyway.
# `agent` joins the `docker` group so `docker` needs no sudo. The daemon is NOT
# started at build or boot — the agent runs `start-docker` (below) on demand.
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
       -o /etc/apt/keyrings/docker.asc \
  && chmod go+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/* \
  && usermod -aG docker agent
# start-docker: bring the inner daemon up on demand, idempotently. dockerd needs
# root (passwordless sudo, above); the agent reaches the socket via the docker
# group with no sudo once it is up. A no-op when already running, so it is safe
# to call before every docker command. Fails loudly if privileged mode is off
# (the setting was never turned on) rather than hanging.
RUN printf '%s\n' \
  '#!/bin/sh' \
  '# Start the workspace-local Docker daemon if it is not already up. Idempotent.' \
  'if docker info >/dev/null 2>&1; then exit 0; fi' \
  'sudo sh -c "dockerd >/var/log/dockerd.log 2>&1 &"' \
  'for _ in $(seq 1 40); do' \
  '  docker info >/dev/null 2>&1 && exit 0' \
  '  sleep 0.5' \
  'done' \
  'echo "dockerd did not come up — is this workspace container_docker=on (privileged)? see /var/log/dockerd.log" >&2' \
  'tail -n 20 /var/log/dockerd.log >&2 2>/dev/null || true' \
  'exit 1' \
  > /usr/local/bin/start-docker \
  && chmod 755 /usr/local/bin/start-docker

# Python versions via uv: prebuilt standalone CPython, no compiling, and the
# agent gets `uv venv -p 3.12`, `uv pip`, `uvx` for free. Installed to a fixed
# system path (agent-owned, so it can add versions later); system python3.13 +
# venv + pip above remain the boring fallback.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.11 3.12 3.13 && chown -R ${UID}:${UID} /opt/uv

# Playwright: the library (`playwright`) and the agent CLI (`playwright-cli`,
# @playwright/cli) installed together, chromium baked at BUILD time into a
# fixed shared path so no run ever boots into a download.
# PLAYWRIGHT_BROWSERS_PATH is the whole mechanism — everything here AND any
# playwright a repo installs later look (and install) there, so a repo pinning
# a different version that needs a different browser revision downloads only
# the browser, into the same cache, with the system libraries already present
# (--with-deps installed them — no hand-maintained apt list to drift).
#
# Versions are PINNED and move together: the CLI's own pinned playwright-core
# names the exact chromium revision baked below, and the system skill further
# down is copied out of that same package — CLI, browser and manual cannot
# drift from each other. Bump the ARGs to move all three at once.
#
# The browser folder is named after the revision each tool pins, and each looks
# in its exact folder and nowhere else — so the browser is installed by BOTH
# installers (same revision = shared, a mismatch = both baked; either way every
# launch finds its browser). Agent-owned so later installs work without sudo.
ARG PLAYWRIGHT_VERSION=1.62.1
ARG PLAYWRIGHT_CLI_VERSION=0.1.18
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} @playwright/cli@${PLAYWRIGHT_CLI_VERSION} \
  && apt-get update \
  && playwright install --with-deps chromium \
  && playwright-cli install-browser chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R ${UID}:${UID} /ms-playwright

# The system skill tier: /opt/skills/<name>/ — scanned by the server at
# session creation (merged into the coding prompt, repo shadowing system) and
# served by skill_load. The playwright-cli skill is the package's OWN manual,
# copied from the pinned install above with our preamble on top; the
# Installation and Windows sections are stripped (this machine has it
# installed, and has no cmd.exe). references/ rides along as bundled files.
COPY playwright-skill-head.md /tmp/skill-head.md
RUN set -e; \
    SRC=/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core/lib/tools/skills/playwright-cli; \
    mkdir -p /opt/skills/playwright-cli; \
    cp -r "$SRC/references" /opt/skills/playwright-cli/references; \
    { cat /tmp/skill-head.md; echo; \
      sed '1,/^---[ \t]*$/d' "$SRC/SKILL.md" \
      | awk '/^## (Installation|URLs with)/{skip=1; next} /^## /{skip=0} !skip'; } \
      > /opt/skills/playwright-cli/SKILL.md; \
    rm /tmp/skill-head.md; \
    grep -q '^## Commands' /opt/skills/playwright-cli/SKILL.md; \
    ! grep -q '^## Installation' /opt/skills/playwright-cli/SKILL.md

# Browser writes land in the agent's SCRATCH PAD (/workspace/scratch — the
# dir the frozen coding prompt already names), never the repo and never the
# container layer. TWO mechanisms, both needed:
#   1. PLAYWRIGHT_MCP_OUTPUT_DIR (documented) — the default home of every
#      AUTO-NAMED output (snapshots, screenshots, traces), honored even when
#      the wrapper is bypassed (npx playwright cli, an absolute path).
#   2. The wrapper — an explicit relative --filename resolves against cwd
#      (documented; outputDir does not apply to it), so the wrapper pins cwd
#      to the scratch pad. AUTOMATIC, not agent-dependent: a relative
#      --filename cannot land in the repo no matter what the agent types.
# Repo files passed IN (upload, run-code --filename) therefore need absolute
# paths — the skill says so.
ENV PLAYWRIGHT_MCP_OUTPUT_DIR=/workspace/scratch
RUN printf '#!/bin/sh\nmkdir -p /workspace/scratch 2>/dev/null\ncd /workspace/scratch 2>/dev/null || cd "${TMPDIR:-/tmp}"\nexec /usr/bin/playwright-cli "$@"\n' \
      > /usr/local/bin/playwright-cli \
  && chmod 755 /usr/local/bin/playwright-cli
# The browser profile and every other XDG-respecting cache (uv, pip) go to
# the session volume too — the container's writable layer stays clean.
ENV XDG_CACHE_HOME=/workspace/.cache
# The excludes stay as the backstop for an overridden output dir.
RUN printf '.playwright-cli/\n' > /etc/gitexcludes \
  && git config --system core.excludesFile /etc/gitexcludes
# /workspace is normally the mounted session volume (agent-owned by uid);
# own the build-time copy too so a bare `docker run` behaves the same.
RUN mkdir -p /workspace/repo && chown -R ${UID}:${UID} /workspace
# The CLI's default browser is the chrome CHANNEL — real Google Chrome, not
# installed here — so a bare `playwright-cli open` would fail. Point the default
# at what is actually baked; the CLI reads this wherever --browser is omitted.
# (Ported from Shockwave, verified live there.)
ENV PLAYWRIGHT_MCP_BROWSER=chromium

# Pre-authentication for the agent, when the API turns it on: the helper reads
# GITHUB_TOKEN from the environment, so a container started with that variable
# has a working `git push` with NOTHING written to disk and nothing embedded in
# a remote URL (a URL-embedded token lands in .git/config and is echoed back by
# `git remote -v`). gh reads GH_TOKEN/GITHUB_TOKEN itself — no `gh auth login`.
# Scoped to github.com only, so an insteadOf redirect finds no helper. Started
# WITHOUT the variable, the helper answers empty and public repos still work.
RUN git config --system 'credential.https://github.com.helper' \
      '!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f'
# A missing credential must fail, never sit on a prompt no one can answer.
ENV GIT_TERMINAL_PROMPT=0

# User-space npm globals: `npm i -g` works without sudo. Set AFTER the root
# npm installs above, which belong in /usr/local.
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH=/home/agent/.npm-global/bin:$PATH
RUN mkdir -p /home/agent/.npm-global && chown -R ${UID}:${UID} /home/agent/.npm-global

# Fail the BUILD, not a turn, if anything isn't actually usable — run AS agent,
# the user every tool and bash call actually executes as.
USER agent
RUN rg --version && git --version && git lfs version && gh --version \
  && node --version && npm --version && corepack --version \
  && python3 --version && uv --version && uv python list --only-installed \
  && playwright --version && playwright-cli --version \
  && test -f /opt/skills/playwright-cli/SKILL.md \
  && test "$(git config --system core.excludesFile)" = /etc/gitexcludes \
  && psql --version && ssh -V && rsync --version \
  && cc --version && sudo -n true \
  && docker --version && docker buildx version && docker compose version \
  && test -x /usr/local/bin/start-docker && id -nG | tr ' ' '\n' | grep -qx docker
WORKDIR /workspace/repo
# No CMD — the runtime supplies `sleep infinity`; any image works here.
