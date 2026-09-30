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

it.effect("authorization runs before any build job and uses owner variables, not inputs", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const authorize = jobBlock(text, "authorize");
    assert.include(authorize, "T3CODE_AUTHORIZED_RUNNERS");
    // Runner labels come from repository variables, never caller inputs.
    assert.notInclude(text, "inputs.linux_runner");
    assert.notInclude(text, "inputs.windows_runner");
    assert.notInclude(text, "inputs.macos_x64_runner");
    assert.notInclude(text, "inputs.macos_arm64_runner");
    // Every build job transitively depends on authorization.
    assert.include(jobBlock(text, "preflight"), "needs: [authorize]");
    assert.include(jobBlock(text, "bundle"), "needs: [preflight]");
  }),
);

it.effect(
  "fresh jobs select source before installing dependencies, without workspace imports",
  () =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
      // The selector must run before `vp install` in preflight, bundle, qualify.
      for (const job of ["preflight", "bundle", "cli_linux_x64", "qualify"]) {
        const block = jobBlock(text, job);
        const sourceIndex = block.indexOf("select-release-source.ts");
        const installIndex = block.indexOf("run: vp install");
        assert.notEqual(sourceIndex, -1, `${job} must select the source`);
        if (installIndex !== -1) {
          assert.isBelow(sourceIndex, installIndex, `${job} must select source before install`);
        }
      }
    }),
);

it.effect("promotion consumes the frozen candidate identity and requires reviewer approval", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const publish = jobBlock(text, "publish");
    assert.include(publish, "candidate-identity.json");
    assert.include(publish, "manifestSha256");
    assert.include(publish, "required_reviewers");
    assert.include(publish, "actions: read");
    assert.notInclude(publish, "build-cli-archive.ts");
    assert.notInclude(publish, "build-desktop-artifact.ts");

    // A real receipt import path exists and binds receipts to a candidate run.
    const receipts = jobBlock(text, "receipts");
    assert.include(receipts, "upload_receipts");
    assert.include(receipts, "receipts_source_run_id");
    assert.include(receipts, "fork-release-native-receipts");
    assert.include(receipts, "upload-artifact");
  }),
);

it.effect("preflight selects source before setup-vp install to keep the job dependency-free", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const preflight = jobBlock(text, "preflight");
    // setup-vp must not eagerly install workspace packages in preflight.
    assert.include(preflight, "run-install: false");
    assert.include(preflight, "--mode public");
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
