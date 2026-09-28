import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  isExactServiceVersion,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";
import {
  isQualifiedWindowsAccount,
  parseScQc,
  parseScQuery,
  scRunningState,
  scServiceDoesNotExist,
  WINDOWS_BOOT_SERVICE_NAME,
  windowsRegistrationMatchesOurBinding,
  windowsServiceHelperPath,
  windowsServiceProgram,
  windowsServiceSteps,
  type WindowsBootServiceBinding,
} from "./windowsBootService.ts";

const BOOT_SERVICE_NAME = "t3code";
const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/**
 * Reads `T3CODE_HOME` back out of a rendered unit or plist. Only values this
 * file writes are expected, so a quoted systemd value is unquoted and
 * unescaped the same way `quoteSystemdValue` produced it.
 */
export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=T3CODE_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) {
    const raw = systemd.trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
        : raw;
    return unquoted.replaceAll("%%", "%");
  }
  const plist = /<key>T3CODE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  if (plist !== undefined) {
    return plist.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  return undefined;
}

export interface BootServicePlan {
  /**
   * What the service manager executes. npm-distributed runtimes run the
   * standalone launcher script with the installing Node; archive-distributed
   * runtimes run their own executable, which hosts the launcher as a hidden
   * subcommand so the machine never needs Node.
   */
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agent tool calls run as children of the server, so they share this cgroup.
    // With the systemd default of OOMPolicy=stop, the kernel killing one greedy
    // child stops the whole unit: the server, every live agent, and the user's
    // connection. Keep running and let Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Plist values are emitted as XML text nodes; only these three need escaping. */
function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // KeepAlive + ThrottleInterval mirror Restart=always + RestartSec=5. launchd
  // has no StartLimitBurst analog; a hard crash loop respawns every 5s forever.
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>T3CODE_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored. Reserved for steps whose common
   * failures (not loaded, already enabled) leave a state a later strict step
   * either tolerates or fails loudly on.
   */
  readonly optional?: boolean;
  /** Override the ProcessRunner default (60s) for steps that block longer. */
  readonly timeout?: Duration.Input;
}

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

/**
 * Platform service-manager integration as data: paths, a pure renderer, and
 * the command steps each flow runs. install/uninstall/status consume this and
 * never branch on platform.
 */
export interface BootServiceManager {
  readonly kind: "systemd" | "launchd" | "scm";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  /** Before rewriting files, when a unit is already installed. */
  readonly stop: ReadonlyArray<BootServiceStep>;
  /** After files are written. The last entry starts the service. */
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** Best-effort recovery after a failed repair of an installed service. */
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Uninstall, before the unit file is removed. */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Uninstall, after the unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

/**
 * SCM integration is registration-based, not file-based: `install`/`status`/
 * `uninstall` branch on it explicitly. `unitPath` is empty because there is no
 * unit file; identity comes from `sc.exe qc`.
 */
function windowsManager(binding: WindowsBootServiceBinding): BootServiceManager {
  const steps = windowsServiceSteps(binding);
  return {
    kind: "scm",
    unitPath: "",
    render: () => windowsServiceProgram(binding).join(" "),
    stop: [steps.stop],
    activate: [steps.reconfigure, steps.start],
    restart: [steps.start],
    deactivate: [steps.stop, steps.delete],
    finalize: [],
  };
}

function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    ".config",
    "systemd",
    "user",
    BOOT_SERVICE_UNIT_FILE,
  );
  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        step: "enabling the service",
        command: "systemctl",
        args: ["--user", "enable", BOOT_SERVICE_UNIT_FILE],
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}

function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
  readonly environmentPath: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    BOOT_SERVICE_PLIST_FILE,
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate
  // kickstart would kill and restart a server it just booted. A lingering job
  // that survived bootout, or a gui domain with nobody logged in at the
  // screen (SSH install), makes bootstrap fail the flow loudly rather than
  // silently keeping a stale server.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a
    // later reinstall. Removing the plist is what stops the next login load.
    // A bootout that fails for a reason other than "not loaded" leaves the
    // job running until logout; the failure is in the boot-service log.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}

/** Undefined means this host cannot run the background service. */
function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
  readonly windows?: WindowsBootServiceBinding;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({ path: input.path, homeDir: input.homeDir });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
    });
  }
  // Windows is only selectable once the explicit account, home, helper and
  // runtime are all known. Missing prerequisites leave the manager undefined so
  // install/status refuse rather than defaulting to LocalSystem.
  if (
    input.platform === "win32" &&
    input.windows !== undefined &&
    isQualifiedWindowsAccount(input.windows.account)
  ) {
    return windowsManager(input.windows);
  }
  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
  "service-account-missing",
  "service-helper-missing",
  "windows-service-unreachable",
  "windows-service-foreign-registration",
]);
type BootServiceProblem = typeof BootServiceProblem.Type;

/** These codes and recovery steps are documented in docs/user/background-service.md. */
export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run T3 with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. T3 Code will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `t3 service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log and `systemctl --user status t3code.service`, then run `t3 service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `t3 service restart` to switch.";
    case "service-account-missing":
      return "Windows background setup needs an explicit, qualified service account (DOMAIN\\user or user@domain). Set T3_SERVICE_ACCOUNT to a dedicated account; T3 never defaults to LocalSystem.";
    case "service-helper-missing":
      return "The T3 Windows service host (t3-windows-service-host.exe) is not installed beside the pinned runtime. It ships with the packaged release; this copy has no Windows service support.";
    case "windows-service-unreachable":
      return "The Windows service control manager did not answer a bounded query. The registration state is unknown, not absent and not healthy; retry after `sc.exe query` responds.";
    case "windows-service-foreign-registration":
      return "An existing service named T3Code is not bound to this T3 home, helper and runtime. T3 will not overwrite or delete another installation's registration.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  { problem: BootServiceProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace t3@${this.installedVersion} with older t3@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError;

