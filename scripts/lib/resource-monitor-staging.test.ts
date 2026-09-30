// @effect-diagnostics nodeBuiltinImport:off - Stages over plain files in a temp fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  ResourceMonitorStageError,
  resourceMonitorStageSpec,
  stageResourceMonitor,
} from "./resource-monitor-staging.ts";

function scratchRepo(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-resource-monitor-stage-"));
}

function writeCargoOutput(repoRoot: string, relative: string, contents: string): string {
  const path = NodePath.join(repoRoot, relative);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
  return path;
}

it("stages the Windows helper into win32-x64 with its .exe name", () => {
  const repoRoot = scratchRepo();
  try {
    const source = writeCargoOutput(
      repoRoot,
      "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe",
      "MZ fake exe",
    );
    const out = NodePath.join(repoRoot, "out");
    const result = stageResourceMonitor({
      target: "win",
      resourceMonitorDir: out,
      repoRoot,
    });
    assert.equal(result.source, source);
    assert.equal(result.destination, NodePath.join(out, "win32-x64", "t3-resource-monitor.exe"));
    assert.equal(NodeFS.readFileSync(result.destination, "utf8"), "MZ fake exe");
    // The Linux key must not appear: the archive copies the whole dir and a
    // stray foreign helper would be a wrong-platform payload.
    assert.notOk(NodeFS.existsSync(NodePath.join(out, "linux-x64")));
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("creates a clean destination directory that does not exist yet", () => {
  const repoRoot = scratchRepo();
  try {
    writeCargoOutput(
      repoRoot,
      "native/resource-monitor/target/release/t3-resource-monitor",
      "ELF fake",
    );
    const out = NodePath.join(repoRoot, "does", "not", "exist", "yet");
    assert.notOk(NodeFS.existsSync(out));
    const result = stageResourceMonitor({ target: "linux", resourceMonitorDir: out, repoRoot });
    assert.ok(NodeFS.existsSync(NodePath.join(out, "linux-x64", "t3-resource-monitor")));
    assert.equal(NodeFS.readFileSync(result.destination, "utf8"), "ELF fake");
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("stages into a destination path containing spaces", () => {
  const repoRoot = scratchRepo();
  try {
    writeCargoOutput(
      repoRoot,
      "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe",
      "MZ spaced",
    );
    const out = NodePath.join(repoRoot, "shared candidate dir", "resource monitor");
    const result = stageResourceMonitor({ target: "win", resourceMonitorDir: out, repoRoot });
    assert.equal(result.destination, NodePath.join(out, "win32-x64", "t3-resource-monitor.exe"));
    assert.equal(NodeFS.readFileSync(result.destination, "utf8"), "MZ spaced");
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("fails with a clear error before writing when the source output is missing", () => {
  const repoRoot = scratchRepo();
  try {
    const out = NodePath.join(repoRoot, "out");
    let caught: unknown;
    try {
      stageResourceMonitor({ target: "win", resourceMonitorDir: out, repoRoot });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, ResourceMonitorStageError);
    assert.match((caught as Error).message, /source-build output for 'win' is missing/);
    // Nothing was created: a missing input must not leave a partial stage dir.
    assert.notOk(NodeFS.existsSync(out));
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("resolves the same resource keys the CLI archive uses", () => {
  assert.equal(resourceMonitorStageSpec("linux").resourceKey, "linux-x64");
  assert.equal(resourceMonitorStageSpec("linux").binaryName, "t3-resource-monitor");
  assert.equal(resourceMonitorStageSpec("win").resourceKey, "win32-x64");
  assert.equal(resourceMonitorStageSpec("win").binaryName, "t3-resource-monitor.exe");
});
