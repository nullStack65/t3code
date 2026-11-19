#!/usr/bin/env bash
# Machine-failover drill: start units of work on machine A, crash A, and check that machine B
# takes them over and finishes them, and that A, back online, shows B's finished result.
# Both "machines" are isolated T3 servers on this host, each with its own home, clone of a
# shared bare origin and a free mock ACP provider. Never touches ~/.t3 or a live lane.
# Usage: machine-failover-drill.sh [--run-dir DIR] [--units N] [--takeover-deadline SECONDS]
#                                  [--return-settle SECONDS] [--strict] [--keep]
# Exit: 0 pass (or, without --strict, failures exactly match the open gaps file),
#       1 unexpected failure, 2 usage or environment error, 3 an open gap now passes (XPASS).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
GAPS_FILE="$HERE/machine-failover-drill.gaps"
RUN="" UNITS=4 TAKEOVER_DEADLINE=120 RETURN_SETTLE=45 STRICT=0 KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir) RUN="$2"; shift 2 ;;
    --units) UNITS="$2"; shift 2 ;;
    --takeover-deadline) TAKEOVER_DEADLINE="$2"; shift 2 ;;
    --return-settle) RETURN_SETTLE="$2"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$UNITS" -ge 2 ] 2>/dev/null || { echo "--units must be at least 2 (one finished, one in flight)" >&2; exit 2; }
RUN=${RUN:-${XDG_CACHE_HOME:-$HOME/.cache}/t3-machine-failover-drill/$(date -u +%Y%m%dT%H%M%SZ)}
umask 077
mkdir -p "$RUN/evidence" "$RUN/bin"
RUN=$(cd "$RUN" && pwd)
case "$RUN" in "$HOME/.t3"|"$HOME/.t3/"*) echo "refusing a run dir inside ~/.t3" >&2; exit 2 ;; esac
case "$RUN$REPO" in *[[:space:]]*) echo "paths with spaces are not supported" >&2; exit 2 ;; esac
[ -d "$REPO/node_modules/.pnpm" ] || { echo "run 'vp i' in $REPO first" >&2; exit 2; }

