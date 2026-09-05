# scripts/ — install, pairing, release, self-update

One flow, two questions. `curl … install-cli.sh | sh` installs the app;
`phantom-cli setup-backend` asks where the server goes and for one model
credential and has the box download and run the release's `install.sh`
over ssh (an existing server is paired on /server, in the app); one `v*`
tag cuts the images and the cli tarballs together, so script and cli are
one release. This map also covers `build/`, `host/`, `updater/`, `caddy/`,
`docker-compose.yml`, the root `Dockerfile` and the release workflow.

```
setup.sh           dev first boot: .env with fresh secrets (free-port scan), the workspace image under the
                   default tag, `compose up -d --build`, wait for /health, then seat url + key in
                   <repo>/.phantom-cli/settings.json (the source run's CONFIG_DIR) so the cli connects untouched
install.sh         the SERVER one-liner (Linux): docker via get.docker.com, ufw, pull the api image and copy
                   /host-files → /opt/phantom-looper, generate .env once, `up -d`, /health + `phantom-backend check`,
                   ONE symlink /usr/local/bin/phantom-backend. Re-running is update + recovery. setup-backend has the
                   box curl this file from the cli's release tag (--yes; script version = cli version)
install-cli.sh     the cli's curl|sh: detect platform, download the release tarball, verify against checksums.txt,
                   unpack to ~/.phantom-cli/app/<version>, point ~/.local/bin/phantom-cli at it. Zero questions.
build-cli.sh       the four tarballs (darwin-arm64 darwin-x64 linux-x64 linux-arm64): esbuild bundle + sidecar files +
                   install.sh + pinned Node 22.22.0 → dist-cli/phantom-cli-<os>-<arch>.tar.gz + checksums.txt
                   (version-less asset names — install-cli.sh and self-update read `latest`)
provision-rig.sh   build/boot/preload the privileged Ubuntu rig (`phantom-rig`, ssh 2222) with locally built api + fs
                   images in its inner dockerd; `down` tears it down
provision-e2e.ts   setup-backend's real path headless against the rig: runInstall over ssh, this checkout's install.sh inline (--tls=internal
                   --address=localhost --no-firewall) → readServerFacts → readServerCa → verifyFromHere; prints PASS
shims/react-devtools-core.js   the one esbuild stub (Ink hoists a DEV-only import)
```

```
build/workspace/Dockerfile    the session image (ghcr.io/…/phantom-backend-session): debian trixie-slim, git + git-lfs, ripgrep
                              (hard requirement), curl wget jq sqlite3 tree procps, build-essential + python3,
                              postgresql-client; user `agent` uid 1000, passwordless sudo. playwright-skill-head.md
                              is the first baked system skill (/opt/skills/)
build/testrig/                Dockerfile: ubuntu 24.04 + sshd + docker, entry.sh: RIG_AUTHORIZED_KEY (env-only key
                              injection, key-only root login), inner dockerd (iptables-legacy), then clears
                              containers/volumes/opt so the box boots BLANK (loaded images kept as cache)
host/phantom-backend          the server box's one command: status logs check version update key ca; ships in the api
                              image at /host-files/host/
updater/watch.sh              sidecar (docker:27-cli, raw socket): polls $TRIGGER_DIR/request every 3s, validates the tag,
                              spawns the detached helper `phantom-update-run` running apply.sh; no network listener
updater/apply.sh              one upgrade: pull $IMAGE:$TAG (tolerates a failed pull when present locally — local-only
                              images), docker create + cp /host-files/. into a staging dir INSIDE the install dir, `mv`
                              (never cp) each file into place, chmod 755 host/phantom-backend, pin PHANTOM_BACKEND_TAG in
                              .env, `compose up -d --remove-orphans`. No file list anywhere.
caddy/Caddyfile               profile https only: `default_sni {$PHANTOM_BACKEND_ADDRESS}`, `email "{$PHANTOM_BACKEND_CERT_EMAIL}"`
                              (quoted), (public) = ACME `profile shortlived` — bare IPs need it and it is applied to every
                              public cert on purpose — / (internal) = `tls internal`; /docs → 404; reverse_proxy api:8080
docker-compose.yml            project phantom-looper: postgres (16, pg-data) · api (127.0.0.1:${PHANTOM_BACKEND_PORT:-8080},
                              DOCKER_HOST=tcp://docker-proxy:2375, WORKSPACE_VOLUME, UPDATE_TRIGGER_DIR=/trigger,
                              PHANTOM_BACKEND_ADDRESS, autoheal label) · docker-proxy (tecnativa 0.3.0:
                              CONTAINERS/EXEC/IMAGES/POST/INFO on) · updater · autoheal · caddy (the ONLY profile, `https`;
                              ports 80/443). Volumes pg-data, phantom-looper-workspaces (fixed name), caddy-data,
                              caddy-config, updater-trigger
Dockerfile (root)             the api image: two-stage node:22-bookworm-slim, `npm run build` + prune; runtime git,
                              ca-certificates, openssl, ripgrep; dist + migrations; /workspaces + /trigger owned by node;
                              deploy files copied to /host-files/ (compose, Caddyfile, updater/, host/); ARG VERSION →
                              APP_VERSION; HEALTHCHECK hits /health with the bearer key
.github/workflows/release.yml on `v*`: `images` (phantom-backend-api / phantom-backend-session × amd64 / arm64, each on
                              a NATIVE runner — arm64 on ubuntu-24.04-arm, no QEMU — pushed by digest) · `manifests` (per image:
                              the two digests → one multi-arch :tag, and :latest unless the tag has a hyphen) · `cli` (npm ci →
                              build-cli.sh → DRAFT release with the four tarballs + checksums.txt) · `publish` (needs manifests +
                              cli; notes from git log; flips the draft public, --latest, or --prerelease for hyphenated tags).
                              NO test or typecheck gate in CI.
```

