#!/usr/bin/env bash
# One-shot deploy of the BUIDLai frontend to a host that already runs tiptag-api.
#
# Usage (from your machine):
#   DEPLOY_HOST=user@your-server ./deploy/deploy.sh
#
# Optional env:
#   DEPLOY_PATH   remote app dir (default: ~/buidlai-ui)
#   DEPLOY_BRANCH git branch to deploy (default: current branch)
#
# What it does on the remote:
#   1. clones/updates the repo at DEPLOY_PATH
#   2. npm ci --omit=dev
#   3. starts/reloads the "buidlai-ui" PM2 process in production mode
#
# Prerequisites on the host: git, node>=18, npm, pm2, and an nginx vhost
# (see deploy/nginx.buidlai.online.conf). DNS for buidlai.online must point
# at the host (A record), replacing the current Namecheap URL-forwarding.

set -euo pipefail

: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@server}"
DEPLOY_PATH="${DEPLOY_PATH:-\$HOME/buidlai-ui}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO_URL="$(git remote get-url origin)"

echo "==> Deploying $REPO_URL ($DEPLOY_BRANCH) to $DEPLOY_HOST:$DEPLOY_PATH"

# shellcheck disable=SC2087
ssh "$DEPLOY_HOST" bash -se <<REMOTE
set -euo pipefail
APP_DIR="$DEPLOY_PATH"

if [ ! -d "\$APP_DIR/.git" ]; then
  git clone --branch "$DEPLOY_BRANCH" "$REPO_URL" "\$APP_DIR"
else
  cd "\$APP_DIR"
  git fetch origin "$DEPLOY_BRANCH"
  git checkout "$DEPLOY_BRANCH"
  git reset --hard "origin/$DEPLOY_BRANCH"
fi

cd "\$APP_DIR"
npm ci --omit=dev

# Start or reload under PM2 in production mode.
pm2 reload ecosystem.config.cjs --env production --update-env \
  || pm2 start ecosystem.config.cjs --env production
pm2 save

echo "==> buidlai-ui is running:"
pm2 describe buidlai-ui | grep -E "status|script|exec mode" || true
REMOTE

echo "==> Done. Verify: curl -I http://buidlai.online/"
