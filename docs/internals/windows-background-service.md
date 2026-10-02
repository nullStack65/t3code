# Windows background service

Status: prototype source only. Windows background support stays disabled and
unqualified until this host, the launcher control adaptation, the BootService
adapter, packaged artifacts and a real SCM run are joined and tested.

The implementation is a [small Rust SCM host](../../native/windows-service-host/src/main.rs).
The rest of T3's background service is platform-neutral: [BootService](../../apps/server/src/cloud/bootService.ts)
owns install/status/restart/uninstall, and [serviceLauncher.ts](../../apps/server/src/serviceLauncher.ts)
owns the server child, remote updates and rollback. This host replaces neither.
It is the SCM entry point that starts the existing pinned `t3.exe
__service-launcher` and reports service state.

Windows currently has no native background service at all. A desktop-owned
child and a WSL systemd unit are different lifecycles; neither is SCM support.
The tracked `native/resource-monitor` is a process monitor, not a service host.

## SCM contract

A real service is registered with `sc.exe create` (or the SCM API) and started
by the service control manager. Registering an ordinary console `t3 serve` is
not enough. The host implements:

- `StartServiceCtrlDispatcherW` on the process main thread, with the service
  name as a `SERVICE_TABLE_ENTRYW` row.
- `ServiceMain` on an SCM thread: `RegisterServiceCtrlHandlerExW`, then the
  supervisor loop.
- `SetServiceStatus` with `START_PENDING`, `RUNNING`, `STOP_PENDING` and
  `STOPPED`, `dwCheckPoint`/`dwWaitHint` while pending, and
  `SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN` only while running. A
  successful spawn publishes the actual `RUNNING` transition: until it is
  published the SCM stays `START_PENDING` and accepts no stop control. Exactly
  one final `STOPPED` is published, after the child resources are released, and
  a `SetServiceStatus` failure is propagated rather than ignored (Microsoft's
  SetServiceStatus contract allows no later status call once the service is
  stopped).
- A control handler that records intent and wakes the supervisor; it never
  blocks on the child. Control handling cannot hang indefinitely.

The single Windows-specific trap is where the arguments live. Auto-start
services receive their command line through the process entry point; they are
**not** delivered to `ServiceMain`'s `argv`. The host parses
`std::env::args_os()` before it calls the dispatcher and never reads
`ServiceMain`'s arguments.

## Identity and launch

The host refuses to start without an explicit, canonical T3 home and the pinned
runtime. There is no `~/.t3` fallback, so an omitted argument can never point
the workload at an interactive user's profile.

- `--home` must be absolute and must not be a drive root or a system directory.
- `--runtime` must be the pinned `t3.exe`. The host appends `__service-launcher`
  and launches it once per service start. Remote updates replace the launcher's
  server child; they do not re-exec the host or change its command line.
- The native spawn builds a Unicode environment block for `CreateProcessW` with
  the selected `--home` as `T3CODE_HOME`, overriding an absent or conflicting
  ambient value; cwd alone is not enough because the pinned launcher reads
  `process.env.T3CODE_HOME`. The rest of the intended host environment is
  preserved. Child stdout/stderr go to `--log` when supplied.
- No credential flag is accepted. A password or token argument is refused
  rather than forwarded. The account password, if any, is registered with SCM
  out of band and kept in LSA; the host never sees it and no password belongs
  on the command line.
- LocalSystem is refused unless `--allow-local-system` is passed explicitly.
  `--expected-account` must be qualified (`DOMAIN\user` or `user@domain`); a
  bare name is refused in configuration because it cannot prove the domain. The
  running identity is read with `GetUserNameExW` (SAM and UPN forms), never the
  ambiguous bare `GetUserNameW` name.

Account constraints: use a dedicated account, ideally the virtual
`NT SERVICE\T3Code` service SID, or a dedicated local/domain user. Do not run
the T3 workload as LocalSystem and do not reuse an interactive user's home or
profile. A virtual service account has no user profile or `HKCU`, so features
that need one are unavailable (below). Dedicated-account provisioning or reuse
of an existing credential is not selected by this source repair; installer
identity selection remains later work.

## Shutdown and process ownership

The child is created suspended, assigned to a job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, its identity captured, then resumed.
Suspending closes the race where a fast child could spawn grandchildren before
assignment. The job is created for the child; the host is not in it, so
`TerminateJobObject` can kill the owned tree while the host stays alive to
report `SERVICE_STOPPED`.