NODE_BIN=""
for c in "${T3_DRILL_NODE:-}" "$(command -v node || true)" "$HOME"/.local/share/vite-plus/js_runtime/node/*/bin/node; do
  [ -x "$c" ] || continue
  major=$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  if [ "$major" -ge 24 ]; then NODE_BIN=$c; break; fi
done
[ -n "$NODE_BIN" ] || { echo "need Node >= 24 (set T3_DRILL_NODE)" >&2; exit 2; }

# An inherited T3CODE_HOME, T3CODE_PORT or T3CODE_TAILSCALE_SERVE would aim the drill at the
# live server's state or its tailnet mapping.
SCRUB=()
while IFS= read -r name; do SCRUB+=(-u "$name"); done < <(compgen -e | grep '^T3CODE_' || true)
# A command that forgets --base-dir lands on an empty guard home, never on the live ~/.t3.
t3() { env "${SCRUB[@]}" T3CODE_HOME="$RUN/no-base-dir-given" "$NODE_BIN" "$REPO/apps/server/src/bin.ts" "$@"; }

RESULTS="$RUN/evidence/results.tsv"
: > "$RESULTS"
log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$RUN/evidence/drill.log" >&2; }
record() { # id status detail
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
  log "$2 $1: $3"
}
sanity() { record "$1" FAIL "$2"; log "sanity check failed; the drill cannot judge the bar"; exit 1; }

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

# --- Machines -----------------------------------------------------------------------------
# A's in-flight units hang, like long agent turns; B's mock answers, so work B takes over can finish.
write_agent() { # path hang(0|1)
  cat > "$1" <<EOT
#!/bin/sh
T3_ACP_HANG_PROMPT_FOREVER=$2 exec "$NODE_BIN" "$REPO/apps/server/scripts/acp-mock-agent.ts" "\$@"
EOT
  chmod +x "$1"
}
write_agent "$RUN/bin/agent-answers" 0
write_agent "$RUN/bin/agent-hangs" 1

setup_machine() { # name hang-agent-path
  local home="$RUN/$1/home"
  mkdir -p "$home/userdata"
  cat > "$home/userdata/settings.json" <<EOT
{ "linkedEnvironmentsEnabled": true,
  "providerInstances": {
    "drillDone": { "displayName": "Drill (answers)", "driver": "acpRegistry",
      "config": { "source": "local", "commandPath": "$RUN/bin/agent-answers", "commandArgs": [] } },
    "drillLong": { "displayName": "Drill (long turn)", "driver": "acpRegistry",
      "config": { "source": "local", "commandPath": "$2", "commandArgs": [] } } } }
EOT
  git clone -q "$RUN/origin.git" "$RUN/$1/project"
}

git init -q --bare -b main "$RUN/origin.git"
git init -q -b main "$RUN/seed"
git -C "$RUN/seed" remote add origin "$RUN/origin.git"
printf '# drill-project\n\nDisposable project for the machine-failover drill.\n' > "$RUN/seed/README.md"
git -C "$RUN/seed" add -A
git -C "$RUN/seed" -c user.name=drill -c user.email=drill@example.invalid commit -q -m "drill: initial commit"
git -C "$RUN/seed" push -q origin HEAD:main
setup_machine a "$RUN/bin/agent-hangs"
setup_machine b "$RUN/bin/agent-answers"

declare -A PORT PGID
PORT[a]=$(free_port)
PORT[b]=$(free_port)

start_machine() { # name
  local home="$RUN/$1/home"
  set -m # own process group, so a crash can take the server and its provider children together
  env "${SCRUB[@]}" T3CODE_TAILSCALE_SERVE=0 PATH="$(dirname "$NODE_BIN"):$PATH" \
    "$NODE_BIN" "$REPO/apps/server/src/bin.ts" serve --base-dir "$home" \
    --port "${PORT[$1]}" --host 127.0.0.1 --no-browser >> "$RUN/$1/server.log" 2>&1 < /dev/null &
  PGID[$1]=$!
  set +m
  for _ in $(seq 1 120); do
    ss -H -ltn "sport = :${PORT[$1]}" | grep -q . && return 0
    kill -0 "${PGID[$1]}" 2>/dev/null || sanity "S0.$1-start" "server $1 exited; see $RUN/$1/server.log"
    sleep 1
  done
  sanity "S0.$1-start" "server $1 not listening within 120 s"
}

ours() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q -- "--base-dir $RUN/$2/home"; }
crash_machine() { # name: SIGKILL the whole group, as when the machine loses power
  local pg=${PGID[$1]:-}
  [ -n "$pg" ] && ours "$pg" "$1" || return 0
  kill -9 -- "-$pg" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 0.5; done
  PGID[$1]=""
}
stop_machine() { # name: orderly stop
  local pg=${PGID[$1]:-}
  [ -n "$pg" ] && ours "$pg" "$1" || return 0
  kill -TERM -- "-$pg" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 0.5; done
  kill -9 -- "-$pg" 2>/dev/null || true
  PGID[$1]=""
}
cleanup() {
  stop_machine a; stop_machine b
  sed -i -E 's/token=[0-9A-Za-z._-]+/token=<redacted>/g' "$RUN"/*/server.log 2>/dev/null || true
  rm -f "$RUN/evidence/pairing.json"
  [ "$KEEP" = 1 ] || rm -rf "$RUN/a/home" "$RUN/b/home" "$RUN/a/project" "$RUN/b/project" "$RUN/seed"
}
trap cleanup EXIT

threads_json() { # machine -> JSON array of the project's threads
  t3 thread list --base-dir "$RUN/$1/home" --project "${PROJECT[$1]}" --json 2>/dev/null || echo '[]'
}
# Prints "<status>\t<threadId>" for each unit title, or "absent" when the machine has no such thread.
unit_states() { # machine
  threads_json "$1" | python3 -c '
import json, sys
threads = json.load(sys.stdin)
for title in sys.argv[1:]:
    match = [t for t in threads if t.get("title") == title]
    print("absent\t-" if not match else match[0]["status"] + "\t" + match[0]["threadId"])
' "${TITLES[@]}"
}
count_status() { # machine status... -> count of units in any of these statuses
  local m=$1; shift
  unit_states "$m" | awk -F'\t' -v want=" $* " 'index(want, " " $1 " ") { n++ } END { print n + 0 }'
}