/**
 * Version of the additive `t3 service status --json` contract. Bump when an
 * existing field changes meaning or is removed; adding optional fields does
 * not require a bump. The contract is documented in
 * `docs/internals/service-status.md`.
 */
export const BOOT_SERVICE_STATUS_SCHEMA_VERSION = 2;

export type BootServiceManagerKind = "systemd" | "launchd" | "scm" | "unsupported";

/** `unknown` is the honest answer whenever the manager did not answer. */
export type BootServiceEnabledState = "enabled" | "disabled" | "unknown";

/**
 * `transitioning` covers manager states that are neither a live job nor a
 * proven stop (systemd `activating`/`deactivating`). A transitional unit is
 * never reported as stopped.
 */
export type BootServiceRunningState =
  | "running"
  | "stopped"
  | "transitioning"
  | "not-loaded"
  | "unknown";

/**
 * A bounded, read-only observation of the service manager. It is deliberately
 * narrower than application health: `running` only means the manager reports
 * the job's main process alive. A state file, a launchd `last exit code` of 0
 * or a `current` identity never substitute for a live manager answer.
 */
export interface BootServiceManagerObservation {
  readonly manager: "systemd" | "launchd" | "scm";
  /** The command this observation came from. */
  readonly source: string;
  readonly observedAt: string;
  /** Whether the manager control plane answered at all. */
  readonly reachable: boolean;
  readonly enabled: BootServiceEnabledState;
  readonly running: BootServiceRunningState;
  /** Raw manager activity token, preserved verbatim (systemd `ActiveState`, launchd `state`). */
  readonly state?: string;
  /** Raw manager sub-state when the manager exposes one (systemd `SubState`). */
  readonly subState?: string;
  /** The manager's main process id, only when it is a valid positive integer. */
  readonly processId?: number;
  /**
   * The program path the manager is *configured* to launch (systemd
   * `ExecStart`, launchd `program`). This is configuration, not proof of the
   * running server: T3 keeps its launcher executable while it swaps the server
   * child during an update, so the configured launcher and the running server
   * can be different versions. It is reported whether or not it binds to the
   * selected base dir; only a bound path yields `configuredVersion`.
   */
  readonly configuredProgramPath?: string;
  /**
   * Version parsed from `configuredProgramPath` when that path is inside the
   * selected base dir's runtime tree. This names the configured launcher, not
   * the running server; a different-home path never produces it.
   */
  readonly configuredVersion?: string;
  /**
   * `systemd NRestarts`: monotonic since the unit last (re)started. launchd has
   * no equivalent, so this is never set on macOS; launchd throttling is not a
   * finite restart budget and must not be presented as one.
   */
  readonly restartCount?: number;
  /** The manager's own last-result token, when it reports one (systemd `Result`, launchd `last exit code`). */
  readonly lastResult?: string;
  /** Why a value is unknown. Sanitized: never contains host secrets or process environments. */
  readonly detail?: string;
}

export interface BootServiceStatus {
  readonly schemaVersion: number;
  readonly supported: boolean;
  readonly manager: BootServiceManagerKind;
  readonly installed: boolean;
  /**
   * Manager-reported registration state. `unknown` whenever the manager could
   * not be reached, timed out or returned output this CLI cannot parse.
   */
  readonly enabled: BootServiceEnabledState;
  /** Manager-observed job state; `unknown` is never healthy. */
  readonly running: BootServiceRunningState;
  /**
   * Identity only: unit/plist matches this CLI, pinned runtime is present, the
   * state file names this version and no update is pending. `current: true`
   * says nothing about whether the server answers or is even running.
   */
  readonly current: boolean;
  readonly installedVersion?: string;
  /**
   * The T3 home the installed unit serves. The unit name is fixed per user,
   * so a caller working against another base dir must not treat this service
   * as its own; `t3 update --base-dir` learned that by restarting the live
   * server of the machine it ran on.
   */
  readonly installedBaseDir?: string;
  /**
   * Version of the launch program the manager is configured to run, when the
   * manager exposes that path and it binds to the selected base dir. This is
   * configuration, not proof of the running server: T3 retains its launcher
   * executable while replacing the server child, so the configured launcher
   * and the running server can differ. There is deliberately no observed
   * running-server version here until a bounded probe can prove one.
   */
  readonly configuredVersion?: string;
  readonly observation?: BootServiceManagerObservation;
  readonly problems?: ReadonlyArray<BootServiceProblem>;
  readonly unitPath: string;
  readonly logPath: string;
  readonly observedAt: string;
}

/** Extracts an exact release version from a manager-reported runtime path. */
export function bootServiceVersionFromProgramPath(programPath: string): string | undefined {
  const version = /[\\/]runtime[\\/]versions[\\/]([^\\/]+)[\\/]/.exec(programPath)?.[1];
  return version !== undefined && isExactServiceVersion(version) ? version : undefined;
}

export interface BootServiceProgramBinding {
  /** Whether the normalized program path really lives under the selected base dir's runtime tree. */
  readonly contained: boolean;
  /** Version parsed from the contained path's first runtime-tree segment, when exact. */
  readonly version?: string;
}

/**
 * A manager-reported program only identifies *this* installation when it lives
 * under the selected T3 home's `runtime/versions` tree. The check normalizes
 * both paths through the platform `Path` helpers and rejects anything whose
 * relative path escapes that tree, so a lexical prefix or a `..` segment
 * under it is not mistaken for containment. A stale unit, or a home other than
 * the one this CLI is bound to, stays unbound rather than being promoted to
 * this service's identity.
 */
