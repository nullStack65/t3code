// @effect-diagnostics nodeBuiltinImport:off - Reads and executes inline workflow checks in scratch fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
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

/** Reads a step's actual block-scalar shell script from its workflow job. */
function stepScript(block: string, name: string): string {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `step ${name} not found`);
  const run = lines.findIndex((line, index) => index > start && line === "        run: |");
  assert.notEqual(run, -1, `step ${name} has no run block`);
  const body: string[] = [];
  for (let index = run + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line === "" ? "" : line.slice(10));
  }
  return body.join("\n");
}

/** Extracts the inline Node program executed by a workflow step. */
function inlineNodeProgram(script: string): string {
  const match = /^node -e '\n([\s\S]*?)\n'$/m.exec(script);
  assert.isNotNull(match, "workflow step must execute its inline Node program");
  return match[1]!;
}

function runNodeProgram(
  program: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync(process.execPath, ["-e", program], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function scratchCandidate(
  overrides: {
    readonly identity?: Readonly<Record<string, unknown>> | undefined;
    readonly manifest?: Readonly<Record<string, unknown>> | undefined;
  } = {},
): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-release-receipt-"));
  const candidate = NodePath.join(root, "candidate");
  NodeFS.mkdirSync(candidate);
  const manifest = {
    repository: "nullStack65/t3code",
    version: "0.0.43",
    sourceSha: "a".repeat(40),
    workflowRunId: "123456789",
    workflowRunAttempt: "2",
    ...overrides.manifest,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  NodeFS.writeFileSync(NodePath.join(candidate, "fork-release-manifest.json"), manifestBytes);
  const identity = {
    runId: "123456789",
    runAttempt: "2",
    repository: "nullStack65/t3code",
    version: "0.0.43",
    sourceSha: "a".repeat(40),
    manifestSha256: NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex"),
    ...overrides.identity,
  };
  NodeFS.writeFileSync(
    NodePath.join(candidate, "candidate-identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  return root;
}

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

it.effect("uses fixed supported hosted labels and no caller-controlled runner variables", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    assert.include(text, "runs-on: ubuntu-24.04");
    assert.include(text, "runner: windows-2025");
    assert.include(text, "runner: macos-15-intel");
    assert.include(text, "runner: macos-15");
    assert.notInclude(text, "T3CODE_AUTHORIZED_RUNNERS");
    assert.notInclude(text, "vars.T3CODE_LINUX_RUNNER");
    assert.notInclude(text, "vars.T3CODE_WINDOWS_RUNNER");
    assert.notInclude(text, "vars.T3CODE_MACOS_X64_RUNNER");
    assert.notInclude(text, "vars.T3CODE_MACOS_ARM64_RUNNER");
    assert.notInclude(text, "inputs.linux_runner");
    assert.notInclude(text, "inputs.windows_runner");
    assert.notInclude(text, "inputs.macos_x64_runner");
    assert.notInclude(text, "inputs.macos_arm64_runner");
  }),
);

it.effect("all build and promotion jobs stay on the fixed hosted Linux label", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    for (const job of ["preflight", "bundle", "cli_linux_x64", "qualify", "receipts", "publish"]) {
      assert.include(
        jobBlock(text, job),
        "runs-on: ubuntu-24.04",
        `${job} must use hosted Linux x64`,
      );
    }
    assert.notInclude(text, "authorize:");
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
    assert.include(text, "native_receipts_json");
    assert.include(receipts, "fork-release-native-receipts");
    assert.include(receipts, "upload-artifact");
  }),
);

it.effect(
  "receipt import binds bounded supplied JSON to the exact frozen candidate without rebuilding",
  () =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
      const receipts = jobBlock(text, "receipts");
      assert.deepEqual(inlineList(receipts, "needs"), ["preflight"]);
      assert.include(receipts, "inputs.upload_receipts");
      assert.notInclude(receipts, "needs.qualify");
      assert.include(receipts, "RECEIPTS_JSON: ${{ inputs.native_receipts_json }}");
      assert.include(receipts, 'Buffer.byteLength(raw, "utf8") > 32 * 1024');
      assert.include(receipts, 'flag: "wx"');
      assert.include(receipts, "identity[key] !== value");
      assert.include(receipts, "digest !== identity.manifestSha256");
      assert.include(receipts, "workflowRunAttempt");
      assert.include(receipts, "--native-receipts fork-native-receipts.json");
      assert.include(receipts, "--require-native-receipts");
      assert.isBelow(
        receipts.indexOf("--require-native-receipts"),
        receipts.indexOf("name: Upload native acceptance receipts"),
      );
      assert.notInclude(receipts, "build-cli-archive.ts");
      assert.notInclude(receipts, "build-desktop-artifact.ts");
      for (const job of [
        "bundle",
        "cli_linux_x64",
        "desktop_win_x64",
        "desktop_mac_x64",
        "desktop_mac_arm64",
        "qualify",
      ]) {
        assert.include(
          jobBlock(text, job),
          "inputs.upload_receipts",
          `${job} must stay out of receipt imports`,
        );
      }
    }),
);

