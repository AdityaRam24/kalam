#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kalam installer — one command from this bundle to a running Kalam.
#
#   ./install.sh                       # everything auto-detected
#   ./install.sh --registry harbor.example.com/tools   # push to your registry
#
# What it does, in order:
#   1. finds kubectl/helm/crane (the bundle ships helm + crane; kubectl is
#      used from your PATH, or the bundled one on Linux)
#   2. gets the bundled image to the cluster:
#        --registry given ....... pushes it there (creates a pull secret if you
#                                 pass credentials)
#        kind/minikube/k3d/
#        docker-desktop ......... loads it straight into the local cluster
#        anything else .......... a per-node loopback image cache
#                                 (see image-cache.yaml) — no registry needed
#   3. works out how the UI should be reached:
#        PCAI (Istio ezaf-gateway) → https://kalam.<pcai-domain> behind SSO
#        --host NAME             → an Ingress for NAME
#        otherwise               → a NodePort on every node
#   4. turns on persistence if the cluster has a default StorageClass
#   5. helm upgrade --install, waits for the rollout, runs `helm test`
#   6. prints the URL, and writes a PCAI-importable chart with the image baked
#      in (out/kalam-<ver>-pcai-import.tgz) for the Import Framework UI.
#
# Re-running is safe: it is an upgrade with the same answers.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VERSION="__VERSION__"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash on Windows rewrites any argument that looks like a POSIX path
# ("/readyz", "HOME=/x") before a native .exe sees it. Turn that off and use
# native C:/... paths instead, which both bash and the .exe tools understand.
if command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  np() { cygpath -m "$1"; }
else
  np() { printf '%s' "$1"; }
fi
HERE="$(np "$HERE")"
CHART="$HERE/chart/kalam-$VERSION.tgz"
IMAGE_TAR="$HERE/images/kalam-$VERSION.tar"
OUT="$HERE/out"

NAMESPACE=kalam
RELEASE=kalam
CONTEXT=""
REGISTRY=""
REGISTRY_USER="${REGISTRY_USER:-}"
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-}"
INSECURE_REGISTRY=false
IMAGE_MODE=auto              # auto | registry | local | cache
CACHE_IMAGE="registry:2"
EXPOSE=auto                  # auto | pcai | ingress | nodeport | clusterip
DOMAIN=""
HOST=""
INGRESS_CLASS=""
TLS_SECRET=""
NODE_PORT=""
PERSISTENCE=auto             # auto | on | off
STORAGE_CLASS=""
ALLOW_WRITE=false
NO_SSO=false
SSH_KEY=""
KNOWN_HOSTS=""
LLM_URL=""
LLM_MODEL=""
GEMINI_KEY="${GEMINI_API_KEY:-}"
EXTRA_ARGS=()
DRY_RUN=false
PACKAGE_ONLY=false
SKIP_TEST=false

