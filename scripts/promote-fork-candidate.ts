#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalProcessRuntime:off - An owner-controlled release promotion adapter over plain files and `gh`.
/**
 * Owner-controlled local/draft promotion for a frozen fork candidate.
 *
 * The CI `publish` job promotes a candidate artifact by workflow run id. That
 * route does not exist when the candidate was assembled locally (no authorized
 * runner), so this adapter promotes the *same frozen bytes* directly from an
 * operator-controlled machine:
 *
 *   1. Read the frozen candidate (`fork-release-manifest.json`,
 *      `candidate-identity.json`, `SHA256SUMS`, assets, digest-bound inspection
 *      evidence, native receipts) or the existing draft release's assets.
 *   2. Reconcile the local candidate against the exact draft release asset
 *      ids/digests so the accepted bytes are the promoted bytes.
 *   3. Run the shared promotion verifier (`verifyPromotion` in
 *      `lib/fork-release-manifest.ts`, the same rules `publish` uses): complete
 *      required asset set, source/version/arch provenance, native acceptance,
 *      tag/release/version conflicts, and the reviewer gate.
 *   4. Require real fork-`main` ancestry for the source SHA.
 *   5. Require explicit approval for *that* candidate digest, then (only with
 *      `--execute`) upload the accepted bytes, read them back, and undraft.
 *
 * The default is a read-only dry run. `--execute` performs writes and is not
 * exercised by the verification tests; a supplied boolean is never treated as
 * evidence of an approval.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CANDIDATE_MANIFEST_FILE_NAME,
  NATIVE_RECEIPTS_FILE_NAME,
  PACKAGED_INSPECTION_FILE_PREFIX,
  RELEASE_ENVIRONMENT,
  requiredReleaseAssetNames,
  sha256Hex,
  verifyPromotion,
  type CandidateTargetSelection,
  type NativeReceipt,
  type PackagedInspectionEvidence,
  type ReleaseAsset,
  type ReleaseCandidateManifest,
} from "./lib/fork-release-manifest.ts";

interface Args {
  candidateDir: string | undefined;
  draftRelease: string | undefined;
  version: string;
  sha: string;
  repository: string;
  tag: string;
  forkRemote: string;
  mainRef: string;
  nativeReceiptsPath: string | undefined;
  inspectionEvidence: ReadonlyArray<string>;
  githubFixture: string | undefined;
  includeMacosArm64: boolean;
  execute: boolean;
  approve: string | undefined;
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
  const version = required("version");
  const inspectionEvidence = (values.get("inspection-evidence") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return {
    candidateDir: values.get("candidate-dir")?.trim(),
    draftRelease: values.get("draft-release")?.trim(),
    version,
    sha: required("sha").toLowerCase(),
    repository: values.get("repository")?.trim() || "nullStack65/t3code",
    tag: values.get("tag")?.trim() || `v${version}`,
    forkRemote: values.get("fork-remote")?.trim() || "fork",
    mainRef: values.get("main-ref")?.trim() || "main",
    nativeReceiptsPath: values.get("native-receipts")?.trim(),
    inspectionEvidence,
    githubFixture: values.get("github-fixture")?.trim(),
    includeMacosArm64: flags.has("include-macos-arm64"),
    execute: flags.has("execute"),
    approve: values.get("approve")?.trim(),
  };
}

const META_FILES = new Set([
  CANDIDATE_MANIFEST_FILE_NAME,
  NATIVE_RECEIPTS_FILE_NAME,
  "candidate-identity.json",
  "SHA256SUMS",
]);

function listAssetFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir)
    .filter((name) => !META_FILES.has(name))
    .filter((name) => !name.startsWith(PACKAGED_INSPECTION_FILE_PREFIX))
    .filter((name) => NodeFS.statSync(NodePath.join(dir, name)).isFile())
    .sort();
}

function observeAssets(dir: string): ReleaseAsset[] {
  return listAssetFiles(dir).map((name) => {
    const bytes = NodeFS.readFileSync(NodePath.join(dir, name));
    return { name, sha256: sha256Hex(bytes), size: bytes.byteLength };
  });
}

function run(command: string, args: ReadonlyArray<string>): { status: number; stdout: string } {
  const result = NodeChildProcess.spawnSync(command, [...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim() };
}

function git(args: ReadonlyArray<string>): { status: number; stdout: string } {
  return run("git", args);
}

function ghJson(args: ReadonlyArray<string>): unknown | undefined {
  const result = run("gh", args);
  if (result.status !== 0 || result.stdout === "") return undefined;
  return JSON.parse(result.stdout);
}

interface DraftAsset {
  readonly id: number;
  readonly name: string;
  readonly digest: string;
  readonly size: number;
}

interface DraftRelease {
  readonly tag: string;
  readonly targetSha: string;
  readonly assets: ReadonlyArray<DraftAsset>;
}

interface GitHubState {
  readonly tag: string;
  readonly releaseExists: boolean;
  readonly releaseTargetSha: string | undefined;
  readonly tagExists: boolean;
  readonly latestVersion: string | undefined;
  readonly requiredReviewers: number;
  readonly draft: DraftRelease | undefined;
}

interface DraftAssetJson {
  readonly id?: number;
  readonly name?: string;
  readonly digest?: string | null;
  readonly size?: number;
}

function parseDraftAssets(raw: unknown): DraftAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as DraftAssetJson)
    .filter(
      (entry): entry is Required<DraftAssetJson> =>
        typeof entry.id === "number" && typeof entry.name === "string",
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      digest: (entry.digest ?? "").replace(/^sha256:/, "").toLowerCase(),
      size: entry.size ?? 0,
    }));
}

function highestStableVersion(tags: ReadonlyArray<{ tagName: string; isDraft: boolean; isPrerelease: boolean }>): string | undefined {
  const versions = tags
    .filter((entry) => !entry.isDraft && !entry.isPrerelease)
    .map((entry) => entry.tagName.replace(/^v/, ""))
    .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry));
  return versions.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);
}

function loadGitHubState(args: Args): GitHubState {
  if (args.githubFixture !== undefined) {
    if (args.execute) {
      throw new Error("--github-fixture is a dry-run input; it cannot drive --execute");
    }
    const fixture = JSON.parse(NodeFS.readFileSync(args.githubFixture, "utf8")) as {
      releaseExists?: boolean;
      releaseTargetSha?: string | null;
      tagExists?: boolean;
      latestVersion?: string | null;
      requiredReviewers?: number;
      draft?: { tag?: string; targetSha?: string; assets?: unknown } | null;
    };
    return {
      tag: args.tag,
      releaseExists: fixture.releaseExists === true,
      releaseTargetSha: fixture.releaseTargetSha ?? undefined,
      tagExists: fixture.tagExists === true,
      latestVersion: fixture.latestVersion ?? undefined,
      requiredReviewers: fixture.requiredReviewers ?? 0,
      draft:
        fixture.draft === undefined || fixture.draft === null
          ? undefined
          : {
              tag: fixture.draft.tag ?? "",
              targetSha: fixture.draft.targetSha ?? "",
              assets: parseDraftAssets(fixture.draft.assets),
            },
    };
  }

  const repo = args.repository;
  const release = ghJson(["api", `repos/${repo}/releases/tags/${args.tag}`]) as
    | { target_commitish?: string }
    | undefined;
  const tagRef = ghJson(["api", `repos/${repo}/git/ref/tags/${args.tag}`]);
  const releases = ghJson([
    "release",
    "list",
    "--repo",
    repo,
    "--limit",
    "100",
    "--json",
    "tagName,isDraft,isPrerelease",
  ]) as ReadonlyArray<{ tagName: string; isDraft: boolean; isPrerelease: boolean }> | undefined;
  const environment = ghJson(["api", `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`]) as
    | { protection_rules?: ReadonlyArray<{ type?: string; reviewers?: ReadonlyArray<unknown> }> }
    | undefined;
  const reviewerRule = environment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  const draftRelease =
    args.draftRelease === undefined
      ? undefined
      : (ghJson(["api", `repos/${repo}/releases/${args.draftRelease}`]) as
          | { tag_name?: string; target_commitish?: string; assets?: unknown }
          | undefined);
  return {
    tag: args.tag,
    releaseExists: release !== undefined,
    releaseTargetSha: release?.target_commitish?.trim().toLowerCase(),
    tagExists: tagRef !== undefined,
    latestVersion: releases === undefined ? undefined : highestStableVersion(releases),
    requiredReviewers: reviewerRule?.reviewers?.length ?? 0,
    draft:
      draftRelease === undefined
        ? undefined
        : {
            tag: draftRelease.tag_name ?? "",
            targetSha: (draftRelease.target_commitish ?? "").trim().toLowerCase(),
            assets: parseDraftAssets(draftRelease.assets),
          },
  };
}

function readNativeReceipts(path: string): NativeReceipt[] {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  const list = Array.isArray(parsed) ? parsed : (parsed as { receipts?: unknown }).receipts;
  if (!Array.isArray(list)) throw new Error(`${path} must be an array or { receipts: [] }`);
  return list as NativeReceipt[];
}

function readInspectionEvidence(paths: ReadonlyArray<string>): PackagedInspectionEvidence[] {
  return paths.map((path) => {
    const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as PackagedInspectionEvidence;
    if (parsed.schemaVersion !== 1) throw new Error(`${path} is not packaged inspection evidence`);
    return parsed;
  });
}

function discoveredEvidence(args: Args): ReadonlyArray<string> {
  if (args.inspectionEvidence.length > 0) return args.inspectionEvidence;
  if (args.candidateDir === undefined) return [];
  return NodeFS.readdirSync(args.candidateDir)
    .filter(
      (name) => name.startsWith(PACKAGED_INSPECTION_FILE_PREFIX) && name.endsWith(".json"),
    )
    .sort()
    .map((name) => NodePath.join(args.candidateDir!, name));
}

function fail(problems: ReadonlyArray<string>): never {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.candidateDir === undefined && args.draftRelease === undefined) {
    fail(["--candidate-dir or --draft-release is required"]);
  }

  const github = loadGitHubState(args);

  // --- Candidate identity -------------------------------------------------
  let manifest: ReleaseCandidateManifest;
  let observedAssets: ReleaseAsset[];
  let identityDigest: string;
  if (args.candidateDir !== undefined) {
    const manifestPath = NodePath.join(args.candidateDir, CANDIDATE_MANIFEST_FILE_NAME);
    if (!NodeFS.existsSync(manifestPath)) {
      fail([`candidate is missing ${CANDIDATE_MANIFEST_FILE_NAME}`]);
    }
    const manifestBytes = NodeFS.readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8")) as ReleaseCandidateManifest;
    observedAssets = observeAssets(args.candidateDir);
    identityDigest = sha256Hex(manifestBytes);
    const identityPath = NodePath.join(args.candidateDir, "candidate-identity.json");
    if (NodeFS.existsSync(identityPath)) {
      const identity = JSON.parse(NodeFS.readFileSync(identityPath, "utf8")) as {
        manifestSha256?: string;
      };
      if (identity.manifestSha256 !== identityDigest) {
        fail([
          `candidate-identity.json records ${identity.manifestSha256 ?? "none"}, but the manifest hashes to ${identityDigest}`,
        ]);
      }
    }
  } else {
    // Draft mode: the existing draft release is the frozen candidate. Its asset
    // ids/digests are authoritative for the accepted bytes.
    if (github.draft === undefined) {
      fail([`draft release ${args.draftRelease} was not found in ${args.repository}`]);
    }
    observedAssets = github.draft.assets.map((asset) => ({
      name: asset.name,
      sha256: asset.digest,
      size: asset.size,
    }));
    manifest = {
      schemaVersion: 1,
      repository: args.repository,
      version: args.version,
      sourceSha: args.sha,
      workflowRevision: "local",
      workflowRunId: "local",
      workflowRunAttempt: "1",
      channel: "stable",
      createdAt: new Date(0).toISOString(),
      assets: observedAssets,
      nativeReceipts: [],
    };
    identityDigest = sha256Hex(Buffer.from(JSON.stringify(manifest, null, 2)));
  }

  // --- Report the exact draft/candidate asset ids and digests -------------
  console.log(`Candidate identity digest: ${identityDigest}`);
  if (github.draft !== undefined) {
    console.log(`Draft release: ${github.draft.tag} (target ${github.draft.targetSha || "unknown"})`);
    for (const asset of github.draft.assets) {
      console.log(`  draft asset ${asset.id} ${asset.name} ${asset.digest || "no-digest"} ${asset.size}B`);
    }
    if (github.draft.targetSha !== args.sha) {
      fail([
        `draft release target ${github.draft.targetSha || "unknown"} does not match source ${args.sha}`,
      ]);
    }
    const draftByName = new Map(github.draft.assets.map((asset) => [asset.name, asset]));
    for (const asset of observedAssets) {
      const staged = draftByName.get(asset.name);
      if (staged !== undefined && staged.digest !== "" && staged.digest !== asset.sha256) {
        fail([
          `draft asset ${asset.name} is ${staged.digest}, but the candidate is ${asset.sha256}; refusing to replace accepted bytes`,
        ]);
      }
    }
  }

  // --- Shared promotion verification --------------------------------------
  const receipts =
    args.nativeReceiptsPath !== undefined
      ? readNativeReceipts(args.nativeReceiptsPath)
      : manifest.nativeReceipts;
  const evidence = readInspectionEvidence(discoveredEvidence(args));
  const targets: CandidateTargetSelection = "all";
  const result = verifyPromotion({
    manifest: { ...manifest, nativeReceipts: receipts },
    expected: { repository: args.repository, version: args.version, sourceSha: args.sha },
    observedAssets,
    includeMacosArm64: args.includeMacosArm64,
    targets,
    requireNativeReceipts: true,
    tagTargetSha: args.sha,
    releaseExists: github.releaseExists,
    tagExists: github.tagExists,
    latestExistingVersion: github.latestVersion,
    authorizationGateExists: github.requiredReviewers > 0,
    packagedProvenance: undefined,
    inspectionEvidence: evidence,
    requirePackagedProvenance: true,
  });
  if (!result.ok) fail(result.failures);
  console.log(`Promotion verification passed for ${args.repository} v${args.version} @ ${args.sha}.`);

  // --- True fork-main eligibility -----------------------------------------
  const mainRef = `refs/remotes/${args.forkRemote}/${args.mainRef}`;
  const fetch = git([
    "fetch",
    "--no-tags",
    args.forkRemote,
    `${args.mainRef}:${mainRef}`,
  ]);
  if (fetch.status !== 0) {
    const existing = git(["rev-parse", "--verify", `${args.forkRemote}/${args.mainRef}`]);
    if (existing.status !== 0) {
      fail([
        `could not refresh or resolve ${args.forkRemote}/${args.mainRef}; refusing to assert main eligibility`,
      ]);
    }
  }
  if (git(["merge-base", "--is-ancestor", args.sha, `${args.forkRemote}/${args.mainRef}`]).status !== 0) {
    fail([`source ${args.sha} is not an ancestor of ${args.repository} ${args.mainRef}`]);
  }
  console.log(`Source ${args.sha} is an ancestor of ${args.forkRemote}/${args.mainRef}.`);

  // --- Explicit approval for this exact candidate -------------------------
  if (args.approve === undefined || args.approve.trim().toLowerCase() !== identityDigest) {
    fail([
      `explicit publication approval is required: pass --approve ${identityDigest} for this exact candidate (a boolean is not approval)`,
    ]);
  }
  console.log(`Publication approved for candidate ${identityDigest}.`);

  const required = requiredReleaseAssetNames(args.version, {
    includeMacosArm64: args.includeMacosArm64,
  });
  const draftNote =
    github.draft === undefined ? "no draft reconciliation requested" : `draft ${github.draft.tag}`;
  if (!args.execute) {
    console.log("\nDRY RUN — no release was created, moved, or published.");
    console.log(`Would publish ${args.tag} (${required.join(", ")}) targeting ${args.sha}.`);
    console.log(`Reviewer gate: ${github.requiredReviewers} required reviewer(s) in '${RELEASE_ENVIRONMENT}'.`);
    console.log(`Bytes preserved via: ${draftNote} -> upload -> readback -> undraft.`);
    return;
  }

  if (args.githubFixture !== undefined) {
    fail(["--github-fixture cannot drive --execute"]);
  }
  if (args.candidateDir === undefined) {
    fail(["--execute requires --candidate-dir so the accepted bytes can be uploaded and read back"]);
  }

  // --- Upload, read back, then undraft ------------------------------------
  // The release is created as a draft from the exact local bytes, every asset
  // is downloaded again and re-hashed, and only then is the draft published.
  const repo = args.repository;
  const files = observedAssets.map((asset) => NodePath.join(args.candidateDir!, asset.name));
  const create = NodeChildProcess.spawnSync(
    "gh",
    [
      "release",
      "create",
      args.tag,
      "--repo",
      repo,
      "--draft",
      "--target",
      args.sha,
      "--title",
      `T3 Code (fork) ${args.tag}`,
      "--notes",
      `Fork build of T3 Code ${args.sha}. Assets are checksummed in SHA256SUMS.`,
      ...files,
    ],
    { stdio: "inherit" },
  );
  if ((create.status ?? 1) !== 0) fail([`gh release create ${args.tag} failed`]);

  const readbackDir = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodePath.dirname(args.candidateDir)), "t3-promote-readback-"));
  try {
    for (const asset of observedAssets) {
      const download = NodeChildProcess.spawnSync(
        "gh",
        ["release", "download", args.tag, "--repo", repo, "--pattern", asset.name, "--dir", readbackDir],
        { stdio: "inherit" },
      );
      if ((download.status ?? 1) !== 0) fail([`readback download of ${asset.name} failed`]);
      const readback = NodePath.join(readbackDir, asset.name);
      const observed = sha256Hex(NodeFS.readFileSync(readback));
      if (observed !== asset.sha256) {
        fail([`readback ${asset.name} is ${observed}, uploaded ${asset.sha256}`]);
      }
    }
  } finally {
    NodeFS.rmSync(readbackDir, { recursive: true, force: true });
  }

  const undraft = NodeChildProcess.spawnSync(
    "gh",
    ["release", "edit", args.tag, "--repo", repo, "--draft=false", "--latest"],
    { stdio: "inherit" },
  );
  if ((undraft.status ?? 1) !== 0) fail([`gh release edit ${args.tag} --draft=false failed`]);
  console.log(`Published ${args.tag} after byte-preserving upload and readback.`);
}

main();
