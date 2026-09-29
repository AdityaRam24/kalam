#!/usr/bin/env bash
# Build the self-contained Kalam bundle: image + chart + tools + installer in
# one .tgz. Needs node/npm, python3, curl and tar — NOT Docker: the image is
# assembled with crane on top of a pinned node:22-alpine.
#
#   deploy/bundle/build-bundle.sh            → deploy/bundle/dist/kalam-<ver>-bundle.tgz
#
# Env overrides: BASE_IMAGE, KUBECTL_VERSION, HELM_VERSION, CRANE_VERSION, SKIP_TESTS=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/deploy/bundle"
CACHE="$HERE/.cache"
DIST="$HERE/dist"
CHART_DIR="$ROOT/deploy/helm/kalam"
VERSION="$(sed -n 's/^appVersion: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$CHART_DIR/Chart.yaml")"

BASE_IMAGE="${BASE_IMAGE:-node:22-alpine@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.33.13}"
HELM_VERSION="${HELM_VERSION:-v3.22.0}"
CRANE_VERSION="${CRANE_VERSION:-v0.22.1}"
TINI_VERSION=v0.19.0

# First interpreter that actually runs (Windows' python3 is often a Store stub).
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; assert sys.version_info >= (3, 8)' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "python 3.8+ is required" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

# ── tools (cached) ───────────────────────────────────────────────────────────
say "Tools"
mkdir -p "$CACHE"
fetch() { [ -s "$CACHE/$2" ] || curl -fsSL "$1" -o "$CACHE/$2"; }
fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl" kubectl-linux-amd64
fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl.sha256" kubectl-linux-amd64.sha256
fetch "https://github.com/krallin/tini/releases/download/$TINI_VERSION/tini-static-amd64" tini-static-amd64
fetch "https://github.com/krallin/tini/releases/download/$TINI_VERSION/tini-static-amd64.sha256sum" tini-static-amd64.sha256sum
(cd "$CACHE" && echo "$(cat kubectl-linux-amd64.sha256)  kubectl-linux-amd64" | sha256sum -c --quiet && sha256sum -c --quiet tini-static-amd64.sha256sum)
for p in Linux_x86_64 Darwin_arm64 Windows_x86_64; do
  fetch "https://github.com/google/go-containerregistry/releases/download/$CRANE_VERSION/go-containerregistry_$p.tar.gz" "crane-$p.tar.gz"
done
for p in linux-amd64 darwin-arm64; do fetch "https://get.helm.sh/helm-$HELM_VERSION-$p.tar.gz" "helm-$p.tar.gz"; done
fetch "https://get.helm.sh/helm-$HELM_VERSION-windows-amd64.zip" helm-windows-amd64.zip

