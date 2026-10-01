# Default workspace image — the agent's environment. Toolchain list ported from
# Shockwave's companion image: a bare base has tar and gzip and nothing else,
# and each absence is invisible until a turn needs it.
#
# ripgrep is a HARD requirement of the tool surface (grep/glob run `rg`).
# Custom container_image values must include it.
#
# Debian 13 (trixie): current stable. Debian FREEZES package versions at
# release, so anything whose ecosystem expects a current toolchain (Go, Rust,
# ffmpeg, Node, Python, Playwright) is installed from its own upstream release
# instead of apt — pinned here, moved only by editing a number. Nothing in this
# image tracks "latest".
#
# The uv pin lives at GLOBAL scope: buildkit cannot expand variables in
# COPY --from=<image>, so the pin feeds a named stage and the COPY names the
# stage (found broken live: the v0.1.29 session-image build failed on it).
ARG UV_VERSION=0.12.19
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-bin
FROM debian:trixie-slim
ARG UID=1000
# amd64 | arm64 — set by buildx per platform (release.yml builds both natively).
ARG TARGETARCH

# Base toolchain — everything the agent might need without burning a turn on
# `apt install`. build-essential/pkg-config/libssl-dev/libffi-dev cover native
# builds (node-gyp needs make+g++; pip sdists need a compiler) — the biggest
# "invisible until a turn needs it" gap the lean image had.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates openssl sudo \
      curl wget jq ripgrep sqlite3 file less bc tree procps \
      unzip zip xz-utils bzip2 \
      build-essential pkg-config libssl-dev libffi-dev cmake \
      python3 python3-pip python3-venv \
      openssh-client rsync patch \
      postgresql-client \
      # Networking: modern ip/ss, packet capture, socket swiss-army-knife, legacy ifconfig/netstat
      iproute2 tcpdump socat net-tools \
      dnsutils iputils-ping netcat-openbsd tzdata \
      # Debug & inspection
      strace ltrace lsof htop gdb valgrind \
      # Search & lint
      fd-find shellcheck man-db \
      # Media, docs & OCR (ffmpeg comes from upstream below — Debian's is 7.1)
      imagemagick poppler-utils ghostscript qpdf \
      tesseract-ocr tesseract-ocr-eng pandoc graphviz \
      # Languages (Node, Python, Go and Rust installed from upstream below)
      ruby php-cli lua5.4 \
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
# Caveat sudo does NOT lift: files under /project must stay uid ${UID} — the
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
# Pin the inner daemon's storage driver. overlayfs is what dockerd picks on its
# own on the /var/lib/docker volume, and it stores only what each layer changed.
# The pin is there for the other case: an agent starting dockerd by hand with
# `--storage-driver=vfs`, which stores a FULL copy of the filesystem per layer —
# one 27-step build filled a 77G disk (63G) in 16 minutes and took the host
# down. With the driver named here dockerd refuses the flag outright ("specified
# both as a flag and in the configuration file") instead of starting.
RUN mkdir -p /etc/docker \
  && echo '{ "storage-driver": "overlayfs" }' > /etc/docker/daemon.json
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

# Go from go.dev's official tarball into /usr/local/go — the standard layout
# (what the golang image does). Debian's golang package is frozen at 1.24,
# unsupported upstream, and any go.mod asking for newer makes Go silently
# download a ~200 MB toolchain mid-turn. GOTOOLCHAIN=local ends that: the
# pinned version is THE version; a module needing newer fails loudly instead.
# ~/go/bin on PATH so `go install <tool>` is callable by name.
ARG GO_VERSION=1.27.1
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
      | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:/home/agent/go/bin:$PATH
ENV GOTOOLCHAIN=local

# Rust via rustup, laid out like the official rust image (RUSTUP_HOME/CARGO_HOME
# under /usr/local, cargo bin on PATH). Debian's rustc is frozen at 1.85 — a
# year of releases behind, below the minimum many current crates require.
# minimal profile + rustfmt/clippy: the tools an agent actually runs, no docs.
# Agent-owned so `cargo install` and `rustup component add` need no sudo.
ARG RUST_VERSION=1.98.1
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
           --default-toolchain "${RUST_VERSION}" --component rustfmt --component clippy \
  && chown -R ${UID}:${UID} /usr/local/rustup /usr/local/cargo

