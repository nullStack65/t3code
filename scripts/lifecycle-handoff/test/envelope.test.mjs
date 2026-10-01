import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNoSecrets, EnvelopeError, parseEnvelope, SCHEMA_VERSION } from "../lib/envelope.mjs";

function validEnvelope(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    handoffId: "hlh-test-0001",
    createdAt: "2026-10-01T00:00:00.000Z",
    originating: { threadId: "t1", projectId: "p1", machine: "mac", platform: "darwin" },
    task: { description: "restart", operation: "restart" },
    command: { argv: ["/bin/true"] },
    waitFor: { pid: 1, timeoutMs: 1000 },
    behavior: {},
    relaunch: { argv: [] },
    readiness: { kind: "none" },
    identity: {},
    callback: { kind: "none" },
    paths: { dir: "/tmp/x", state: "/tmp/x/s.json", log: "/tmp/x/l.log", result: "/tmp/x/r.json" },
    supervisor: { nodePath: "/usr/bin/node", scriptPath: "/s/supervisor.mjs" },
    ...overrides,
  };
}

test("accepts a minimal valid envelope", () => {
  const envelope = parseEnvelope(validEnvelope());
  assert.equal(envelope.handoffId, "hlh-test-0001");
  assert.deepEqual(envelope.command.argv, ["/bin/true"]);
});

test("rejects forbidden credential keys anywhere", () => {
  assert.throws(
    () => assertNoSecrets({ nested: { authToken: "x" } }),
    (error) => error instanceof EnvelopeError && /forbidden key/.test(error.message),
  );
});

test("rejects credential-shaped values", () => {
  for (const value of ["ghp_abcdefghijklmnopqrstuvwxyz0123", "Bearer abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrst"]) {
    assert.throws(() => assertNoSecrets({ note: value }), EnvelopeError, `expected rejection for ${value.slice(0, 8)}`);
  }
});

test("rejects a missing required identifier", () => {
  const broken = validEnvelope();
  delete broken.originating.threadId;
  assert.throws(() => parseEnvelope(broken), /originating.threadId/);
});

test("rejects an unknown schema version", () => {
  assert.throws(() => parseEnvelope(validEnvelope({ schemaVersion: 99 })), /unsupported envelope schemaVersion/);
});

test("keeps an optional afterCommand for independent identity verification", () => {
  const envelope = parseEnvelope(
    validEnvelope({ identity: { afterCommand: { argv: ["t3", "--version"] } } }),
  );
  assert.deepEqual(envelope.identity.afterCommand.argv, ["t3", "--version"]);
});