usage() {
  cat <<EOF
Kalam $VERSION installer

Usage: ./install.sh [options]

Where it goes
  -n, --namespace NS        namespace (default: kalam)
  -r, --release NAME        helm release name (default: kalam)
      --context CTX         kubeconfig context (default: current)

Image (default: auto)
      --registry REPO       push the image to REPO/kalam:$VERSION, e.g.
                            harbor.example.com/tools or 10.0.0.5:5000
      --registry-user U     credentials for --registry (or env REGISTRY_USER);
      --registry-password P also creates an imagePullSecret (env REGISTRY_PASSWORD)
      --insecure-registry   registry speaks plain HTTP / self-signed TLS
      --image-mode MODE     force: registry | local | cache
      --cache-image IMG     registry image for the node cache (default registry:2)

How it is reached (default: auto)
      --domain DOMAIN       PCAI domain; UI at https://kalam.DOMAIN
      --host NAME           plain Ingress for NAME (non-PCAI clusters)
      --ingress-class C     ingress class (default: the cluster default)
      --tls-secret S        TLS secret for --host
      --nodeport [PORT]     NodePort service (default port: auto)
      --clusterip           no external exposure (use port-forward)
      --no-sso              PCAI: do not put platform SSO in front (not advised)

What it can do
      --allow-write         allow restart/scale/delete from the UI (default: read-only)
      --ssh-key FILE        private key for reaching VMs over SSH
      --known-hosts FILE    known_hosts to go with it
      --llm-url URL         OpenAI-compatible endpoint, e.g. http://ollama.ai:11434/v1
      --llm-model NAME      model on that endpoint
      --gemini-key KEY      use Gemini instead (or env GEMINI_API_KEY)

State
      --persistence on|off  keep inventory/KB/history on a PVC (default: auto)
      --storage-class SC    StorageClass for the PVC

Other
  -f, --values FILE         extra helm values file (repeatable)
      --set K=V             extra helm --set (repeatable)
      --package-only        push the image and write the PCAI import chart; no install
      --dry-run             show what would be installed; change nothing
      --skip-test           do not run helm test
  -h, --help
EOF
}

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B='' G='' Y='' R='' D='' N=''; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '    %s✔%s %s\n' "$G" "$N" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ── args ─────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--namespace) NAMESPACE="$2"; shift 2 ;;
    -r|--release) RELEASE="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --registry) REGISTRY="${2%/}"; shift 2 ;;
    --registry-user) REGISTRY_USER="$2"; shift 2 ;;
    --registry-password) REGISTRY_PASSWORD="$2"; shift 2 ;;
    --insecure-registry) INSECURE_REGISTRY=true; shift ;;
    --image-mode) IMAGE_MODE="$2"; shift 2 ;;
    --cache-image) CACHE_IMAGE="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; EXPOSE=pcai; shift 2 ;;
    --host) HOST="$2"; EXPOSE=ingress; shift 2 ;;
    --ingress-class) INGRESS_CLASS="$2"; shift 2 ;;
    --tls-secret) TLS_SECRET="$2"; shift 2 ;;
    --nodeport) EXPOSE=nodeport
                if [ $# -gt 1 ] && [[ "$2" =~ ^[0-9]+$ ]]; then NODE_PORT="$2"; shift; fi; shift ;;
    --clusterip) EXPOSE=clusterip; shift ;;
    --no-sso) NO_SSO=true; shift ;;
    --allow-write) ALLOW_WRITE=true; shift ;;
    --ssh-key) SSH_KEY="$(np "$2")"; shift 2 ;;
    --known-hosts) KNOWN_HOSTS="$(np "$2")"; shift 2 ;;
    --llm-url) LLM_URL="$2"; shift 2 ;;
    --llm-model) LLM_MODEL="$2"; shift 2 ;;
    --gemini-key) GEMINI_KEY="$2"; shift 2 ;;
    --persistence) PERSISTENCE="$2"; shift 2 ;;
    --storage-class) STORAGE_CLASS="$2"; shift 2 ;;
    -f|--values) EXTRA_ARGS+=(-f "$(np "$2")"); shift 2 ;;
    --set) EXTRA_ARGS+=(--set "$2"); shift 2 ;;
    --package-only) PACKAGE_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-test) SKIP_TEST=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done
[ -n "$REGISTRY" ] && [ "$IMAGE_MODE" = auto ] && IMAGE_MODE=registry
[ "$IMAGE_MODE" = registry ] && [ -z "$REGISTRY" ] && die "--image-mode registry needs --registry REPO"
[ -f "$CHART" ] || die "chart not found at $CHART — run this from the unpacked bundle"
[ -f "$IMAGE_TAR" ] || die "image not found at $IMAGE_TAR — run this from the unpacked bundle"

# ── tools ────────────────────────────────────────────────────────────────────
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)             PLAT=linux-amd64 ;;
  Darwin-arm64)             PLAT=darwin-arm64 ;;
  MINGW*|MSYS*|CYGWIN*)     PLAT=windows-amd64 ;;
  *)                        PLAT="" ;;
