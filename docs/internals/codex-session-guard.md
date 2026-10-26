# Codex session guard

`codexSessionGuard` (server settings) is a host-level, opt-in requirement that
T3's driver-backed Codex processes run behind the Closura fenced provider
launcher. On an enrolled host, `enforce` turns an unguarded launch into a
refusal instead of a silent fallback. `disabled` is the default and never
inspects the filesystem, so hosts that never opt in keep the existing spawn
path.

## The contract it binds to

The reviewed launcher holds a shared advisory lock on one stable inode —
`<state_root>/session-fence/.omp-company-profile.lock` — for the provider's whole
lifetime, then passes exactly that descriptor to the provider (`pass_fds`, with
its number in `CLOSURA_SESSION_FENCE_FD`). Reconciliation takes the exclusive
lock, so a guarded session excludes configuration mutation. The launcher also
refuses `CODEX_HOME`/`OPENCODE_*` overrides rather than clearing them, and the
fence contract only covers native macOS and Linux.

## Why `enforce` refuses instead of launching

The reviewed contract states plainly that the launcher cannot prove a provider
keeps the inherited descriptor, closes it in unrelated descendants, or avoids
daemonizing. A T3-managed `codex app-server` is exactly that unqualified shape.
T3 also cannot substitute its own holder: it is the parent of the launcher, so a
T3 crash would drop T3's lock while the provider may still be running, which is
the case the fence exists to prevent.

Spawning through the launcher anyway would manufacture a lifetime guarantee
nobody can check. `enforce` validates the configured references and then refuses
with a stable blocker code, before any process exists and before the shadow home
is written.

## What the gate covers

The gate is `CodexDriver.create`. Every Codex process T3 builds for a provider
instance starts from that instance: the session app-server and its version
probe, status/Skills/reset-credit probes, `codex exec` text generation, and
maintenance/update resolution. `CodexTypedSkillsDriver` constructs through the
same factory, so it is covered too.

Not covered, and not claimed: a user's terminal PTY (`terminal/Manager`),
`t3 triage`, and any Codex process started outside T3. This is not a
host-universal guarantee, and it says nothing about processes from an earlier
server run.

T3 also does not read the delivery journal, receipts, device health or setup
ownership. Partial-journal and unhealthy-state refusal belong to the reviewed
launcher and reconciler. T3's refusal is unconditional and independent of that
state, so it neither duplicates nor replaces those checks.

## Enrollment is fixed at server startup

The effective policy is the value the server loads when it starts. It never
changes while that server runs, because T3 cannot make a runtime transition
safe: a Codex session owns a detached scope (`Scope.make` plus transfer in
`CodexAdapter.startSession`), so closing a registry entry does not stop it, and
a start already past its instance lookup can still reach the spawn boundary
after the policy flips. Per-instance reconciliation identity was tried and
removed: it rebuilt construction readers but could neither stop a running
session nor close that interleaving, and it left callers able to observe a
policy the live processes were not held to.

So the settings service treats the guard as boot-latched:

- The first load of the settings file fixes the effective policy for the
  process; reads, `streamChanges` and `subscribeChanges` only ever carry that
  effective value.
- A later file edit keeps the effective policy and logs that a restart is
  required. The edited value stays on disk as pending, and saving unrelated
  settings preserves it instead of reverting or adopting it.
- An API patch that would change the policy fails with `restart-required`
  before secret handling, the file write or a change emission, so a client can
  never observe "enforce accepted" while processes started under the previous
  policy keep running.

Consequences: with the policy disabled at startup nothing claims to be guarded,
and no later file or API edit can claim it. With the policy enforced at startup
no Codex instance is constructed at all, so there is no session to leak. Both
directions require a restart, which is also the point where an operator has to
stop the server (quiescent) rather than have T3 interrupt live sessions.

The server cannot prove that non-T3 Codex processes, or processes left behind by
an earlier run, are quiescent. That remains an explicit operator and upstream
qualification prerequisite; a restart is not evidence of it.

## What a refusal checks, and what it does not prove

Validation exists because enrollment must name one reviewed integration with
explicit absolute references, and because a typo should become an actionable
refusal instead of a later surprise. It is **not authentication and not
qualification**: matching paths, a matching device document or a present fence
inode say nothing about the source tree's contents, and none of it can qualify a
provider chain.

- Every reference is absolute, NUL-free and canonical (`realpath` unchanged), so
  two spellings of one target cannot look like two integrations.
- `launcher` must equal `path.join(sourceRoot, "company", "agent-environment",
"config-delivery", "launch_provider.py")` — the reviewed path inside that
  checkout, not merely a same-depth file with the same basename.
- `deviceFile` is a small JSON document whose `state_root` is the configured
  `stateRoot`, so a stale or crossed device file cannot enroll another fence.
- The fence is a real, singly-linked inode; a symlinked or hardlinked lock would
  cover a different object than the reconciler takes.
- `interpreter` resolves to an executable regular file; provider-root overrides
  (injected `CODEX_HOME` or an inherited one) are reported as
  `provider-root-override`, never stripped.

Diagnostics name fields and stable reason codes only; no environment value,
credential or file content is echoed.

## Activating it

`enforce` starts Codex only after two things exist, and neither is a setting:

1. Agent-config-owned qualification that the exact executable/argv chain retains
   the inherited descriptor until exit and does not daemonize. A hash in the
   device document is not behavioral proof.
2. A T3 change that builds the launcher argv (`interpreter`, `launcher`,
   `--source-root`, `--device`, `--state-root`, `--`, provider executable and
   `app-server` args), passes the merged provider environment through unchanged,
   and keeps the launcher as the direct child so cancellation still forwards to
   the provider's process group. That change also needs narrowly qualified
   exact-root support upstream for the provider root T3 would use. Clearing or
   stripping a user's configured home override is not acceptable and is not a
   substitute for that qualification.

Until both land, `enforce` is a refusal. Do not add a switch that claims the
lifetime guarantee.

## Operating it

Configuration lives in server settings (`codexSessionGuard`), not the provider
settings form. An instance that refuses becomes unavailable with the refusal
detail, so an enrolled host with Codex enabled shows why Codex is not starting.

To change the policy: stop the server, edit the file (or set it through any
tool while stopped), then start it again. A patch while the server is running is
rejected with `restart-required`, and a file edit is kept pending on disk and
only read at the next start. The guard keeps no state of its own and writes
nothing.
