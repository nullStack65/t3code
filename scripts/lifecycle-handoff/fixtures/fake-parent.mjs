// Fake initiating agent. It prepares a real detached handoff for a harmless
// command, then exits — exactly the moment the real agent would quit T3.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, port] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const handoffCli = join(here, "..", "handoff.mjs");
mkdirSync(dir, { recursive: true });

const request = {
  threadId: "fixture-thread",
  projectId: "fixture-project",
  machine: "fixture-machine",
  operation: "fixture-restart",
  description: "harmless detached handoff fixture",
  agentPid: process.pid,
  waitPid: process.pid,
  waitTimeoutMs: 30_000,
  command: { argv: [process.execPath, join(here, "apply.mjs"), join(dir, "applied.marker")] },
  relaunch: { argv: [process.execPath, join(here, "fake-service.mjs"), join(dir, "service-ready.marker")] },
  readiness: { kind: "file", path: join(dir, "service-ready.marker"), timeoutMs: 30_000, pollMs: 200 },
  identity: {
    before: { version: "0.0.43" },
    after: { version: "0.0.44" },
    afterCommand: { argv: [process.execPath, "-e", "process.stdout.write('0.0.44')"] },
  },
  callback: { kind: "http", url: `http://127.0.0.1:${port}/callback` },
};

const requestPath = join(dir, "request.json");
writeFileSync(requestPath, JSON.stringify(request, null, 2));
const outcome = spawnSync(process.execPath, [handoffCli, "prepare", "--request", requestPath, "--dir", dir], {
  encoding: "utf8",
});
process.stderr.write(outcome.stderr ?? "");
if (outcome.status !== 0) {
  process.stderr.write(`prepare failed: ${outcome.stdout}\n`);
  process.exit(outcome.status ?? 1);
}
writeFileSync(join(dir, "parent-prepared.json"), outcome.stdout ?? "");
// Exiting here releases the supervisor's wait, mirroring an agent quitting T3.
