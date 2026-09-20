# syntax=docker/dockerfile:1
FROM node:26.8.2-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:server \
    && npm ci --prefix dist/server --omit=dev --no-audit --no-fund
# Reuse the CLI's pinned release and checksum verification at image build time.
RUN node --input-type=module -e "import { installCloudflared } from './scripts/local-server-cloudflared.mjs'; import { copyFile } from 'node:fs/promises'; await copyFile(await installCloudflared(), '/tmp/cloudflared');"

FROM node:26.8.2-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/crate
COPY --from=build /build/dist/server ./
COPY --from=build --chmod=755 /tmp/cloudflared /usr/local/bin/cloudflared
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/crate-entrypoint
COPY --chmod=755 scripts/docker-cli.sh /usr/local/bin/crate
RUN mkdir /data && chown node:node /data
USER node
ENV CRATE_DOCKER=1
VOLUME ["/data"]
# The kernel releases this lease even after SIGKILL. It covers startup, shutdown,
# and administration across containers sharing this volume.
ENTRYPOINT ["flock", "--nonblock", "--no-fork", "--conflict-exit-code", "73", "/data/.server-lease", "/usr/local/bin/crate-entrypoint"]
CMD ["setup", "--port", "8787"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/.well-known/crate', {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
