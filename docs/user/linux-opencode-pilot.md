# Linux x86_64 OpenCode pilot (source-prepared, not yet executed)

> **Status: preparation only.** No host was confirmed, no artifact was
> installed, and no service was started or activated. Host size/provider and
> account state remain **UNKNOWN**. This page replaces the draft "Stage C"
> handoff in the PR body; that draft command is superseded and must not be run.

This is a bounded, receipt-gated handoff for the single persistent Linux
x86_64 environment. It intentionally contains no merge, release, install,
activation, purchase, provisioning, network/auth change, or live model test.

## 1. Pinned identities

Every identity below is exact and independently recorded. Nothing is
discovered from a moving branch, `latest`, or a release channel.

| Component                           | Identity                                                                                                                                       | Notes                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T3 base                             | `419f7574010c066a56974fc9e3ac0709a08efb33`                                                                                                     | `origin/main` at preparation                                                                                                |
| T3 source repair                    | branch `fix/opencode-missing-session-continuation-20260928`                                                                                    | **not** in any published binary                                                                                             |
| Installer source                    | `nullStack65/t3code` `scripts/install.sh` @ `419f7574010c066a56974fc9e3ac0709a08efb33`                                                         | reviewed bytes, see §3                                                                                                      |
| Installer SHA-256                   | `e2462ba995aaa2773872f1fe9f2ccee53094d4ba6a4207dbc5115a65710b8a0a` (9838 bytes)                                                                | recomputed from the pinned commit                                                                                           |
| Published baseline release          | tag `v0.0.43`, published `2026-09-28`                                                                                                          | binary source `929b63795e7696855ada61de5fd359dc2f51da78`, distinct from main                                                |
| Baseline Linux archive              | `t3-0.0.43-linux-x64.tar.gz`, asset ID `595218686`, 64106782 bytes, SHA-256 `a8d8a519dc572451f19167246fdba0d8eb92cf7d53ec498097b0b3e636c81772` | **does not contain this fix**                                                                                               |
| Pilot candidate release             | **UNISSUED**                                                                                                                                   | a repair-containing release does not exist yet                                                                              |
| Canonical config                    | `nullStack65/closura-agent-config` master `b60a29788c62a242b5ca3968075879956b0294ba`                                                           | `harnesses/setup/adapters.yaml#opencode`, `company/agent-environment/contract/candidate/environment-release.candidate.yaml` |
| OpenCode version                    | `1.17.9`                                                                                                                                       | the only version with a probed MCP rendering; see §2                                                                        |
| OpenCode linux-x64 artifact SHA-256 | **UNRECORDED**                                                                                                                                 | required receipt; see §2                                                                                                    |
| Provider route                      | native OpenCode CLI, own auth                                                                                                                  | loopback gateway contract is source-only and not a prerequisite                                                             |
| Recovery direction                  | host-level Tailscale primary (ENV-1 `closura-agent-config#237`)                                                                                | Cloudflare conditional/unselected; keep T3 private                                                                          |

**Baseline vs. repair.** `v0.0.43` predates the missing-session repair. A future
artifact containing the repair must be built from a commit at or after this PR.
Do not relabel `v0.0.43`, current `main`, or this patch as containing the fix,
and do not move its tag or assets.

## 2. OpenCode input and the floor reconciliation

- T3 runtime accepts `opencode >= 1.14.19` (`MINIMUM_OPENCODE_VERSION` in
  `apps/server/src/provider/opencodeRuntime.ts`).
- The Closura setup adapter only declares a **probed** MCP rendering for
  `>=1.17.9 <2.0.0`, probed at `1.17.9`; earlier 1.x minors are not claimed and
  fail closed, and 2.x fails closed
  (`harnesses/setup/adapters.yaml#opencode` @ `b60a297`).
- Therefore the managed pilot input is the **exact** version `1.17.9`. The
  runtime floor `1.14.19` is a T3 acceptance minimum, not a qualified managed
  input; do not use `1.14.19`–`1.17.8`.