esac
BIN="$HERE/bin/$PLAT"
EXE=""; [ "$PLAT" = windows-amd64 ] && EXE=.exe
tool() {  # prefer the bundled copy so versions are known-good; else PATH
  if [ -n "$PLAT" ] && [ -x "$BIN/$1$EXE" ]; then echo "$BIN/$1$EXE"
  elif command -v "$1" >/dev/null 2>&1; then command -v "$1"
  else echo ""; fi
}
HELM="$(tool helm)"; CRANE="$(tool crane)"
KUBECTL="$(command -v kubectl 2>/dev/null || true)"; [ -z "$KUBECTL" ] && KUBECTL="$(tool kubectl)"
[ -n "$KUBECTL" ] || die "kubectl not found. Install it, or run from Linux x86_64 where the bundle ships one."
[ -n "$HELM" ] || die "helm not found for $(uname -s)-$(uname -m). Install helm 3."
[ -n "$CRANE" ] || die "crane not found for $(uname -s)-$(uname -m)."
KC=("$KUBECTL"); HC=("$HELM")
if [ -n "$CONTEXT" ]; then KC+=(--context "$CONTEXT"); HC+=(--kube-context "$CONTEXT"); fi
kc() { "${KC[@]}" "$@"; }
hc() { "${HC[@]}" "$@"; }

WORK="$(np "$(mktemp -d)")"
PF_PID=""
cleanup() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# ── 0. cluster ───────────────────────────────────────────────────────────────
step "Cluster"
CTX="${CONTEXT:-$(kc config current-context 2>/dev/null || true)}"
[ -n "$CTX" ] || die "no kubeconfig context. Point KUBECONFIG at your cluster (PCAI: download it from the UI)."
kc get --raw /readyz >/dev/null 2>&1 || kc get ns >/dev/null 2>&1 \
  || die "cannot reach the cluster of context '$CTX'. Check: $KUBECTL cluster-info"
SERVER="$(kc config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
ok "context $CTX ($SERVER)"
ok "release '$RELEASE' in namespace '$NAMESPACE'"
kc auth can-i create clusterrolebinding >/dev/null 2>&1 \
  || warn "you may lack rights to create a ClusterRole; if the install fails, add --set rbac.clusterWide=false"

has_api() { kc api-resources --api-group="$1" -o name 2>/dev/null | grep -q "^$2\."; }

# ── 1. image ─────────────────────────────────────────────────────────────────
step "Image"
IMG_REPO=""; IMG_DIGEST=""; PULL_SECRET=""
if [ "$IMAGE_MODE" = auto ]; then
  case "$CTX" in
    kind-*)          command -v kind >/dev/null && IMAGE_MODE=local ;;
    minikube*)       command -v minikube >/dev/null && IMAGE_MODE=local ;;
    k3d-*)           command -v k3d >/dev/null && IMAGE_MODE=local ;;
    docker-desktop|rancher-desktop) command -v docker >/dev/null && docker info >/dev/null 2>&1 && IMAGE_MODE=local ;;
  esac
  [ "$IMAGE_MODE" = auto ] && IMAGE_MODE=cache
fi

push_to() {  # $1 = full target ref; prints digest
  local flags=(--platform linux/amd64)
  $INSECURE_REGISTRY && flags+=(--insecure)
  "$CRANE" push "${flags[@]}" "$IMAGE_TAR" "$1" 2>"$WORK/push.err" | tail -n1 | sed 's/.*@//' \
    || { cat "$WORK/push.err" >&2; return 1; }
}

