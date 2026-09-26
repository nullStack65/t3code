#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalProcessRuntime:off - A machine-local publication handoff that shells out to git/gh and the repo's own verifier.
/**
 * Local/draft promotion handoff for a frozen fork candidate.
 *
 * The workflow's `publish` job consumes a `fork-release-candidate` *CI run* and
 * cannot be reached without an authorized runner. This tool is the small
 * documented local route: it reuses `verify-fork-candidate.ts --promote` for the
 * byte-level checks (complete asset set, current hashes, native receipts,
 * digest-bound inspection evidence, tag target, no-overwrite, version ordering,
 * approval-gate existence) and adds only the gates a local handoff needs:
 * fork-main eligibility and candidate-specific approval.
 *
 * Default is a read-only preflight/dry run: it performs live read-only GitHub
 * probes (release/tag existence, latest version, environment reviewers) and
 * prints the exact publication command **without** running it. `--execute` is
 * required to publish, and it is further gated on `--approve <frozen manifest
 * sha256>` so approval is specific to the exact frozen bytes.
 *
 * `--preflight-json <file>` replaces the live probes with a labeled fixture and
 * `--gh-bin <path>` replaces the `gh` executable, so publication behavior can be
 * exercised without touching GitHub.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  parsePublicationProbe,
  parseRemoteReleaseInventory,
  promotionGateFailures,
  releaseInventoryFailures,
  type GitHubPublicationProbe,
} from "./lib/fork-promotion.ts";
import { RELEASE_ENVIRONMENT } from "./lib/fork-release-manifest.ts";

interface Args {
  candidateDir: string | undefined;
  version: string;
  sha: string;
  repository: string;
  forkRemote: string;
  nativeReceipts: string | undefined;
  inspectionEvidence: ReadonlyArray<string>;
  includeMacosArm64: boolean;
  skipProvenanceInspection: boolean;
  preflightJson: string | undefined;
  ghBin: string;
  ghPrefix: ReadonlyArray<string>;
  approve: string | undefined;
  execute: boolean;
  inspectRelease: string | undefined;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") throw new Error(`--${key} is required`);
    return value.trim();
  };
  return {
    candidateDir: values.get("candidate-dir")?.trim(),
    version: required("version"),
    sha: values.get("sha")?.trim().toLowerCase() ?? "",
    repository: values.get("repository")?.trim() || "nullStack65/t3code",
    forkRemote: values.get("fork-remote")?.trim() || "fork",
    nativeReceipts: values.get("native-receipts")?.trim(),
    inspectionEvidence: (values.get("inspection-evidence") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    includeMacosArm64: flags.has("include-macos-arm64"),
    skipProvenanceInspection: flags.has("skip-provenance-inspection"),
    preflightJson: values.get("preflight-json")?.trim(),
    ghBin: values.get("gh-bin")?.trim() || "gh",
    ghPrefix: (values.get("gh-prefix") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    approve: values.get("approve")?.trim(),
    execute: flags.has("execute"),
    inspectRelease: values.get("inspect-release")?.trim(),
  };
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: ReadonlyArray<string>): RunResult {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sha256File(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

/** gh argv, allowing `--gh-prefix` to run a fixture script instead of real gh. */
function ghArgs(args: Args, rest: ReadonlyArray<string>): string[] {
  return [...args.ghPrefix, ...rest];
}