- The provider profile is Windows/macOS only; there is **no Linux provider
  binding**. The environment candidate records
  `linux-x64: { binary: null, version: null }` for `opencode` and no artifact
  digest. The native OpenCode route does not depend on that loopback contract.

**Precise missing receipts (owners unchanged).**

| Missing receipt                                                                 | Owner                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Exact OpenCode `1.17.9` linux-x64 artifact SHA-256 and size                     | setup/adapter owner (`harnesses/setup/adapters.yaml#opencode`) |
| `environment-release.candidate.yaml` `opencode.linux-x64` binary/version/digest | agent-environment candidate owner (ENV-1)                      |
| Repair-containing T3 release (version, archive size/hash, binary source)        | T3 release owner                                               |
| Target host identity and account/access confirmation                            | ENV-1                                                          |

No hash, route, or Linux qualification is invented here.

## 3. Receipt-gated dormant install (guards fail before mutation)

This reuses the reviewed installer mechanism; it is not a new downloader. The
guard **exits before any download, extraction, or symlink** while a required
receipt is unset/`UNISSUED`, then verifies the installer and archive digests it
fetched. It then exposes **only** those verified bytes through a private
loopback staging mirror and points the installer's existing
`T3CODE_RELEASE_BASE_URL` at it. There is no second upstream download, an
ambient `T3CODE_RELEASE_BASE_URL` cannot redirect the fetch, and a stale
`.install-complete` marker cannot skip consumption of the verified archive. Run
as an ordinary user, never root. This is a dormant install: it does not start a
service. Requires `curl`, `tar`, `sha256sum` (or `shasum`), and `python3` for
the private staging mirror.

The installer and archive precheck sources are overridable **only** through
`T3_INSTALLER_SOURCE_URL` / `T3_ARCHIVE_SOURCE_URL`; those bytes remain bound by
`T3_INSTALLER_SHA256` / `T3_ARCHIVE_SHA256`+`T3_ARCHIVE_SIZE`, which the retained
offline regression test (`scripts/pilot-handoff.test.ts`) uses with small local
fixtures. The installer itself always runs from the verified local copy.

**What this binds.** The guard binds the _bytes_ of the installer and of the
release archive (`size` + `SHA-256`) and refuses a stale marker, so the archive
the installer extracts is exactly the archive this guard verified. It does
**not** establish build, platform, or provenance for the binary inside that
archive: `T3_BINARY_SOURCE` and `OPENCODE_LINUX_SHA256` are format-checked
_recorded_ receipts, not verified bindings. A nonempty `T3_BINARY_SOURCE` is a
recorded commit, not a proven build origin, and the OpenCode `1.17.9` linux-x64
artifact remains **UNRECORDED** (§2) until its owner supplies the digest. Do not
read this guard as a Linux qualification.