## Rules

- **Script version = cli version.** `install.sh` travels inside the cli
  tarball. `phantom-cli update` brings this machine and the server to the
  LATEST published release (each half alone with `--client` / `--server`),
  POSTing that tag to `/update` and waiting for `/health` to report it —
  same-tag is the pairing rule, kept visible by the quit notice rather than
  enforced. `APP_VERSION` is baked by
  esbuild (`PHANTOM_CLI_VERSION`), as is `NODE_ENV=production` so the
  tarball carries React's production build (`npm run phantom-cli` sets it
  too — the development build's render timings leak under node); `'dev'`
  from a checkout never nags and is never offered updates.
- **The release tag regex `^v[0-9]+\.[0-9]+\.[0-9]+$` lives in three
  places** (the /update route, watch.sh, apply.sh) and `test/deploy.test.ts`
  pins their agreement, plus: `/host-files` delivers every deploy file, no
  script holds a file list, exactly one symlink on PATH, executable bits.
- **Publish is atomic**: the release is a draft until every artifact
  exists — `install-cli.sh` and self-update read `latest` and must never see
  a half-published release. ghcr packages are private by default; make both
  public after the first tag push.
- **System ssh owns the terminal.** The install runs with stdio inherited,
  the script is downloaded BY THE BOX (never piped over ssh's stdin — that
  is the password's channel), one control master serves the run (one
  password), and nothing of ours reads the terminal meanwhile (node keeps
  consuming tty input once stdin has been read, even paused; the wizard's
  questions open /dev/tty per question). setup-backend never sees a
  password; host-key checking is never disabled (`accept-new` only via
  `PHANTOM_CLI_SSH_ACCEPT_NEW`, a rig hook, like `PHANTOM_CLI_SSH_IDENTITY`
  and `PHANTOM_CLI_INSTALL_FLAGS`). Secrets cross only the ssh channel
  (`readServerFacts` / `readServerCa`); the internal-mode CA lands at
  `~/.phantom-cli/ca/<host>.pem` and is trusted via an undici global
  dispatcher at launch; `/health` is verified FROM THE LAPTOP (the box
  cannot speak for the client's route) before the model key is pushed.
- **Env names are `PHANTOM_BACKEND_*`** in compose (`_PORT _IMAGE _FS_IMAGE
  _ADDRESS _TLS _CERT_EMAIL _DIR _TAG`); `install.sh` writes them into the
  server's `.env`. The root `.env.example` is the api process's own env for
  a source run, not compose's. `_ADDRESS` also reaches the api container as
  the Telegram webhook host. Compose `${VAR:?}` fires even on a profile
  that is off, so caddy uses `${PHANTOM_BACKEND_ADDRESS:-}`.
- `/health` needs its bearer token from every prober (install.sh, the
  dispatcher probes); a re-install must not let docker recreate a
  bind-mount source as a directory — both were rig findings.
