#!/usr/bin/env bash
# Kalam — one-time setup on a Linux machine (the equivalent of setup.bat).
#
#   ./scripts/setup.sh              install deps + build the frontend
#   ./scripts/setup.sh --no-build   skip the frontend build (dev-only machines)
#   ./scripts/setup.sh --link       also register the global 'kalam' CLI
#   ./scripts/setup.sh --clean      wipe node_modules/dist and install from scratch
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

DO_BUILD=1
DO_LINK=0
DO_CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --no-build) DO_BUILD=0 ;;
        --link)     DO_LINK=1 ;;
        --clean)    DO_CLEAN=1 ;;
        -h|--help)  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "Unknown option: $arg (try --help)" ;;
    esac
done

banner "LINUX SETUP"
guard_no_proxy

# ------------------------------------------------------------ 1. Node.js ---
step "[1/6] Checking prerequisites"
if ! have node; then
    err "Node.js is not installed."
    hint "Debian/Ubuntu : sudo apt install -y nodejs npm"
    hint "Fedora/RHEL   : sudo dnf install -y nodejs npm"
    hint "Arch          : sudo pacman -S nodejs npm"
    hint "Any distro    : https://github.com/nvm-sh/nvm  then  nvm install 22"
    exit 1
fi
require_node
ok "Node.js $(node -v)"
have npm || die "npm was not found — check your Node.js installation."
ok "npm $(npm -v)"

# ------------------------------------------------------------ 2. .env ------
step "[2/6] Environment configuration"
ensure_env_file
load_config
ok "Backend ${HOST}:${PORT}   ·   dev client ${CLIENT_HOST}:${CLIENT_PORT}"
[ -n "$(env_value GEMINI_API_KEY)" ] || info "GEMINI_API_KEY is empty — the Gemini agent stays disabled (local LLMs still work)."

# ------------------------------------------------------------ 3. deps ------
step "[3/6] Installing dependencies"
if [ "$DO_CLEAN" -eq 1 ]; then
    warn "Removing node_modules/ and dist/ (--clean)"
    rm -rf node_modules dist
fi
if [ -f package-lock.json ] && [ "$DO_CLEAN" -eq 1 ]; then
    npm ci
else
    npm install
fi
ok "Dependencies installed."

# ------------------------------------------------------------ 4. CLI -------
step "[4/6] Global 'kalam' CLI"
if [ "$DO_LINK" -eq 1 ]; then
    if npm link; then
        ok "'kalam' registered — open a new shell to use it."
    else
        warn "'npm link' failed (usually a permissions issue on the global prefix)."
        hint "Fix without sudo:  npm config set prefix ~/.npm-global"
        hint "then add          export PATH=\"\$HOME/.npm-global/bin:\$PATH\"  to ~/.bashrc"
    fi
else
    info "Skipped (pass --link to register the global 'kalam' command)."
fi

# ------------------------------------------------------------ 5. build -----
step "[5/6] Frontend build"
if [ "$DO_BUILD" -eq 1 ]; then
    npm run build
    ok "Built to dist/ — ./scripts/start.sh can now serve it on a single port."
else
    info "Skipped (--no-build). Use ./scripts/dev.sh, or build later with 'npm run build'."
fi

# ------------------------------------------------------ 6. optional tools --
step "[6/6] Optional cluster tools"
have docker  && ok "docker  $(docker --version 2>/dev/null | head -n1)"  || info "docker not found — needed only for container features."
have kubectl && ok "kubectl present"                                     || info "kubectl not found — needed only for Kubernetes features."
have curl    || warn "curl not found — health checks and browser auto-open will be skipped. (sudo apt install -y curl)"

printf '\n'
banner "SETUP COMPLETE"
printf '\n'
info "Production run (one port, serves dist/):  ${C_YELLOW}./scripts/start.sh${C_RESET}"
info "Development run (hot reload):             ${C_YELLOW}./scripts/dev.sh${C_RESET}"
info "Something not connecting?                 ${C_YELLOW}./scripts/doctor.sh${C_RESET}"
