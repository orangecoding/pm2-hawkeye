#!/usr/bin/env bash
# update.sh — update a self-hosted pm2-manager installation to the latest version.
#
# Usage:
#   chmod +x update.sh
#   ./update.sh
#
# What it does:
#   1. Pulls the latest commits from the upstream repository (fast-forward only).
#   2. Installs / updates Node.js dependencies.
#   3. Rebuilds the frontend bundle.
#   4. Restarts the pm2-manager process under PM2 (if running).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

info()    { echo -e "${GREEN}[update]${NC} $*"; }
warn()    { echo -e "${YELLOW}[update]${NC} $*"; }
die()     { echo -e "${RED}[update] ERROR:${NC} $*" >&2; exit 1; }

# ── 1. Pull latest changes ────────────────────────────────────────────────────
info "Pulling latest changes..."
if ! git diff --quiet || ! git diff --cached --quiet; then
    die "Working directory has uncommitted changes. Commit or stash them first."
fi

git pull --ff-only || die "git pull failed — resolve any conflicts and try again."

# ── 2. Install / update dependencies ─────────────────────────────────────────
info "Installing dependencies..."
if command -v yarn &>/dev/null; then
    yarn install --frozen-lockfile
else
    npm ci
fi

# ── 3. Build frontend ─────────────────────────────────────────────────────────
info "Building frontend..."
npm run build

# ── 4. Restart pm2-manager ───────────────────────────────────────────────────
if command -v pm2 &>/dev/null && pm2 describe pm2-manager &>/dev/null 2>&1; then
    info "Restarting pm2-manager via PM2..."
    pm2 restart pm2-manager
    pm2 save
    info "Done. pm2-manager is running the latest version."
else
    warn "pm2-manager is not running under PM2."
    warn "Start it manually with:"
    warn "  pm2 start lib/transport/server.js --name pm2-manager"
    warn "  pm2 save"
fi
