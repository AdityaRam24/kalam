#!/usr/bin/env bash
# Kalam — register the global 'kalam' command (the equivalent of install-cli.bat).
#
#   ./scripts/install-cli.sh            npm link
#   ./scripts/install-cli.sh --uninstall
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

UNINSTALL=0
for arg in "$@"; do
    case "$arg" in
        --uninstall) UNINSTALL=1 ;;
        -h|--help)   sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           die "Unknown option: $arg (try --help)" ;;
    esac
done

banner "CLI INSTALL"
require_node
require_deps
guard_no_proxy

if [ "$UNINSTALL" -eq 1 ]; then
    npm unlink -g kalam || warn "Nothing to unlink."
    ok "Global 'kalam' removed."
    exit 0
fi

PREFIX="$(npm config get prefix)"
if [ ! -w "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
    warn "npm's global prefix (${PREFIX}) is not writable by $(whoami)."
    hint "Recommended, no sudo needed:"
    hint "  npm config set prefix ~/.npm-global"
    hint "  echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.bashrc && . ~/.bashrc"
    hint "Then rerun this script."
fi

if npm link; then
    chmod +x bin/kalam.cjs 2>/dev/null || true
    ok "'kalam' registered. Open a NEW shell, then run: kalam"
    have kalam && info "Resolved to: $(command -v kalam)"
else
    die "npm link failed — see the hint above about the global prefix."
fi