export function bindBootServiceProgramPath(
  programPath: string,
  baseDir: string,
  path: Path.Path,
): BootServiceProgramBinding {
  const versionsDir = path.resolve(pinnedRuntimeVersionsDir(path, baseDir));
  const relative = path.relative(versionsDir, path.resolve(programPath));
  const escaped =
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  if (escaped) return { contained: false };
  const [segment = ""] = relative.split(path.sep);
  return {
    contained: true,
    ...(isExactServiceVersion(segment) ? { version: segment } : {}),
  };
}

/**
 * `launchctl` stderr is not a stable format either, so only a coarse token
 * match is used. A permission refusal is a distinct observation: the manager
 * control plane exists but this user may not inspect it. It must never be
 * folded into "missing domain" or "job not loaded" and must never be healthy.
 */
export function launchdPermissionDenied(stderr: string): boolean {
  return /\b(operation not permitted|permission denied|not privileged|eperm)\b/i.test(stderr);
}

/**
 * The established "this job/domain does not exist" outcomes. Any other nonzero
 * launchctl failure is an unexpected query error, not evidence of absence.
 */
export function launchdNotFound(stderr: string): boolean {
  return /\b(could not find|not find|no such (?:process|service|domain)|service not found|domain not found)\b/i.test(
    stderr,
  );
}

export interface BootServiceSystemdProperties {
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly unitFileState: string;
  readonly execStart: string;
  readonly mainPid?: number;
  readonly nRestarts?: number;
  readonly result?: string;
}

/**
 * Reads a whole field as a safe integer. A numeric prefix with trailing junk
 * (`12junk`), a non-decimal spelling, or a value outside `Number.MAX_SAFE_INTEGER`
 * stays unknown rather than being truncated or rounded into a misleading
 * number. Sign and positivity are decided by the caller's domain rules.
 */
function parseWholeSafeInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parses `systemctl --user show` key=value output. Missing LoadState or
 * ActiveState means the answer is unusable and must stay unknown rather than
 * defaulting to a healthy value. A malformed or nonpositive `MainPID` and a
 * malformed or negative `NRestarts` are dropped rather than coerced, including
 * values too large to represent exactly as a safe integer.
 */
export function parseSystemdShow(stdout: string): BootServiceSystemdProperties | undefined {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const loadState = values.get("LoadState");
  const activeState = values.get("ActiveState");
  if (loadState === undefined || activeState === undefined) return undefined;
  const restartValue = parseWholeSafeInteger(values.get("NRestarts"));
  const nRestarts = restartValue !== undefined && restartValue >= 0 ? restartValue : undefined;
  const mainPidValue = parseWholeSafeInteger(values.get("MainPID"));
  const mainPid = mainPidValue !== undefined && mainPidValue > 0 ? mainPidValue : undefined;
  const result = values.get("Result");
  return {
    loadState,
    activeState,
    subState: values.get("SubState") ?? "",
    unitFileState: values.get("UnitFileState") ?? "",
    execStart: values.get("ExecStart") ?? "",
    ...(mainPid === undefined ? {} : { mainPid }),
    ...(nRestarts === undefined ? {} : { nRestarts }),
    ...(result !== undefined && result !== "" ? { result } : {}),
  };
}

export interface BootServiceLaunchdPrint {
  readonly state?: string;
  readonly pid?: number;
  readonly program?: string;
  readonly lastExitCode?: number;
}

/**
 * `launchctl print` has no stable machine format, so only a few anchored tokens
 * are read. A response with none of them is malformed and stays unknown. A
 * `pid` is only observed when the whole field is a positive safe integer; a
 * zero, a numeric prefix with trailing junk, or an unrepresentable value is not
 * a live process. `last exit code` is read as a whole safe signed integer.
 */
export function parseLaunchdPrint(stdout: string): BootServiceLaunchdPrint | undefined {
  if (!/(?:^|\n)[ \t]*(?:state|pid|program|last exit code)[ \t]*=/.test(stdout)) return undefined;
  const state = /(?:^|\n)[ \t]*state[ \t]*=[ \t]*([^\n]*)/.exec(stdout)?.[1]?.trim();
  const pidText = /(?:^|\n)[ \t]*pid[ \t]*=[ \t]*([^\n]*)/.exec(stdout)?.[1];
  const program = /(?:^|\n)[ \t]*program[ \t]*=[ \t]*([^\n]*)/.exec(stdout)?.[1]?.trim();
  const lastExitText = /(?:^|\n)[ \t]*last exit code[ \t]*=[ \t]*([^\n]*)/.exec(stdout)?.[1];
  const pidValue = parseWholeSafeInteger(pidText);
  const pid = pidValue !== undefined && pidValue > 0 ? pidValue : undefined;
  const lastExitCode = parseWholeSafeInteger(lastExitText);
  return {
    ...(state === undefined || state === "" ? {} : { state }),
    ...(pid === undefined ? {} : { pid }),
    ...(program === undefined || program === "" ? {} : { program }),
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
  };
}

