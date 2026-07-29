#!/usr/bin/env bash
# Kalam — one-click start for Linux / macOS.
# Kept at the repo root for convenience; the real scripts live in scripts/.
#
#   chmod +x start.sh scripts/*.sh   # once
#   ./start.sh                       # same flags as scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")"
exec ./scripts/start.sh "$@"
