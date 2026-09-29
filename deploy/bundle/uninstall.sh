#!/usr/bin/env bash
# Remove Kalam.
#
#   ./uninstall.sh                 # the helm release; keeps the data PVC and secrets
#   ./uninstall.sh --purge         # also the PVC, secrets, namespace and node image cache
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash: pass arguments to native .exe tools verbatim (see install.sh).
if command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  HERE="$(cygpath -m "$HERE")"
fi
NAMESPACE=kalam
RELEASE=kalam
CONTEXT=""
PURGE=false
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--namespace) NAMESPACE="$2"; shift 2 ;;
    -r|--release) RELEASE="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --purge) PURGE=true; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLAT=linux-amd64 ;; Darwin-arm64) PLAT=darwin-arm64 ;;
  MINGW*|MSYS*|CYGWIN*) PLAT=windows-amd64 ;; *) PLAT="" ;;
esac
EXE=""; [ "$PLAT" = windows-amd64 ] && EXE=.exe
HELM="$HERE/bin/$PLAT/helm$EXE"; [ -x "$HELM" ] || HELM="$(command -v helm)"
KUBECTL="$(command -v kubectl 2>/dev/null || echo "$HERE/bin/$PLAT/kubectl$EXE")"
KC=("$KUBECTL"); HC=("$HELM")
if [ -n "$CONTEXT" ]; then KC+=(--context "$CONTEXT"); HC+=(--kube-context "$CONTEXT"); fi

if "${HC[@]}" status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
  "${HC[@]}" uninstall "$RELEASE" -n "$NAMESPACE" --wait
else
  echo "release $RELEASE not found in $NAMESPACE (already removed)"
fi

if $PURGE; then
  "${KC[@]}" -n "$NAMESPACE" delete pvc -l app.kubernetes.io/instance="$RELEASE" --ignore-not-found
  "${KC[@]}" -n "$NAMESPACE" delete secret kalam-ssh kalam-llm kalam-registry --ignore-not-found
  if [ -z "$("${KC[@]}" -n "$NAMESPACE" get all,pvc,secret,configmap -o name 2>/dev/null | grep -v -e 'kube-root-ca' -e 'default-token')" ]; then
    "${KC[@]}" delete ns "$NAMESPACE" --ignore-not-found --wait=false
  else
    echo "namespace $NAMESPACE still holds other objects; left in place"
  fi
  if "${KC[@]}" get ns kalam-image-cache >/dev/null 2>&1; then
    # Empty each node's cache directory before the pods that own it go away.
    for pod in $("${KC[@]}" -n kalam-image-cache get pods -o name); do
      "${KC[@]}" -n kalam-image-cache exec "$pod" -- sh -c 'rm -rf /var/lib/registry/*' 2>/dev/null || true
    done
    "${KC[@]}" delete ns kalam-image-cache --wait=false
  fi
  echo "purged"
else
  echo "kept: PVC with the VM inventory/KB/history, secrets, namespace. Use --purge to remove them."
fi
