#!/usr/bin/env node
// Detached handoff supervisor entry point.
//
// launchd (macOS) / Task Scheduler (Windows) start this file with the absolute
// node path recorded in the envelope. It must not import anything from the T3
// app bundle, must not read credentials, and must keep working after the T3
// process that prepared the handoff is gone.

import { appendFileSync, existsSync, rmSync } from "node:fs";

import { parseEnvelope } from "./lib/envelope.mjs";
import {
  bootoutLaunchd,
  deleteWindowsTask,
  macPlistPath,
  windowsTaskName,
} from "./lib/platform.mjs";
import { independence } from "./lib/process.mjs";
import { supervise } from "./lib/run.mjs";
import { readJson, writeJsonPrivate } from "./lib/state.mjs";

function parseArgs(argv) {
  const index = argv.indexOf("--envelope");
  if (index === -1 || !argv[index + 1]) {
    throw new Error("usage: supervisor.mjs --envelope <path>");
  }
  return { envelopePath: argv[index + 1] };
}

function makeLogger(logPath) {
  return (line) => {
    const stamp = new Date().toISOString();
    try {
      appendFileSync(logPath, `${stamp} ${line}\n`);
    } catch {
      // A logger failure must never abort the handoff.
    }
  };
}

function cleanupFor(envelope, uid) {
  return async () => {
    if (envelope.originating.platform === "darwin") {
      const plistPath = macPlistPath(envelope.handoffId);
      // Remove the plist first so a login reload cannot re-run the job; then
      // ask launchd to unload it (this terminates the current process last).
      if (existsSync(plistPath)) rmSync(plistPath, { force: true });
      bootoutLaunchd({ label: macLabelFor(envelope.handoffId), uid, plistPath });
      return;
    }
    if (envelope.originating.platform === "win32") {
      deleteWindowsTask({ taskName: windowsTaskName(envelope.handoffId) });
    }
  };
}

function macLabelFor(handoffId) {
  return `ai.closura.t3.handoff.${handoffId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
}

async function main() {
  const { envelopePath } = parseArgs(process.argv.slice(2));
  const raw = readJson(envelopePath);
  if (!raw) throw new Error(`envelope not found or unreadable: ${envelopePath}`);
  const envelope = parseEnvelope(raw);
  const log = makeLogger(envelope.paths.log);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

  log(`supervisor started pid=${process.pid} ancestry=${JSON.stringify(independence(process.pid).ancestry)}`);

  const result = await supervise(envelope, {
    log,
    detachment: independence(process.pid, { forbiddenPids: [envelope.originating.agentPid].filter(Boolean) }),
    previousResult: readJson(envelope.paths.result),
    cleanup: cleanupFor(envelope, uid),
  });

  // Durable evidence survives even when the callback and cleanup both fail.
  writeJsonPrivate(envelope.paths.result, result);
  log(`supervisor finished state=${result.state}`);
}

main().catch((error) => {
  process.exitCode = 1;
  try {
    process.stderr.write(`lifecycle-handoff supervisor failed: ${error?.stack ?? error}\n`);
  } catch {
    // ignore
  }
});