# --- Phase 0: two machines, linked both ways ------------------------------------------------
log "run dir $RUN; node $NODE_BIN; units $UNITS"
start_machine a
start_machine b
declare -A PROJECT
for m in a b; do
  PROJECT[$m]=$(t3 project add "$RUN/$m/project" --base-dir "$RUN/$m/home" | sed -n 's/^Added project \([^ ]*\) .*/\1/p')
  [ -n "${PROJECT[$m]}" ] || sanity "S0.$m-project" "could not add the project on $m"
done
link() { # from to
  t3 auth pairing create --base-dir "$RUN/$2/home" --ttl 10m --label "drill $1" --json > "$RUN/evidence/pairing.json" \
    || sanity "S0.link-$1-$2" "could not mint a pairing code on $2"
  local code
  code=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["credential"])' "$RUN/evidence/pairing.json")
  rm -f "$RUN/evidence/pairing.json"
  t3 environment link "http://127.0.0.1:${PORT[$2]}" --pairing-code "$code" --access full-access \
    --base-dir "$RUN/$1/home" > /dev/null 2>> "$RUN/evidence/drill.log" \
    || sanity "S0.link-$1-$2" "could not link $1 to $2"
}
link a b
link b a
record S0.setup PASS "A and B serve, each has the project, and each links the other"

# --- Phase 1: N units on A: unit 0 finishes, the rest are in flight ----------------------
RUN_ID=$(basename "$RUN")
TITLES=()
for k in $(seq 0 $((UNITS - 1))); do TITLES+=("mf-drill $RUN_ID unit $k"); done
t3 thread start "${PROJECT[a]}" "Unit 0 of the failover drill: answer once." --title "${TITLES[0]}" \
  --base-dir "$RUN/a/home" --provider drillDone --model default --request-id "mf-$RUN_ID-0" --wait --json > "$RUN/evidence/unit-0.json" \
  || sanity S1.units "unit 0 did not finish on A"
for k in $(seq 1 $((UNITS - 1))); do
  t3 thread start "${PROJECT[a]}" "Unit $k of the failover drill: long turn." --title "${TITLES[$k]}" \
    --base-dir "$RUN/a/home" --provider drillLong --model default --request-id "mf-$RUN_ID-$k" --json > "$RUN/evidence/unit-$k.json" \
    || sanity S1.units "unit $k did not start on A"
done
for _ in $(seq 1 60); do
  [ "$(count_status a running)" -ge $((UNITS - 1)) ] && break
  sleep 1
done
unit_states a > "$RUN/evidence/a-before-crash.tsv"
[ "$(count_status a completed)" -ge 1 ] && [ "$(count_status a running)" -ge $((UNITS - 1)) ] \
  || sanity S1.units "A does not show 1 finished and $((UNITS - 1)) running units ($(tr '\t\n' ' ;' < "$RUN/evidence/a-before-crash.tsv"))"
# What the in-flight units last pushed: the checkpoint a takeover must resume from, not restart.
for k in $(seq 1 $((UNITS - 1))); do
  git -C "$RUN/a/project" checkout -q -b "mf-drill/unit-$k" origin/main
  printf 'unit %s progress before the crash\n' "$k" > "$RUN/a/project/unit-$k.txt"
  git -C "$RUN/a/project" add "unit-$k.txt"
  git -C "$RUN/a/project" -c user.name=drill -c user.email=drill@example.invalid commit -q -m "unit $k: checkpoint"
  git -C "$RUN/a/project" push -q origin "mf-drill/unit-$k"
  git -C "$RUN/a/project" checkout -q main
done
record S1.units PASS "A shows unit 0 completed and $((UNITS - 1)) units running; checkpoints pushed to origin"

# --- Phase 2: A goes down ------------------------------------------------------------------
crash_machine a
ss -H -ltn "sport = :${PORT[a]}" | grep -q . && sanity S2.crash "A still listens after SIGKILL"
record S2.crash PASS "A's server and provider processes killed with SIGKILL"

# --- Phase 3: B takes over -----------------------------------------------------------------
deadline=$((SECONDS + TAKEOVER_DEADLINE))
while [ $SECONDS -lt $deadline ]; do
  [ "$(count_status b completed)" -ge "$UNITS" ] && break
  sleep 5