Every step after `CreateProcessW` succeeds is checked and scoped: assignment to
the job, creation-time identity capture, and `ResumeThread`. If any of them
fails, the freshly created process is terminated explicitly — the created
process handle is retained until that cleanup outcome is known — and the failure
is reported together with the cleanup result. The cleanup outcome is carried
structurally (`SpawnError::Admission`), not flattened into a string: only a
*confirmed* reclaim may take the ordinary bounded launch retry. A failed,
unknown or timed-out reclaim — for example assignment failure plus a failed or
timed-out `TerminateProcess` — stops without a second spawn and reports a
recovery-required cause, because starting another child could leak a second
process outside the job while the real ownership is unresolved. A suspended
child is never silently orphaned outside the job, and a failed creation-time
query is reported as unknown rather than a fabricated zero identity.

A stop is bounded and two-stage:

1. On `SERVICE_CONTROL_STOP`/`SHUTDOWN`, the supervisor writes the launcher stop
   marker and asks the launcher to stop, then reports `STOP_PENDING` with
   checkpoints.
2. If the child has not exited by `--drain-timeout-ms` (default 30s), the job
   tree is terminated and the service reports `STOPPED`. The termination outcome
   is explicit: only a confirmed child exit is a clean stop. A refused
   (foreign or unverified) tree and a failed or unconfirmed termination report
   `STOPPED` with an unknown cause. Closing the kill-on-close job is itself a
   termination effect, so it is treated as an implicit, bounded cleanup rather
   than as evidence of a clean shutdown; the job only ever contains this host's
   owned members, so no PID or process name is matched.

Whole-job completion is not the same as the root process exiting. Before a
natural root exit can finish clean or start a replacement, the host explicitly
reclaims the owned job through the retained job handle and confirms it is empty.
`TerminateJobObject` is only a *request*; emptiness is proven with job
accounting (`QueryInformationJobObject` / `JobObjectBasicAccountingInformation`,
`ActiveProcesses`), with a bounded drain poll. A still-nonempty job, a
termination request that does not take effect, or a failed job query is never
`Confirmed`: a root exit with a surviving grandchild, an unexpected exit, or a
planned stop all report `STOPPED` with a recovery-required cause instead of a
clean stop, and no replacement child is started over an uncleared tree. The
retained process/job handles are the ownership authority here; the host never
re-opens a possibly-reused PID for this cleanup. `Drop` remains only a
last-resort safeguard that closes the job; it is never the source of a
`Confirmed` result.

This is deliberately different from a normal launcher replacement. During an
update the launcher terminates its own server child but stays alive and starts
the replacement; the host must not touch the job during that handoff. The host
only terminates the tree for a whole-service stop. It does not know about
launcher protocol upgrades and does not manage updates or rollback.

For a graceful stop request and a forced termination while the root may still be
alive, ownership is verified first: the host re-opens the recorded PID and
compares its creation time with the one captured at spawn, because a held handle
stays valid after the child exits and cannot detect PID reuse. `Ok(false)` means
the PID is foreign and is left alone; a failed query means ownership is
**unknown** and is never read as a successful stop. Whole-job cleanup after the
root has already exited instead uses the retained job handle, which only ever
contains this host's assigned members; a stale or foreign PID is never the
target. Only owned members and confirmed-empty job accounting may be reported as
a clean stop.

## Required launcher control (not implemented here)

`serviceLauncher.ts` is owned by its current writer and is not edited by this
slice. Two small adaptations are required before the host can stop gracefully:

- **A parent control channel.** Spawn the launcher with an IPC channel and have
  `Launcher.run()` treat a `{ "type": "stop" }` message from its parent (the
  host) like a `SIGTERM`: call `this.stop("SIGTERM")`, which writes the stop
  marker before it terminates the child. This belongs next to the existing
  `serviceProtocol.ts` messages as an additive type. The host already restores
  `T3CODE_HOME` and starts `t3.exe __service-launcher`; it only needs to be
  given the channel.
- **Graceful child shutdown on Windows.** Windows has no POSIX signals. Node's
  `child.kill("SIGTERM")` calls `TerminateProcess`, so the server child cannot
  read the stop marker in its shutdown finalizer. The launcher must deliver a
  graceful shutdown over the child IPC channel it already opens, then fall back
  to `terminateChild` after its own grace period.

Until both land, the host's stop degrades to writing the marker and then
force-terminating the job after the drain. That is honest, bounded, and still
correct for the service tree, but it is not graceful server shutdown.

Because the launcher is not adapted yet, the host writes the stop marker
directly. A later integration owner should decide whether the host keeps that
fallback or relies solely on the control message.

## Honest failure states

