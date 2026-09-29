# Kalam — a single image serving the built UI and the API from one port.
#
# This is the Docker path. deploy/bundle/build-bundle.sh builds the same image
# WITHOUT Docker (crane on top of the same base) and packs it with the Helm
# chart and an installer into one .tgz — use that to ship to a cluster.
#
# The image carries kubectl: in-cluster, Kalam reads the cluster through the
# ServiceAccount token. SSH to hosts goes through the ssh2 library, so no ssh
# binary is needed. A container runtime is NOT installed — in a cluster the
# interesting data comes from kubectl and SSH.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Fails the build on a type error or a broken test rather than shipping it.
RUN npm run build && npx vitest run

# Runtime deps only (tsx is one: the server runs TypeScript directly), then cut
# to what the server imports — the frontend libraries are already in dist/.
RUN npm prune --omit=dev \
 && apk add --no-cache python3 \
 && python3 deploy/bundle/prune-deps.py /app

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# kubectl: the in-cluster read path. tini: PID 1 that reaps children.
ARG KUBECTL_VERSION=v1.33.13
RUN apk add --no-cache ca-certificates tini curl \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in x86_64) KARCH=amd64 ;; aarch64) KARCH=arm64 ;; *) KARCH=amd64 ;; esac \
 && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    HOME=/home/kalam \
    KALAM_VMS_PATH=/data/inventory/vms.json \
    KALAM_LEARNED_PATH=/data/inventory/learned.json \
    KALAM_KB_PATH=/data/pcai/kb.json \
    KALAM_HISTORY_DIR=/data/history \
    KALAM_METRICS_DIR=/data/metrics

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/server       ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json /app/tsconfig.server.json ./

# Writable state (SSH inventory, KB, change history, metrics) lives under
# /data, which the chart mounts a volume over.
RUN rm -rf /app/server/__tests__ \
 && addgroup -g 10001 -S kalam \
 && adduser  -u 10001 -S kalam -G kalam -h /home/kalam \
 && mkdir -p /data \
 && chown -R kalam:kalam /app/server /data /home/kalam
USER 10001

EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