it.effect("the workflow candidate-binding program rejects identity and digest tampering", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const receipts = jobBlock(text, "receipts");
    const program = inlineNodeProgram(
      stepScript(receipts, "Bind the downloaded candidate to its recorded identity"),
    );
    const env = {
      CANDIDATE_RUN_ID: "123456789",
      RELEASE_VERSION: "0.0.43",
      RELEASE_SHA: "a".repeat(40),
    };

    const validRoot = scratchCandidate();
    try {
      const result = runNodeProgram(program, validRoot, env);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      NodeFS.rmSync(validRoot, { recursive: true, force: true });
    }

    const tamperingCases = [
      { name: "run ID", identity: { runId: "987654321" } },
      { name: "repository", manifest: { repository: "other/repository" } },
      { name: "source SHA", identity: { sourceSha: "b".repeat(40) } },
      { name: "version", manifest: { version: "0.0.44" } },
      { name: "attempt", identity: { runAttempt: "3" } },
      { name: "manifest digest", identity: { manifestSha256: "0".repeat(64) } },
    ];
    for (const testCase of tamperingCases) {
      const root = scratchCandidate({
        identity: testCase.identity,
        manifest: testCase.manifest,
      });
      try {
        const result = runNodeProgram(program, root, env);
        assert.notEqual(result.status, 0, `tampered ${testCase.name} was accepted`);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }
  }),
);

it.effect("the workflow receipt-input program rejects missing, oversized, and malformed JSON", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const receipts = jobBlock(text, "receipts");
    const program = inlineNodeProgram(stepScript(receipts, "Write the supplied native receipts"));
    const invalidInputs = [
      { name: "missing payload", value: "" },
      { name: "UTF-8 oversized payload", value: "é".repeat(16_385) },
      { name: "malformed JSON", value: "[" },
      { name: "non-array JSON", value: "{}" },
    ];
    for (const input of invalidInputs) {
      const root = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "fork-release-receipt-input-"),
      );
      try {
        const result = runNodeProgram(program, root, { RECEIPTS_JSON: input.value });
        assert.notEqual(result.status, 0, `${input.name} was accepted`);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-release-receipt-input-"));
    try {
      const result = runNodeProgram(program, root, { RECEIPTS_JSON: "[]" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(root, "fork-native-receipts.json"), "utf8"),
        "[]\n",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
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

it.effect("SEA build uses vp exec for both the pinned Node proof and build", () =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const linux = jobBlock(text, "cli_linux_x64");
    assert.include(linux, 'VP_NODE_VERSION: "26.8.2"');
    assert.include(linux, "vp exec --filter t3 -- node --version");
    assert.include(linux, "vp exec --filter t3 -- node -e '");
    assert.include(linux, "vp exec --filter t3 -- node scripts/cli.ts build-exe --verbose");
    assert.notInclude(linux, "vp run --filter t3 exec --");
    assert.notInclude(linux, "node apps/server/scripts/cli.ts build-exe --verbose");
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

it.effect("the fork release attaches native digest-bound Intel DMG inspection evidence", () =>
  Effect.gen(function* () {
    const fork = yield* Effect.promise(() => readWorkflow("fork-release.yml"));
    const desktop = yield* Effect.promise(() => readWorkflow("release-desktop.yml"));
    const intelMac = jobBlock(fork, "desktop_mac_x64");
    const qualify = jobBlock(fork, "qualify");
    const desktopInput = desktop.slice(
      desktop.indexOf("      emit_macos_inspection:"),
      desktop.indexOf("      clerk_publishable_key:"),
    );

    assert.include(intelMac, "emit_macos_inspection: true");
    assert.include(desktopInput, "emit_macos_inspection:");
    assert.include(desktopInput, "default: false");
    const inspect = desktop.slice(
      desktop.indexOf("- name: Inspect macOS release artifact provenance"),
      desktop.indexOf("- name: Collect resource monitor"),
    );
    assert.include(inspect, "inputs.emit_macos_inspection && inputs.platform == 'mac'");
    assert.include(inspect, "scripts/verify-fork-candidate.ts");
    assert.include(inspect, "--candidate-dir release-publish");
    assert.include(inspect, '--version "$RELEASE_VERSION"');
    assert.include(inspect, '--sha "$RELEASE_SHA"');
    assert.include(inspect, '--repository "nullStack65/t3code"');
    assert.include(inspect, "--targets mac");
    assert.include(inspect, "--emit-inspection");
    assert.include(inspect, "fork-inspection-evidence-macos-x64.json");
    assert.isBelow(
      desktop.indexOf("- name: Inspect macOS release artifact provenance"),
      desktop.indexOf("- name: Upload build artifacts"),
    );
    assert.include(
      desktop.slice(desktop.indexOf("- name: Upload build artifacts")),
      "release-publish/*",
    );
    const downloadDesktop = qualify.slice(
      qualify.indexOf("- name: Download desktop artifacts"),
      qualify.indexOf("- name: Download CLI archives"),
    );
    assert.include(downloadDesktop, "pattern: desktop-*");
    assert.include(downloadDesktop, "merge-multiple: true");
    assert.include(downloadDesktop, "path: candidate");
    assert.include(qualify, "fork-inspection-evidence*.json");
    assert.include(qualify, "--inspection-evidence");
  }),
);
