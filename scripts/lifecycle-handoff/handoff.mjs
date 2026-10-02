#!/usr/bin/env node
// Initiating-agent CLI for detached T3 lifecycle handoffs.
//
//   node handoff.mjs prepare --request <request.json> [--dir <dir>] [--no-register]
//   node handoff.mjs status  --dir <dir> --id <handoffId>
//   node handoff.mjs verify  --id <handoffId> --pid <pid>
//
// `prepare` writes the envelope, registers the OS-owned one-shot supervisor and
// proves the supervisor is NOT a descendant of this process before returning.
// Only after that proof may the caller quit T3.

import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvelope, SCHEMA_VERSION } from "./lib/envelope.mjs";
import {
  bootstrapLaunchd,
  bootoutLaunchd,
  launchdJobPid,
  macPlistPath,
  renderLaunchdPlist,
  renderScheduledTaskXml,
  registerWindowsTask,
  runWindowsTask,
  windowsTaskName,
  shortId,
  macLabel,
} from "./lib/platform.mjs";
import { independence } from "./lib/process.mjs";
import { ensureDir, readJson, writeJsonPrivate } from "./lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultHandoffDir(baseDir = join(homedir(), ".t3", "userdata")) {
  return join(baseDir, "lifecycle-handoff");
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function newHandoffId() {
  return `hlh-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function buildEnvelope({ request, handoffId = newHandoffId(), dir }) {
  const paths = {
    dir,
    state: join(dir, `${handoffId}.state.json`),
    log: join(dir, `${handoffId}.log`),
    result: join(dir, `${handoffId}.result.json`),
    ...(request.originating?.fromThread ? { fromThread: request.originating.fromThread } : {}),
  };
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    handoffId,
    createdAt: new Date().toISOString(),
    originating: {
      threadId: request.threadId,
      projectId: request.projectId,
      machine: request.machine ?? hostname(),
      platform: osPlatform(),
      ...(Number.isInteger(request.agentPid) ? { agentPid: request.agentPid } : {}),
    },
    task: { description: request.description, operation: request.operation },
    command: request.command,
    waitFor: {
      pid: Number.isInteger(request.waitPid) ? request.waitPid : process.ppid,
      timeoutMs: request.waitTimeoutMs ?? 5 * 60 * 1000,
      pollMs: request.waitPollMs ?? 500,
    },
    behavior: request.behavior ?? {},
    relaunch: request.relaunch ?? { argv: [] },
    readiness: request.readiness ?? { kind: "none" },
    identity: request.identity ?? {},
    callback: request.callback ?? { kind: "none" },
    paths,
    supervisor: { nodePath: process.execPath, scriptPath: join(HERE, "supervisor.mjs") },
  };
  return parseEnvelope(envelope);
}

async function registerMac(envelope, log) {
  const uid = process.getuid();
  const label = macLabel(envelope.handoffId);
  const plistPath = macPlistPath(envelope.handoffId);
  const plist = renderLaunchdPlist({
    label,
    nodePath: envelope.supervisor.nodePath,
    scriptPath: envelope.supervisor.scriptPath,
    envelopePath: join(envelope.paths.dir, `${envelope.handoffId}.envelope.json`),
    logPath: envelope.paths.log,
  });
  writeFileSync(plistPath, plist, { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  bootstrapLaunchd({ plistPath, uid });
  log(`registered LaunchAgent ${label}`);

  // Wait for launchd to actually place the job, then prove independence.
  const deadline = Date.now() + 10_000;
  let proof = null;
  while (Date.now() < deadline) {
    const pid = launchdJobPid({ label, uid });
    if (Number.isInteger(pid)) {
      proof = independence(pid, { forbiddenPids: [process.pid, process.ppid] });
      if (proof.independent) return { mechanism: "launchd", proof, plistPath, uid };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  bootoutLaunchd({ label, uid, plistPath });
  throw new Error(`supervisor is not launchd-owned/independent: ${JSON.stringify(proof)}`);
}

async function registerWindows(envelope, log) {
  const taskName = windowsTaskName(envelope.handoffId);
  const xmlPath = join(envelope.paths.dir, `${envelope.handoffId}.task.xml`);
  const xml = renderScheduledTaskXml({
    taskName,
    nodePath: envelope.supervisor.nodePath,
    scriptPath: envelope.supervisor.scriptPath,
    envelopePath: join(envelope.paths.dir, `${envelope.handoffId}.envelope.json`),
    startBoundary: new Date(Date.now() + 60_000).toISOString(),
  });
  writeFileSync(xmlPath, xml, { mode: 0o600 });
  registerWindowsTask({ taskName, xmlPath });
  runWindowsTask({ taskName });
  log(`registered scheduled task ${taskName}`);
  return { mechanism: "schtasks", taskName, xmlPath };
}

async function prepare(flags) {
  if (!flags.request) throw new Error("prepare requires --request <request.json>");
  const request = readJson(flags.request);
  if (!request) throw new Error(`request not found: ${flags.request}`);
  const dir = flags.dir ? resolve(String(flags.dir)) : defaultHandoffDir();
  ensureDir(dir);

  const envelope = buildEnvelope({ request, dir, ...(flags.id ? { handoffId: String(flags.id) } : {}) });
  const envelopePath = join(dir, `${envelope.handoffId}.envelope.json`);
  writeJsonPrivate(envelopePath, envelope);
  writeJsonPrivate(envelope.paths.state, {
    handoffId: envelope.handoffId,
    state: "PREPARED",
    updatedAt: new Date().toISOString(),
    transitions: [{ state: "PREPARED", at: new Date().toISOString() }],
  });

  const log = (line) => process.stderr.write(`[handoff] ${line}\n`);
  if (flags["no-register"]) {
    return { handoffId: envelope.handoffId, dir, envelopePath, registered: false };
  }

  const platform = envelope.originating.platform;
  const registration =
    platform === "darwin"
      ? await registerMac(envelope, log)
      : platform === "win32"
        ? await registerWindows(envelope, log)
        : (() => {
            throw new Error(`detached handoff is unsupported on '${platform}'`);
          })();

  // Record the independence proof where a human/manager can read it.
  const state = readJson(envelope.paths.state) ?? { handoffId: envelope.handoffId };
  writeJsonPrivate(envelope.paths.state, { ...state, registration });
  return { handoffId: envelope.handoffId, dir, envelopePath, registered: true, registration };
}

function status(flags) {
  if (!flags.dir || !flags.id) throw new Error("status requires --dir and --id");
  const dir = resolve(String(flags.dir));
  const state = readJson(join(dir, `${flags.id}.state.json`));
  const result = readJson(join(dir, `${flags.id}.result.json`));
  process.stdout.write(`${JSON.stringify({ state, result }, null, 2)}\n`);
}

function verify(flags) {
  if (!flags.id || !flags.pid) throw new Error("verify requires --id and --pid");
  const proof = independence(Number.parseInt(String(flags.pid), 10), {
    forbiddenPids: [process.pid, process.ppid],
  });
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  if (!proof.independent) process.exitCode = 2;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "prepare") {
    const outcome = await prepare(flags);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return;
  }
  if (command === "status") return status(flags);
  if (command === "verify") return verify(flags);
  process.stderr.write(
    "usage: handoff.mjs <prepare|status|verify> [--request f] [--dir d] [--id i] [--pid p] [--no-register]\n",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`handoff failed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

export { shortId };
