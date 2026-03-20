#!/bin/bash
set -e

SERVER=${SPRAWL_HOST:-root@178.104.84.207}

ssh $SERVER 'source ~/.cargo/env && cd /opt/sprawl && git pull && cd server && cargo build --release && systemctl restart sprawl'

echo "Deployed. Check: ssh $SERVER systemctl status sprawl"
