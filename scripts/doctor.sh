#!/usr/bin/env bash
# Kalam — diagnose connection problems, in particular:
#
#     connect ECONNREFUSED 0.0.0.0:5173
#     connect ECONNREFUSED 127.0.0.1:3001
#
# ECONNREFUSED means the TCP handshake was actively rejected: nothing is
# listening on that address:port. This script reports which of the usual causes
# applies on this machine and prints the exact fix.
#
#   ./scripts/doctor.sh
#   ./scripts/doctor.sh --fix    also free stuck ports and reinstall if needed
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT_DIR"

FIX=0
for arg in "$@"; do
    case "$arg" in
        --fix)     FIX=1 ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         die "Unknown option: $arg (try --help)" ;;
    esac
done

banner "DOCTOR"
load_config
PROBLEMS=0
note_problem() { PROBLEMS=$((PROBLEMS + 1)); err "$1"; shift; for l in "$@"; do hint "$l"; done; }

# --------------------------------------------------------- 1. toolchain ----
step "[1/7] Toolchain"
if have node; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -lt 20 ]; then
        note_problem "Node.js $(node -v) is too old (need 20+)." "nvm install 22 && nvm use 22"
    else
        ok "Node.js $(node -v)"
    fi
else
    note_problem "Node.js is not installed." "See scripts/setup.sh"
fi
have npm && ok "npm $(npm -v)" || note_problem "npm not found."
for t in curl lsof ss; do have "$t" && ok "$t present" || info "$t not found (optional, but helps diagnostics)"; done

# ------------------------------------------------------------- 2. files ----
step "[2/7] Project state"
[ -f .env ] && ok ".env present" || note_problem ".env missing." "Run ./scripts/setup.sh"
if [ -d node_modules ]; then
    ok "node_modules present"
else
    note_problem "node_modules missing — Vite can't start, so :${CLIENT_PORT} refuses connections." \
                 "Run ./scripts/setup.sh"
    [ "$FIX" -eq 1 ] && { info "Installing (--fix) ..."; npm install; }
fi
if [ -f dist/index.html ]; then
    ok "dist/ built — production mode can serve everything from :${PORT}"
else
    info "dist/ not built. ./scripts/start.sh will build it on first run."
fi
[ -x scripts/dev.sh ] || info "Scripts are not executable yet: chmod +x scripts/*.sh"

# ------------------------------------------------------------ 3. config ----
step "[3/7] Effective configuration"
info "backend  HOST=${HOST}  PORT=${PORT}"
info "client   CLIENT_HOST=${CLIENT_HOST}  CLIENT_PORT=${CLIENT_PORT}"
if [ "$CLIENT_HOST" = "0.0.0.0" ] || [ "$HOST" = "0.0.0.0" ]; then
    warn "0.0.0.0 is a *bind* address — it is not a valid destination."
    hint "Browsing to http://0.0.0.0:${CLIENT_PORT} is exactly what prints"
    hint "'connect ECONNREFUSED 0.0.0.0:${CLIENT_PORT}' on some clients."
    hint "Use http://127.0.0.1:${CLIENT_PORT} locally, or http://<this-host-ip>:${CLIENT_PORT} remotely."
fi

# Serving through a cluster ingress trips three separate things in turn, so
# report all of them together rather than one error at a time.
if [ -n "${CLIENT_PUBLIC_HOST}" ] || [ -n "${CLIENT_ALLOWED_HOSTS}" ]; then
    info "ingress  CLIENT_PUBLIC_HOST=${CLIENT_PUBLIC_HOST:-(unset)}  CLIENT_ALLOWED_HOSTS=${CLIENT_ALLOWED_HOSTS:-(default .pcaicoe.com,.ext.hpe.com)}"
    if [ "$CLIENT_HOST" != "0.0.0.0" ] && [ "$HOST" != "0.0.0.0" ]; then
        warn "Ingress settings are present but nothing binds 0.0.0.0 — the ingress cannot reach a loopback-only process."
        hint "Set HOST=0.0.0.0 (and CLIENT_HOST=0.0.0.0 for dev mode) in .env."
    fi
    if [ -n "${CLIENT_PUBLIC_HOST}" ] && [ -z "${CLIENT_ALLOWED_HOSTS}" ]; then
        case "$CLIENT_PUBLIC_HOST" in
            *.pcaicoe.com|*.ext.hpe.com) : ;;
            *) warn "CLIENT_PUBLIC_HOST=${CLIENT_PUBLIC_HOST} is not covered by the default allowlist — Vite will answer 'Blocked request'."
               hint "Add it: CLIENT_ALLOWED_HOSTS=${CLIENT_PUBLIC_HOST}" ;;
        esac
    fi
