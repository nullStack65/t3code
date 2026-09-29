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
receipt is unset/`UNISSUED`. Run as an ordinary user, never root. This is a
dormant install: it does not start a service.

```sh
#!/bin/sh
# Dormant install guard. Fails closed (EX_CONFIG=78) before any mutation.
set -eu

# Reviewed installer bytes, pinned by full commit + independently recorded digest.
T3_INSTALLER_REPO="${T3_INSTALLER_REPO:-nullStack65/t3code}"
T3_INSTALLER_COMMIT="${T3_INSTALLER_COMMIT:-419f7574010c066a56974fc9e3ac0709a08efb33}"
T3_INSTALLER_SHA256="${T3_INSTALLER_SHA256:-e2462ba995aaa2773872f1fe9f2ccee53094d4ba6a4207dbc5115a65710b8a0a}"

# Pilot-candidate receipts. UNISSUED until a release owner records them.
T3_VERSION="${T3_VERSION:-UNISSUED}"
T3_ARCHIVE_SHA256="${T3_ARCHIVE_SHA256:-UNISSUED}"
T3_ARCHIVE_SIZE="${T3_ARCHIVE_SIZE:-UNISSUED}"
T3_BINARY_SOURCE="${T3_BINARY_SOURCE:-UNISSUED}"
OPENCODE_VERSION="${OPENCODE_VERSION:-UNISSUED}"
OPENCODE_LINUX_SHA256="${OPENCODE_LINUX_SHA256:-UNISSUED}"

for name in T3_VERSION T3_ARCHIVE_SHA256 T3_ARCHIVE_SIZE T3_BINARY_SOURCE \
            OPENCODE_VERSION OPENCODE_LINUX_SHA256; do
  eval "value=\${$name}"
  case "$value" in
    ""|UNISSUED)
      printf 'refusing to install: receipt %s is unset/UNISSUED\n' "$name" >&2
      exit 78 ;;
  esac
done

# 1. Fetch the installer at the pinned COMMIT (never `main`), verify its exact
#    bytes against the recorded digest, and only then execute them.
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT INT TERM
src="https://raw.githubusercontent.com/${T3_INSTALLER_REPO}/${T3_INSTALLER_COMMIT}/scripts/install.sh"
curl -fsSL "$src" -o "$work/install.sh"
actual="$(sha256sum "$work/install.sh" | cut -d' ' -f1)"
[ "$actual" = "$T3_INSTALLER_SHA256" ] || { printf 'installer digest mismatch\n' >&2; exit 65; }

# 2. Independently verify the release archive BEFORE the installer consumes it.
#    The release's own SHA256SUMS sits beside the mutable archive and is not
#    sufficient alone; T3_ARCHIVE_SHA256/SIZE are the authoritative receipt.
base="https://github.com/${T3_INSTALLER_REPO}/releases/download/v${T3_VERSION}"
curl -fsSL "${base}/t3-${T3_VERSION}-linux-x64.tar.gz" -o "$work/archive.tar.gz"
size="$(wc -c < "$work/archive.tar.gz" | tr -d ' ')"
hash="$(sha256sum "$work/archive.tar.gz" | cut -d' ' -f1)"
[ "$size" = "$T3_ARCHIVE_SIZE" ] || { printf 'archive size mismatch\n' >&2; exit 65; }
[ "$hash" = "$T3_ARCHIVE_SHA256" ] || { printf 'archive digest mismatch\n' >&2; exit 65; }

# 3. Run the reviewed, digest-verified installer with the exact version pinned.
#    `install.sh` downloads, checks the release SHA256SUMS, extracts, smoke-runs
#    `t3 --version`, and symlinks into ~/.local/bin. It does not start a service.
T3CODE_VERSION="$T3_VERSION" \
T3CODE_RELEASE_REPOSITORY="$T3_INSTALLER_REPO" \
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
capped at **50 MiB**. Existing tools only; no daemon or dashboard. A missing
metric is recorded `unavailable`, never guessed. `df` measures **filesystem
capacity/free space**, not the growth of any individual directory.

```sh
interval=60; max_seconds=604800; cap_bytes=52428800
out="$HOME/t3-opencode-pilot-$(date +%Y%m%dT%H%M%SZ)"; mkdir -p "$out"
log="$out/monitor.log"; end=$(( $(date +%s) + max_seconds )); total=0
while [ "$(date +%s)" -lt "$end" ]; do
  cpu="$(awk '/^cpu /{print $2+$3+$4, $5}' /proc/stat 2>/dev/null || true)"; [ -n "$cpu" ] || cpu=unavailable
  mem="$(free -m 2>/dev/null | awk '/^Mem:/{print $2,$3,$4};/^Swap:/{print $2,$3}' | tr '\n' ';' || true)"; [ -n "$mem" ] || mem=unavailable
  psi="$(awk 'NF{printf "%s ",$0}' /proc/pressure/memory 2>/dev/null || true)"; [ -n "$psi" ] || psi=unavailable
  cap="$(df -B1 --output=source,size,used,avail / 2>/dev/null | tail -n +2 | tr '\n' ';' || true)"; [ -n "$cap" ] || cap=unavailable
  line="$(date -u +%FT%TZ) cpu_jiffies=$cpu mem_swap_mb=$mem psi_memory=$psi fs_capacity=$cap"
  printf '%s\n' "$line" >> "$log"; total=$(( total + ${#line} + 1 ))
  [ "$total" -lt "$cap_bytes" ] || { printf 'size cap reached\n' >> "$log"; break; }
  sleep "$interval"
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
