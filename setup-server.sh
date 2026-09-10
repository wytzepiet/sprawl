#!/bin/bash
# Turn a fresh Ubuntu VPS into a Sprawl server, once. Then ./deploy.sh.
#
#   ./setup-server.sh root@178.104.84.207 eu-1.sprawl.nl
#
# The domain must already point at the machine: Caddy gets its certificate
# by answering for it. Rerunning is safe; every step is idempotent.
set -euo pipefail

HOST=${1:?usage: ./setup-server.sh <user@host> <domain>}
DOMAIN=${2:?usage: ./setup-server.sh <user@host> <domain>}

ssh -o StrictHostKeyChecking=accept-new "$HOST" "bash -s $DOMAIN" << 'REMOTE'
set -euo pipefail
DOMAIN=$1
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y build-essential git curl unzip debian-keyring debian-archive-keyring apt-transport-https
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
curl -fsSL https://bun.sh/install | bash

# Caddy: TLS and the WebSocket upgrade, in front of the server on 4801.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
cat > /etc/caddy/Caddyfile << CADDY
$DOMAIN {
    reverse_proxy localhost:4801
}
CADDY
systemctl restart caddy

[ -d /opt/sprawl ] || git clone https://github.com/wytzepiet/sprawl.git /opt/sprawl

# The world lives in /var/lib/sprawl, which systemd creates and deploy.sh wipes.
cat > /etc/systemd/system/sprawl.service << 'UNIT'
[Unit]
Description=Sprawl
After=network.target

[Service]
WorkingDirectory=/opt/sprawl/server
Environment=CLIENT_DIR=/opt/sprawl/client/dist
Environment=SPRAWL_DB=/var/lib/sprawl/sprawl.db
StateDirectory=sprawl
ExecStart=/opt/sprawl/server/target/release/sprawl-server
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable sprawl

echo "$DOMAIN is ready; now ./deploy.sh"
REMOTE
