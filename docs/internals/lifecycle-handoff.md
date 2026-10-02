# Detached lifecycle handoff

A lifecycle action that stops or replaces T3 (install, update, restart) cannot be
performed by an agent running *inside* T3: the action kills the agent that is
executing it, so the last step — reporting back — never runs. A **detached
handoff** moves the action to an OS-owned helper whose lifetime is independent of
T3, and gives that helper enough state to relaunch T3 and report the result into
the thread that requested it.

Implementation lives in [`scripts/lifecycle-handoff/`](../../scripts/lifecycle-handoff/README.md).

## Execution model

```
initiating agent (inside T3)
  ├─ writes a user-private envelope            PREPARED
  ├─ registers a transient OS job              DETACHED
  └─ proves the helper is OS-owned, then quits T3
                     │
OS-owned supervisor (launchd / Task Scheduler)
  ├─ verifies its own ancestry
  ├─ waits for the initiating pid to exit      WAITING_FOR_EXIT
  ├─ runs the lifecycle command                APPLYING
  ├─ relaunches T3                             RELAUNCHING
  ├─ waits for readiness                       WAITING_FOR_T3
  ├─ runs an optional identity probe
  ├─ delivers the callback + writes the result CALLBACK_PENDING
  ├─ writes the terminal result envelope       COMPLETE / FAILED
  └─ removes its own job registration
```

The supervisor never force-kills a process. If the waited-for pid is still alive
when its bound expires, the handoff fails with `FAILED` and durable evidence
rather than killing active work.

## Supervisor mechanism

**macOS** — a transient, per-handoff LaunchAgent in `~/Library/LaunchAgents`
(`RunAtLoad`, `KeepAlive=false`, `ProcessType=Background`, log to the handoff
directory). `launchctl bootstrap gui/<uid> <plist>` starts it; its direct parent
is launchd (pid 1), so T3/Electron job-object teardown cannot reach it. It removes
its own plist and `launchctl bootout`s itself as its last step.

**Windows** — a transient current-user Scheduled Task created from an XML task
definition (`InteractiveToken`, `LeastPrivilege`, one `TimeTrigger`,
`StartWhenAvailable`). The Task Scheduler service owns the process, so it is not
an Electron job-object child. `schtasks /Delete` removes it at the end. This path
is implemented but **has not been executed on a Windows host** (see "Validation").

`nohup`, `Start-Process`, and terminal detachment are deliberately not used:
neither reliably escapes the parent job object on the platforms that matter.

## Independence proof

Before the initiating agent may quit T3 it must show the helper cannot be killed
with T3. `handoff.mjs prepare` polls `launchctl print gui/<uid>/<label>` for the
job pid, then walks the process parent chain:

- `directParent === 1` (launchd) is required;
- none of the helper's ancestors may be the initiator or its parent.

The proof is stored in the handoff state file. If it fails, `prepare` boots the
job out and throws — T3 is never stopped on an unproven helper.

## Handoff envelope

Written to `paths.dir/<handoffId>.envelope.json`, mode `0600`, in a `0700`
directory (default `~/.t3/userdata/lifecycle-handoff`). Required fields:

| Field | Meaning |
| --- | --- |
| `handoffId` | unique id; also the idempotency key |
| `originating.threadId` / `projectId` / `machine` / `platform` | where to return |
| `task.description` / `operation` | what is being done |
| `command.argv` / `cwd` / `timeoutMs` | the lifecycle command |
| `waitFor.pid` / `timeoutMs` | the process whose exit gates the command |
| `relaunch.argv` | how to bring T3 back (empty = no relaunch) |
| `readiness` | `none` \| `file` \| `pid` \| `tcp` \| `http` |
| `identity.before` / `after` / `afterCommand` | expected and independently observed identity |
| `callback` | `none` \| `github` \| `http` |
| `paths` / `supervisor` | state, log, result, node and script paths |

Credentials are rejected at write time: any key matching
`token|secret|password|credential|bearer|api-key|private-key|cookie`, and any value
shaped like a GitHub/Slack/OpenAI/JWT/PEM credential, fails the write.

## Callback contract

The supervisor always writes a terminal result envelope to `paths.result`. The
callback is a best-effort *notification* layered on top:

- `none` — result envelope only.
- `github` — `gh issue comment <issue> --repo <repo> --body-file -` with a short
  message. This is the durable cross-machine receipt when no T3 callback exists.
- `http` — `POST` JSON `{handoffId, state, message}`.

Message shape:

```
DETACHED HANDOFF COMPLETE <id>.
Operation: <op> (exit=0).
Before: {"version":"0.0.43"}
After: "0.0.44"
Result: <result path>
```

**Supported T3 callback: not available today.** T3 exposes no CLI or REST command
that appends a message / starts a turn. The only supported mutation transport is
the authenticated `/ws` `orchestration.dispatchCommand` (`thread.turn.start`),
which needs an environment-session credential. The supervisor therefore does
**not** touch `state.sqlite`, does not fabricate orchestration events, and does not
copy auth tokens; it uses the result envelope + GitHub receipt fallback. When a
supported callback endpoint exists, it slots in behind `callback.kind = "http"`
without changing the lifecycle logic.

## Security model

- Envelope, state, log, and result files are owner-private (`0600`) in a `0700`
  directory; the plist/task XML is `0600`.
- No secrets in the envelope, argv, or logs; credential-shaped values are refused.
- No root/SYSTEM task; the Windows task is `LeastPrivilege`, InteractiveToken.
- No database access and no orchestration-event fabrication.
- `KeepAlive=false` and a single-run claim (`<handoffId>.lock`) mean a crash cannot
  become an endless restart loop.
- The callback is attempted only after the result is durable, so a failed receipt
  still leaves local evidence.

## Recovery procedure

1. `node scripts/lifecycle-handoff/handoff.mjs status --dir <dir> --id <id>` — read
   `state` and `result`.
2. Read `<dir>/<id>.log` and `<id>.state.json` — every transition is timestamped.
3. `FAILED` results carry `failure.reason`; `command.stdoutTail/stderrTail`
   preserve the command's own evidence.
4. A terminal result means the destructive command will **not** run again; re-running
   the same handoff id is a no-op. To retry deliberately, start a new handoff id.

## Validation

- Harmless fixture on macOS (real launchd): fake parent → prepare → parent exits →
  supervisor survives → harmless command runs → fake service returns → callback
  delivered exactly once → job unregistered → idempotent replay is a no-op.
- Windows: implemented, not executed (no Windows host here).
- A real-T3 restart smoke is intentionally **not** run from an active initiating
  session, because it would terminate that session. The mechanism to do so is
  proven by the fixture; run the real smoke only from an idle T3 with a bounded,
  non-mutating command.
