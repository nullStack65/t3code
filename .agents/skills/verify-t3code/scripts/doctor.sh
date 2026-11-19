#!/usr/bin/env bash
# Read-only check that RUN_DIR is the right build, is yours, and is worth driving.
# Usage: doctor.sh RUN_DIR      Exit 0 = healthy, 1 = fix before driving.
set -uo pipefail
RUN=${1:?usage: doctor.sh RUN_DIR}
RUN=$(cd "$RUN" 2>/dev/null && pwd) || { echo "FAIL no such run dir"; exit 1; }
[ -f "$RUN/instance.env" ] || { echo "FAIL no $RUN/instance.env (run launch.sh)"; exit 1; }
# shellcheck disable=SC1090
. "$RUN/instance.env"
bad=0
ok()  { echo "ok   $*"; }
bad() { echo "FAIL $*"; bad=1; }

head=$(git -C "$REPO" rev-parse --short=10 HEAD)
echo "head $head ($(git -C "$REPO" rev-parse --abbrev-ref HEAD)), dirty files: $(git -C "$REPO" status --short | wc -l)"

# 1. The runner we recorded is alive and is our dev runner.
if kill -0 "$RUNNER_PID" 2>/dev/null && tr '\0' ' ' < "/proc/$RUNNER_PID/cmdline" | grep -q "dev-runner.ts dev --home-dir $RUN/home"; then
  ok "dev runner pid $RUNNER_PID is ours (--home-dir $RUN/home)"
else bad "dev runner $RUNNER_PID is not alive or not ours"; fi

# 2. Each port is listened to by a descendant of that runner, never by someone else.
descendants() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do echo "$c"; descendants "$c"; done; }
mine=" $RUNNER_PID $(descendants "$RUNNER_PID" | tr '\n' ' ')"
for port in "$SERVER_PORT" "$WEB_PORT"; do
  pid=$(ss -H -ltnp "sport = :$port" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [ -z "$pid" ]; then bad "nothing listens on :$port"
  elif [[ "$mine" == *" $pid "* ]]; then ok ":$port owned by our pid $pid"
  else bad ":$port is owned by pid $pid, which this run did not start"; fi
done

# 3. The server is ready (not just listening) and reports this checkout's version.
env_json=$(curl -s -m 60 "http://127.0.0.1:$SERVER_PORT/.well-known/t3/environment" || true)
if echo "$env_json" | grep -q '"serverVersion"'; then ok "server ready: $(echo "$env_json" | grep -o '"serverVersion":"[^"]*"')"; else bad "server did not answer /.well-known/t3/environment"; fi
code=$(curl -s -m 120 -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" || true)
[ "$code" = 200 ] && ok "web :$WEB_PORT serves the app shell" || bad "web :$WEB_PORT returned $code"

# 4. This instance must not have taken over a tailnet mapping.
if grep -q 'Tailscale Serve configured' "$RUN/dev.log"; then bad "instance configured Tailscale Serve"; else ok "no Tailscale Serve mapping from this instance"; fi
echo "tailscale serve now: $(tailscale serve status 2>/dev/null | sed -n 2p)"

# 5. Host pressure: a saturated host makes dev-mode pages time out, not the app fail.
echo "load: $(cut -d' ' -f1-3 /proc/loadavg), MemAvailable: $(awk '/MemAvailable/{printf "%d MB", $2/1024}' /proc/meminfo)"
exit $bad