done
unit_states b > "$RUN/evidence/b-after-takeover.tsv"
present=$(awk -F'\t' '$1 != "absent"' "$RUN/evidence/b-after-takeover.tsv" | wc -l)
claimed=$(awk -F'\t' '$1 != "absent" && $1 != "idle"' "$RUN/evidence/b-after-takeover.tsv" | sed 1d | wc -l)
done_b=$(count_status b completed)
summary_b="$(tr '\t\n' ' ;' < "$RUN/evidence/b-after-takeover.tsv")"
[ "$present" -ge "$UNITS" ] && record C1.record PASS "B holds all $UNITS units while A is down" \
  || record C1.record FAIL "B holds $present of $UNITS units while A is down ($summary_b)"
[ "$claimed" -ge $((UNITS - 1)) ] && record C2.lease PASS "B claimed A's $((UNITS - 1)) in-flight units within ${TAKEOVER_DEADLINE}s" \
  || record C2.lease FAIL "B claimed $claimed of $((UNITS - 1)) in-flight units within ${TAKEOVER_DEADLINE}s of A going down"
resumed=0
while IFS=$'\t' read -r status thread; do
  [ "$status" = completed ] || continue
  dir=$(t3 thread show "$thread" --base-dir "$RUN/b/home" --json 2>/dev/null \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["thread"].get("worktreePath") or "")' || true)
  dir=${dir:-$RUN/b/project}
  for k in $(seq 1 $((UNITS - 1))); do
    git -C "$dir" fetch -q origin "mf-drill/unit-$k" 2>/dev/null || continue
    git -C "$dir" merge-base --is-ancestor FETCH_HEAD HEAD 2>/dev/null && { resumed=$((resumed + 1)); break; }
  done
done < <(sed 1d "$RUN/evidence/b-after-takeover.tsv")
[ "$done_b" -ge "$UNITS" ] && [ "$resumed" -ge $((UNITS - 1)) ] \
  && record C3.takeover PASS "B finished all $UNITS units, $resumed resumed from their pushed checkpoint" \
  || record C3.takeover FAIL "B finished $done_b of $UNITS units; $resumed of $((UNITS - 1)) resumed from a pushed checkpoint"

# --- Phase 4: A comes back -----------------------------------------------------------------
start_machine a
sleep "$RETURN_SETTLE"
unit_states a > "$RUN/evidence/a-after-return.tsv"
stale=$(count_status a running starting queued preparing)
done_a=$(count_status a completed)
summary_a="$(tr '\t\n' ' ;' < "$RUN/evidence/a-after-return.tsv")"
[ "$stale" -eq 0 ] && record C4.fence PASS "A, back online, runs none of the units B owns" \
  || record C4.fence FAIL "A, back online, is running its stale copy of $stale units ($summary_a)"
[ "$done_a" -ge "$UNITS" ] && record C4.reconcile PASS "A shows all $UNITS units completed, matching B" \
  || record C4.reconcile FAIL "A shows $done_a of $UNITS units completed after ${RETURN_SETTLE}s back online"

# --- Verdict -------------------------------------------------------------------------------
failed=$(awk -F'\t' '$2 == "FAIL" { print $1 }' "$RESULTS" | sort)
open=$(grep -v '^\s*#' "$GAPS_FILE" | awk 'NF { print $1 }' | sort)
unexpected=$(comm -23 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$open" | sed '/^$/d'))
xpass=$(comm -13 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$open" | sed '/^$/d'))
log "results: $RESULTS"
if [ "$STRICT" = 1 ]; then
  [ -z "$failed" ] && { log "PASS: the machine-failover bar holds"; exit 0; }
  log "FAIL (strict): $(echo $failed)"; exit 1
fi
[ -n "$unexpected" ] && { log "UNEXPECTED FAIL: $(echo $unexpected) (not in $GAPS_FILE)"; exit 1; }
[ -n "$xpass" ] && { log "XPASS: $(echo $xpass) now pass; remove them from $GAPS_FILE"; exit 3; }
log "EXPECTED FAIL: $(echo $failed) match the open gaps in $GAPS_FILE"
exit 0
