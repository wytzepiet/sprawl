#!/bin/bash
set -e

SERVER=root@178.104.84.207

ssh $SERVER 'bash -s' << 'REMOTE'
set -e

apt update && apt install -y build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

git clone https://github.com/wytzepiet/sprawl.git /opt/sprawl
cd /opt/sprawl/server && cargo build --release

mkdir -p /mnt/HC_Volume_105179622/sprawl

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
echo "Done. Server running on port 3001."
REMOTE
