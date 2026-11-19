#!/usr/bin/env bash
# Stop the instance launch.sh started (by the PIDs it recorded and their descendants,
# never by process name), then delete its scratch state and keep RUN_DIR/evidence.
# Usage: cleanup.sh RUN_DIR [--keep-home]
set -euo pipefail
RUN=${1:?usage: cleanup.sh RUN_DIR [--keep-home]}
[ -f "$RUN/instance.env" ] || { echo "no $RUN/instance.env" >&2; exit 1; }
# shellcheck disable=SC1091
. "$RUN/instance.env"

descendants() { local p=$1 c; for c in $(pgrep -P "$p" 2>/dev/null || true); do echo "$c"; descendants "$c"; done; }

# The headless Chromium browser.mjs started: kill only the recorded PID, and only while
# its command line still points at this run's profile.
if [ -f "$RUN/browser.env" ]; then
  BROWSER_PID=$(sed -n 's/^BROWSER_PID=//p' "$RUN/browser.env")
  if [ -n "$BROWSER_PID" ] && tr '\0' ' ' < "/proc/$BROWSER_PID/cmdline" 2>/dev/null | grep -q -- "--user-data-dir=$RUN/profile"; then
    BP="$(descendants "$BROWSER_PID" | tac | tr '\n' ' ') $BROWSER_PID"
    # shellcheck disable=SC2086
    kill $BP 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    for p in $BP; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; done
  fi
  rm -rf "$RUN/profile" "$RUN/browser.env"
fi

if kill -0 "$RUNNER_PID" 2>/dev/null; then
  # Only trust the recorded PID if it still runs our dev runner from this checkout.
  if tr '\0' ' ' < "/proc/$RUNNER_PID/cmdline" | grep -q 'dev-runner.ts dev'; then
    PIDS="$(descendants "$RUNNER_PID" | tac | tr '\n' ' ') $RUNNER_PID"
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      alive=0; for p in $PIDS; do kill -0 "$p" 2>/dev/null && alive=1; done
      [ $alive = 0 ] && break; sleep 0.5
    done
    # shellcheck disable=SC2086
    for p in $PIDS; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; done
  else
    echo "PID $RUNNER_PID is no longer our dev runner; not killing it" >&2
  fi
fi

for port in "$SERVER_PORT" "$WEB_PORT"; do
  if ss -H -ltn "sport = :$port" | grep -q .; then echo "WARNING: port $port still listening (not ours to kill by name)" >&2; fi
done
[ "${2:-}" = "--keep-home" ] || rm -rf "$RUN/home"
rm -f "$RUN/instance.env" "$RUN/dev.pid"
echo "stopped; evidence kept in $RUN/evidence"