```sh
#!/bin/sh
# Dormant, receipt-gated install guard. Fails closed before any mutation.
set -eu

# Reviewed installer bytes, pinned by full commit + independently recorded digest.
T3_INSTALLER_REPO="${T3_INSTALLER_REPO:-nullStack65/t3code}"
T3_INSTALLER_COMMIT="${T3_INSTALLER_COMMIT:-419f7574010c066a56974fc9e3ac0709a08efb33}"
T3_INSTALLER_SHA256="${T3_INSTALLER_SHA256:-e2462ba995aaa2773872f1fe9f2ccee53094d4ba6a4207dbc5115a65710b8a0a}"
T3_INSTALLER_SOURCE_URL="${T3_INSTALLER_SOURCE_URL:-https://raw.githubusercontent.com/${T3_INSTALLER_REPO}/${T3_INSTALLER_COMMIT}/scripts/install.sh}"

# Pilot-candidate receipts. UNISSUED until a release owner records them.
T3_VERSION="${T3_VERSION:-UNISSUED}"
T3_ARCHIVE_SHA256="${T3_ARCHIVE_SHA256:-UNISSUED}"
T3_ARCHIVE_SIZE="${T3_ARCHIVE_SIZE:-UNISSUED}"
T3_BINARY_SOURCE="${T3_BINARY_SOURCE:-UNISSUED}"
OPENCODE_VERSION="${OPENCODE_VERSION:-UNISSUED}"
OPENCODE_LINUX_SHA256="${OPENCODE_LINUX_SHA256:-UNISSUED}"
T3_ARCHIVE_SOURCE_URL="${T3_ARCHIVE_SOURCE_URL:-https://github.com/${T3_INSTALLER_REPO}/releases/download/v${T3_VERSION}/t3-${T3_VERSION}-linux-x64.tar.gz}"

die() { printf 'refusing to install: %s\n' "$1" >&2; exit "$2"; }
is_hex() { printf '%s' "$1" | grep -Eq "^[0-9a-f]{$2}$"; }
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for name in T3_VERSION T3_ARCHIVE_SHA256 T3_ARCHIVE_SIZE T3_BINARY_SOURCE \
            OPENCODE_VERSION OPENCODE_LINUX_SHA256; do
  eval "value=\${$name}"
  case "$value" in
    ""|UNISSUED)
      die "receipt $name is unset/UNISSUED" 78 ;;
  esac
done
is_hex "$T3_INSTALLER_SHA256" 64 || die "T3_INSTALLER_SHA256 is not a 64-hex digest" 65
is_hex "$T3_ARCHIVE_SHA256" 64 || die "T3_ARCHIVE_SHA256 is not a 64-hex digest" 65
is_hex "$T3_BINARY_SOURCE" 40 || die "T3_BINARY_SOURCE is not a 40-hex commit" 65
is_hex "$OPENCODE_LINUX_SHA256" 64 || die "OPENCODE_LINUX_SHA256 is not a 64-hex digest" 65
printf '%s' "$T3_ARCHIVE_SIZE" | grep -Eq '^[0-9]+$' || die "T3_ARCHIVE_SIZE is not an integer" 65

work="$(mktemp -d)"; server_pid=
cleanup() { [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM

# 1. Fetch the installer at the pinned COMMIT (never `main`) and verify its
#    exact bytes before it can run.
curl -fsSL "$T3_INSTALLER_SOURCE_URL" -o "$work/install.sh"
[ "$(checksum "$work/install.sh")" = "$T3_INSTALLER_SHA256" ] || die "installer digest mismatch" 65

# 2. Independently download and verify the release archive BEFORE the installer
#    consumes it. The release's own SHA256SUMS sits beside the mutable archive
#    and is not trusted alone; T3_ARCHIVE_SHA256/SIZE are the authoritative receipt.
curl -fsSL "$T3_ARCHIVE_SOURCE_URL" -o "$work/archive.tar.gz"
[ "$(wc -c < "$work/archive.tar.gz" | tr -d ' ')" = "$T3_ARCHIVE_SIZE" ] || die "archive size mismatch" 65
[ "$(checksum "$work/archive.tar.gz")" = "$T3_ARCHIVE_SHA256" ] || die "archive digest mismatch" 65

# 3. Expose ONLY the verified bytes through a private loopback staging mirror,
#    so the installer's own download extracts exactly the archive just verified.
archive_name="t3-${T3_VERSION}-linux-x64.tar.gz"
mirror="$work/mirror"; mkdir -p "$mirror/v${T3_VERSION}"
cp "$work/archive.tar.gz" "$mirror/v${T3_VERSION}/${archive_name}"
printf '%s  %s\n' "$T3_ARCHIVE_SHA256" "$archive_name" > "$mirror/v${T3_VERSION}/SHA256SUMS"
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
( cd "$mirror" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 ) &
server_pid=$!
i=0
while ! curl -fsS "http://127.0.0.1:${port}/v${T3_VERSION}/SHA256SUMS" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 100 ] || die "staging mirror did not start" 69
  sleep 0.1
done

# 4. Refuse a stale marker: the verified bytes must actually be consumed, never
#    skipped because something already looks installed.
t3_home="${T3CODE_HOME:-$HOME/.t3}"
if [ -e "${t3_home}/runtime/versions/${T3_VERSION}/.install-complete" ]; then
  die "isolated target already has an install marker for ${T3_VERSION}; use an empty target" 65
fi

# 5. Run the reviewed, digest-verified installer. These assignments deliberately
#    override any ambient T3CODE_RELEASE_BASE_URL.
T3CODE_VERSION="$T3_VERSION" \
T3CODE_RELEASE_REPOSITORY="$T3_INSTALLER_REPO" \
T3CODE_RELEASE_BASE_URL="http://127.0.0.1:${port}" \
T3CODE_HOME="$t3_home" \
T3CODE_INSTALL_BIN_DIR="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}" \
sh "$work/install.sh"
```

