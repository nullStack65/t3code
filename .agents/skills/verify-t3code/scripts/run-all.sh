#!/usr/bin/env bash
# Launch an isolated instance and its browser, wait until it is really ready, run Doctor,
# seed the baseline, then drive threads and the other surfaces.
# Usage: run-all.sh [RUN_DIR]     Leaves the instance running; stop it with cleanup.sh RUN_DIR.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=$("$HERE/launch.sh" ${1:+"$1"} | tail -1)
# shellcheck disable=SC1091
. "$RUN/instance.env"
NODE=$(dirname "$NODE_BIN")
export PATH="$NODE:$PATH"
node "$HERE/browser.mjs" up "$RUN"
# Dev mode compiles on first request; wait until the app shell answers (can take minutes on a busy host).
for _ in $(seq 1 60); do
  [ "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/")" = 200 ] && break
  sleep 5
done
"$HERE/doctor.sh" "$RUN"
node "$HERE/seed.mjs" "$RUN"
node "$HERE/drive-threads.mjs" "$RUN"
node "$HERE/drive-surfaces.mjs" "$RUN"
echo "evidence: $RUN/evidence (observed.log + screenshots)"
