#!/usr/bin/env bash
# Kalam — development mode on Linux: Express API + Vite dev server (hot reload).
#
#   ./scripts/dev.sh                 backend on :3001, client on :5173 (loopback)
#   ./scripts/dev.sh --lan           bind 0.0.0.0 so other machines can reach it
#   ./scripts/dev.sh --force         kill whatever already holds the ports
#   ./scripts/dev.sh --port 4000     backend port
#   ./scripts/dev.sh --client-port 5200
#   ./scripts/dev.sh --no-open       don't launch a browser
#
# This is also the fix for `connect ECONNREFUSED 0.0.0.0:5173`: the ports are
# checked before anything starts, Vite is pinned with strictPort so it can never
# silently move to 5174, and the URL printed/opened is a dialable address rather
# than the 0.0.0.0 bind address.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

FORCE=0
OPEN=1
LAN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force)       FORCE=1 ;;
        --no-open)     OPEN=0 ;;
        --lan)         LAN=1 ;;
        --port)        PORT="${2:?--port needs a value}"; shift ;;
        --client-port) CLIENT_PORT="${2:?--client-port needs a value}"; shift ;;
        -h|--help)     sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)             die "Unknown option: $1 (try --help)" ;;
    esac
    shift
done

banner "DEV MODE"
guard_no_proxy
require_node
ensure_env_file
require_deps
load_config

if [ "$LAN" -eq 1 ]; then
    HOST=0.0.0.0
    CLIENT_HOST=0.0.0.0
    export HOST CLIENT_HOST
    warn "Binding 0.0.0.0 — this API can run docker/kubectl/ssh commands. Only do this on a trusted network."
fi

# ------------------------------------------------------------- preflight ---
step "Checking ports"
for p in "$PORT" "$CLIENT_PORT"; do
    if port_busy "$p"; then
        if [ "$FORCE" -eq 1 ]; then
            free_port "$p"
        else
            err "Port ${p} is $(describe_port "$p")."
            hint "Free it with  ./scripts/stop.sh   or rerun with  --force"
            hint "Or pick another:  ./scripts/dev.sh --port 3002 --client-port 5174"
            exit 1
        fi
    fi
done
ok "Ports ${PORT} (api) and ${CLIENT_PORT} (client) are free."

DIAL="$(dial_host "$CLIENT_HOST")"
CLIENT_URL="http://${DIAL}:${CLIENT_PORT}"

# -------------------------------------------------------------- launch -----
step "Starting backend (:${PORT}) and Vite dev server (:${CLIENT_PORT})"
info "Open ${C_YELLOW}${CLIENT_URL}${C_RESET}   ${C_DIM}(API proxied from there to :${PORT})${C_DIM}${C_RESET}"
if [ "$CLIENT_HOST" = "0.0.0.0" ]; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "${LAN_IP:-}" ] && info "From other machines: ${C_YELLOW}http://${LAN_IP}:${CLIENT_PORT}${C_RESET}"
fi
hint "Ctrl+C stops both processes."
printf '\n'

# Best-effort browser open once Vite actually answers — never fatal.
if [ "$OPEN" -eq 1 ]; then
    (
        if wait_http "$CLIENT_URL" 90; then
            open_browser "$CLIENT_URL"
        else
            warn "Vite did not answer on ${CLIENT_URL} within 90s — run ./scripts/doctor.sh"
        fi
    ) &
fi

# `npm run dev` runs both halves under concurrently; Ctrl+C reaches the whole
# foreground process group, so both the API and Vite stop together.
# vite.config.ts reads CLIENT_HOST / CLIENT_PORT / PORT from the environment.
exec npm run dev
