# scripts/ — install, release, the rig

Also covers `build/`, `host/`, `updater/`, `caddy/`, `docker-compose.yml`,
the root `Dockerfile` and `.github/workflows/release.yml`. One `v*` tag
cuts the two images and the four cli tarballs together, so a cli and the
install script it carries are one release.

```
setup.sh            dev first boot: .env with fresh secrets, the session image built locally, compose up, wait for
                    /health, seat url + key in <repo>/.phantom-cli/settings.json
install.sh          the server one-liner (Linux): docker, ufw, pull the api image, copy /host-files → /opt/phantom-looper,
                    .env once, compose up, /health, one symlink /usr/local/bin/phantom-backend. Re-running is update + recovery
install-cli.sh      the cli one-liner: download the release tarball, verify against checksums.txt, unpack to
                    ~/.phantom-cli/app/<version>, point ~/.local/bin/phantom-cli at it. Zero questions
build-cli.sh        the four tarballs: esbuild bundle + sidecar files + install.sh + pinned Node → dist-cli/
provision-rig.sh    boot the privileged Ubuntu rig (`phantom-rig`, ssh 2222) with locally built images preloaded; `down`
provision-e2e.ts    setup-backend's real path against the rig, headless; prints PASS
models-snapshot.ts  the model catalog snapshot from models.dev; the image build runs it, `npm run models:snapshot` refreshes
                    the committed copy
shims/              the one esbuild stub (react-devtools-core)
```

```
build/workspace/Dockerfile   the session image: debian, git, ripgrep (required), build tools, user `agent`; /opt/skills
build/testrig/               ubuntu + sshd + inner dockerd; boots blank, keeps loaded images as cache
host/phantom-backend         the server box's one command: status logs check version update key ca. Add subcommands here
updater/watch.sh             polls $TRIGGER_DIR/request, validates the tag, spawns the detached helper running apply.sh
updater/apply.sh             pull the tag, copy /host-files out of the image, mv into place, pin the tag in .env, compose up
caddy/Caddyfile              the https profile: public (ACME, short-lived profile) or internal TLS; reverse_proxy api:8080
docker-compose.yml           postgres · api · docker-proxy · updater · autoheal · caddy (profile https)
Dockerfile                   the api image: build + a fresh models snapshot; deploy files at /host-files
release.yml                  v* tag → images per arch on native runners → multi-arch manifests → draft release with the
                             tarballs → publish
```

## How an install and an update move

The box downloads `install.sh` from the cli's release tag; it never rides
ssh's stdin, which is the password's channel. The host files come out of
the api image at `/host-files`; no script holds a file list, so a box can
never hold a stale list. `apply.sh` renames files into place rather than
copying, because it is one of the files. `POST /update` writes one trigger
file; the updater holds the docker socket and has no network surface.

The release tag regex `^v[0-9]+\.[0-9]+\.[0-9]+$` lives in the update
route, `watch.sh` and `apply.sh`. Publishing is atomic: the release is a
draft until every artifact exists, because `install-cli.sh` and self-update
read `latest`.

## Env names

Compose reads `PHANTOM_BACKEND_*` (`_PORT _IMAGE _FS_IMAGE _ADDRESS _TLS
_CERT_EMAIL _DIR _TAG`); `install.sh` writes them into the server's `.env`.
The root `.env.example` is the api process's own env for a source run.
`_ADDRESS` also reaches the api as the Telegram webhook host.

## Never run here

Let's Encrypt issuance, the release workflow, or the default session image
with docker installed. `install.sh` is verified on Linux through the rig.

