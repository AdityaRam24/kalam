# Kalam — a single image serving the built UI and the API from one port.
#
# The image deliberately carries kubectl and an SSH client: Kalam's whole job is
# to read clusters and hosts, and in-cluster it does that with the ServiceAccount
# token (kubectl) and with the keys mounted into it (ssh). A container runtime
# is NOT installed — Kalam treats Docker as one optional source among several,
# and in a cluster the interesting data comes from kubectl and SSH.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Fails the build on a type error or a broken test rather than shipping it.
RUN npm run build && npx vitest run

# Drop dev dependencies; tsx stays because the server runs TypeScript directly.
RUN npm prune --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# openssh-client: remote host discovery. kubectl: the in-cluster read path.
# tini: PID 1 that reaps children, which matters because Kalam spawns ssh.
ARG KUBECTL_VERSION=v1.31.4
RUN apk add --no-cache openssh-client ca-certificates tini curl \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in x86_64) KARCH=amd64 ;; aarch64) KARCH=arm64 ;; *) KARCH=amd64 ;; esac \
 && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/server       ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json /app/tsconfig.server.json ./

# Writable state (SSH inventory, learned KB, change history) lives on a volume;
# these are the only paths the app writes to.
RUN mkdir -p /app/server/history/data \
 && addgroup -g 10001 -S kalam \
 && adduser  -u 10001 -S kalam -G kalam \
 && chown -R kalam:kalam /app/server
USER 10001

EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "server/index.ts"]
