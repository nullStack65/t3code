import * as Duration from "effect/Duration";
import type * as Path from "effect/Path";

import type { BootServiceStep } from "./bootService.ts";

/**
 * Pure, Windows-only pieces of the T3-owned SCM service adapter. Everything here
 * can be unit-tested on any host: command rendering, `sc.exe` output parsing and
 * the registration/identity rules. The `BootService` flows consume it; nothing
 * here starts a process. A missing helper, a foreign registration or a changed
 * target binding is refused in the caller before any mutation.
 */
export const WINDOWS_BOOT_SERVICE_NAME = "T3Code";
/** The T3-owned SCM host, compiled from `native/windows-service-host` and shipped
    beside the pinned runtime. Never a generic wrapper. */
export const WINDOWS_SERVICE_HELPER_FILE = "t3-windows-service-host.exe";

export interface WindowsBootServiceBinding {
  /** Absolute path to the shipped `t3-windows-service-host.exe`. */
  readonly hostPath: string;
  /** Canonical T3 home; passed to the host and matched on status. */
  readonly homeDir: string;
  /** The pinned `t3.exe` the host launches under the job object. */
  readonly runtimePath: string;
  readonly logPath: string;
  readonly serviceName: string;
  /**
   * Qualified service account (`DOMAIN\user` or `user@domain`). Absent means
   * the prerequisites are not met: the adapter never defaults to LocalSystem.
   */
  readonly account?: string;
}

export function windowsServiceHelperPath(runtimeEntryPath: string, path: Path.Path): string {
  return path.join(path.dirname(runtimeEntryPath), WINDOWS_SERVICE_HELPER_FILE);
}

/**
 * A qualified service account proves a domain/user boundary; a bare name cannot.
 * The host refuses a bare name too, so the adapter refuses it before writing.
 */
export function isQualifiedWindowsAccount(account: string | undefined): boolean {
  if (account === undefined) return false;
  const trimmed = account.trim();
  if (trimmed === "") return false;
  const backslash = trimmed.indexOf("\\");
  if (backslash > 0 && backslash < trimmed.length - 1) return true;
  return /^[^@\s]+@[^@\s]+$/.test(trimmed);
}

