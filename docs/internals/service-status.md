# Background service status contract

`t3 service status --json` publishes a small, versioned projection of the native
service manager. It exists so the ENV inventory/doctor can consume service
state without scraping human output and without inventing an application
health check. The implementation is
[BootService.status](https://github.com/nullStack65/t3code/blob/main/apps/server/src/cloud/bootService.ts)
and [formatServiceStatus](https://github.com/nullStack65/t3code/blob/main/apps/server/src/cli/service.ts).

## Identity is not health

The contract keeps these observations separate, and each one may be `unknown`:

| Field                   | Meaning                                                                                                                                                                   | Not a claim about                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `supported` / `manager` | This host can run a service, and which manager.                                                                                                                           | Whether one is installed.                                                               |
| `installed`             | The unit/plist file for this fixed per-user name exists.                                                                                                                  | Whether the manager has loaded it.                                                      |
| `enabled`               | Manager's own registration state (`systemd UnitFileState`, launchd `print-disabled`).                                                                                     | Running state.                                                                          |
| `running`               | Manager-observed job state: `running`, `stopped`, `not-loaded`, `unknown`.                                                                                                | The server answering, or the expected artifact.                                         |
| `current`               | Identity only: unit/plist matches this CLI, the pinned runtime is present, the launcher state file names this version and no update is pending.                           | Running, enabled, or healthy.                                                           |
| `installedVersion`      | Version recorded in the launcher state file.                                                                                                                              | The process that is actually running.                                                   |
| `runningVersion`        | Version parsed from the program path the manager reports as launched (launchd `program`, systemd `ExecStart`), only when that path is inside the selected base directory. | That the server answers, is authenticated, or that a foreign-home path is this service. |

A launcher state file records intent; the manager records what it launched; the
server answering is a third, separate gate. `current: true` with
`running: "not-loaded"` is a truthful combination, not a contradiction.

`observation` carries provenance for the fields above: `manager`, the exact
`source` command, `observedAt`, `reachable`, and a sanitized `detail` when a
value is `unknown` or diverges. A manager that is missing, inaccessible,
permission-refused, timed out, or returned unparseable output is
`reachable: false` or `running: "unknown"`; none of those is treated as
healthy, and a different-home program never produces a `runningVersion`. Local paths are included; credentials,
process environments and pairing URLs never are.

## Versioning

`BOOT_SERVICE_STATUS_SCHEMA_VERSION` is in
[bootService.ts](https://github.com/nullStack65/t3code/blob/main/apps/server/src/cloud/bootService.ts).
Adding an optional field does not bump it; changing a field's meaning or
removing one does. Consumers should ignore unknown fields and treat any
`unknown` as unknown rather than a default.

## macOS launchctl observations

`launchctl print` is not a stable machine format, so only a few anchored tokens
are read and the result of a malformed answer stays `unknown`. The probe is
bounded and read-only:

- `launchctl print gui/<uid>` must answer and be non-empty, or there is no GUI
  login domain to inspect (`gui-login-domain-unavailable`). A LaunchAgent is a
  login-session service; a missing domain is not a missing service. With no
  selected user (`uid` unknown) the probe does not guess a domain
  (`manager-user-unknown`).
- `launchctl print gui/<uid>/<label>` distinguishes a loaded job from a missing
  one (`launch-agent-not-loaded`). `running` requires a `state = running` and a
  `pid`; otherwise the job exists but is not running.
- `launchctl print-disabled gui/<uid>` supplies `enabled`/`disabled`.
- A launchctl permission refusal (`Operation not permitted`, `Permission
denied`) is reported as `manager-permission-denied` and stays `unknown`,
  never as a missing domain or a not-loaded job.

A manager-reported program only counts as this service's running identity when
it lives under the selected base directory's `runtime/versions/` tree. A
program path from another home is reported as `running-from-different-home`
with no `runningVersion`, so a stale unit or wrong `T3CODE_HOME` is visible
rather than silently attributed to the selected installation.

launchd throttling (`ThrottleInterval`) is not a finite restart budget, so the
contract never reports a launchd restart count. `restartCount` is populated
from systemd `NRestarts` only, where it is a monotonic count since the unit
last started — not a rate and not by itself a problem.

## Deliberately out of scope

There is no health endpoint, no second registry, and no reset of restart
policies or crash loops. Proving the expected running artifact end to end needs
a later identity/readiness probe the current primitives do not provide; this
contract returns `runningVersion` only when the manager itself exposes the
launched program, and reports `unknown` otherwise.
