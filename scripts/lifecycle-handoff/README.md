# Detached lifecycle handoff

Move a T3-stopping lifecycle action (install / update / restart) to an OS-owned
supervisor that survives T3 exiting, then report the outcome back. Design and
security model: [`docs/internals/lifecycle-handoff.md`](../../docs/internals/lifecycle-handoff.md).

Zero dependencies; runs on the Node that is already present.

## How an agent invokes it

1. Write a request JSON (`command.argv` is the lifecycle command; `waitPid` is the
   pid that must exit first — normally the T3 server):

```json
{
  "threadId": "<t3 thread id>",
  "projectId": "<project id>",
  "operation": "update",
  "description": "upgrade T3 to the next released build",
  "agentPid": 1234,
  "waitPid": 5678,
  "command": { "argv": ["/path/to/t3", "update"], "timeoutMs": 900000 },
  "relaunch": { "argv": ["open", "-a", "/Applications/T3 Code (Alpha).app"] },
  "readiness": { "kind": "http", "url": "http://127.0.0.1:3773/health" },
  "identity": { "before": { "version": "0.0.43" }, "afterCommand": { "argv": ["/path/to/t3", "--version"] } },
  "callback": { "kind": "github", "github": { "repo": "nullStack65/t3code", "issue": 10 } }
}
```

2. Prepare and verify independence. **Only quit T3 if this exits 0:**

```bash
node scripts/lifecycle-handoff/handoff.mjs prepare --request request.json
```

It prints the handoff id and the independence proof
(`registration.proof.independent === true`, `directParent === 1`). If it fails, it
has already unregistered the job — do not stop T3.

3. Read progress:

```bash
node scripts/lifecycle-handoff/handoff.mjs status --dir <dir> --id <handoffId>
```

## Layout

| File | Purpose |
| --- | --- |
| `handoff.mjs` | initiating-agent CLI (`prepare` / `status` / `verify`) |
| `supervisor.mjs` | detached entry point started by launchd / Task Scheduler |
| `lib/envelope.mjs` | envelope schema, secret refusal, state names |
| `lib/process.mjs` | liveness and parent-chain independence proof |
| `lib/platform.mjs` | LaunchAgent and Scheduled Task rendering + registration |
| `lib/state.mjs` | atomic owner-only state writes, single-run claim |
| `lib/run.mjs` | the state machine + readiness + callback |
| `fixtures/` | harmless fake parent / command / service for the fixture test |

## Tests

```bash
node --test test/envelope.test.mjs test/run.test.mjs          # unit
node --test test/fixture.integration.test.mjs                 # real launchd (macOS)
```

The integration test runs a real LaunchAgent: a fake parent prepares a handoff,
exits, and the detached supervisor is asserted to survive, run a harmless command,
relaunch a fake service, call back exactly once, unregister itself, and refuse to
re-run the destructive command on replay.
