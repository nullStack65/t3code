// End-to-end detached-handoff fixture on a real macOS launchd.
//
// fake parent prepares a handoff for a harmless command and exits -> the
// launchd-owned supervisor survives -> runs the harmless command -> "relaunches"
// a fake service -> observes readiness -> calls back -> cleans up its job.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PARENT = join(HERE, "..", "fixtures", "fake-parent.mjs");
const SUPERVISOR = join(HERE, "..", "supervisor.mjs");

function runParent(dir, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PARENT, dir, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function waitFor(predicate, { timeoutMs = 60_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const macOnly = process.platform === "darwin" ? test : test.skip;

macOnly("survives the initiating process, completes, and calls back", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlh-fixture-"));
  const callbacks = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      callbacks.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const parent = await runParent(dir, port);
    assert.equal(parent.code, 0, `fake parent failed: ${parent.stderr}`);

    const prepared = JSON.parse(readFileSync(join(dir, "parent-prepared.json"), "utf8"));
    assert.equal(prepared.registered, true);
    assert.equal(prepared.registration.mechanism, "launchd");
    // The helper is launchd-owned (parent pid 1) and not a descendant of the initiator.
    assert.equal(prepared.registration.proof.directParent, 1);
    assert.equal(prepared.registration.proof.independent, true);

    const resultPath = join(dir, `${prepared.handoffId}.result.json`);
    const result = await waitFor(() => {
      if (!existsSync(resultPath)) return null;
      const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      return parsed.state === "COMPLETE" || parsed.state === "FAILED" ? parsed : null;
    });
    assert.ok(result, "supervisor never produced a terminal result");

    assert.equal(result.state, "COMPLETE", `unexpected failure: ${result.failure?.reason}`);
    assert.equal(result.command.code, 0);
    assert.equal(result.readiness.ready, true);
    assert.equal(result.identity.observedAfter, "0.0.44");
    assert.equal(result.callback.ok, true, `callback failed: ${result.callback.detail}`);
    assert.equal(result.detachment.directParent ?? result.registration?.proof?.directParent ?? 1, 1);
    assert.ok(existsSync(join(dir, "applied.marker")), "harmless lifecycle command never ran");
    assert.ok(existsSync(join(dir, "service-ready.marker")), "fake service never came back");
    assert.equal(callbacks.length, 1, "callback was not delivered exactly once");
    assert.match(callbacks[0], /DETACHED HANDOFF COMPLETE/);

    // The transient job removed its own registration.
    const plist = join(process.env.HOME ?? "", "Library", "LaunchAgents", `ai.closura.t3.handoff.${prepared.handoffId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}.plist`);
    const gone = await waitFor(() => !existsSync(plist), { timeoutMs: 15_000, pollMs: 250 });
    assert.ok(gone, "LaunchAgent plist was not cleaned up");

    // Idempotency: re-running the same handoff must not repeat the destructive command.
    const markerBefore = readFileSync(join(dir, "applied.marker"), "utf8");
    const rerun = spawnSync(process.execPath, [SUPERVISOR, "--envelope", join(dir, `${prepared.handoffId}.envelope.json`)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(readFileSync(join(dir, "applied.marker"), "utf8"), markerBefore, "idempotent rerun re-ran the command");
  } finally {
    server.close();
  }
});