TOOLS="$CACHE/tools"
rm -rf "$TOOLS"; mkdir -p "$TOOLS"/{linux-amd64,darwin-arm64,windows-amd64}
tar -xzf "$CACHE/crane-Linux_x86_64.tar.gz" -C "$TOOLS/linux-amd64" crane
tar -xzf "$CACHE/crane-Darwin_arm64.tar.gz" -C "$TOOLS/darwin-arm64" crane
tar -xzf "$CACHE/crane-Windows_x86_64.tar.gz" -C "$TOOLS/windows-amd64" crane.exe
tar -xzf "$CACHE/helm-linux-amd64.tar.gz" -C "$TOOLS/linux-amd64" --strip-components=1 linux-amd64/helm
tar -xzf "$CACHE/helm-darwin-arm64.tar.gz" -C "$TOOLS/darwin-arm64" --strip-components=1 darwin-arm64/helm
unzip -qjo "$CACHE/helm-windows-amd64.zip" windows-amd64/helm.exe -d "$TOOLS/windows-amd64"
cp "$CACHE/kubectl-linux-amd64" "$TOOLS/linux-amd64/kubectl"
chmod +x "$TOOLS"/*/*

case "$(uname -s)" in
  Linux)  HOSTBIN="$TOOLS/linux-amd64"; EXE="" ;;
  Darwin) HOSTBIN="$TOOLS/darwin-arm64"; EXE="" ;;
  *)      HOSTBIN="$TOOLS/windows-amd64"; EXE=".exe" ;;
esac
CRANE="$HOSTBIN/crane$EXE"; HELM="$HOSTBIN/helm$EXE"

# ── app ──────────────────────────────────────────────────────────────────────
say "Build + test the app"
cd "$ROOT"
[ -d node_modules ] || npm ci
npm run build
[ "${SKIP_TESTS:-}" = 1 ] || npx vitest run

say "Stage /app"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP="$WORK/app"; mkdir -p "$APP"
# Tracked files only: a developer's vms.json / kb.json never ship.
git ls-files server | grep -v '__tests__' | tar -cf - -T - | tar -xf - -C "$APP"
cp -r dist "$APP/dist"
cp package.json package-lock.json tsconfig.json tsconfig.server.json "$APP/"
(cd "$APP" && npm ci --omit=dev --ignore-scripts --os=linux --cpu=x64 --libc=musl --no-audit --no-fund)
"$PY" "$HERE/prune-deps.py" "$APP"

# ── image ────────────────────────────────────────────────────────────────────
say "Image kalam:$VERSION on $BASE_IMAGE"
mkdir -p "$WORK/etc"
"$CRANE" export --platform linux/amd64 "$BASE_IMAGE" - | tar -xf - -C "$WORK" etc/passwd etc/group
"$PY" "$HERE/make-layer.py" "$APP" "$CACHE/kubectl-linux-amd64" "$CACHE/tini-static-amd64" "$WORK/etc" "$WORK/layer.tar"

B="$WORK/bundle/kalam-$VERSION"
mkdir -p "$B"/{images,chart,manifests,bin}
# Git Bash rewrites any argument that looks like a POSIX path ("/app",
# "HOME=/home/kalam") into a Windows one before crane.exe sees it — which
# silently bakes C:/Program Files/Git/... into the image. So crane gets its
# arguments verbatim, and the two real file paths are made native by hand.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
"$CRANE" mutate "$BASE_IMAGE" --platform linux/amd64 --append "$(native "$WORK/layer.tar")" \
  --entrypoint /sbin/tini,-- --cmd node,--import,tsx,server/index.ts \
  -w /app -u 10001:10001 --exposed-ports 3001/tcp \
  -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=3001 -e HOME=/home/kalam \
  -e KALAM_VMS_PATH=/data/inventory/vms.json -e KALAM_LEARNED_PATH=/data/inventory/learned.json \
  -e KALAM_KB_PATH=/data/pcai/kb.json -e KALAM_HISTORY_DIR=/data/history -e KALAM_METRICS_DIR=/data/metrics \
  -l org.opencontainers.image.title=kalam -l "org.opencontainers.image.version=$VERSION" \
  -l "org.opencontainers.image.revision=$(git rev-parse --short HEAD)" \
  -l "org.opencontainers.image.base.name=$BASE_IMAGE" \
  -t "kalam:$VERSION" -o "$(native "$B/images/kalam-$VERSION.tar")" >/dev/null

# Refuse to ship an image whose config is not exactly what the chart expects.
"$PY" - "$B/images/kalam-$VERSION.tar" <<'EOF'
import json, sys, tarfile
t = tarfile.open(sys.argv[1])
c = json.load(t.extractfile(json.load(t.extractfile('manifest.json'))[0]['Config']))['config']
env = dict(e.split('=', 1) for e in c['Env'])
want = {
    'Entrypoint': ['/sbin/tini', '--'], 'Cmd': ['node', '--import', 'tsx', 'server/index.ts'],
    'WorkingDir': '/app', 'User': '10001:10001',
}
bad = [f'{k}={c.get(k)!r}' for k, v in want.items() if c.get(k) != v]
bad += [f'{k}={env.get(k)!r}' for k in ('HOME', 'KALAM_VMS_PATH', 'KALAM_KB_PATH', 'KALAM_HISTORY_DIR', 'KALAM_METRICS_DIR')
        if not env.get(k, '').startswith(('/home/', '/data/'))]
if bad:
    sys.exit('image config is wrong: ' + ', '.join(bad))
print('image config verified')
EOF

# ── chart ────────────────────────────────────────────────────────────────────
say "Chart"
"$HELM" lint "$CHART_DIR" --strict
"$HELM" package "$CHART_DIR" -d "$B/chart" >/dev/null

# ── assemble ─────────────────────────────────────────────────────────────────
say "Bundle"
sed "s/__VERSION__/$VERSION/" "$HERE/install.sh" >"$B/install.sh"
cp "$HERE/uninstall.sh" "$B/uninstall.sh"
cp "$HERE/image-cache.yaml" "$B/manifests/image-cache.yaml"
sed "s/__VERSION__/$VERSION/g" "$HERE/BUNDLE-README.md" >"$B/README.md"
cp -r "$TOOLS"/. "$B/bin/"
chmod +x "$B/install.sh" "$B/uninstall.sh" "$B"/bin/*/*
(cd "$B" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum >SHA256SUMS)

mkdir -p "$DIST"
OUTFILE="$DIST/kalam-$VERSION-bundle.tgz"
# Packed with explicit modes: a Windows build machine has no exec bits to
# carry, and the scripts and bin/ tools must arrive executable.
"$PY" - "$WORK/bundle" "kalam-$VERSION" "$OUTFILE" <<'EOF'
import os, sys, tarfile
base, top, out = sys.argv[1:4]
def fix(ti):
    ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
    name = ti.name.split('/', 1)[1] if '/' in ti.name else ''
    exe = ti.isdir() or name in ('install.sh', 'uninstall.sh') or name.startswith('bin/')
    ti.mode = 0o755 if exe else 0o644
    return ti
with tarfile.open(out, 'w:gz', compresslevel=6) as t:
    t.add(os.path.join(base, top), arcname=top, filter=fix)
EOF
cp "$B/chart/kalam-$VERSION.tgz" "$DIST/"
say "Done"
ls -la "$DIST"