case "$IMAGE_MODE" in
  registry)
    info "pushing to $REGISTRY/kalam:$VERSION"
    REG_HOST="${REGISTRY%%/*}"
    if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_PASSWORD" ] && ! $DRY_RUN; then
      printf '%s' "$REGISTRY_PASSWORD" | "$CRANE" auth login "$REG_HOST" -u "$REGISTRY_USER" --password-stdin >/dev/null \
        || die "registry login to $REG_HOST failed"
      ok "logged in to $REG_HOST as $REGISTRY_USER"
    fi
    if ! $DRY_RUN; then
      IMG_DIGEST="$(push_to "$REGISTRY/kalam:$VERSION")" || die "push to $REGISTRY failed (see above). Wrong path, credentials, or add --insecure-registry for HTTP."
      ok "pushed $REGISTRY/kalam:$VERSION@$IMG_DIGEST"
    fi
    IMG_REPO="$REGISTRY/kalam"
    if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_PASSWORD" ]; then PULL_SECRET="kalam-registry"; fi
    ;;
  local)
    $DRY_RUN || case "$CTX" in
      kind-*)    kind load image-archive "$IMAGE_TAR" --name "${CTX#kind-}" ;;
      minikube*) minikube image load "$IMAGE_TAR" ;;
      k3d-*)     k3d image import "$IMAGE_TAR" -c "${CTX#k3d-}" ;;
      *)         docker load -i "$IMAGE_TAR" >/dev/null ;;
    esac
    IMG_REPO="kalam"
    ok "loaded kalam:$VERSION into the local cluster ($CTX)"
    ;;
  cache)
    info "no registry given — using a per-node loopback image cache (127.0.0.1:5959)"
    info "(to use your own registry instead: ./install.sh --registry REPO)"
    IMG_REPO="127.0.0.1:5959/kalam"
    if ! $DRY_RUN; then
      sed "s#__CACHE_IMAGE__#$CACHE_IMAGE#" "$HERE/manifests/image-cache.yaml" | kc apply -f - >/dev/null
      if ! kc -n kalam-image-cache rollout status ds/kalam-image-cache --timeout=180s >/dev/null 2>&1; then
        kc -n kalam-image-cache get pods -o wide >&2 || true
        die "the image cache did not start on every node (above). If the cluster cannot pull '$CACHE_IMAGE', pass --cache-image <mirror>/registry:2, or use --registry."
      fi
      PODS="$(kc -n kalam-image-cache get pods -l app.kubernetes.io/name=kalam-image-cache -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}')"
      port=15959
      while IFS='=' read -r pod node; do
        [ -n "$pod" ] || continue
        port=$((port + 1))
        kc -n kalam-image-cache port-forward "pod/$pod" "$port:5959" >"$WORK/pf-$pod.log" 2>&1 &
        PF_PID=$!
        for _ in $(seq 1 30); do grep -q Forwarding "$WORK/pf-$pod.log" 2>/dev/null && break; sleep 0.5; done
        INSECURE_REGISTRY=true
        d="$(push_to "127.0.0.1:$port/kalam:$VERSION")" || die "could not push into the cache on node $node (see above)"
        IMG_DIGEST="$d"
        kill "$PF_PID" 2>/dev/null || true; PF_PID=""
        ok "node $node"
      done <<<"$PODS"
    fi
    ;;
  *) die "unknown --image-mode $IMAGE_MODE" ;;
esac

# ── 2. exposure ──────────────────────────────────────────────────────────────
step "Access"
PCAI_GATEWAY=false
if has_api networking.istio.io gateways && kc -n istio-system get gateways.networking.istio.io ezaf-gateway >/dev/null 2>&1; then
  PCAI_GATEWAY=true
fi
if [ "$EXPOSE" = auto ]; then
  if $PCAI_GATEWAY; then EXPOSE=pcai; else EXPOSE=nodeport; fi
fi
if [ "$EXPOSE" = pcai ] && [ -z "$DOMAIN" ]; then
  # The domain every PCAI app is published under: from the gateway's hosts, or
  # else the most common suffix among existing VirtualService hosts.
  DOMAIN="$(kc -n istio-system get gateways.networking.istio.io ezaf-gateway -o jsonpath='{.spec.servers[*].hosts[*]}' 2>/dev/null \
            | tr ' ' '\n' | sed -n 's#^\([^/]*/\)\{0,1\}\*\.\(.*\)$#\2#p' | head -n1)"
  if [ -z "$DOMAIN" ]; then
    DOMAIN="$(kc get virtualservices.networking.istio.io -A -o jsonpath='{range .items[*]}{.spec.hosts[*]}{"\n"}{end}' 2>/dev/null \
              | tr ' ' '\n' | grep '\.' | grep -v '\*' | grep -v 'svc.cluster.local' | cut -d. -f2- | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
  fi
  [ -n "$DOMAIN" ] || die "this looks like PCAI but the domain could not be detected. Pass --domain <your-pcai-domain>."