/** Quotes one argument for a Windows command line sc.exe will re-parse. */
export function quoteWindowsArgument(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** The host's argv without shell quoting; `program` in a plan. */
export function windowsServiceProgram(binding: WindowsBootServiceBinding): ReadonlyArray<string> {
  return [
    binding.hostPath,
    "--home",
    binding.homeDir,
    "--runtime",
    binding.runtimePath,
    "--log",
    binding.logPath,
    "--service-name",
    binding.serviceName,
    ...(binding.account === undefined ? [] : ["--expected-account", binding.account]),
  ];
}

/**
 * The canonical `ImagePath` sc.exe stores. The status flow compares the
 * manager-reported value against this same rendering, so a changed binding is
 * detected rather than silently adopted.
 */
export function renderWindowsServiceImagePath(binding: WindowsBootServiceBinding): string {
  return windowsServiceProgram(binding).map(quoteWindowsArgument).join(" ");
}

export interface WindowsServiceSteps {
  readonly register: BootServiceStep;
  readonly reconfigure: BootServiceStep;
  readonly start: BootServiceStep;
  readonly stop: BootServiceStep;
  readonly delete: BootServiceStep;
}

/**
 * `sc.exe` steps. `binPath=` carries the whole host command line as one value
 * (sc.exe requires the space after `=`); the value itself is quoted inside
 * {@link renderWindowsServiceImagePath}. `start= auto` mirrors the systemd unit's
 * restart-at-boot intent; the host owns its own restart budget.
 */
export function windowsServiceSteps(binding: WindowsBootServiceBinding): WindowsServiceSteps {
  const imagePath = renderWindowsServiceImagePath(binding);
  const target = [
    "binPath=",
    imagePath,
    "obj=",
    binding.account ?? "",
    "start=",
    "auto",
    "DisplayName=",
    "T3 Code",
  ] as const;
  return {
    register: {
      step: "registering the SCM service",
      command: "sc.exe",
      args: ["create", binding.serviceName, ...target],
      timeout: STOP_STEP_TIMEOUT,
    },
    reconfigure: {
      step: "updating the SCM service registration",
      command: "sc.exe",
      args: ["config", binding.serviceName, ...target],
      timeout: STOP_STEP_TIMEOUT,
    },
    start: {
      step: "starting the service",
      command: "sc.exe",
      args: ["start", binding.serviceName],
      timeout: STOP_STEP_TIMEOUT,
    },
    stop: {
      step: "stopping the service",
      command: "sc.exe",
      args: ["stop", binding.serviceName],
      timeout: STOP_STEP_TIMEOUT,
    },
    delete: {
      step: "deleting the SCM service registration",
      command: "sc.exe",
      args: ["delete", binding.serviceName],
      timeout: STOP_STEP_TIMEOUT,
    },
  };
}

/** `sc.exe stop` blocks while the service drains; keep it above the runner default. */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

export interface ScQuery {
  readonly state?: string;
  readonly stateCode?: number;
  readonly processId?: number;
}

/**
 * Parses `sc.exe query`/`queryex`. Only anchored `STATE`/`PID` tokens are read;
 * a response without them is malformed and stays unknown rather than healthy.
 */
export function parseScQuery(stdout: string): ScQuery | undefined {
  const stateLine = /(?:^|\n)\s*STATE\s*:\s*(\d+)\s*([A-Z_ ]+)/.exec(stdout);
  const pidLine = /(?:^|\n)\s*PID\s*:\s*(\d+)/.exec(stdout);
  if (stateLine === null && pidLine === null) return undefined;
  const stateCode = stateLine === null ? undefined : Number.parseInt(stateLine[1] ?? "", 10);
  const processId = pidLine === null ? undefined : Number.parseInt(pidLine[1] ?? "", 10);
  return {
    ...(stateLine === null || stateLine[2] === undefined
      ? {}
      : { state: stateLine[2].trim(), ...(stateCode === undefined ? {} : { stateCode }) }),
    ...(processId === undefined || !Number.isSafeInteger(processId) ? {} : { processId }),
  };
}

export interface ScQc {
  readonly binaryPathName?: string;
  readonly serviceStartName?: string;
  readonly startType?: string;
}

/** Parses `sc.exe qc`. Missing fields stay absent; they are never defaulted. */
export function parseScQc(stdout: string): ScQc | undefined {
  const read = (label: string) =>
    new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]*)`).exec(stdout)?.[1]?.trim();
  const binaryPathName = read("BINARY_PATH_NAME");
  const serviceStartName = read("SERVICE_START_NAME");
  const startType = read("START_TYPE");
  if (binaryPathName === undefined && serviceStartName === undefined && startType === undefined) {
    return undefined;
  }
  return {
    ...(binaryPathName === undefined ? {} : { binaryPathName }),
    ...(serviceStartName === undefined ? {} : { serviceStartName }),
    ...(startType === undefined ? {} : { startType }),
  };
}

/** `ERROR_SERVICE_DOES_NOT_EXIST` (1060) is the only absence the SCM reports. */
export function scServiceDoesNotExist(
  code: number | null,
  stdout: string,
  stderr: string,
): boolean {
  if (code === 1060) return true;
  return /\b1060\b|does not exist as an installed service/i.test(`${stdout}\n${stderr}`);
}

/** Manager `sc.exe` state tokens mapped to the shared running state. */
export function scRunningState(
  state: string | undefined,
): "running" | "stopped" | "transitioning" | "not-loaded" | "unknown" {
  switch (state) {
    case "RUNNING":
      return "running";
    case "STOPPED":
      return "stopped";
    case "START_PENDING":
    case "STOP_PENDING":
    case "PAUSED":
    case "PAUSE_PENDING":
    case "CONTINUE_PENDING":
      return "transitioning";
    default:
      return "unknown";
  }
}

/**
 * Whether an existing `sc.exe` registration is this adapter's own: it must bind
 * the exact helper binary and the exact home/runtime/log/service-name. A
 * registration whose `ImagePath` names another home, helper or account is
 * foreign and is never overwritten or deleted by install/restart/uninstall.
 */
export function windowsRegistrationMatchesOurBinding(
  qc: ScQc,
  binding: WindowsBootServiceBinding,
): boolean {
  if (qc.binaryPathName === undefined) return false;
  const expected = renderWindowsServiceImagePath(binding);
  return normalizeWindowsImagePath(qc.binaryPathName) === normalizeWindowsImagePath(expected);
}

/** Collapses whitespace and normalizes an outer pair of quotes for comparison. */
export function normalizeWindowsImagePath(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replaceAll(/\s+/g, " ").trim();
}
