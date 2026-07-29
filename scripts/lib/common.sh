# Shared helpers for the Kalam Linux scripts.
# Sourced, never executed:  . "$(dirname "$0")/lib/common.sh"

# ---------------------------------------------------------------- paths ----
# Repo root = parent of the scripts/ directory that holds this file.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------- output ---
if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'
else
    C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''
fi

info()  { printf '%s\n' "${C_BLUE}[i]${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}[ok]${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}[!]${C_RESET} $*" >&2; }
err()   { printf '%s\n' "${C_RED}[x]${C_RESET} $*" >&2; }
die()   { err "$@"; exit 1; }
step()  { printf '\n%s\n' "${C_BLUE}==>${C_RESET} $*"; }
hint()  { printf '%s\n' "    ${C_DIM}$*${C_RESET}"; }

banner() {
    printf '%s\n' "==================================================="
    printf '%s\n' "  KALAM  -  $1"
    printf '%s\n' "==================================================="
}

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ env ----
# Read a single KEY from .env without sourcing it (values are never eval'd).
env_value() {
    local key="$1" file="${2:-${ROOT_DIR}/.env}"
    [ -f "$file" ] || return 0
    sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" \
        | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'
}

# Fill in the ports/hosts every script agrees on. Precedence: shell env > .env > default.
load_config() {
    PORT="${PORT:-$(env_value PORT)}"; PORT="${PORT:-3001}"
    HOST="${HOST:-$(env_value HOST)}"; HOST="${HOST:-127.0.0.1}"
    CLIENT_PORT="${CLIENT_PORT:-$(env_value CLIENT_PORT)}"; CLIENT_PORT="${CLIENT_PORT:-5173}"
    # The Vite dev server binds wherever the backend binds unless told otherwise.
    CLIENT_HOST="${CLIENT_HOST:-$(env_value CLIENT_HOST)}"; CLIENT_HOST="${CLIENT_HOST:-$HOST}"
    export PORT HOST CLIENT_PORT CLIENT_HOST
}

# A host you can actually *connect* to. 0.0.0.0 is a bind address, not a
# destination — dialing it is what produces "connect ECONNREFUSED 0.0.0.0:5173".
dial_host() {
    case "$1" in
        0.0.0.0|''|'*') printf '127.0.0.1' ;;
        ::|'[::]')      printf '127.0.0.1' ;;
        *)              printf '%s' "$1" ;;
    esac
}

# localhost-bound services are unreachable through an HTTP proxy. Make sure the
# loopback is always excluded, or curl/node/vite calls fail with ECONNREFUSED.
guard_no_proxy() {
    if [ -n "${http_proxy:-${HTTP_PROXY:-}}" ] || [ -n "${https_proxy:-${HTTPS_PROXY:-}}" ]; then
        local extra='localhost,127.0.0.1,::1,0.0.0.0'
        export no_proxy="${no_proxy:+$no_proxy,}$extra"
        export NO_PROXY="${NO_PROXY:+$NO_PROXY,}$extra"
    fi
}

# ---------------------------------------------------------------- ports ----
# Print the listening PIDs on a TCP port (empty when free).
port_pids() {
    local port="$1"
    if have lsof; then
        lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null
    elif have ss; then
        ss -lptnH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
    elif have fuser; then
        fuser "$port"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'
    fi
}

port_busy() { [ -n "$(port_pids "$1")" ]; }

describe_port() {
    local port="$1" pids
    pids="$(port_pids "$port" | tr '\n' ' ')"
    [ -n "${pids// /}" ] || { printf 'free'; return; }
    local descr=''
    for pid in $pids; do
        descr="${descr:+$descr, }pid ${pid} ($(ps -p "$pid" -o comm= 2>/dev/null || echo '?'))"
    done
    printf 'in use by %s' "$descr"
}

free_port() {
    local port="$1" pids
    pids="$(port_pids "$port")"
    [ -n "$pids" ] || return 0
    warn "Freeing port ${port} (killing: $(echo "$pids" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        port_busy "$port" || return 0
        sleep 0.3
    done
    pids="$(port_pids "$port")"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    sleep 0.5
}

# Block until a URL answers. wait_http URL [timeout_seconds]
wait_http() {
    local url="$1" timeout="${2:-60}" i=0
    have curl || { sleep 3; return 0; }
    while [ "$i" -lt "$timeout" ]; do
        curl -sf -o /dev/null --max-time 2 --noproxy '*' "$url" && return 0
        i=$((i + 1))
        sleep 1
    done
    return 1
}

open_browser() {
    local url="$1"
    if have xdg-open;   then xdg-open   "$url" >/dev/null 2>&1 || true
    elif have gio;      then gio open   "$url" >/dev/null 2>&1 || true
    elif have open;     then open       "$url" >/dev/null 2>&1 || true
    elif have wslview;  then wslview    "$url" >/dev/null 2>&1 || true
    fi
}

# ------------------------------------------------------------ toolchain ----
require_node() {
    have node || die "Node.js not found. Run scripts/setup.sh first, or install it from https://nodejs.org/"
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -lt 20 ]; then
        die "Node.js ${major}.x is too old — this project needs Node 20+ (Vite 8 / TypeScript 6). Try nvm: 'nvm install 22'."
    fi
}

require_deps() {
    [ -d "${ROOT_DIR}/node_modules" ] \
        || die "Dependencies are missing. Run: ${C_YELLOW}./scripts/setup.sh${C_RESET}"
}

ensure_env_file() {
    [ -f "${ROOT_DIR}/.env" ] && return 0
    info "Creating a default .env ..."
    cat > "${ROOT_DIR}/.env" <<'EOF'
# Kalam Configuration
PORT=3001

# Bind address for the backend. 127.0.0.1 keeps the API (which can run
# docker/kubectl/ssh) private. Set 0.0.0.0 only to serve other machines.
HOST=127.0.0.1

# Vite dev-server port (dev mode only).
CLIENT_PORT=5173

# Add your Google Gemini API Key here to enable the conversational DevOps Agent
GEMINI_API_KEY=
EOF
    ok "Created .env — add your GEMINI_API_KEY if you use Google Gemini."
}