fi

if [ "$EXPOSE" = ingress ] && [ -z "$INGRESS_CLASS" ]; then
  INGRESS_CLASS="$(kc get ingressclass -o jsonpath='{range .items[?(@.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -n1)"
  [ -z "$INGRESS_CLASS" ] && INGRESS_CLASS="$(kc get ingressclass -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
fi

NODE_IPS=""
if [ "$EXPOSE" = nodeport ]; then
  NODE_IPS="$( { kc get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'; echo
                 kc get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="ExternalIP")].address}'; } 2>/dev/null \
               | tr ' ' '\n' | grep . | sort -u | paste -sd, -)"
fi

case "$EXPOSE" in
  pcai)      ok "PCAI gateway: https://kalam.$DOMAIN$($NO_SSO && echo ' (NO SSO)' || echo ', behind platform SSO')" ;;
  ingress)   ok "Ingress: http$([ -n "$TLS_SECRET" ] && echo s)://$HOST (class: ${INGRESS_CLASS:-cluster default})" ;;
  nodeport)  ok "NodePort on every node (${NODE_IPS:-no node IPs found})" ;;
  clusterip) ok "ClusterIP only — reach it with kubectl port-forward" ;;
esac

# ── 3. persistence ───────────────────────────────────────────────────────────
if [ "$PERSISTENCE" = auto ]; then
  DEFAULT_SC="$(kc get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -n1)"
  if [ -n "$STORAGE_CLASS" ] || [ -n "$DEFAULT_SC" ]; then PERSISTENCE=on; else PERSISTENCE=off; fi
fi
if [ "$PERSISTENCE" = on ]; then ok "state on a 2Gi PVC (${STORAGE_CLASS:-${DEFAULT_SC:-default StorageClass}})"
else warn "no default StorageClass: state (VM inventory, KB, history) resets on pod restart. Use --storage-class SC to keep it."; fi

# ── 4. values ────────────────────────────────────────────────────────────────
VALUES="$WORK/values.yaml"
{
  echo "image:"
  echo "  repository: \"$IMG_REPO\""
  echo "  tag: \"$VERSION\""
  [ -n "$IMG_DIGEST" ] && echo "  digest: \"$IMG_DIGEST\""
  echo "  pullPolicy: IfNotPresent"
  [ -n "$PULL_SECRET" ] && printf 'imagePullSecrets:\n  - name: %s\n' "$PULL_SECRET"
  echo "rbac:"
  echo "  allowWrite: $ALLOW_WRITE"
  echo "ezua:"
  if [ "$EXPOSE" = pcai ]; then
    echo "  enabled: true"
    echo "  domainName: \"$DOMAIN\""
    echo "  virtualService:"
    echo "    endpoint: \"kalam.$DOMAIN\""
    echo "  authorizationPolicy:"
    echo "    enabled: $($NO_SSO && echo false || echo true)"
  else
    echo "  enabled: false"
  fi
  if [ "$EXPOSE" = ingress ]; then
    echo "ingress:"
    echo "  enabled: true"
    echo "  host: \"$HOST\""
    [ -n "$INGRESS_CLASS" ] && echo "  className: \"$INGRESS_CLASS\""
    if [ -n "$TLS_SECRET" ]; then printf '  tls:\n    enabled: true\n    secretName: "%s"\n' "$TLS_SECRET"; fi
  fi
  echo "service:"
  if [ "$EXPOSE" = nodeport ]; then
    echo "  type: NodePort"
    [ -n "$NODE_PORT" ] && echo "  nodePort: $NODE_PORT"
  else
    echo "  type: ClusterIP"
  fi
  if [ "$EXPOSE" = nodeport ] && [ -n "$NODE_IPS" ]; then
    # The API checks the browser's Origin; node IPs have to be on the list.
    printf 'config:\n  allowedHosts: "%s"\n' "$NODE_IPS"
  fi
  echo "persistence:"
  echo "  enabled: $([ "$PERSISTENCE" = on ] && echo true || echo false)"
  [ -n "$STORAGE_CLASS" ] && echo "  storageClass: \"$STORAGE_CLASS\""
  if [ -n "$LLM_URL" ] || [ -n "$LLM_MODEL" ] || [ -n "$GEMINI_KEY" ]; then
    echo "llm:"
    if [ -n "$GEMINI_KEY" ] && [ -z "$LLM_URL" ]; then
      echo "  provider: gemini"
      echo "  existingSecret: kalam-llm"
    else
      echo "  provider: local"
    fi
    [ -n "$LLM_URL" ] && echo "  localUrl: \"$LLM_URL\""
    [ -n "$LLM_MODEL" ] && echo "  localModel: \"$LLM_MODEL\""
    [ -n "$GEMINI_KEY" ] && [ -n "$LLM_URL" ] && echo "  existingSecret: kalam-llm"
  fi
  if [ -n "$SSH_KEY" ]; then
    printf 'ssh:\n  secretName: kalam-ssh\n  keyFile: id_rsa\n'
    [ -n "$KNOWN_HOSTS" ] && echo "  knownHosts: known_hosts"
  fi
} >"$VALUES"

