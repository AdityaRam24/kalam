#!/usr/bin/env bash
# Kalam — production run on Linux. One process, one port: the Express backend
# serves the built frontend from dist/, so no Vite dev server is involved
# (and nothing ever dials :5173).
#
#   ./scripts/start.sh              build if needed, then serve on :3001
#   ./scripts/start.sh --rebuild    force a fresh frontend build first
#   ./scripts/start.sh --lan        bind 0.0.0.0 for other machines
#   ./scripts/start.sh --force      kill whatever already holds the port
#   ./scripts/start.sh --port 8080
#   ./scripts/start.sh --no-open    don't launch a browser
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

FORCE=0
OPEN=1
LAN=0
REBUILD=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force)    FORCE=1 ;;
        --no-open)  OPEN=0 ;;
        --lan)      LAN=1 ;;
        --rebuild)  REBUILD=1 ;;
        --port)     PORT="${2:?--port needs a value}"; shift ;;
        -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "Unknown option: $1 (try --help)" ;;
    esac
    shift
done

banner "START"
guard_no_proxy
require_node
ensure_env_file
load_config

[ "$LAN" -eq 1 ] && { HOST=0.0.0.0; export HOST; \
    warn "Binding 0.0.0.0 — this API can run docker/kubectl/ssh commands. Only do this on a trusted network."; }

# ------------------------------------------------------------ 1. deps ------
step "[1/4] Dependencies"
if [ ! -d node_modules ]; then
    info "First run — installing ..."
    npm install
fi
ok "node_modules present."

# ----------------------------------------------------------- 2. build ------
step "[2/4] Frontend build"
if [ "$REBUILD" -eq 1 ]; then
    rm -rf dist
    npm run build
elif [ ! -f dist/index.html ]; then
    info "No dist/ yet — building once ..."
    npm run build
else
    ok "dist/ found. Use --rebuild to refresh it."
fi

# ------------------------------------------------------------ 3. port ------
step "[3/4] Port ${PORT}"
if port_busy "$PORT"; then
    if [ "$FORCE" -eq 1 ]; then
        free_port "$PORT"
    else
        err "Port ${PORT} is $(describe_port "$PORT")."
        hint "Free it with  ./scripts/stop.sh   or rerun with  --force  /  --port 8080"
        exit 1
    fi
fi
ok "Port ${PORT} is free."

# ---------------------------------------------------------- 4. launch ------
DIAL="$(dial_host "$HOST")"
URL="http://${DIAL}:${PORT}"

step "[4/4] Starting Kalam on ${URL}"
if [ "$HOST" = "0.0.0.0" ]; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "${LAN_IP:-}" ] && info "From other machines: ${C_YELLOW}http://${LAN_IP}:${PORT}${C_RESET}"
fi
hint "Ctrl+C stops the server."
printf '\n'

if [ "$OPEN" -eq 1 ]; then
    ( wait_http "$URL" 60 && open_browser "$URL" ) &
fi

exec npx tsx server/index.ts
