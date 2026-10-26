# Codex session guard

`codexSessionGuard` (server settings) is a host-level, opt-in requirement that
T3's Codex processes run behind the Closura fenced provider launcher. On an
enrolled host, `enforce` turns an unguarded launch into a refusal instead of a
silent fallback. `disabled` is the default and never inspects the filesystem, so
hosts that never opt in keep the existing spawn path.

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

Spawning through the launcher anyway would therefore manufacture a lifetime
guarantee nobody can check. `enforce` validates every configured reference and
then refuses with a stable blocker code, before any process exists and before
the shadow home is written. The refusal is honest about what is missing rather
than pretending a wrapper is a qualification.

## Where the gate applies

One admission point: `CodexDriver.create`, immediately after the home layout is
resolved and before `materializeCodexShadowHome`. It is host-wide rather than
per-instance so a managed host cannot be partly enrolled by leaving one
instance unguarded.

Every T3-owned Codex process is constructed from that instance, so one check
covers all of them:

- the session app-server and its version probe (`CodexSessionRuntime`)
- status, Skills and reset-credit probes (`CodexProvider.withCodexAppServerClient`)
- `codex exec` text generation (`CodexTextGeneration`)
- maintenance and update resolution (`CodexDriver`, `providerMaintenance`)

Out of scope, and never counted as covered: the user's terminal PTY
(`terminal/Manager`) and `t3 triage`, which run Codex for the developer rather
than as a T3 provider session, and any Codex process started outside T3.

## What a refusal checks

- Every reference is present, absolute, NUL-free and canonical (`realpath`
  unchanged), so two spellings of one target cannot look like two integrations.
- `launcher` is the reviewed `launch_provider.py` and `sourceRoot` is the
  checkout that contains it at the reviewed path — the binding the launcher
  itself re-checks before starting a provider.
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
   the provider's process group. It must also stop injecting `CODEX_HOME`, which
   the guard refuses.

Until both land, `enforce` is a refusal. Do not add a switch that claims the
lifetime guarantee.

## Operating it

Configuration lives in server settings (`codexSessionGuard`), not the provider
settings form. An instance that refuses becomes unavailable with the refusal
detail, so an enrolled host with Codex enabled shows why Codex is not starting.
Reverting to `disabled` restores the legacy path on the next instance rebuild;
the guard keeps no state and writes nothing.
