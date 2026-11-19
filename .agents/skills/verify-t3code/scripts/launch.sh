#!/usr/bin/env bash
# Start an isolated T3 Code dev instance (server + web) from this checkout.
# Usage: launch.sh [RUN_DIR]     (default: ~/.cache/verify-t3code/<utc timestamp>)
# Prints RUN_DIR; writes RUN_DIR/instance.env (ports, pids, pairing URL, mode 600).
# Run on ASUS, never the 8 GB laptop. Never run it against ~/.t3/userdata.
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RUN=${1:-$HOME/.cache/verify-t3code/$(date -u +%Y%m%dT%H%M%SZ)}
umask 077   # dev.log carries the pairing URL (a credential); keep everything owner-only
mkdir -p "$RUN/home" "$RUN/evidence"
RUN=$(cd "$RUN" && pwd)
case "$RUN$REPO" in *[[:space:]]*) echo "paths with spaces are not supported (RUN=$RUN REPO=$REPO)" >&2; exit 1;; esac

# Node: the repo wants ^24; /usr/bin/node 22 cannot run the TypeScript dev runner.
NODE_BIN=""
for c in "${T3_VERIFY_NODE:-}" "$(command -v node || true)" "$HOME/.cache/ship-live-node/bin/node"; do
  [ -x "$c" ] || continue
  major=$("$c" -p 'process.versions.node.split(".")[0]') || continue
  if [ "$major" -ge 24 ]; then NODE_BIN=$c; break; fi
done
[ -n "$NODE_BIN" ] || { echo "need Node >= 24 (set T3_VERIFY_NODE)" >&2; exit 1; }

[ -d "$REPO/node_modules/.pnpm" ] || { echo "run 'pnpm install --frozen-lockfile --ignore-scripts' in $REPO, then build node-pty (see SKILL.md Launch)" >&2; exit 1; }

# Provider boundary: a fake `cursor-agent` that answers `about` and hands `acp` to the
# repo's own mock ACP agent, so threads can run turns with no live provider and no spend.
mkdir -p "$RUN/bin" "$RUN/home/userdata" "$RUN/fixture"
cat > "$RUN/bin/cursor-agent" <<EOT
#!/bin/sh
case "\$1" in
  about) echo '{"cliVersion":"2026.11.0-verify","userEmail":"verify@example.invalid","subscriptionTier":"verify"}' ;;
  --version) echo "2026.11.0-verify" ;;
  *) T3_ACP_PROMPT_RESPONSE_TEXT="\${T3_ACP_PROMPT_RESPONSE_TEXT:-verify-t3code mock reply}" exec "$NODE_BIN" "$REPO/apps/server/scripts/acp-mock-agent.ts" "\$@" ;;
esac
EOT
chmod +x "$RUN/bin/cursor-agent"
[ -f "$RUN/home/userdata/settings.json" ] || cat > "$RUN/home/userdata/settings.json" <<EOT
{ "providers": { "cursor": { "enabled": true, "binaryPath": "$RUN/bin/cursor-agent" } } }
EOT

# Fixture project: a tiny git repo to add as a project.
if [ ! -d "$RUN/fixture/demo-app/.git" ]; then
  mkdir -p "$RUN/fixture/demo-app"
  git -C "$RUN/fixture/demo-app" init -q -b main
  printf '# demo-app\n\nFixture project for verify-t3code.\n' > "$RUN/fixture/demo-app/README.md"
  git -C "$RUN/fixture/demo-app" -c user.name=verify -c user.email=verify@example.invalid add -A
  git -C "$RUN/fixture/demo-app" -c user.name=verify -c user.email=verify@example.invalid commit -q -m "fixture: initial commit"
fi

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
SERVER_PORT=$(free_port)
# Reusable per-instance credential: lets every throwaway browser profile pair with the
# same startup URL. The URL carries it, so it lives in RUN_DIR/instance.env and dev.log
# (both mode 600); cleanup.sh redacts it from dev.log. It is never printed.
DEV_TOKEN=$(openssl rand -hex 32)

# Scrub every ambient T3CODE_* variable. A parent T3 session exports
# T3CODE_TAILSCALE_SERVE=1, T3CODE_PORT and T3CODE_HOME; inherited, they make this
# instance replace the live server's `tailscale serve` mapping and fight for its port.
unset_args=()
while IFS= read -r name; do unset_args+=(-u "$name"); done < <(compgen -e | grep '^T3CODE_' || true)

(
  cd "$REPO"
  PATH="$(dirname "$NODE_BIN"):$REPO/node_modules/.bin:$PATH" \
  exec setsid env "${unset_args[@]}" T3CODE_TAILSCALE_SERVE=0 "T3CODE_DEV_AUTH_TOKEN=$DEV_TOKEN" \
    node scripts/dev-runner.ts dev --home-dir "$RUN/home" --port "$SERVER_PORT" \
    > "$RUN/dev.log" 2>&1 < /dev/null
) &
RUNNER_PID=$!

write_env() {
  cat > "$RUN/instance.env" <<EOT
RUN_DIR=$RUN
REPO=$REPO
NODE_BIN=$NODE_BIN
SERVER_PORT=$SERVER_PORT
WEB_PORT=${WEB_PORT:-0}
RUNNER_PID=$RUNNER_PID
PAIR_URL=${PAIR_URL:-}
EOT
}
# Record the runner at once so a failed launch can still be stopped by cleanup.sh.
write_env
fail() { echo "$1" >&2; "$(dirname "$0")/cleanup.sh" "$RUN" --keep-home >&2 || true; exit "${2:-1}"; }

for _ in $(seq 1 120); do
  grep -q 'pairingUrl:' "$RUN/dev.log" 2>/dev/null && break
  kill -0 "$RUNNER_PID" 2>/dev/null || fail "dev runner exited; see $RUN/dev.log"
  sleep 1
done
PAIR_URL=$(grep -o 'pairingUrl: .*' "$RUN/dev.log" | head -1 | sed 's/pairingUrl: //' || true)
WEB_PORT=$(grep -o 'webPort=[0-9]*' "$RUN/dev.log" | head -1 | cut -d= -f2 || true)
[ -n "$PAIR_URL" ] && [ -n "$WEB_PORT" ] || fail "no pairing URL or web port in $RUN/dev.log within 120 s"
if grep -q 'Tailscale Serve configured' "$RUN/dev.log"; then
  fail "ABORT: instance configured Tailscale Serve (stopped it); check 'tailscale serve status' and restore the live mapping" 2
fi
write_env
echo "$RUN"