The `v0.0.43` baseline can be installed the same way for a **non-candidate**
smoke check by setting `T3_VERSION=0.0.43`,
`T3_ARCHIVE_SIZE=64106782`,
`T3_ARCHIVE_SHA256=a8d8a519dc572451f19167246fdba0d8eb92cf7d53ec498097b0b3e636c81772`,
and `T3_BINARY_SOURCE=929b63795e7696855ada61de5fd359dc2f51da78`. It does **not**
contain the repair; do not present it as the pilot candidate.

## 4. Stages (all unexecuted)

- **A — target verification (read-only).** Confirm `uname -srm` is
  `Linux … x86_64`, a live `systemctl --user status`, and record disk/RAM.
  `which opencode && opencode --version` must be the exact pinned `1.17.9`.
  State UNKNOWN rather than inventing a host id.
- **B — access preparation.** Join the host to the tailnet under the existing
  ENV-1 Tailscale direction. Never request credentials in chat or GitHub and
  never invent an IP/host id. Keep T3 loopback/private; production-control
  credentials stay outside ordinary coding authority. An ordinary user owns the
  install.
- **C — dormant artifact installation.** Run the §3 guard with the receipts set.
  No service is started; `install.sh` only downloads, verifies, extracts, and
  symlinks.
- **D — activation (explicitly out of scope).** `t3 service install` **starts**
  the service and may enable lingering. For an attended run use foreground
  `t3 serve`. Recovery/stop: `t3 service status`, `t3 service restart`,
  `t3 service uninstall`, and `sudo loginctl enable-linger "$(id -un)"` only if
  status reports linger-disabled.

## 5. Bounded local measurement (one week, no prompts/secrets)

One sample every **60 s**, hard stop after **604800 s**, cumulative output
capped at **50 MiB**. Existing tools only; no daemon or dashboard. Any metric
that cannot be read is recorded `unavailable`, never guessed. The cap is checked
on the exact UTF-8 byte length **before** the line is written, and the terminal
status text counts toward it, so the file can never exceed the cap. Each probe
is a bounded subprocess (killed at `MEASURE_PROBE_TIMEOUT`), and the sleep never
runs past the hard stop. `df` measures **filesystem capacity/free space**, not
the growth of any individual directory; no recursive directory scans are
performed. CPU counters are recorded as raw, named `/proc/stat` fields including
`steal`; memory uses `MemAvailable` (not `MemFree`) and records swap where
available; memory pressure (PSI) is recorded where available.

