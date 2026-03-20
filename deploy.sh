#!/bin/bash
set -e

SERVERS=(
  root@178.104.84.207
)

for SERVER in "${SERVERS[@]}"; do
  echo "Deploying to $SERVER..."
  ssh -o StrictHostKeyChecking=accept-new $SERVER 'source ~/.cargo/env && export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH" && cd /opt/sprawl && git pull && cd client && bun install && bun run build && cd ../server && cargo build --release && systemctl restart sprawl'
  echo "Done: $SERVER"
done
