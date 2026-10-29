#!/bin/bash
# The preview box's half: the deploy key runs this and nothing else.
#   up <slug>    the build on stdin, at https://<slug>.<domain>, on the world
#                its last push left (the game starts over a save it cannot read)
#   down <slug>  the world, its save and its address, gone
set -euo pipefail
read -r verb slug <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ $slug =~ ^[a-z0-9-]{1,40}$ ]] || { echo "bad slug: $slug" >&2; exit 1; }
root=/opt/previews
dir=$root/$slug
domain=$(cat $root/domain)

case $verb in
up)
  mkdir -p $dir
  if [ ! -f $dir/port ]; then
    port=4900
    # Not `cat | grep -q`: grep leaving early kills cat, and pipefail made
    # that a free port, so every new world was handed 4900.
    while grep -qx $port $root/*/port 2>/dev/null; do port=$((port + 1)); done
    echo $port > $dir/port
  fi
  port=$(cat $dir/port)
  systemctl stop sprawl-preview@$slug 2>/dev/null || true
  # Whatever else still holds the port, or still runs this world's binary,
  # would keep serving the old build.
  fuser -k $port/tcp 2>/dev/null || true
  pkill -KILL -f "^$dir/app/sprawl-server" || true
  rm -rf $dir/app
  mkdir $dir/app
  tar -xz -C $dir/app
  printf 'SPRAWL_PORT=%s\nCLIENT_DIR=%s\nSPRAWL_DB=%s\nSPRAWL_SEED=7\n' $port $dir/app/dist $dir/sprawl.db > $dir/env
  printf '%s {\n\treverse_proxy localhost:%s\n}\n' $slug.$domain $port > /etc/caddy/previews/$slug.caddy
  systemctl reload caddy
  systemctl reset-failed sprawl-preview@$slug 2>/dev/null || true
  systemctl enable --now sprawl-preview@$slug
  # Up is the unit running and its own process answering on its port.
  answers() {
    systemctl is-active -q sprawl-preview@$slug &&
      [ "$(fuser $port/tcp 2>/dev/null | tr -d ' ')" = "$(systemctl show -P MainPID sprawl-preview@$slug)" ] &&
      curl -sf localhost:$port/health >/dev/null
  }
  for _ in $(seq 30); do answers && break; sleep 1; done
  answers || {
    echo "did not come up on :$port" >&2
    journalctl -u sprawl-preview@$slug -n 20 --no-pager >&2
    exit 1
  }
  echo "https://$slug.$domain"
  ;;
down)
  systemctl disable --now sprawl-preview@$slug 2>/dev/null || true
  rm -rf $dir /etc/caddy/previews/$slug.caddy
  systemctl reload caddy
  echo "gone: $slug"
  ;;
*)
  echo "usage: up|down <slug>" >&2; exit 1 ;;
esac