```sh
#!/bin/sh
# Bounded one-week sampler. Reads only counters; never prompts, args, or content.
interval="${MEASURE_INTERVAL:-60}"; max_seconds="${MEASURE_MAX_SECONDS:-604800}"
cap_bytes="${MEASURE_CAP_BYTES:-52428800}"; probe_timeout="${MEASURE_PROBE_TIMEOUT:-5}"
proc_root="${MEASURE_PROC_ROOT:-/proc}"
out="${MEASURE_OUT:-$HOME/t3-opencode-pilot-$(date +%Y%m%dT%H%M%SZ)}"
now="${MEASURE_NOW:-date +%s}"; nap="${MEASURE_SLEEP:-sleep}"

# Run a probe in the background and kill it if it outlives probe_timeout.
bounded() {
  secs="$1"; shift; "$@" & pid=$!
  ticks=0; limit=$((secs * 10))
  while kill -0 "$pid" 2>/dev/null; do
    ticks=$((ticks + 1))
    if [ "$ticks" -gt "$limit" ]; then
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124
    fi
    sleep 0.1
  done
  wait "$pid"
}

mkdir -p "$out"; log="$out/monitor.log"; total=0
end=$(( $($now) + max_seconds ))
while :; do
  [ "$($now)" -lt "$end" ] || break
  if [ -n "${MEASURE_PROBE:-}" ]; then
    line="$(bounded "$probe_timeout" sh -c "$MEASURE_PROBE" 2>/dev/null || true)"
  else
    cpu="$(bounded "$probe_timeout" awk '/^cpu /{print "user="$2" nice="$3" system="$4" idle="$5" iowait="$6" irq="$7" softirq="$8" steal="$9}' "$proc_root/stat" 2>/dev/null || true)"; [ -n "$cpu" ] || cpu=unavailable
    mem="$(bounded "$probe_timeout" sh -c 'free -m 2>/dev/null' | awk '/^Mem:/{print "total="$2" used="$3" free="$4" available="$7} /^Swap:/{print "swap_total="$2" swap_used="$3" swap_free="$4"}' || true)"; [ -n "$mem" ] || mem=unavailable
    psi="$(bounded "$probe_timeout" awk 'NF{printf "%s ",$0}' "$proc_root/pressure/memory" 2>/dev/null || true)"; [ -n "$psi" ] || psi=unavailable
    cap="$(bounded "$probe_timeout" sh -c 'df -B1 / 2>/dev/null' | tail -n +2 | tr '\n' ';' || true)"; [ -n "$cap" ] || cap=unavailable
    line="$(date -u +%FT%TZ) cpu[$cpu] mem[$mem] psi_memory[$psi] fs_capacity[$cap]"
  fi
  [ -n "$line" ] || line="$(date -u +%FT%TZ) unavailable"
  bytes="$(printf '%s\n' "$line" | wc -c | tr -d ' ')"
  if [ $((total + bytes)) -gt "$cap_bytes" ]; then
    banner='size cap reached'; bb="$(printf '%s\n' "$banner" | wc -c | tr -d ' ')"
    [ $((total + bb)) -le "$cap_bytes" ] && printf '%s\n' "$banner" >> "$log"
    break
  fi
  printf '%s\n' "$line" >> "$log"; total=$((total + bytes))
  remaining=$((end - $($now))); [ "$remaining" -gt 0 ] || break
  step="$interval"; [ "$step" -lt "$remaining" ] || step="$remaining"
  "$nap" "$step"
done
```

- Optional directory growth (bounded, opt-in): only `du -sb --max-depth=0` on
  the worktree and `~/.t3/userdata`. Do not recursively scan user homes or
  archives.
- Heavy-job activity: recording start/stop of **two deliberate heavy jobs at
  once** is a pilot choice, not measured capacity.
- Session continuity: record reconnects, and note that a missing native session
  now surfaces as an error instead of a silent fresh thread.
- Never collect prompts, tool arguments, credentials, or raw session content.

## 6. Acceptance still required (owners unchanged)

- Independent review and merge of the source PR, then a release containing the
  fix (T3 release owner).
- Target/account confirmation and access preparation (ENV-1); this page records
  UNKNOWN.
- Missing OpenCode/provider/host receipts from §2.
- Real target verification, dormant install, and later activation remain
  unexecuted here.
