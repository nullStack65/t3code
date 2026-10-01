import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseEnvelope, SCHEMA_VERSION } from "../lib/envelope.mjs";
import { supervise } from "../lib/run.mjs";
import { claimRun } from "../lib/state.mjs";

function makeEnvelope(dir, overrides = {}) {
  return parseEnvelope({
    schemaVersion: SCHEMA_VERSION,
    handoffId: `hlh-unit-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    originating: { threadId: "t", projectId: "p", machine: "m", platform: process.platform },
    task: { description: "unit", operation: "unit-op" },
    command: { argv: ["node", "-e", "0"] },
    waitFor: { pid: 4242, timeoutMs: 5000, pollMs: 1 },
    behavior: {},
    relaunch: { argv: [] },
    readiness: { kind: "none" },
    identity: {},
    callback: { kind: "none" },
    paths: {
      dir,
      state: join(dir, "state.json"),
      log: join(dir, "log.log"),
      result: join(dir, "result.json"),
    },
    supervisor: { nodePath: process.execPath, scriptPath: "/s/supervisor.mjs" },
    ...overrides,
  });
}

const noSleep = async () => {};

test("runs the command only after the waited-for pid exits, then completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-unit-"));
  const envelope = makeEnvelope(dir);
  const calls = [];
  let aliveChecks = 0;
  const result = await supervise(envelope, {
    isAlive: () => {
      aliveChecks += 1;
      return aliveChecks <= 2;
    },
    sleep: noSleep,
    spawnCommand: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "done", stderr: "", timedOut: false };
    },
    waitReady: async () => true,
    deliverCallback: async () => ({ ok: true, detail: "stub" }),
    cleanup: async () => {},
  });
  assert.equal(result.state, "COMPLETE");
  assert.equal(result.command.code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    result.transitions.map((t) => t.state),
    ["DETACHED", "WAITING_FOR_EXIT", "APPLYING", "WAITING_FOR_T3", "CALLBACK_PENDING", "COMPLETE"],
  );
});

test("a terminal previous result prevents re-running the destructive command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-unit-"));
  const envelope = makeEnvelope(dir);
  let spawned = 0;
  const result = await supervise(envelope, {
    isAlive: () => false,
    sleep: noSleep,
    previousResult: { state: "COMPLETE", transitions: [] },
    spawnCommand: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    cleanup: async () => {},
  });
  assert.equal(result.skippedBecauseTerminal, true);
  assert.equal(spawned, 0);
});

test("a non-zero lifecycle command fails with durable evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-unit-"));
  const envelope = makeEnvelope(dir);
  const result = await supervise(envelope, {
    isAlive: () => false,
    sleep: noSleep,
    spawnCommand: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }),
    cleanup: async () => {},
  });
  assert.equal(result.state, "FAILED");
  assert.match(result.failure.reason, /exited 1/);
});

test("an over-running initiating pid fails without force-killing anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-unit-"));
  const envelope = makeEnvelope(dir, { waitFor: { pid: 4242, timeoutMs: 0, pollMs: 1 } });
  let spawned = 0;
  const result = await supervise(envelope, {
    isAlive: () => true,
    sleep: noSleep,
    spawnCommand: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    cleanup: async () => {},
  });
  assert.equal(result.state, "FAILED");
  assert.match(result.failure.reason, /still alive/);
  assert.equal(spawned, 0);
});

test("a live claim refuses a second concurrent supervisor", () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-unit-"));
  const now = () => new Date().toISOString();
  const first = claimRun(dir, "hlh-dup", { pid: process.pid, isAlive: () => true, now });
  const second = claimRun(dir, "hlh-dup", { pid: 999_999, isAlive: () => true, now });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
});
