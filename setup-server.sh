#!/bin/bash
set -e

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./setup-server.sh <ip> <domain>"
  echo "Example: ./setup-server.sh 178.104.84.207 eu-1.sprawl.nl"
  exit 1
fi

IP=$1
DOMAIN=$2

ssh root@$IP "bash -s $DOMAIN" << 'REMOTE'
set -e
DOMAIN=$1

apt update && apt install -y build-essential debian-keyring debian-archive-keyring apt-transport-https curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

cat > /etc/caddy/Caddyfile << EOF
$DOMAIN {
    reverse_proxy localhost:3001
}
EOF
systemctl restart caddy

# Build
git clone https://github.com/wytzepiet/sprawl.git /opt/sprawl
cd /opt/sprawl/server && cargo build --release

# Persistence
mkdir -p /mnt/HC_Volume_105179622/sprawl

# Service
cat > /etc/systemd/system/sprawl.service << 'UNIT'
[Unit]
Description=Sprawl
After=network.target

[Service]
Environment=SPRAWL_DB=/mnt/HC_Volume_105179622/sprawl/sprawl.db
ExecStart=/opt/sprawl/server/target/release/sprawl-server
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable --now sprawl
echo "Done. $DOMAIN ready."
REMOTE
