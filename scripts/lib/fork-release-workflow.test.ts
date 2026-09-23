// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as text to assert the job graph.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const workflowsDir = NodePath.resolve(import.meta.dirname, "../../.github/workflows");

const readWorkflow = (name: string): Promise<string> =>
  NodeFSP.readFile(NodePath.join(workflowsDir, name), "utf8");

/** Extracts a top-level job block (`  name:`) up to the next top-level job. */
function jobBlock(text: string, job: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`  ${job}:`));
  assert.notEqual(start, -1, `job ${job} not found`);
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index > start && /^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

const inlineList = (block: string, key: string): string[] => {
  const match = new RegExp(`^\\s*${key}:\\s*\\[(.*)\\]`, "m").exec(block);
  if (match === null) return [];
  return match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
};

const scalar = (block: string, key: string): string | undefined =>
  new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();

it.effect("the qualify job depends on the optional arm64 job and handles skipped", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const qualify = jobBlock(text, "qualify");
    const needs = inlineList(qualify, "needs");
    assert.include(needs, "desktop_mac_arm64", "qualify.needs must include the optional arm64 job");
    assert.include(needs, "desktop_win_x64");
    assert.include(needs, "desktop_mac_x64");
    assert.include(needs, "cli_linux_x64");

    const condition = scalar(qualify, "if") ?? "";
    assert.include(condition, "needs.desktop_mac_arm64.result");
    assert.include(condition, "inputs.include_macos_arm64");
    // Disabled arm64 is a skipped job, so the guard must allow the disabled case.
    assert.include(condition, "inputs.include_macos_arm64 == false");
  }),
);

it.effect("arm64 stays optional and is not silently exercised", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const arm64 = jobBlock(text, "desktop_mac_arm64");
    assert.include(scalar(arm64, "if") ?? "", "inputs.include_macos_arm64");
  }),
);

it.effect("builds the Windows CLI archive so the Windows install path has an asset", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const win = jobBlock(text, "desktop_win_x64");
    assert.include(scalar(win, "cli_archive") ?? "", "true");
  }),
);

it.effect("no job silently defaults to a GitHub-hosted runner label", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    assert.notInclude(text, "runs-on: ubuntu-");
    assert.notInclude(text, "runs-on: windows-");
    assert.notInclude(text, "runs-on: macos-");
    assert.include(text, "T3CODE_AUTHORIZED_RUNNERS");
  }),
);

it.effect("publication promotes a candidate by run id and never rebuilds", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const publish = jobBlock(text, "publish");
    assert.include(publish, "candidate_run_id");
    assert.include(publish, "gh run download");
    assert.include(publish, "fork-release-native-receipts");
    assert.include(publish, "--promote");
    assert.include(publish, "--tag-target");
    assert.include(publish, "environments/fork-release");
    assert.include(publish, "fork-release-publish");
    assert.notInclude(publish, "build-cli-archive.ts");
    assert.notInclude(publish, "build-desktop-artifact.ts");
  }),
);

it.effect("release-desktop binds provenance to the checked-out ref", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("release-desktop.yml"));
    assert.include(text, 'git checkout --detach "$CHECKOUT_REF"');
    assert.notInclude(text, "git checkout --detach FETCH_HEAD");
    assert.include(text, "T3CODE_SOURCE_SHA: ${{ inputs.ref }}");
    assert.include(text, 'T3CODE_RELEASE_BUILD: "1"');
  }),
);