function fail(problems: ReadonlyArray<string>): never {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

/** Read-only live GitHub probe. Any failure is reported as "not found". */
function probeGitHub(args: Args): GitHubPublicationProbe {
  const repo = args.repository;
  const tag = `v${args.version}`;
  const release = run(
    args.ghBin,
    ghArgs(args, ["release", "view", tag, "--repo", repo, "--json", "tagName"]),
  );
  const tagLookup = run("git", ["ls-remote", "--tags", args.forkRemote, `refs/tags/${tag}`]);
  const latest = run(
    args.ghBin,
    ghArgs(args, [
      "release",
      "list",
      "--repo",
      repo,
      "--limit",
      "100",
      "--json",
      "tagName",
      "--jq",
      '[.[].tagName | sub("^v"; "")] | join(",")',
    ]),
  );
  const environment = run(
    args.ghBin,
    ghArgs(args, ["api", `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`]),
  );
  let reviewers = 0;
  if (environment.status === 0) {
    try {
      const parsed = JSON.parse(environment.stdout) as {
        protection_rules?: Array<{ type?: string; reviewers?: unknown[] }>;
      };
      const rule = (parsed.protection_rules ?? []).find(
        (entry) => entry.type === "required_reviewers",
      );
      reviewers = rule?.reviewers?.length ?? 0;
    } catch {
      reviewers = 0;
    }
  }
  return {
    releaseExists: release.status === 0,
    tagExists: tagLookup.status === 0 && tagLookup.stdout.trim() !== "",
    latestVersion: latest.status === 0 ? latest.stdout.trim() || undefined : undefined,
    authorizationGateReviewers: reviewers,
    onForkMain: isAncestor(args.sha, `${args.forkRemote}/main`),
  };
}

function isAncestor(sha: string, ref: string): boolean {
  const result = run("git", ["merge-base", "--is-ancestor", sha, ref]);
  return result.status === 0;
}

function loadProbe(args: Args): GitHubPublicationProbe {
  if (args.preflightJson !== undefined) {
    const raw: unknown = JSON.parse(NodeFS.readFileSync(args.preflightJson, "utf8"));
    console.log(`[fixture] GitHub preflight read from ${args.preflightJson}, not live probes.`);
    return parsePublicationProbe(raw);
  }
  return probeGitHub(args);
}

function verifierArgs(args: Args, probe: GitHubPublicationProbe): string[] {
  const candidateDir = args.candidateDir!;
  const verifier = NodePath.join(import.meta.dirname, "verify-fork-candidate.ts");
  const list = [
    verifier,
    "--candidate-dir",
    candidateDir,
    "--version",
    args.version,
    "--sha",
    args.sha,
    "--repository",
    args.repository,
    "--promote",
    "--tag-target",
    args.sha,
    "--latest-version",
    probe.latestVersion ?? "",
    "--authorization-gate-exists",
    probe.authorizationGateReviewers > 0 ? "true" : "false",
  ];
  if (args.nativeReceipts !== undefined) list.push("--native-receipts", args.nativeReceipts);
  if (args.inspectionEvidence.length > 0) {
    list.push("--inspection-evidence", args.inspectionEvidence.join(","));
  }
  if (args.includeMacosArm64) list.push("--include-macos-arm64");
  if (args.skipProvenanceInspection) list.push("--skip-provenance-inspection");
  if (probe.releaseExists) list.push("--release-exists");
  if (probe.tagExists) list.push("--tag-exists");
  return list;
}

function publicationCommand(args: Args, assets: ReadonlyArray<string>): ReadonlyArray<string> {
  const tag = `v${args.version}`;
  const notes = [
    `Fork build of T3 Code \`${args.sha}\`.`,
    "",
    `Repository: \`${args.repository}\`. Fork version \`${args.version}\` is the fork's own increasing line.`,
    "",
    "Assets are checksummed in `SHA256SUMS`.",
  ].join("\n");
  return [
    args.ghBin,
    ...args.ghPrefix,
    "release",
    "create",
    tag,
    "--repo",
    args.repository,
    "--target",
    args.sha,
    "--title",
    `T3 Code (fork) v${args.version}`,
    "--notes",
    notes,
    "--latest",
    ...assets,
  ];
}

function runInspectRelease(args: Args): never {
  const id = args.inspectRelease!;
  const result = run(args.ghBin, ghArgs(args, ["api", `repos/${args.repository}/releases/${id}`]));
  if (result.status !== 0) {
    fail([`could not read release ${id}: ${result.stderr.trim() || "gh api failed"}`]);
  }
  const inventory = parseRemoteReleaseInventory(JSON.parse(result.stdout));
  const problems = releaseInventoryFailures(inventory, args.version, {
    includeMacosArm64: args.includeMacosArm64,
  });
  console.log(
    `Release ${inventory.id} '${inventory.tagName}' (draft=${inventory.draft}) has ${inventory.assets.length} asset(s).`,
  );
  for (const asset of inventory.assets) {
    console.log(`  - ${asset.name} (${asset.size} bytes, ${asset.state})`);
  }
  if (problems.length > 0) {
    console.log("BLOCKED — this release is not a promotable complete candidate:");
    fail(problems);
  }
  console.log("This release carries the complete required asset set for the version.");
  process.exit(0);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspectRelease !== undefined) {
    runInspectRelease(args);
  }

  if (args.candidateDir === undefined) {
    fail(["--candidate-dir is required (or use --inspect-release <id>)"]);
  }
  if (args.sha.trim() === "") {
    fail(["--sha is required for the local candidate handoff"]);
  }
  const manifestPath = NodePath.join(args.candidateDir, "fork-release-manifest.json");
  if (!NodeFS.existsSync(manifestPath)) {
    fail([`candidate is missing ${manifestPath}; run the aggregate freeze first`]);
  }

  const frozenManifestDigest = sha256File(manifestPath);
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
    repository: string;
    version: string;
    sourceSha: string;
    assets: ReadonlyArray<{ name: string }>;
  };

  const identityPath = NodePath.join(args.candidateDir, "candidate-identity.json");
  const identityProblems: string[] = [];
  if (NodeFS.existsSync(identityPath)) {
    const identity = JSON.parse(NodeFS.readFileSync(identityPath, "utf8")) as {
      manifestSha256?: string;
      sourceSha?: string;
      version?: string;
    };
    if (identity.manifestSha256 !== undefined && identity.manifestSha256 !== frozenManifestDigest) {
      identityProblems.push(
        `candidate-identity.json digest ${identity.manifestSha256} does not match the frozen manifest ${frozenManifestDigest}`,
      );
    }
    if (identity.sourceSha !== undefined && identity.sourceSha !== args.sha) {
      identityProblems.push(
        `candidate-identity.json sourceSha ${identity.sourceSha} does not match --sha ${args.sha}`,
      );
    }
    if (identity.version !== undefined && identity.version !== args.version) {
      identityProblems.push(
        `candidate-identity.json version ${identity.version} does not match --version ${args.version}`,
      );
    }
  }
  if (identityProblems.length > 0) fail(identityProblems);
  console.log(
    `Frozen candidate manifest digest: ${frozenManifestDigest} (${manifest.assets.length} assets)`,
  );

  const probe = loadProbe(args);

  // Byte-level promotion checks: reuse the shipped verifier, never a reimplementation.
  const verifier = run(process.execPath, verifierArgs(args, probe));
  if (verifier.stdout.trim() !== "") console.log(verifier.stdout.trim());
  if (verifier.status !== 0) {
    if (verifier.stderr.trim() !== "") console.error(verifier.stderr.trim());
    fail(["promotion verification failed; the local candidate is not promotable"]);
  }

  const gateProblems = promotionGateFailures({
    onForkMain: probe.onForkMain,
    forkRemote: args.forkRemote,
    sourceSha: args.sha,
    frozenManifestDigest,
    approvalDigest: args.approve,
    execute: args.execute,
  });
  if (gateProblems.length > 0) fail(gateProblems);

  const assets = manifest.assets.map((asset) => NodePath.join(args.candidateDir!, asset.name));
  const command = publicationCommand(args, assets);

  if (!args.execute) {
    console.log("PROMOTION READY (dry run — no GitHub write performed).");
    console.log(`Next, with explicit approval of digest ${frozenManifestDigest}:`);
    console.log(`  ${command.join(" ")}`);
    console.log(
      `Re-run with --execute --approve ${frozenManifestDigest} to publish (still unauthorized in this task).`,
    );
    return;
  }

  const published = run(command[0]!, command.slice(1));
  if (published.stdout.trim() !== "") console.log(published.stdout.trim());
  if (published.status !== 0) {
    if (published.stderr.trim() !== "") console.error(published.stderr.trim());
    fail([`publication command failed with exit code ${published.status}`]);
  }
  console.log(`Published v${args.version} from the frozen local candidate.`);
}

main();
