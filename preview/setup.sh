#!/bin/bash
# Once, from a machine that can already ssh in as root: makes the box take
# previews, and gives GitHub a key that may only run box.sh.
#   preview/setup.sh <ip> <domain>     e.g. preview/setup.sh 178.104.84.207 preview.sprawl.nl
# DNS: *.<domain> must point at <ip>. Needs `gh` signed in, for the secrets.
set -euo pipefail
IP=$1
DOMAIN=$2
cd "$(dirname "$0")"

key=$(mktemp -d)/preview
ssh-keygen -q -t ed25519 -N '' -C sprawl-preview -f $key

scp box.sh root@$IP:/usr/local/bin/sprawl-preview
ssh root@$IP "bash -s $DOMAIN '$(cat $key.pub)'" <<'REMOTE'
set -euo pipefail
DOMAIN=$1
PUB=$2
chmod +x /usr/local/bin/sprawl-preview
mkdir -p /opt/previews /etc/caddy/previews
echo $DOMAIN > /opt/previews/domain

# Caddy may already serve the old game; previews sit beside it.
grep -q 'import /etc/caddy/previews' /etc/caddy/Caddyfile 2>/dev/null ||
  echo 'import /etc/caddy/previews/*.caddy' >> /etc/caddy/Caddyfile
systemctl reload caddy

cat > /etc/systemd/system/sprawl-preview@.service <<'UNIT'
[Unit]
Description=Sprawl preview %i
After=network.target

[Service]
EnvironmentFile=/opt/previews/%i/env
WorkingDirectory=/opt/previews/%i
ExecStart=/opt/previews/%i/app/sprawl-server
Restart=always
# Reached only through Caddy.
IPAddressAllow=localhost
IPAddressDeny=any

[Install]
WantedBy=multi-user.target
UNIT

# A world not pushed to for a week stops; its next push starts it again.
cat > /etc/systemd/system/sprawl-preview-sleep.service <<'UNIT'
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for d in $(find /opt/previews -mindepth 2 -maxdepth 2 -name app -mtime +7); do systemctl stop sprawl-preview@$(basename $(dirname $d)); done'
UNIT
cat > /etc/systemd/system/sprawl-preview-sleep.timer <<'UNIT'
[Timer]
OnCalendar=daily

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now sprawl-preview-sleep.timer

mkdir -p ~/.ssh
grep -q sprawl-preview ~/.ssh/authorized_keys 2>/dev/null && sed -i '/sprawl-preview$/d' ~/.ssh/authorized_keys
echo "restrict,command=\"/usr/local/bin/sprawl-preview\" $PUB" >> ~/.ssh/authorized_keys
ldd --version | head -1
REMOTE

gh secret set PREVIEW_SSH_KEY -R wytzepiet/sprawl < $key
ssh-keyscan -t ed25519 $IP 2>/dev/null | gh secret set PREVIEW_KNOWN_HOSTS -R wytzepiet/sprawl
gh variable set PREVIEW_HOST -R wytzepiet/sprawl --body $IP
rm -rf "$(dirname $key)"
echo "Ready: the next push to any branch lands at https://<branch>.$DOMAIN"
