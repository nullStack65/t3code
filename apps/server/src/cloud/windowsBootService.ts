import * as Duration from "effect/Duration";
import type * as Path from "effect/Path";

import { isExactServiceVersion } from "./serviceProtocol.ts";
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

/**
 * Quotes one argument for a Windows command line sc.exe will re-parse. This
 * implements the reverse of {@link parseWindowsCommandLine}: a run of
 * backslashes is doubled when it precedes a closing quote, `"` is escaped as
 * `2n + 1` backslashes plus the quote, and a trailing run of backslashes is
 * doubled before the closing quote. An argument that needs no quoting is left
 * bare; one that contains whitespace or a quote is quoted and escaped. An empty
 * argument renders as `""`.
 */
export function quoteWindowsArgument(value: string): string {
  if (value === "") return '""';
  if (!/[\s"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      result += character;
    } else if (character === '"') {
      result += `${"\\".repeat(backslashes + 1)}"`;
      backslashes = 0;
    } else {
      backslashes = 0;
      result += character;
    }
  }
  return `${result}${"\\".repeat(backslashes)}"`;
}

/**
 * Splits a Windows command line back into its arguments using the same rule
 * set `quoteWindowsArgument` emits: whitespace outside quotes separates
 * arguments, a quote escapes a literal quote only when preceded by an odd run
 * of backslashes (an even run leaves the quote as a delimiter), and runs of
 * backslashes collapse by pairs. This is a bounded command-line splitter, not a
 * shell parser: it never expands, globs or interprets anything. It preserves
 * argument boundaries and inner whitespace losslessly, so a quoted path with
 * spaces can be compared exactly.
 */
export function parseWindowsCommandLine(commandLine: string): ReadonlyArray<string> {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  let index = 0;
  while (index < commandLine.length) {
    const character = commandLine[index] ?? "";
    if (!inQuotes && (character === " " || character === "\t")) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      index += 1;
      continue;
    }
    if (character === "\\") {
      let count = 0;
      while (index < commandLine.length && commandLine[index] === "\\") {
        count += 1;
        index += 1;
      }
      if (index < commandLine.length && commandLine[index] === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
        index += 1;
      } else {
        current += "\\".repeat(count);
      }
      started = true;
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      started = true;
      index += 1;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) args.push(current);
  return args;
}

/** Case-insensitive equality for Windows paths and account names. */
function sameWindowsToken(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

/** The value of a `--flag value` pair in an already-split argv, if present. */
function optionValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

/**
 * Whether a registered `--runtime` path lives under `<home>/runtime/versions/`
 * for any exact version. Any version tree under the same home is owned; this is
 * what lets an owned older runtime be upgraded rather than refused as foreign.
 */
export function windowsRuntimeBelongsToHome(runtimePath: string, homeDir: string): boolean {
  const normalize = (value: string) =>
    value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const versionsPrefix = `${normalize(homeDir)}\\runtime\\versions`;
  const runtime = normalize(runtimePath);
  if (!runtime.startsWith(`${versionsPrefix}\\`)) return false;
  const [version = ""] = runtime.slice(versionsPrefix.length + 1).split("\\");
  return version !== "" && isExactServiceVersion(version);
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
    ...(processId === undefined || !Number.isSafeInteger(processId) || processId <= 0
      ? {}
      : { processId }),
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

/**
 * `ERROR_SERVICE_DOES_NOT_EXIST` (1060) is the only absence the SCM reports.
 * Only the authoritative numeric result code establishes absence: a localized
 * or incidental `1060` inside unrelated stdout/stderr, an access-denied
 * failure, or an unavailable code is unknown, never permission to create or
 * delete a registration.
 */
export function scServiceDoesNotExist(code: number | null): boolean {
  return code === 1060;
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
 * Whether an existing `sc.exe` registration is this adapter's own. Ownership is
 * bound to the exact native account (`SERVICE_START_NAME`), the exact helper
 * binary, home, log and service name, and only requires the registered runtime
 * to live under this home's runtime tree. The desired runtime version is *not*
 * part of ownership: an owned older runtime can be upgraded by an ordinary
 * install rather than being refused as a foreign registration. Argument
 * boundaries and inner whitespace are compared losslessly through
 * {@link parseWindowsCommandLine}; a changed account or a genuinely different
 * home never matches. A registration whose `ImagePath` names another home,
 * helper or account is foreign and is never overwritten or deleted by
 * install/restart/uninstall.
 */
export function windowsRegistrationOwnedByUs(
  qc: ScQc,
  binding: WindowsBootServiceBinding,
): boolean {
  if (qc.binaryPathName === undefined) return false;
  const args = parseWindowsCommandLine(qc.binaryPathName);
  const program = args[0];
  if (program === undefined || !sameWindowsToken(program, binding.hostPath)) return false;
  const home = optionValue(args, "--home");
  if (home === undefined || !sameWindowsToken(home, binding.homeDir)) return false;
  const serviceName = optionValue(args, "--service-name");
  if (serviceName === undefined || !sameWindowsToken(serviceName, binding.serviceName))
    return false;
  const log = optionValue(args, "--log");
  if (log === undefined || !sameWindowsToken(log, binding.logPath)) return false;
  const runtime = optionValue(args, "--runtime");
  if (runtime === undefined || !windowsRuntimeBelongsToHome(runtime, binding.homeDir)) return false;
  if (binding.account !== undefined) {
    if (qc.serviceStartName === undefined) return false;
    if (!sameWindowsToken(qc.serviceStartName, binding.account)) return false;
    const expectedAccount = optionValue(args, "--expected-account");
    if (expectedAccount !== undefined && !sameWindowsToken(expectedAccount, binding.account)) {
      return false;
    }
  }
  return true;
}

/**
 * Strict identity for read-only status: the registration is ours *and* its
 * configured runtime is exactly the desired one. This never gates mutation —
 * install/restart/uninstall use {@link windowsRegistrationOwnedByUs} so an
 * owned older runtime can be upgraded.
 */
export function windowsRegistrationMatchesOurBinding(
  qc: ScQc,
  binding: WindowsBootServiceBinding,
): boolean {
  if (!windowsRegistrationOwnedByUs(qc, binding) || qc.binaryPathName === undefined) return false;
  const runtime = optionValue(parseWindowsCommandLine(qc.binaryPathName), "--runtime");
  return runtime !== undefined && sameWindowsToken(runtime, binding.runtimePath);
}

/** The registered runtime path from a `qc` image path, split losslessly. */
export function windowsRuntimeFromImagePath(binaryPathName: string): string | undefined {
  return optionValue(parseWindowsCommandLine(binaryPathName), "--runtime");
}