fi

# ------------------------------------------------------------- 4. ports ----
step "[4/7] Ports"
for pair in "${PORT}:backend" "${CLIENT_PORT}:vite-client"; do
    p="${pair%%:*}"; name="${pair##*:}"
    if port_busy "$p"; then
        info "${name} port ${p}: $(describe_port "$p")"
    else
        info "${name} port ${p}: free (nothing listening → connections are refused)"
    fi
done
if have ss; then
    printf '\n%s\n' "${C_DIM}Listening sockets on these ports:${C_RESET}"
    ss -ltnp 2>/dev/null | grep -E ":(${PORT}|${CLIENT_PORT})\b" || printf '%s\n' "  ${C_DIM}(none)${C_RESET}"
fi
if [ "$FIX" -eq 1 ]; then
    for p in "$PORT" "$CLIENT_PORT"; do
        port_busy "$p" && free_port "$p"
    done
fi

# ------------------------------------------------------------ 5. proxy -----
step "[5/7] Proxy environment"
proxy_set=0
for v in http_proxy HTTP_PROXY https_proxy HTTPS_PROXY; do
    [ -n "${!v:-}" ] && { warn "${v}=${!v}"; proxy_set=1; }
done
if [ "$proxy_set" -eq 1 ]; then
    if printf '%s' "${no_proxy:-${NO_PROXY:-}}" | grep -q '127.0.0.1'; then
        ok "no_proxy already excludes the loopback."
    else
        note_problem "An HTTP proxy is set but no_proxy does not cover the loopback." \
            "Every localhost request is sent to the proxy, which refuses it → ECONNREFUSED." \
            "export no_proxy=localhost,127.0.0.1,::1  (and NO_PROXY the same)"
    fi
else
    ok "No proxy variables set."
fi

# ---------------------------------------------------------- 6. loopback ----
step "[6/7] Loopback reachability"
if have curl; then
    for pair in "${PORT}:backend" "${CLIENT_PORT}:client"; do
        p="${pair%%:*}"; name="${pair##*:}"
        if curl -sf -o /dev/null --max-time 3 --noproxy '*' "http://127.0.0.1:${p}/"; then
            ok "${name}: http://127.0.0.1:${p} answers."
        else
            info "${name}: http://127.0.0.1:${p} does not answer (expected if it isn't running)."
        fi
    done
    if curl -sf -o /dev/null --max-time 3 --noproxy '*' "http://127.0.0.1:${PORT}/api/status"; then
        ok "Backend API /api/status is healthy."
    fi
else
    info "curl not installed — skipped."
fi
if [ ! -f /etc/hosts ]; then
    info "/etc/hosts not readable here — skipped (not a Linux host?)."
elif grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+.*\blocalhost\b' /etc/hosts 2>/dev/null; then
    ok "/etc/hosts maps localhost → 127.0.0.1"
else
    note_problem "localhost is not mapped to 127.0.0.1 in /etc/hosts." \
        "Node may resolve localhost to ::1 only; if the server bound IPv4, the proxy hop refuses." \
        "Add this line to /etc/hosts:  127.0.0.1  localhost"
fi

# ---------------------------------------------------------- 7. verdict -----
step "[7/7] Summary"
if [ "$PROBLEMS" -eq 0 ]; then
    ok "No blocking problems found."
else
    warn "${PROBLEMS} problem(s) reported above."
fi

cat <<EOF

${C_BLUE}Why "connect ECONNREFUSED 0.0.0.0:${CLIENT_PORT}" happens${C_RESET}
  1. Vite simply isn't running. The dev client only exists during
     ./scripts/dev.sh — ./scripts/start.sh serves everything from :${PORT}.
  2. You dialed 0.0.0.0. That address means "bind to every interface"; as a
     destination it is not routable. Use 127.0.0.1 locally, or the machine's
     LAN IP from another host.
  3. Vite moved to another port. Without strictPort it silently takes 5174 when
     5173 is busy, so whatever pointed at 5173 gets refused. vite.config.ts now
     pins the port and fails loudly instead.
  4. Vite bound to loopback only while you browsed from another machine.
     Start with ./scripts/dev.sh --lan.
  5. An HTTP proxy env var swallows loopback traffic — see section 5 above.

${C_BLUE}Quickest path to a working app${C_RESET}
  ./scripts/stop.sh && ./scripts/start.sh        # single port, no 5173 at all
  ./scripts/dev.sh --force                       # hot reload, ports cleaned first
EOF