- **Unexpected exit:** the supervisor restarts the child while a restart budget
  allows it (`--max-restarts` inside `--restart-window-ms`, default 5 in 300s,
  mirroring the systemd unit), reporting `START_PENDING` between attempts. The
  restart only happens when the whole owned job was confirmed empty first.
- **Planned stop:** a child exit while `STOP_PENDING` is success, not a failure;
  a non-zero exit code is ignored so a crashed-but-stopping child does not look
  like an unexpected stop. An unconfirmed whole-tree cleanup during a planned
  stop is not reported clean.
- **Repeated failure:** once the budget is exhausted the service stops with
  `ERROR_SERVICE_SPECIFIC_ERROR` and a specific code instead of respawning
  forever. There is no Windows analog of systemd's finite start limit, so the
  budget lives here.
- **Slow drain:** reports `STOP_PENDING` with checkpoints and forces the tree
  after the deadline. It never hangs.
- **Unconfirmed cleanup (specific code 5):** a created process that could not be
  admitted and could not be confirmed reclaimed, or an owned job that stayed
  nonempty (or could not be queried) after termination, stops the service with a
  recovery-required specific code. The host does not retry and does not claim a
  clean stop; it reports the unresolved ownership rather than promising removal.
- **Publication failure:** if `SetServiceStatus` fails for any state, the failure
  is surfaced (not ignored); the host abandons the run, cleans the owned child
  once and reports an unknown cause rather than claiming a clean stop.
- **Stale/foreign PID:** as above, verified and left alone; unknown is not
  stopped.

## Platform limitations

- **Session 0.** The service runs in session 0 with no interactive desktop.
  Anything that needs a GUI, a visible browser window, a desktop keychain or an
  interactive-only credential is unavailable.
- **Browser auth.** OAuth and provider logins that open a browser cannot
  complete in session 0. Credentials must be pre-seeded for the service
  account, or the feature is unsupported in service mode.
- **Profile.** A virtual service account has no profile directory or `HKCU`.
  A dedicated user account can have one, but it must be seeded and owned by
  that account; it must not be an interactive user's profile.
- **A temporary login Scheduled Task is not SCM parity.** A task with "run only
  when the user is logged on" runs in that user's interactive profile and stops
  at logout. It is at most a declared temporary profile, never proof of the
  unattended service. Do not present it as equivalent.
- **No wrapper dependency chosen.** NSSM/WinSW are not adopted. A wrapper would
  have to justify a concrete maintenance or correctness advantage over this
  ~1-file host; it would also become a fleet-wide runtime dependency and a
  generic supervisor T3 does not otherwise need. No such comparison has been
  made, so no wrapper is selected.

## Integration boundary

A later single integration owner joins these parts; this slice writes only
`native/windows-service-host/**` and this document.

Adapter (`apps/server/src/cloud/bootService.ts`, owned by R6-T3-STATUS):
- Add `"scm"` to the manager union and a `windowsManager(...)` sibling of
  `systemdManager`/`launchdManager`. `render` produces the host command
  (`hostPath`, `--home`, `--runtime <activeVersion>/t3.exe`, `--log`,
  `--service-name`, optional `--expected-account`). The steps are `sc.exe
  create/start/stop/delete/config` with `obj=` and the account, not a unit file.
- `selectBootServiceManager` returns it for `platform === "win32"` when the home
  and account are known, instead of `undefined`.
- `BootServiceStatus` learns the SCM state; installation, registration and
  observed running state stay separate, as they already are for Linux.

Launcher (`apps/server/src/serviceLauncher.ts`, `serviceProtocol.ts`): the two
adaptations above.

Packaging (`packaging/**`, root workspaces, release workflows): compile the host
and ship it beside the pinned runtime. Root Cargo/package workspaces and the
release pipeline are outside this slice.

CI (`.github/workflows/ci.yml`): the `Rust` job hardcodes the native crate list
(`resource-monitor kde-snap-shot hyprland-snap-shot`). Add `windows-service-host`
there so its portable tests and `cargo fmt --check` run on every PR. The host
already passes both locally; the workflow itself is outside this slice.

## Artifact and provenance inputs

- The host binary: pinned fork commit and toolchain, signed, with a recorded
  SHA-256. The SCM `ImagePath` must bind that exact binary.
- The pinned runtime archive and its `.install-complete` sentinel; the active
  version comes from `runtime/service-state.json`, which the launcher owns.
- The `sc.exe qc T3Code` registration record: `ImagePath`, `obj=`, `start=`.
- `/5`'s frozen release branch and build source are untouched by this slice.

## Rollback and native acceptance checklist

