#!/usr/bin/env bash
# Kalam - one-click start for Linux / macOS (the equivalent of start.bat).
#   chmod +x start.sh   # once
#   ./start.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==================================================="
echo "               KALAM - ONE-CLICK START"
echo "==================================================="
echo

# 1. Node.js must be present
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found."
    echo "        Install it first, e.g.:"
    echo "          Debian/Ubuntu : sudo apt install -y nodejs npm"
    echo "          Fedora/RHEL   : sudo dnf install -y nodejs npm"
    echo "          Any distro    : https://nodejs.org/  (or use nvm)"
    exit 1
fi
echo "[0/4] Node.js detected: $(node -v)"

# 2. Environment file
if [ ! -f .env ]; then
    echo "[1/4] Creating a default .env ..."
    cat > .env <<'EOF'
# Kalam Configuration
PORT=3001

# Add your Google Gemini API Key here to enable the conversational DevOps Agent
GEMINI_API_KEY=
EOF
    echo "      Created .env — add your GEMINI_API_KEY if you use Google Gemini."
else
    echo "[1/4] .env already present."
fi

# 3. Dependencies
if [ ! -d node_modules ]; then
    echo "[2/4] Installing dependencies (first run) ..."
    npm install
else
    echo "[2/4] Dependencies already installed."
fi

# 4. Frontend build
if [ ! -f dist/index.html ]; then
    echo "[3/4] Building the frontend (one-time) ..."
    npm run build
else
    echo "[3/4] Frontend build found (dist/). Delete the dist folder to force a rebuild."
fi

# 5. Launch
PORT="$(grep -E '^[[:space:]]*PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
PORT="${PORT:-3001}"
URL="http://localhost:${PORT}"

echo "[4/4] Starting Kalam on ${URL} ..."

# Open a browser once the server answers — best effort, never fatal.
(
    for _ in $(seq 1 30); do
        if command -v curl >/dev/null 2>&1 && curl -sf -o /dev/null "${URL}"; then
            break
        fi
        sleep 1
    done
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${URL}" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
        open "${URL}" >/dev/null 2>&1 || true
    fi
) &

exec npx tsx server/index.ts
