#!/bin/bash
# The dev stack. One definition of what "running" means, two ways to watch it.
#
#   ./dev.sh              a TUI, both logs side by side, restart with `r`
#   ./dev.sh --headless   same processes in the background, logs only
#   ./dev.sh --stop       stop whatever is running
#
# Either way both processes write to .dev/<name>.log, so a run can be read
# after the fact, and by anything that cannot attach to a TUI.
set -e
cd "$(dirname "$0")"
mkdir -p .dev

# The server rebuilds and restarts on save. A binary that falls behind its
# source looks exactly like a fix that did not work, which has cost real time.
SERVER_CMD="cd server && cargo watch -q -w src -x run"
CLIENT_CMD="cd client && bun run dev"

# Stop anything from a previous run. An orphan holding a port makes the next
# start either die or quietly move elsewhere — which is how you end up
# debugging a server you are not looking at.
stop() {
  if [ -f .dev/pids ]; then
    while read -r pid; do kill -- "-$pid" 2>/dev/null || true; done < .dev/pids
    rm -f .dev/pids
  fi
  for port in 3000 3001; do
    pids=$(lsof -ti:$port || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
  done
  # Watchers survive the thing they watch, and would restart it behind us.
  pkill -f "cargo watch -q -w src" 2>/dev/null || true
}

stop
if [ "$1" = "--stop" ]; then
  echo "stopped"
  exit 0
fi

if [ "$1" = "--headless" ]; then
  set -m   # each job gets its own process group, so it can be killed as one
  bash -c "$SERVER_CMD" > .dev/server.log 2>&1 &
  echo $! > .dev/pids
  bash -c "$CLIENT_CMD" > .dev/client.log 2>&1 &
  echo $! >> .dev/pids
  echo "started headless; logs in .dev/, stop with ./dev.sh --stop"
  exit 0
fi

exec mprocs --log-dir .dev --names server,client "$SERVER_CMD" "$CLIENT_CMD"
