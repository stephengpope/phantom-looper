# The phantom-backend image — thin. The agent's toolchain lives in the WORKSPACE image
# (build/workspace), not here.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY core/ core/
COPY phantom-backend/ phantom-backend/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production APP_VERSION=$VERSION
# git + CA certs: all credential-bearing git runs in THIS container.
# ripgrep rides along for the grep tool. openssl named explicitly even
# though ca-certificates drags it in — relying on a transitive install turns a
# base-image change into "the server won't start".
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates openssl ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN git --version && openssl version
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY migrations/ migrations/
# The workspace volume mounts at /workspaces root-owned on first use unless the
# image owns the path — same mechanism Shockwave uses for /data/agent. /trigger
# is where POST /update drops a release tag for the updater sidecar (a shared
# volume); owned here for the same reason.
RUN mkdir -p /workspaces /trigger && chown -R node:node /workspaces /trigger /app

# The files that live on the HOST rather than in a container: the compose
# file, Caddy's config, the updater scripts and the `phantom-backend` command. They
# ride in the image so a release is ONE artifact — install.sh and
# updater/apply.sh copy this directory out of the tagged image instead of
# fetching a file list from GitHub. The layout mirrors the install directory
# exactly, so extraction is a straight copy. There is deliberately no list of
# these files anywhere on a server: a list frozen in whatever script a box last
# installed is what jammed Shockwave's boxes when a file was removed
# (test/deploy.test.ts pins this).
COPY docker-compose.yml /host-files/
COPY caddy/Caddyfile /host-files/caddy/

COPY updater/ /host-files/updater/
COPY host/ /host-files/host/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',{headers:{authorization:'Bearer '+process.env.API_KEY}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/phantom-backend/index.js"]
