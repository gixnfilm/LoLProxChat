#!/usr/bin/env bash
#
# Deploy the signaling server to a remote Docker host by syncing source +
# rebuilding the container. Does NOT touch the remote docker-compose.yml, so
# your production secrets (ENCRYPTION_KEY, TURN tokens) baked into that file
# stay put.
#
# Why this exists: the remote deploy is a file-sync, NOT a `git pull` on the
# host. The v0.2.0 / v0.2.1 server upgrades silently never landed because the
# sync was done by hand and the new files were missed — every v0.2.x client
# then talked to a v0.1 server and got empty proximity volumes. This script
# makes the sync exhaustive and verifies the new code is actually serving
# before it claims success.
#
# Usage (from the repo root, in git-bash / WSL / any bash):
#
#   PROXCHAT_DEPLOY_HOST=root@192.168.0.10 \
#   PROXCHAT_DEPLOY_PATH=/mnt/user/appdata/proxchat-server \
#   ./scripts/deploy-server.sh
#
# Requires: passwordless ssh + scp to the host, and `docker compose` on the host.

set -euo pipefail

HOST="${PROXCHAT_DEPLOY_HOST:?set PROXCHAT_DEPLOY_HOST, e.g. root@192.168.0.10}"
DEST="${PROXCHAT_DEPLOY_PATH:?set PROXCHAT_DEPLOY_PATH, e.g. /mnt/user/appdata/proxchat-server}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

echo "==> [1/5] Build + test locally first (fail before touching prod)"
( cd "$SERVER_DIR" && npm ci --silent && npm run build && npm test )

echo "==> [2/5] Back up remote source for rollback"
ssh "$HOST" "cd '$DEST' && ts=\$(date +%s) && cp -r src \"src.bak.\$ts\" && echo '    backed up src.bak.'\$ts"

echo "==> [3/5] Sync source + build files (docker-compose.yml is left untouched)"
scp "$SERVER_DIR"/src/*.ts "$HOST:$DEST/src/"
scp "$SERVER_DIR"/tsconfig.json \
    "$SERVER_DIR"/package.json \
    "$SERVER_DIR"/package-lock.json \
    "$SERVER_DIR"/Dockerfile \
    "$SERVER_DIR"/.dockerignore \
    "$HOST:$DEST/"

echo "==> [4/5] Rebuild + restart container"
ssh "$HOST" "cd '$DEST' && docker compose up -d --build"

echo "==> [5/5] Verify the new code is actually serving"
sleep 4
ssh "$HOST" '
  set -e
  echo -n "    health:       "; curl -fsS http://localhost:3100/health; echo
  echo -n "    tiered path:  "
  # A v0.3+ server returns myBlob:"" for a room-shaped request. A stale v0.1
  # server would return a non-empty encrypted blob here — the exact symptom
  # that hid the v0.2 deploy never landing.
  curl -fsS -X POST http://localhost:3100/compute-volumes \
    -H "Content-Type: application/json" \
    -d "{\"myPosition\":{\"x\":0,\"y\":0},\"roomId\":\"deploycheck\",\"name\":\"x\"}"
  echo
'
echo "==> Done. health ok + myBlob empty == the v0.3+ tiered path is live."
echo "    Rollback if needed: ssh $HOST 'cd $DEST && rm -rf src && mv src.bak.<ts> src && docker compose up -d --build'"
