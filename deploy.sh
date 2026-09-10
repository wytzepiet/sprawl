#!/bin/bash
# Put a branch online, on a server that setup-server.sh prepared.
#
#   ./deploy.sh root@178.104.84.207            deploys origin/main
#   ./deploy.sh root@178.104.84.207 my-branch  deploys another branch
#
# Builds on the server, so nothing depends on the machine this runs from.
# Every deploy starts a fresh world: a save written by another build refuses
# to load, and a server that refuses to start would restart forever.
set -euo pipefail

HOST=${1:?usage: ./deploy.sh <user@host> [branch]}
BRANCH=${2:-main}

ssh -o StrictHostKeyChecking=accept-new "$HOST" "bash -s $BRANCH" << 'REMOTE'
set -euo pipefail
BRANCH=$1
source ~/.cargo/env
export PATH="$HOME/.bun/bin:$PATH"

cd /opt/sprawl
git fetch origin
git reset --hard "origin/$BRANCH"
(cd client && bun install --frozen-lockfile && bun run build)
(cd server && cargo build --release)

systemctl stop sprawl
rm -f /var/lib/sprawl/sprawl.db
systemctl start sprawl

# The same question as in development: is what answers the binary just built?
for _ in $(seq 20); do
  sleep 1
  if health=$(curl -fsS localhost:4801/health); then
    echo "$health"
    exit 0
  fi
done
echo "server did not come up:" >&2
journalctl -u sprawl -n 50 --no-pager >&2
exit 1
REMOTE