Rollback: `sc.exe stop T3Code` then `sc.exe delete T3Code`, or restore the
previous `ImagePath` with `sc.exe config`. Existing T3 data under the home is
never touched by install or uninstall. If a previous non-SCM supervisor owns
the backend, do not attach a second one.

Native acceptance (not executed here; see the recipe):

1. `sc.exe query` reports `STOPPED` before start and `RUNNING` after; the
   control handler answers interrogate without hanging.
2. A planned stop reaches `STOPPED` within the drain bound; the job tree is
   empty afterwards, including any grandchild.
3. Killing the dummy root while its grandchild is still alive does **not**
   restart over the survivor: the host reclaims the owned job, confirms it
   empty, and only then reports `STOPPED` (or a recovery-required specific code
   if the job cannot be confirmed empty); no restart storm.
4. A child that ignores the stop marker is force-terminated at the deadline and
   reported `STOPPED`.
5. A stale PID and an unrelated process are never terminated, and a failed job
   query is reported as unknown rather than confirmed empty.
6. Registration and cleanup remove exactly the synthetic service, its
   processes, its home under the disposable test root, and nothing else.

## Native test recipe (unexecuted)

Only an environment already reserved for disposable Windows tests may run this.
Do not run it on an active workstation or against real T3 state. The recipe
builds the host with the development-only `test-child` feature, runs a uniquely
named dummy child that records its own and its grandchild's PID inside the probe
home, and cleans up in a `finally` block. Process cleanup is proven by those
captured PIDs, not by a process-name listing.

```powershell
# Build the exact binary the recipe runs. The crate is standalone, so the binary
# lands under native/windows-service-host/target; build WITH the test-child
# feature so --exec exists, or the launch below will fail.
cargo build --locked --release --features test-child `
  --manifest-path native/windows-service-host/Cargo.toml
$hostExe = Join-Path $PWD "native/windows-service-host/target/release/t3-windows-service-host.exe"
if (-not (Test-Path $hostExe)) { throw "host binary not built at $hostExe" }

$svc  = "T3WinSvcProbe$([guid]::NewGuid().ToString('N').Substring(0,8))"
$root = Join-Path $env:TEMP $svc
$home = Join-Path $root "home"
New-Item -ItemType Directory -Force $home | Out-Null

# The dummy records its own PID and spawns a sleeping grandchild that records
# its PID too, so cleanup can be checked against exactly these two processes.
$dummy = Join-Path $root "dummy.ps1"
@'
$pidFile = Join-Path $env:T3CODE_HOME "dummy.pid"
$PID | Set-Content $pidFile
$gcFile = Join-Path $env:T3CODE_HOME "grandchild.pid"
Start-Process powershell -WindowStyle Hidden -ArgumentList `
  "-NoProfile","-Command","$PID | Set-Content '$gcFile'; Start-Sleep -Seconds 600"
Start-Sleep -Seconds 600
'@ | Set-Content $dummy

# A service account cannot read the interactive user's TEMP: grant the selected
# test account explicit access to only this probe root.
icacls $root /grant "NT AUTHORITY\LocalService:(OI)(CI)F" /T | Out-Null

$created = $false
try {
  sc.exe create $svc binPath= "`"$hostExe`" --home `"$home`" --service-name $svc --exec powershell.exe --exec-arg -NoProfile --exec-arg -File --exec-arg `"$dummy`" --drain-timeout-ms 3000" `
    obj= "NT AUTHORITY\LocalService" start= demand
  $created = $true
  sc.exe start $svc
  sc.exe query $svc            # expect RUNNING
  sc.exe control $svc 4        # interrogate; must return
  sc.exe stop $svc             # expect STOPPED within the drain bound

  $probePids = @(
    (Join-Path $home "dummy.pid"),
    (Join-Path $home "grandchild.pid")
  ) | Where-Object { Test-Path $_ } | ForEach-Object { [int](Get-Content $_) }
  foreach ($probePid in $probePids) {
    if (Get-Process -Id $probePid -ErrorAction SilentlyContinue) {
      throw "probe-owned process $probePid survived the stop"
    }
  }
} finally {
  if ($created) {
    sc.exe stop $svc   | Out-Null
    sc.exe delete $svc | Out-Null
  }
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
```

`--exec` exists only under `--features test-child` and is not part of the
production child selection. Portable and cross-compiled checks prove the
portable core, the SCM FFI's type surface, the environment/argument construction
and the quoting logic; they do not prove a real service run, job-object
ownership or graceful shutdown. Running this recipe on the reserved environment
is the native gate; its absence leaves that gate unrun.
