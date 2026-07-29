#!/usr/bin/env bash
# Kalam — stop anything listening on the Kalam ports.
#
#   ./scripts/stop.sh                stop the backend (3001) and dev client (5173)
#   ./scripts/stop.sh --port 8080    stop one specific port
#   ./scripts/stop.sh 3002 5174      stop arbitrary ports
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

load_config
PORTS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --port)    PORTS+=("${2:?--port needs a value}"); shift ;;
        -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        [0-9]*)    PORTS+=("$1") ;;
        *)         die "Unknown option: $1 (try --help)" ;;
    esac
    shift
done
[ "${#PORTS[@]}" -gt 0 ] || PORTS=("$PORT" "$CLIENT_PORT")

banner "STOP"
if ! have lsof && ! have ss && ! have fuser; then
    die "Need one of lsof, ss (iproute2) or fuser to find listeners. e.g. sudo apt install -y lsof"
fi

stopped=0
for p in "${PORTS[@]}"; do
    if port_busy "$p"; then
        free_port "$p"
        if port_busy "$p"; then
            err "Port ${p} is still $(describe_port "$p") — it may belong to another user (try sudo)."
        else
            ok "Port ${p} released."
            stopped=$((stopped + 1))
        fi
    else
        info "Port ${p} was already free."
    fi
done

printf '\n'
ok "Done (${stopped} port(s) released)."
