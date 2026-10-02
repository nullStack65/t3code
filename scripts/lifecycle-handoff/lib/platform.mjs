// OS-owned supervisor registration.
//
// macOS  : a transient per-handoff LaunchAgent (launchd owns the process; its
//          parent is pid 1, so T3/Electron job-object teardown cannot reach it).
// Windows: a transient current-user Scheduled Task (InteractiveToken, no
//          elevation, run once), which is a Task Scheduler-owned process rather
//          than an Electron job-object child.
//
// `nohup`/`Start-Process` are deliberately NOT used: neither escapes the parent
// job object on the platforms that matter.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export class PlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlatformError";
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runQuiet(command, args) {
  try {
    return { ok: true, stdout: run(command, args) };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

const SHORT_ID = /[^a-zA-Z0-9]/g;

export function shortId(handoffId) {
  return handoffId.replace(SHORT_ID, "").slice(0, 24);
}

/** XML-escape a value for a plist <string>. */
function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------------------------------------------------------------------------
// macOS / launchd
// ---------------------------------------------------------------------------

export const MAC_LABEL_PREFIX = "ai.closura.t3.handoff";

export function macLabel(handoffId) {
  return `${MAC_LABEL_PREFIX}.${shortId(handoffId)}`;
}

export function launchAgentsDir() {
  return join(homedir(), "Library", "LaunchAgents");
}

export function macPlistPath(handoffId) {
  return join(launchAgentsDir(), `${macLabel(handoffId)}.plist`);
}

export function renderLaunchdPlist({ label, nodePath, scriptPath, envelopePath, logPath }) {
  const args = [nodePath, scriptPath, "--envelope", envelopePath];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    // Run once at bootstrap. Not KeepAlive: this is a one-shot supervisor, and a
    // crash loop must not become an endless restart loop.
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <false/>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function bootstrapLaunchd({ plistPath, uid }) {
  const result = runQuiet("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (!result.ok) {
    throw new PlatformError(`launchctl bootstrap failed: ${result.stderr?.trim() || result.stdout}`);
  }
  return result.stdout.trim();
}

/**
 * The pid launchd reports for the job, or null if it is not currently running.
 * Used to prove independence from the initiating process before T3 is stopped.
 */
export function launchdJobPid({ label, uid }) {
  const result = runQuiet("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
  if (!result.ok) return null;
  const match = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/.exec(result.stdout);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function bootoutLaunchd({ label, uid, plistPath }) {
  runQuiet("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath]);
  runQuiet("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
}

// ---------------------------------------------------------------------------
// Windows / Task Scheduler
// ---------------------------------------------------------------------------

export const WIN_TASK_PREFIX = "ClosuraT3Handoff";

export function windowsTaskName(handoffId) {
  return `${WIN_TASK_PREFIX}-${shortId(handoffId)}`;
}

/**
 * One-shot, current-user, non-elevated task. `<LogonType>InteractiveToken</LogonType>`
 * runs the helper in the user's own session; the Task Scheduler service, not the
 * Electron job object, owns its lifetime.
 */
export function renderScheduledTaskXml({ taskName, nodePath, scriptPath, envelopePath, startBoundary }) {
  const command = `"${nodePath}" "${scriptPath}" --envelope "${envelopePath}"`;
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Transient T3 lifecycle handoff supervisor (one-shot)</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <TimeTrigger>`,
    `      <StartBoundary>${xml(startBoundary)}</StartBoundary>`,
    `      <Enabled>true</Enabled>`,
    `    </TimeTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>`,
    `    <Enabled>true</Enabled>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${xml(nodePath)}</Command>`,
    `      <Arguments>"${xml(scriptPath)}" --envelope "${xml(envelopePath)}"</Arguments>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

export function registerWindowsTask({ taskName, xmlPath }) {
  const result = runQuiet("schtasks.exe", ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
  if (!result.ok) {
    throw new PlatformError(`schtasks /Create failed: ${result.stderr?.trim() || result.stdout}`);
  }
  return result.stdout.trim();
}

export function runWindowsTask({ taskName }) {
  const result = runQuiet("schtasks.exe", ["/Run", "/TN", taskName]);
  if (!result.ok) {
    throw new PlatformError(`schtasks /Run failed: ${result.stderr?.trim() || result.stdout}`);
  }
  return result.stdout.trim();
}

export function deleteWindowsTask({ taskName }) {
  runQuiet("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
}

// ---------------------------------------------------------------------------

/** Resolve the platform adapter for a Node-style platform string. */
export function platformAdapter(platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  return undefined;
}
