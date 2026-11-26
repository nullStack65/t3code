#!/usr/bin/env bash
# Stop the instance launch.sh started (by the PIDs it recorded and their descendants,
# never by process name), then delete its scratch state and keep RUN_DIR/evidence.
# Usage: cleanup.sh RUN_DIR [--keep-home]
set -euo pipefail
RUN=${1:?usage: cleanup.sh RUN_DIR [--keep-home]}
RUN=$(cd "$RUN" && pwd)   # same normalized path launch.sh and browser.mjs recorded
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
  # Only trust the recorded PID while its command line still has this run's --home-dir.
  if tr '\0' ' ' < "/proc/$RUNNER_PID/cmdline" | grep -q -- "--home-dir $RUN/home"; then
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
  [ "$port" != 0 ] || continue
  if ss -H -ltn "sport = :$port" | grep -q .; then echo "WARNING: port $port still listening (not ours to kill by name)" >&2; fi
done
[ "${2:-}" = "--keep-home" ] || rm -rf "$RUN/home"
# dev.log holds the pairing URL token; keep the log but redact the credential.
[ ! -f "$RUN/dev.log" ] || sed -i -E 's/token=[0-9A-Za-z]+/token=<redacted>/g' "$RUN/dev.log"
rm -f "$RUN/instance.env"
echo "stopped; evidence kept in $RUN/evidence"