mkdir -p "$OUT"
cp "$VALUES" "$OUT/values-$RELEASE.yaml"

# ── 5. PCAI Import Framework chart (image baked in) ──────────────────────────
# The PCAI UI imports a chart .tgz and substitutes ${DOMAIN_NAME} itself, so
# this copy keeps the placeholder and only fixes where the image comes from.
step "PCAI import chart"
mkdir -p "$WORK/pkg"
tar -xzf - -C "$WORK/pkg" <"$CHART"   # stdin: GNU tar reads "C:/x" as host:path
awk -v repo="$IMG_REPO" -v dig="$IMG_DIGEST" -v ps="$PULL_SECRET" '
  /^image:/ { inimg=1 }
  /^[a-zA-Z]/ && !/^image:/ { inimg=0 }
  inimg && /^  repository:/ { print "  repository: " repo "   # set by install.sh"; next }
  inimg && /^  digest:/ { print "  digest: \"" dig "\""; next }
  ps != "" && /^imagePullSecrets: \[\]/ { print "imagePullSecrets:"; print "  - name: " ps; next }
  { print }' "$WORK/pkg/kalam/values.yaml" >"$WORK/pkg/values.new"
mv "$WORK/pkg/values.new" "$WORK/pkg/kalam/values.yaml"
hc package "$WORK/pkg/kalam" -d "$WORK" >/dev/null
mv "$WORK/kalam-$VERSION.tgz" "$OUT/kalam-$VERSION-pcai-import.tgz"
ok "$OUT/kalam-$VERSION-pcai-import.tgz"
if [ "$IMAGE_MODE" = cache ]; then
  info "(it pulls from the node cache this run filled; for a cluster this script has not"
  info " run against, re-run with --registry so the image is somewhere every node can reach)"
fi

if $PACKAGE_ONLY; then
  step "Done (--package-only)"
  info "PCAI → Tools & Frameworks → Import Framework → upload $OUT/kalam-$VERSION-pcai-import.tgz"
  [ -n "$PULL_SECRET" ] && info "create the pull secret '$PULL_SECRET' in the target namespace first (see README)"
  exit 0
fi

# ── 6. install ───────────────────────────────────────────────────────────────
step "Install"
info "values: $OUT/values-$RELEASE.yaml"
if $DRY_RUN; then
  hc upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} --dry-run=server 2>/dev/null \
    || hc template "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
  exit 0
fi