/** Reads enabled/disabled out of `launchctl print-disabled gui/<uid>`. */
export function parseLaunchdDisabled(stdout: string, label: string): boolean | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)[ \\t]*"?${escaped}"?[ \\t]*=>[ \\t]*(true|false)`).exec(
    stdout,
  );
  return match === null ? undefined : match[1] === "true";
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (options?: {
      readonly allowDowngrade?: boolean;
      /**
       * Write the unit for this version but leave the service on whatever it
       * is running now. `t3 update` uses this when the user declines the
       * restart, so a later `t3 service restart` lands on the new version.
       */
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Stop and start the installed service on the version its unit names.
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone. Resolves false when nothing was
     * restarted.
     */
    readonly restart: Effect.Effect<boolean, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const uid = yield* HostProcessUserId;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );
  const environmentPath = Array.from(
    new Set([
      ...xmlSafeInstallerDirectories,
      path.dirname(host.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ).join(":");

  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion, platform);
  // Windows binds an explicit, qualified account; there is no LocalSystem
  // default. Absent or unqualified, the manager is not selectable at all.
  const windowsAccount = Option.getOrUndefined(
    yield* Config.String("T3_SERVICE_ACCOUNT").pipe(Config.option),
  )?.trim();
  const windowsBinding: WindowsBootServiceBinding | undefined =
    platform === "win32"
      ? {
          hostPath: windowsServiceHelperPath(runtimePaths.entryPath, path),
          homeDir: input.baseDir,
          runtimePath: runtimePaths.entryPath,
          logPath: path.join(input.logsDir, "boot-service.log"),
          serviceName: WINDOWS_BOOT_SERVICE_NAME,
          ...(windowsAccount === undefined || windowsAccount === ""
            ? {}
            : { account: windowsAccount }),
        }
      : undefined;
  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
    ...(windowsBinding === undefined ? {} : { windows: windowsBinding }),
  });
  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, "boot-service.log");
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        // Opened read-write: Windows refuses to flush a handle without write access.
        yield* (yield* fs.open(tempPath, { flag: "r+" })).sync;
        yield* fs.rename(tempPath, filePath);
        // Windows has no directory fsync (EPERM); NTFS journals the rename.
        yield* (yield* fs.open(directory, { flag: "r" })).sync.pipe(
          Effect.catchIf(
            (error) => (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM",
            () => Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  // The executable hosts the launcher as a hidden subcommand of itself, so
  // the unit runs the pinned runtime directly.
  const plan: BootServicePlan = {
    program: [runtimePaths.entryPath, "__service-launcher"],
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const logFailure = (error: { readonly message: string }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError(logFailure),
    );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(
          entry.step,
          entry.command,
          entry.args,
          entry.timeout === undefined ? undefined : { timeout: entry.timeout },
        );
        // runStep's tapError already appends the failure to the log, so an
        // ignored optional step still leaves a trace.
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const probe = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.seconds(5) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  const lingerArgs = [
    "show-user",
    ...(uid === undefined ? [] : [String(uid)]),
    "--property=Linger",
    "--value",
  ];
  const readSystemdProblems = Effect.fn("cloud.boot_service.read_systemd_problems")(function* (
    includeService: boolean,
  ) {
    const [manager, linger] = yield* Effect.all(
      [probe("systemctl", ["--user", "show-environment"]), probe("loginctl", lingerArgs)],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (!succeeded(manager)) problems.push("user-manager-unavailable");
    const lingering = succeeded(linger) && Option.isSome(linger) ? linger.value.stdout.trim() : "";
    if (lingering !== "yes") {
      problems.push(lingering === "no" ? "linger-disabled" : "linger-unavailable");
    }
    if (includeService && succeeded(manager)) {
      const [enabled, active] = yield* Effect.all(
        [
          probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
          probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !succeeded(enabled) ||
        (Option.isSome(enabled) && enabled.value.stdout.trim() !== "enabled")
      ) {
        problems.push("service-disabled");
      }
      if (!succeeded(active)) problems.push("service-stopped");
    }
    return problems;
  });

  /**
   * A single bounded, read-only manager probe. Timeouts are the caller's to
   * interpret: a manager that does not answer within the bound is unknown, not
   * stopped and certainly not healthy.
   */
  const probeManager = (command: string, args: ReadonlyArray<string>) =>
    runner
      .run({
        command,
        args,
        timeout: Duration.seconds(5),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);

  const unknownObservation = (input: {
    readonly manager: "systemd" | "launchd" | "scm";
    readonly source: string;
    readonly observedAt: string;
    readonly detail: string;
    readonly enabled?: BootServiceEnabledState;
    readonly reachable?: boolean;
  }): BootServiceManagerObservation => ({
    manager: input.manager,
    source: input.source,
    observedAt: input.observedAt,
    reachable: input.reachable ?? false,
    enabled: input.enabled ?? "unknown",
    running: "unknown",
    detail: input.detail,
  });

  const observeSystemd = Effect.fn("cloud.boot_service.observe_systemd")(function* () {
    const source = `systemctl --user show ${BOOT_SERVICE_UNIT_FILE}`;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* probeManager("systemctl", [
      "--user",
      "show",
      BOOT_SERVICE_UNIT_FILE,
      "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState,ExecStart,NRestarts,Result",
    ]);
    if (Option.isNone(result)) {
      return unknownObservation({
        manager: "systemd",
        source,
        observedAt,
        detail: "manager-unreachable",
      });
    }
    if (result.value.timedOut) {
      return unknownObservation({
        manager: "systemd",
        source,
        observedAt,
        detail: "manager-timeout",
      });
    }
    if (result.value.code !== 0) {
      return unknownObservation({
        manager: "systemd",
        source,
        observedAt,
        detail: "manager-unreachable",
      });
    }
    const parsed = parseSystemdShow(result.value.stdout);
    if (parsed === undefined) {
      return unknownObservation({
        manager: "systemd",
        source,
        observedAt,
        detail: "manager-output-malformed",
        reachable: true,
      });
    }
    const running: BootServiceRunningState =
      parsed.loadState === "not-found"
        ? "not-loaded"
        : parsed.activeState === "activating" || parsed.activeState === "deactivating"
          ? "transitioning"
          : parsed.activeState === "active" || parsed.activeState === "reloading"
            ? parsed.subState === "running" && parsed.mainPid !== undefined
              ? "running"
              : "unknown"
            : parsed.activeState === "inactive" || parsed.activeState === "failed"
              ? "stopped"
              : "unknown";
    const enabled: BootServiceEnabledState =
      parsed.unitFileState === "enabled"
        ? "enabled"
        : parsed.unitFileState === "disabled" ||
            parsed.unitFileState === "masked" ||
            parsed.unitFileState === "not-found"
          ? "disabled"
          : "unknown";
    const programPath = /path=([^;]+?)\s*(?:;|})/.exec(parsed.execStart)?.[1];
    const binding =
      programPath === undefined
        ? undefined
        : bindBootServiceProgramPath(programPath, input.baseDir, path);
    const detail =
      binding !== undefined && !binding.contained
        ? "configured-from-different-home"
        : running === "unknown"
          ? "manager-state-unknown"
          : undefined;
    return {
      manager: "systemd",
      source,
      observedAt,
      reachable: true,
      enabled,
      running,
      ...(parsed.activeState === "" ? {} : { state: parsed.activeState }),
      ...(parsed.subState === "" ? {} : { subState: parsed.subState }),
      ...(parsed.mainPid === undefined ? {} : { processId: parsed.mainPid }),
      ...(programPath === undefined ? {} : { configuredProgramPath: programPath }),
      ...(binding?.version === undefined ? {} : { configuredVersion: binding.version }),
      ...(parsed.nRestarts === undefined ? {} : { restartCount: parsed.nRestarts }),
      ...(parsed.result === undefined ? {} : { lastResult: parsed.result }),
      ...(detail === undefined ? {} : { detail }),
    } satisfies BootServiceManagerObservation;
  });

  const observeLaunchd = Effect.fn("cloud.boot_service.observe_launchd")(function* () {
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    if (uid === undefined) {
      // The selected user is unknown, so there is no `gui/<uid>` domain to bind
      // to. Guessing one (e.g. `gui/0`) would observe the wrong user.
      return unknownObservation({
        manager: "launchd",
        source: `launchctl print gui/<uid>/${BOOT_SERVICE_LAUNCHD_LABEL}`,
        observedAt,
        detail: "manager-user-unknown",
      });
    }
    const domainTarget = `gui/${String(uid)}`;
    const domainSource = `launchctl print ${domainTarget}`;
    const jobSource = `launchctl print ${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
    const domain = yield* probeManager("launchctl", ["print", domainTarget]);
    if (Option.isNone(domain)) {
      return unknownObservation({
        manager: "launchd",
        source: domainSource,
        observedAt,
        detail: "manager-unreachable",
      });
    }
    if (domain.value.timedOut) {
      return unknownObservation({
        manager: "launchd",
        source: domainSource,
        observedAt,
        detail: "manager-timeout",
      });
    }
    if (domain.value.code !== 0 || domain.value.stdout.trim() === "") {
      if (launchdPermissionDenied(domain.value.stderr)) {
        return unknownObservation({
          manager: "launchd",
          source: domainSource,
          observedAt,
          detail: "manager-permission-denied",
          reachable: true,
        });
      }
      // A zero-code answer, or an explicit "could not find", is an absent domain.
      // Any other nonzero result is an unexpected query failure and is not
      // evidence that the domain is missing.
      const absentDomain = domain.value.code === 0 || launchdNotFound(domain.value.stderr);
      return unknownObservation({
        manager: "launchd",
        source: domainSource,
        observedAt,
        detail: absentDomain ? "gui-login-domain-unavailable" : "manager-query-failed",
        reachable: !absentDomain,
      });
    }
    const disabledResult = yield* probeManager("launchctl", ["print-disabled", domainTarget]);
    const disabled =
      Option.isSome(disabledResult) &&
      !disabledResult.value.timedOut &&
      disabledResult.value.code === 0
        ? parseLaunchdDisabled(disabledResult.value.stdout, BOOT_SERVICE_LAUNCHD_LABEL)
        : undefined;
    const enabled: BootServiceEnabledState =
      disabled === undefined ? "unknown" : disabled ? "disabled" : "enabled";
    const job = yield* probeManager("launchctl", [
      "print",
      `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`,
    ]);
    if (Option.isNone(job)) {
      return unknownObservation({
        manager: "launchd",
        source: jobSource,
        observedAt,
        detail: "manager-unreachable",
        enabled,
        reachable: true,
      });
    }
    if (job.value.timedOut) {
      return unknownObservation({
        manager: "launchd",
        source: jobSource,
        observedAt,
        detail: "manager-timeout",
        enabled,
        reachable: true,
      });
    }
    if (job.value.code !== 0) {
      if (launchdPermissionDenied(job.value.stderr)) {
        return unknownObservation({
          manager: "launchd",
          source: jobSource,
          observedAt,
          detail: "manager-permission-denied",
          enabled,
          reachable: true,
        });
      }
      // A genuine "could not find service" is a not-loaded job. Any other
      // nonzero result is an unexpected query failure: unknown, not absence.
      return launchdNotFound(job.value.stderr)
        ? ({
            manager: "launchd",
            source: jobSource,
            observedAt,
            reachable: true,
            enabled,
            running: "not-loaded",
            detail: "launch-agent-not-loaded",
          } satisfies BootServiceManagerObservation)
        : unknownObservation({
            manager: "launchd",
            source: jobSource,
            observedAt,
            detail: "manager-query-failed",
            enabled,
            reachable: true,
          });
    }
    const parsed = parseLaunchdPrint(job.value.stdout);
    if (parsed === undefined) {
      return unknownObservation({
        manager: "launchd",
        source: jobSource,
        observedAt,
        detail: "manager-output-malformed",
        enabled,
        reachable: true,
      });
    }
    const running: BootServiceRunningState =
      parsed.state === "running" && parsed.pid !== undefined
        ? "running"
        : parsed.state === "not running" || parsed.state === "waiting" || parsed.state === "exited"
          ? "stopped"
          : "unknown";
    const binding =
      parsed.program === undefined
        ? undefined
        : bindBootServiceProgramPath(parsed.program, input.baseDir, path);
    const detail =
      binding !== undefined && !binding.contained
        ? "configured-from-different-home"
        : running === "unknown"
          ? "manager-state-unknown"
          : undefined;
    return {
      manager: "launchd",
      source: jobSource,
      observedAt,
      reachable: true,
      enabled,
      running,
      ...(parsed.state === undefined ? {} : { state: parsed.state }),
      ...(parsed.pid === undefined ? {} : { processId: parsed.pid }),
      ...(parsed.program === undefined ? {} : { configuredProgramPath: parsed.program }),
      ...(binding?.version === undefined ? {} : { configuredVersion: binding.version }),
      ...(parsed.lastExitCode === undefined ? {} : { lastResult: String(parsed.lastExitCode) }),
      ...(detail === undefined ? {} : { detail }),
    } satisfies BootServiceManagerObservation;
  });

  /**
   * Bounded SCM observation through `sc.exe`. Registration, start type and the
   * live state are read from real manager output; a failed or timed-out query is
   * unknown, and only the SCM's own 1060 is absence.
   */
  const observeScm = Effect.fn("cloud.boot_service.observe_scm")(function* () {
    const source = `sc.exe queryex ${WINDOWS_BOOT_SERVICE_NAME}`;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const binding = windowsBinding;
    if (binding === undefined) {
      return unknownObservation({
        manager: "scm",
        source,
        observedAt,
        detail: "manager-unconfigured",
      });
    }
    const result = yield* probeManager("sc.exe", ["queryex", binding.serviceName]);
    if (Option.isNone(result)) {
      return unknownObservation({
        manager: "scm",
        source,
        observedAt,
        detail: "manager-unreachable",
      });
    }
    if (result.value.timedOut) {
      return unknownObservation({ manager: "scm", source, observedAt, detail: "manager-timeout" });
    }
    if (
      result.value.code !== 0 &&
      scServiceDoesNotExist(result.value.code, result.value.stdout, result.value.stderr)
    ) {
      return {
        manager: "scm",
        source,
        observedAt,
        reachable: true,
        enabled: "unknown",
        running: "not-loaded",
        detail: "service-not-registered",
      } satisfies BootServiceManagerObservation;
    }
    if (result.value.code !== 0) {
      return unknownObservation({
        manager: "scm",
        source,
        observedAt,
        detail: "manager-query-failed",
        reachable: true,
      });
    }
    const parsed = parseScQuery(result.value.stdout);
    if (parsed === undefined) {
      return unknownObservation({
        manager: "scm",
        source,
        observedAt,
        detail: "manager-output-malformed",
        reachable: true,
      });
    }
    const qcResult = yield* probeManager("sc.exe", ["qc", binding.serviceName]);
    const qc =
      Option.isSome(qcResult) && !qcResult.value.timedOut && qcResult.value.code === 0
        ? parseScQc(qcResult.value.stdout)
        : undefined;
    const enabled: BootServiceEnabledState =
      qc?.startType === undefined
        ? "unknown"
        : /AUTO_START/i.test(qc.startType)
          ? "enabled"
          : /DEMAND_START|DISABLED/i.test(qc.startType)
            ? "disabled"
            : "unknown";
    const runtimeFromImage =
      qc?.binaryPathName === undefined
        ? undefined
        : /--runtime\s+"?([^"\s]+)"?/.exec(qc.binaryPathName)?.[1];
    const bound =
      runtimeFromImage === undefined
        ? undefined
        : bindBootServiceProgramPath(runtimeFromImage, input.baseDir, path);
    const running = scRunningState(parsed.state);
    return {
      manager: "scm",
      source,
      observedAt,
      reachable: true,
      enabled,
      running,
      ...(parsed.state === undefined ? {} : { state: parsed.state }),
      ...(parsed.processId === undefined ? {} : { processId: parsed.processId }),
      ...(qc?.binaryPathName === undefined ? {} : { configuredProgramPath: qc.binaryPathName }),
      ...(bound?.version === undefined ? {} : { configuredVersion: bound.version }),
      ...(running === "unknown" ? { detail: "manager-state-unknown" } : {}),
    } satisfies BootServiceManagerObservation;
  });

  const observeManager =
    detectedManager?.kind === "systemd"
      ? observeSystemd
      : detectedManager?.kind === "launchd"
        ? observeLaunchd
        : observeScm;

  const requireSystemdPrerequisites = Effect.gen(function* () {
    const problems = yield* readSystemdProblems(false);
    const unavailable = problems.find((problem) => problem !== "linger-disabled");
    if (unavailable) return yield* new BootServicePrerequisiteError({ problem: unavailable });
    if (!problems.includes("linger-disabled")) return;
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        (cause) => new BootServicePrerequisiteError({ problem: "linger-disabled", cause }),
      ),
    );
    const remaining = yield* readSystemdProblems(false);
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  const requireWindowsBinding = Effect.gen(function* () {
    if (windowsBinding === undefined || !isQualifiedWindowsAccount(windowsBinding.account)) {
      return yield* new BootServicePrerequisiteError({ problem: "service-account-missing" });
    }
    return windowsBinding;
  });

  /**
   * Reads the existing SCM registration without mutating it. `undefined`
   * registered means the SCM's own 1060; a failed or timed-out query is
   * distinct and callers must not read it as absence.
   */
  const inspectWindowsRegistration = (binding: WindowsBootServiceBinding) =>
    Effect.gen(function* () {
      const result = yield* probeManager("sc.exe", ["qc", binding.serviceName]);
      if (Option.isNone(result) || result.value.timedOut) {
        return { kind: "unreachable" as const };
      }
      if (result.value.code !== 0) {
        return scServiceDoesNotExist(result.value.code, result.value.stdout, result.value.stderr)
          ? { kind: "absent" as const }
          : { kind: "unreachable" as const };
      }
      const qc = parseScQc(result.value.stdout);
      if (qc === undefined) return { kind: "unreachable" as const };
      return { kind: "registered" as const, qc };
    });

  const installWindows = Effect.fn("cloud.boot_service.install_windows")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const binding = yield* requireWindowsBinding;
    if (!(yield* fs.exists(binding.hostPath))) {
      return yield* new BootServicePrerequisiteError({ problem: "service-helper-missing" });
    }
    const steps = windowsServiceSteps(binding);
    const inspection = yield* inspectWindowsRegistration(binding);
    if (inspection.kind === "unreachable") {
      return yield* new BootServicePrerequisiteError({ problem: "windows-service-unreachable" });
    }
    const registered = inspection.kind === "registered";
    if (
      inspection.kind === "registered" &&
      !windowsRegistrationMatchesOurBinding(inspection.qc, binding)
    ) {
      // A foreign or changed binding is refused before anything is stopped or
      // rewritten; the adapter never adopts another install's registration.
      return yield* new BootServicePrerequisiteError({
        problem: "windows-service-foreign-registration",
      });
    }
    const start = options?.start !== false;
    if (registered && start) yield* runSteps([steps.stop]);

    if (registered) {
      const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
      if (Option.isSome(previousStateText)) {
        if (serviceStateHasPendingUpdate(previousStateText.value)) {
          return yield* new BootServiceUpdatePendingError();
        }
        const installedVersion = serviceStateActiveVersion(previousStateText.value);
        if (
          installedVersion !== undefined &&
          options?.allowDowngrade !== true &&
          compareExactServiceVersions(input.cliVersion, installedVersion) < 0
        ) {
          return yield* new BootServiceDowngradeRefusedError({
            installedVersion,
            targetVersion: input.cliVersion,
          });
        }
      }
    }
    if (!start && registered) {
      yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
    }
    yield* writeDurably(
      statePath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
      `${JSON.stringify(
        {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: input.cliVersion,
        } satisfies ServiceState,
        null,
        2,
      )}\n`,
    );
    if (!start && registered) {
      const written = yield* fs.readFileString(statePath);
      if (serviceStateActiveVersion(written) !== input.cliVersion) {
        return yield* new BootServiceUpdatePendingError();
      }
    }
    if (start) {
      // `reconfigure` is idempotent; `register` only runs when absent. Start is
      // last, so no administrative write follows a successful start.
      yield* runSteps(
        registered ? [steps.reconfigure, steps.start] : [steps.register, steps.start],
      );
      yield* fs.remove(restartPendingPath, { force: true });
    }
    return {
      program: windowsServiceProgram(binding),
      baseDir: input.baseDir,
      logPath,
      unitPath: binding.hostPath,
    } satisfies BootServicePlan;
  });

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // A permissions failure must not leave a partial install or stop a working server.
    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [...pinnedRuntimeCommand(runtime).args, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned t3 runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned t3 runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    if (manager.kind === "scm") {
      return yield* installWindows(options).pipe(
        Effect.mapError((cause) =>
          cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
        ),
      );
    }
    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // With start=false the service keeps running while its files change. The
    // launcher reads the state file once at startup and the unit only matters
    // on the next start, so that is safe as long as the launcher is not in
    // the middle of a remote update, which is the one time it writes the
    // state file itself. That case is refused below, before anything is
    // written, from the same read the downgrade check uses; the stop that
    // normally serialises against the launcher is skipped on purpose.
    const start = options?.start !== false;
    if (installed && start) {
      yield* runSteps(manager.stop);
    }

    yield* Effect.gen(function* () {
      if (installed) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
        if (Option.isSome(previousStateText)) {
          if (serviceStateHasPendingUpdate(previousStateText.value)) {
            return yield* new BootServiceUpdatePendingError();
          }
          // A remote update can finish after the CLI checks status. Read its
          // final version after the launcher stops and before changing files.
          const installedVersion = serviceStateActiveVersion(previousStateText.value);
          if (
            installedVersion !== undefined &&
            options?.allowDowngrade !== true &&
            compareExactServiceVersions(input.cliVersion, installedVersion) < 0
          ) {
            return yield* new BootServiceDowngradeRefusedError({
              installedVersion,
              targetVersion: input.cliVersion,
            });
          }
        }
      }
      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      if (!start && installed) {
        // Written first: once the files below name the new version, the
        // running service is behind them, and a failure between the two
        // writes must not leave it looking current. The launcher removes the
        // marker when it starts, `restart` and a started install do too.
        yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
      }
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      if (!start && installed) {
        // The launcher only writes this file while a remote update is in
        // flight. One that began after the check above lands either before
        // this write (then the launcher's copy in memory is what it keeps
        // acting on, and its next write puts its own outcome back) or after
        // it, which this read catches: the file no longer says what was just
        // written, so stop here before repointing the unit.
        const written = yield* fs.readFileString(statePath);
        if (serviceStateActiveVersion(written) !== input.cliVersion) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* writeDurably(unitPath, manager.render(plan));

      if (start) {
        yield* runSteps(manager.activate);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      Effect.tapError(() =>
        installed && start ? runSteps(manager.restart).pipe(Effect.ignore) : Effect.void,
      ),
    );
    return plan;
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    if (manager.kind === "scm") {
      const binding = yield* requireWindowsBinding;
      const inspection = yield* inspectWindowsRegistration(binding);
      if (
        inspection.kind !== "registered" ||
        !windowsRegistrationMatchesOurBinding(inspection.qc, binding)
      ) {
        // Absent, unreachable or another home's registration: leave it alone.
        return false;
      }
      const steps = windowsServiceSteps(binding);
      yield* runSteps([steps.stop]);
      yield* runSteps([steps.start]).pipe(
        Effect.tapError(() => runSteps([steps.start]).pipe(Effect.ignore)),
      );
      yield* fs.remove(restartPendingPath, { force: true });
      return true;
    }
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return false;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return false;
    }
    yield* runSteps(manager.stop);
    yield* runSteps(manager.activate).pipe(
      // Same recovery as a failed repair: a service that was running should
      // not be left stopped because daemon-reload or enable failed.
      Effect.tapError(() => runSteps(manager.restart).pipe(Effect.ignore)),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return true;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    if (manager.kind === "scm") {
      const binding = yield* requireWindowsBinding;
      const inspection = yield* inspectWindowsRegistration(binding);
      if (
        inspection.kind !== "registered" ||
        !windowsRegistrationMatchesOurBinding(inspection.qc, binding)
      ) {
        // Never delete a foreign or unreachable registration, and never touch
        // the home or userdata; only the exact owned registration is removed.
        return false;
      }
      const steps = windowsServiceSteps(binding);
      yield* runSteps([steps.stop]).pipe(Effect.ignore);
      yield* runSteps([steps.delete]);
      return true;
    }
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    yield* runSteps(manager.deactivate);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runSteps(manager.finalize);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    if (detectedManager === undefined) {
      return {
        schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        supported: false,
        manager: "unsupported",
        installed: false,
        enabled: "unknown",
        running: "unknown",
        current: false,
        unitPath,
        logPath,
        observedAt,
      } satisfies BootServiceStatus;
    }
    if (detectedManager.kind === "scm") {
      const binding = yield* requireWindowsBinding.pipe(
        Effect.catchTag("BootServicePrerequisiteError", () =>
          Effect.succeed(undefined as WindowsBootServiceBinding | undefined),
        ),
      );
      if (binding === undefined) {
        return {
          schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
          supported: false,
          manager: "unsupported",
          installed: false,
          enabled: "unknown",
          running: "unknown",
          current: false,
          unitPath,
          logPath,
          observedAt,
        } satisfies BootServiceStatus;
      }
      const observation = yield* observeScm();
      if (observation.detail === "service-not-registered") {
        return {
          schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
          supported: true,
          manager: "scm",
          installed: false,
          enabled: "unknown",
          running: "not-loaded",
          current: false,
          observation,
          unitPath,
          logPath,
          observedAt,
        } satisfies BootServiceStatus;
      }
      const inspection = yield* inspectWindowsRegistration(binding);
      const queryFailed =
        inspection.kind === "unreachable" ||
        [
          "manager-unreachable",
          "manager-timeout",
          "manager-query-failed",
          "manager-output-malformed",
        ].includes(observation.detail ?? "");
      const [runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ]);
      const installedVersion = Option.isSome(stateText)
        ? serviceStateActiveVersion(stateText.value)
        : undefined;
      const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
      const bound =
        inspection.kind === "registered" &&
        windowsRegistrationMatchesOurBinding(inspection.qc, binding);
      const problems: BootServiceProblem[] = [];
      if (queryFailed) problems.push("windows-service-unreachable");
      else if (!bound) problems.push("windows-service-foreign-registration");
      if (observation.running === "stopped") problems.push("service-stopped");
      if (observation.enabled === "disabled") problems.push("service-disabled");
      if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
      return {
        schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        supported: true,
        manager: "scm",
        installed: inspection.kind === "registered",
        enabled: observation.enabled,
        running: observation.running,
        ...(installedVersion === undefined ? {} : { installedVersion }),
        installedBaseDir: binding.homeDir,
        ...(observation.configuredVersion === undefined
          ? {}
          : { configuredVersion: observation.configuredVersion }),
        observation,
        problems,
        current:
          problems.length === 0 &&
          bound &&
          runtimeEntryExists &&
          Option.isSome(runtimeSentinel) &&
          runtimeSentinel.value.trim() === input.cliVersion &&
          state?.activeVersion === input.cliVersion &&
          state?.update?.status !== "pending",
        unitPath,
        logPath,
        observedAt,
      } satisfies BootServiceStatus;
    }
    if (!(yield* fs.exists(unitPath))) {
      // No unit file is the only claim made here. The manager is not probed for
      // an unregistered service, and an absent file is not evidence about a
      // foreign registration that happens to share the fixed unit name.
      return {
        schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        supported: true,
        manager: detectedManager.kind,
        installed: false,
        enabled: "unknown",
        running: "unknown",
        current: false,
        unitPath,
        logPath,
        observedAt,
      } satisfies BootServiceStatus;
    }
    const [unit, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
      fs.readFileString(unitPath),
      fs.exists(runtimePaths.entryPath),
      fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
      fs.readFileString(statePath).pipe(Effect.option),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir = bootServiceBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    // Existing problem codes and their `current` effect are preserved; the
    // richer manager observation below is additive and never rewrites them.
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd" ? [...(yield* readSystemdProblems(true))] : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    const observation = yield* observeManager();
    return {
      schemaVersion: BOOT_SERVICE_STATUS_SCHEMA_VERSION,
      supported: true,
      manager: detectedManager.kind,
      installed: true,
      enabled: observation.enabled,
      running: observation.running,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      ...(observation.configuredVersion === undefined
        ? {}
        : { configuredVersion: observation.configuredVersion }),
      observation,
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
      observedAt,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, restart, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