# ffmpeg 9 as a static binary from BtbN/FFmpeg-Builds — the standard source for
# a current ffmpeg on Debian (whose package is 7.1 from 2024: no animated WebP,
# VVC still experimental, two years of fixes behind). Static = every codec
# built in, no library conflicts with the apt tree. Pinned to one autobuild
# release AND one asset name (the "latest" assets float within a branch).
# whisper (faster-whisper) and imagemagick call `ffmpeg` on PATH — they see it.
ARG FFMPEG_BUILD=autobuild-2026-09-26-13-03
ARG FFMPEG_ASSET=ffmpeg-n9.0.2-10-g51c4a23d74
RUN case "${TARGETARCH}" in amd64) a=linux64 ;; arm64) a=linuxarm64 ;; *) exit 1 ;; esac \
  && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/${FFMPEG_ASSET}-${a}-gpl-9.0.tar.xz" \
      | tar -C /usr/local/bin -xJ --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'

# Python versions via uv: prebuilt standalone CPython, no compiling, and the
# agent gets `uv venv -p 3.12`, `uv pip`, `uvx` for free. Installed to a fixed
# system path (agent-owned, so it can add versions later); system python3.13 +
# venv + pip above remain the boring fallback.
# Pinned like Playwright below: a floating uv tag would let the toolchain
# drift between builds. Bump with the other ARGs.
COPY --from=uv-bin /uv /uvx /usr/local/bin/
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
# Bump as a PAIR: check `npm view @playwright/cli@<v> dependencies` and pick
# the CLI whose playwright-core is the same minor as PLAYWRIGHT_VERSION — a
# different minor means a different chromium revision and two browsers baked.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG PLAYWRIGHT_CLI_VERSION=0.1.19
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
# /project is normally the mounted session volume (agent-owned by uid);
# own the build-time copy too so a bare `docker run` behaves the same.
RUN mkdir -p /workspace/repo && chown -R ${UID}:${UID} /project
# The CLI's default browser is the chrome CHANNEL — real Google Chrome, not
# installed here — so a bare `playwright-cli open` would fail. Point the default
# at what is actually baked; the CLI reads this wherever --browser is omitted.
# (Ported from Shockwave, verified live there.)
ENV PLAYWRIGHT_MCP_BROWSER=chromium

# Whisper (speech-to-text): whisper-ctranslate2 is a drop-in CLI replacement
# for OpenAI's whisper that runs on CTranslate2 — same flags, 4x faster on CPU,
# no PyTorch dependency. Aliased to `whisper` so the original command name works.
# Decodes audio through the `ffmpeg` binary on PATH (the upstream static build above).
RUN pip install --break-system-packages whisper-ctranslate2 \
  && ln -s "$(which whisper-ctranslate2)" /usr/local/bin/whisper

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
# No terminal, no editor: `git rebase --continue` after a resolved conflict
# (the agent's own step) otherwise errors "unable to start editor" and the
# rebase never finishes. `true` accepts git's prepared message as-is.
ENV GIT_EDITOR=true

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
  && cc --version && cmake --version && sudo -n true \
  && docker --version && docker buildx version && docker compose version \
  && whisper --help > /dev/null \
  # Languages
  && go version && test "$(go env GOTOOLCHAIN)" = local \
  && rustc --version && cargo --version && cargo fmt --version && cargo clippy --version \
  && ruby --version && php --version && lua5.4 -v \
  # Networking & debug
  && ip -V && tcpdump --version && socat -V > /dev/null \
  && strace -V && gdb --version > /dev/null && valgrind --version \
  # Media, docs & OCR
  && ffmpeg -version | head -1 | grep -q 'ffmpeg version n9' && ffprobe -version > /dev/null \
  && convert --version > /dev/null \
  && pdftotext -v 2>&1 | grep -q poppler && gs --version \
  && tesseract --version > /dev/null && pandoc --version > /dev/null \
  && dot -V 2>&1 \
  && test -x /usr/local/bin/start-docker && id -nG | tr ' ' '\n' | grep -qx docker \
  && grep -q '"storage-driver": "overlayfs"' /etc/docker/daemon.json
WORKDIR /workspace/repo
# No CMD — the runtime supplies `sleep infinity`; any image works here.