kc get ns "$NAMESPACE" >/dev/null 2>&1 || { kc create ns "$NAMESPACE" >/dev/null; ok "created namespace $NAMESPACE"; }

apply_secret() { kc -n "$NAMESPACE" create secret "$@" --dry-run=client -o yaml | kc apply -f - >/dev/null; }
if [ -n "$PULL_SECRET" ]; then
  apply_secret docker-registry "$PULL_SECRET" --docker-server="${REGISTRY%%/*}" \
    --docker-username="$REGISTRY_USER" --docker-password="$REGISTRY_PASSWORD"
  ok "pull secret $PULL_SECRET"
fi
if [ -n "$SSH_KEY" ]; then
  [ -f "$SSH_KEY" ] || die "--ssh-key $SSH_KEY: no such file"
  args=(--from-file=id_rsa="$SSH_KEY")
  if [ -n "$KNOWN_HOSTS" ]; then
    [ -f "$KNOWN_HOSTS" ] || die "--known-hosts $KNOWN_HOSTS: no such file"
    args+=(--from-file=known_hosts="$KNOWN_HOSTS")
  fi
  apply_secret generic kalam-ssh "${args[@]}"
  ok "ssh key secret kalam-ssh"
fi
if [ -n "$GEMINI_KEY" ]; then
  apply_secret generic kalam-llm --from-literal=GEMINI_API_KEY="$GEMINI_KEY"
  ok "gemini key secret kalam-llm"
fi

if ! hc upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} --wait --timeout 6m >"$WORK/helm.log" 2>&1; then
  cat "$WORK/helm.log" >&2
  echo >&2
  kc -n "$NAMESPACE" get pods -l app.kubernetes.io/instance="$RELEASE" -o wide >&2 || true
  REASON="$(kc -n "$NAMESPACE" get pods -l app.kubernetes.io/instance="$RELEASE" -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)"
  case "$REASON" in
    *ImagePull*|*ErrImage*)
      [ "$IMAGE_MODE" = cache ] && die "the nodes could not pull from the loopback cache (their runtime refuses plain-HTTP localhost registries). Re-run with --registry <your-registry>."
      die "the nodes could not pull $IMG_REPO:$VERSION. Check the registry is reachable from the nodes and, if private, pass --registry-user/--registry-password." ;;
    *) kc -n "$NAMESPACE" describe pods -l app.kubernetes.io/instance="$RELEASE" 2>/dev/null | tail -n 25 >&2 || true
       die "install did not become ready (details above)." ;;
  esac
fi
ok "helm release $RELEASE deployed"

if ! $SKIP_TEST; then
  if hc test "$RELEASE" -n "$NAMESPACE" --timeout 3m >"$WORK/test.log" 2>&1; then
    ok "helm test passed (service → /healthz, /api/llm/defaults, UI)"
  else
    warn "helm test failed:"; sed 's/^/      /' "$WORK/test.log" >&2
  fi
fi

# ── 7. where ─────────────────────────────────────────────────────────────────
step "Kalam is running"
FULL="$(kc -n "$NAMESPACE" get svc -l app.kubernetes.io/instance="$RELEASE" -o jsonpath='{.items[0].metadata.name}')"
case "$EXPOSE" in
  pcai)    info "${B}https://kalam.$DOMAIN${N}" ;;
  ingress) info "${B}http$([ -n "$TLS_SECRET" ] && echo s)://$HOST${N}   (DNS for $HOST must point at your ingress)" ;;
  nodeport)
    NP="$(kc -n "$NAMESPACE" get svc "$FULL" -o jsonpath='{.spec.ports[0].nodePort}')"
    for ip in ${NODE_IPS//,/ }; do info "${B}http://$ip:$NP${N}"; done ;;
esac
info "${D}always works:${N} $KUBECTL -n $NAMESPACE port-forward svc/$FULL 8080:80  →  http://localhost:8080"
info "${D}values used:${N}  $OUT/values-$RELEASE.yaml   ${D}uninstall:${N} ./uninstall.sh -n $NAMESPACE -r $RELEASE"
