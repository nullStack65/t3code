# Background service status contract

`t3 service status --json` publishes a small, versioned projection of the native
service manager. It exists so the ENV inventory/doctor can consume service
state without scraping human output and without inventing an application
health check. The implementation is
[BootService.status](https://github.com/nullStack65/t3code/blob/main/apps/server/src/cloud/bootService.ts)
and [formatServiceStatus](https://github.com/nullStack65/t3code/blob/main/apps/server/src/cli/service.ts).

## Identity is not health

The contract keeps these observations separate, and each one may be `unknown`:

| Field                   | Meaning                                                                                                                                                                                                                                               | Not a claim about                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `supported` / `manager` | This host can run a service, and which manager (`systemd`, `launchd`, `scm`, or `unsupported`).                                                                                                                                                       | Whether one is installed.                                                                                                        |
| `installed`             | The fixed-name unit/plist file exists, or (Windows) an SCM registration is present.                                                                                                                                                                   | Whether the manager has loaded it, or that the registration is this home's.                                                      |
| `enabled`               | Manager's own registration state (`systemd UnitFileState`, launchd `print-disabled`, SCM `START_TYPE`).                                                                                                                                               | Running state.                                                                                                                   |
| `running`               | Manager-observed job state: `running`, `stopped`, `transitioning`, `not-loaded`, `unknown`.                                                                                                                                                           | The server answering, or the expected artifact.                                                                                  |
| `current`               | Identity only: unit/plist or SCM registration matches this CLI, the pinned runtime is present, the launcher state file names this version and no update is pending.                                                                                   | Running, enabled, or healthy.                                                                                                    |
| `installedVersion`      | Version recorded in the launcher state file.                                                                                                                                                                                                          | The process that is actually running.                                                                                            |
| `configuredVersion`     | Version parsed from the program path the manager is _configured_ to launch (launchd `program`, systemd `ExecStart`, SCM `BINARY_PATH_NAME` `--runtime`), only when that path normalizes inside the selected base directory's `runtime/versions` tree. | That the server answers, is authenticated, or that a foreign-home path is this service; that the running server is this version. |

A launcher state file records intent; the manager records what it is configured
to launch; the server answering is a third, separate gate. `current: true` with
`running: "not-loaded"` is a truthful combination, not a contradiction.

There is deliberately no observed running-server version. The manager only
exposes the _configured_ launch program, and T3 retains its launcher executable
while replacing the server child during an update, so the configured launcher
and the running server can be different versions. `configuredVersion` therefore
names the configured launcher/installation, never a proven running server; when
a live process is needed but cannot be tied to the target, the identity stays
absent. `observation` carries the raw `state` (systemd `ActiveState`, launchd
`state`), systemd `subState`, and the manager's `processId` when it is a
positive integer, so a consumer can tell a transition or an exited unit from a
live one.

`observation` also carries provenance for the fields above: `manager`, the exact
`source` command, `observedAt`, `reachable`, and a sanitized `detail` when a
value is `unknown` or diverges. A manager that is missing, inaccessible,
permission-refused, timed out, or returned unparseable output is
`reachable: false` or `running: "unknown"`; none of those is treated as
healthy. An unexpected nonzero `launchctl` failure stays `unknown`
(`manager-query-failed`); only an established "could not find" outcome is
absence. A different-home program never produces a `configuredVersion`. Local
paths are included; credentials, process environments and pairing URLs never
are.

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

- `launchctl print gui/<uid>` must answer with a domain, or there is no GUI
  login domain to inspect (`gui-login-domain-unavailable`). A LaunchAgent is a
  login-session service; a missing domain is not a missing service. With no
  selected user (`uid` unknown) the probe does not guess a domain
  (`manager-user-unknown`).
- `launchctl print gui/<uid>/<label>` distinguishes a loaded job from a missing
  one by the explicit "could not find" outcome
  (`launch-agent-not-loaded`). `running` requires `state = running` and a
  positive `pid`; otherwise the job exists but is not running.
- `launchctl print-disabled gui/<uid>` supplies `enabled`/`disabled`.
- A launchctl permission refusal (`Operation not permitted`, `Permission
denied`) is reported as `manager-permission-denied` and stays `unknown`,
  never as a missing domain or a not-loaded job.
- Any other nonzero result, or unparseable output, stays `unknown`
  (`manager-query-failed` / `manager-output-malformed`). A nonzero exit is not
  by itself evidence of absence.

A manager-reported program only counts as this installation's configured
launcher when its normalized path lives under the selected base directory's
`runtime/versions/` tree. A lexical prefix or a `..` segment that escapes that
tree does not count. A program path from another home is reported as
`configured-from-different-home` with no `configuredVersion`, so a stale unit
or wrong `T3CODE_HOME` is visible rather than silently attributed to the
selected installation.

## systemd observations

`systemd` activity and process evidence are separate. `running` requires an
`active`/`reloading` unit with `SubState=running` and a positive `MainPID`;
`active` with no live main process (for example `SubState=exited`) stays
`unknown` rather than being called running or stopped. `activating` and
`deactivating` are `transitioning`, never `stopped`. `inactive`/`failed` are
`stopped`. A malformed or nonpositive `MainPID` and a malformed or negative
`NRestarts` are dropped instead of coerced by `parseInt`.

launchd throttling (`ThrottleInterval`) is not a finite restart budget, so the
contract never reports a launchd restart count. `restartCount` is populated
from systemd `NRestarts` only, where it is a monotonic count since the unit
last started — not a rate and not by itself a problem.

## Windows SCM observations

Windows has no unit file: the service is an SCM registration whose `ImagePath`
is the T3-owned `t3-windows-service-host.exe` plus the explicit `--home`,
`--runtime`, `--log`, `--service-name` and `--expected-account`. The probe is
bounded and read-only, using `sc.exe queryex` and `sc.exe qc`:

- Only the SCM's own `ERROR_SERVICE_DOES_NOT_EXIST` (1060) is absence
  (`service-not-registered`). Any other nonzero result, a timeout, or
  unparseable output stays `unknown` (`manager-query-failed` /
  `manager-timeout` / `manager-output-malformed`); a failed query is never
  absence and never healthy.
- `running` comes from the `STATE` token (`RUNNING` / `STOPPED` /
  `*_PENDING`); `enabled` comes from `START_TYPE` (`AUTO_START` vs
  `DEMAND_START`/`DISABLED`).
- A registration is this installation's own only when its normalized
  `BINARY_PATH_NAME` equals this adapter's rendering for the selected home,
  helper, runtime, log and account. A different binding is
  `windows-service-foreign-registration`, and install/restart/uninstall refuse
  to overwrite or delete it. `install` also refuses when the account is not
  qualified or the helper is not installed beside the runtime.

## Deliberately out of scope

There is no health endpoint, no second registry, and no reset of restart
policies or crash loops. Proving the running server identity end to end needs a
later identity/readiness probe the current primitives do not provide; this
contract reports only the manager's own facts and leaves observed running
identity unknown otherwise.
