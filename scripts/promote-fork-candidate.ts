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
 * Publication is a draft → upload → readback → verify → finalize sequence, not a
 * single `gh release create`:
 *   1. create an empty *draft* at the candidate source SHA;
 *   2. upload the exact enumerated payload (build assets + `SHA256SUMS` + the
 *      frozen manifest and available acceptance/evidence metadata);
 *   3. read the remote inventory back and require every file at the exact size
 *      in `uploaded` state, with no unenumerated files;
 *   4. download the published bytes and require each digest to match the local
 *      candidate, including that a consumer's `SHA256SUMS` validates the runtime;
 *   5. finalize (undraft + `--latest`) only after (4) passes.
 * A failed read is never treated as absence; a partially uploaded or mismatched
 * release is never finalized or advertised as success.
 *
 * Default is a read-only preflight/dry run: it performs live read-only GitHub
 * probes (release/tag existence, latest version, environment reviewers,
 * fork-main ancestry) and prints the exact planned sequence **without** running
 * it. `--execute` is required to publish, and it is further gated on
 * `--approve <frozen manifest sha256>` so approval is specific to the exact
 * frozen bytes.
 *
 * `--simulate` is the clearly-labeled offline mode for tests: it requires a
 * `--preflight-json` fixture and an offline mock transport (`--gh-bin` +
 * `--gh-prefix`) and is the *only* way a fixture can be used. The live publisher
 * rejects `--preflight-json`, so fixture claims can never reach real GitHub.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  checksumCoverageFailures,
  evidenceLayoutFailures,
  finalReleaseConfirmationFailures,
  parseChecksumsFile,
  parseGhReleaseViewInventory,
  parsePublicationProbe,
  parseRemoteReleaseInventory,
  promotionGateFailures,
  publicationMetadataFailures,
  publicationProbeFailures,
  releaseInventoryFailures,
  uploadReadbackFailures,
  type GhReleaseViewInventory,
  type GitHubPublicationProbe,
  type ProbeReadState,
} from "./lib/fork-promotion.ts";
import {
  CANDIDATE_MANIFEST_FILE_NAME,
  NATIVE_RECEIPTS_FILE_NAME,
  PACKAGED_INSPECTION_FILE_PREFIX,
  RELEASE_ENVIRONMENT,
  SHA256SUMS_FILE_NAME,
} from "./lib/fork-release-manifest.ts";

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
  simulate: boolean;
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
    simulate: flags.has("simulate"),
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

/**
 * Maps a read to present/absent/unresolved. A nonzero exit that does not look
 * like an authoritative "not found" is `unresolved`, never `absent`: an auth,
 * permission, rate-limit or malformed-response failure cannot prove a
 * release/tag/version does not exist.
 */
function classifyRead(result: RunResult, absentPattern: RegExp): ProbeReadState {
  if (result.status === 0) return "present";
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return absentPattern.test(text) ? "absent" : "unresolved";
}

/** Resolves the writable fork remote whose URL names the requested repository. */
function resolveForkRemote(args: Args): { remote: string; read: ProbeReadState } {
  for (const remote of [args.forkRemote, "origin"]) {
    const url = run("git", ["remote", "get-url", remote]);
    if (
      url.status === 0 &&
      url.stdout.trim().toLowerCase().includes(args.repository.toLowerCase())
    ) {
      return { remote, read: "present" };
    }
  }
  return { remote: args.forkRemote, read: "unresolved" };
}

/** Read-only live GitHub probe, distinguishing confirmed absence from failed reads. */
function probeGitHub(args: Args): GitHubPublicationProbe {
  const repo = args.repository;
  const tag = `v${args.version}`;
  const gh = (rest: ReadonlyArray<string>): RunResult => run(args.ghBin, ghArgs(args, rest));
  const fork = resolveForkRemote(args);

  const release = gh(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
  const releaseRead = classifyRead(release, /not found|404|could not find/);

  const tagLookup =
    fork.read === "present"
      ? run("git", ["ls-remote", "--tags", fork.remote, `refs/tags/${tag}`])
      : { status: 1, stdout: "", stderr: "" };
  const tagRead: ProbeReadState =
    fork.read === "unresolved"
      ? "unresolved"
      : tagLookup.status !== 0
        ? "unresolved"
        : tagLookup.stdout.trim() === ""
          ? "absent"
          : "present";

  const latest = gh([
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
  ]);
  const latestRead: ProbeReadState = latest.status === 0 ? "present" : "unresolved";
  const latestVersion = latestRead === "present" ? latest.stdout.trim() || undefined : undefined;

  const environment = gh(["api", `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`]);
  const authorizationGateRead = classifyRead(environment, /not found|404/);
  let reviewers = 0;
  if (authorizationGateRead === "present") {
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

  // Confirm the resolved fork remote and fetch current fork-main state before
  // asserting ancestry.
  let onForkMain = false;
  let onForkMainRead: ProbeReadState;
  if (fork.read === "unresolved") {
    onForkMainRead = "unresolved";
  } else {
    const fetch = run("git", ["fetch", "--quiet", fork.remote, "main"]);
    if (fetch.status !== 0) {
      onForkMainRead = "unresolved";
    } else {
      const ancestor = run("git", ["merge-base", "--is-ancestor", args.sha, `${fork.remote}/main`]);
      if (ancestor.status === 0) {
        onForkMain = true;
        onForkMainRead = "present";
      } else if (ancestor.status === 1) {
        onForkMain = false;
        onForkMainRead = "present";
      } else {
        onForkMainRead = "unresolved";
      }
    }
  }

  return {
    releaseExists: releaseRead === "present",
    releaseRead,
    tagExists: tagRead === "present",
    tagRead,
    latestVersion,
    latestRead,
    authorizationGateReviewers: reviewers,
    authorizationGateRead,
    onForkMain,
    onForkMainRead,
  };
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

function releaseNotes(args: Args): string {
  return [
    `Fork build of T3 Code \`${args.sha}\`.`,
    "",
    `Repository: \`${args.repository}\`. Fork version \`${args.version}\` is the fork's own increasing line.`,
    "",
    `Assets are checksummed in \`${SHA256SUMS_FILE_NAME}\`; the frozen \`${CANDIDATE_MANIFEST_FILE_NAME}\` records the source and accepted digests.`,
    "",
  ].join("\n");
}

interface PublicationPayload {
  readonly files: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

/**
 * The exact publication payload: the distributed build assets plus the required
 * checksum/manifest metadata and the available acceptance/evidence metadata. The
 * list is enumerated by name — never by wildcard — so unrelated screenshots or
 * logs cannot be swept into a public release.
 */
function publicationPayload(
  args: Args,
  manifest: { readonly assets: ReadonlyArray<{ readonly name: string; readonly sha256: string }> },
): PublicationPayload {
  const dir = args.candidateDir!;
  const problems: string[] = [];
  const manifestPath = NodePath.join(dir, CANDIDATE_MANIFEST_FILE_NAME);
  const checksumsPath = NodePath.join(dir, SHA256SUMS_FILE_NAME);
  const hasManifest = NodeFS.existsSync(manifestPath);
  const hasChecksums = NodeFS.existsSync(checksumsPath);
  problems.push(...publicationMetadataFailures({ hasChecksums, hasManifest }));

  if (hasChecksums) {
    const checksums = parseChecksumsFile(NodeFS.readFileSync(checksumsPath, "utf8"));
    problems.push(...checksumCoverageFailures(checksums, manifest.assets));
  }

  const files = manifest.assets.map((asset) => NodePath.join(dir, asset.name));
  if (hasManifest) files.push(manifestPath);
  if (hasChecksums) files.push(checksumsPath);
  for (const meta of [NATIVE_RECEIPTS_FILE_NAME, "candidate-identity.json"]) {
    const path = NodePath.join(dir, meta);
    if (NodeFS.existsSync(path)) files.push(path);
  }
  const evidence = NodeFS.readdirSync(dir)
    .filter((name) => name.startsWith(PACKAGED_INSPECTION_FILE_PREFIX) && name.endsWith(".json"))
    .sort();
  for (const name of evidence) files.push(NodePath.join(dir, name));

  for (const file of files) {
    if (!NodeFS.existsSync(file)) problems.push(`publication payload file ${file} does not exist`);
  }
  return { files, problems };
}

/** A human-readable dry-run of the draft → upload → readback → verify → finalize sequence. */
function plannedCommandLines(args: Args, files: ReadonlyArray<string>): ReadonlyArray<string> {
  const tag = `v${args.version}`;
  const gh = [args.ghBin, ...args.ghPrefix].join(" ");
  return [
    `${gh} release create ${tag} --repo ${args.repository} --target ${args.sha} --title "T3 Code (fork) v${args.version}" --notes-file <generated> --draft`,
    `${gh} release upload ${tag} --repo ${args.repository} ${files.map((file) => NodePath.basename(file)).join(" ")}`,
    `${gh} release view ${tag} --repo ${args.repository} --json id,tagName,isDraft,targetCommitish,assets`,
    `${gh} release download ${tag} --repo ${args.repository} --dir <tmp> (then sha256-verify every file)`,
    `${gh} release edit ${tag} --repo ${args.repository} --draft=false --latest`,
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

/**
 * Draft → upload → readback → verify-bytes → finalize. Returns a nonzero status
 * (via `fail`) at the first deviation, so a partial upload or digest mismatch can
 * never be finalized or reported as success. `finalized` records whether the
 * release was undrafted.
 */
function publish(args: Args, files: ReadonlyArray<string>): void {
  const repo = args.repository;
  const tag = `v${args.version}`;
  const notesFile = NodePath.join(NodeOS.tmpdir(), `t3-release-notes-${process.pid}.txt`);
  NodeFS.writeFileSync(notesFile, releaseNotes(args));
  const downloadDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-readback-"));
  let finalized = false;
  try {
    const create = run(
      args.ghBin,
      ghArgs(args, [
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--target",
        args.sha,
        "--title",
        `T3 Code (fork) v${args.version}`,
        "--notes-file",
        notesFile,
        "--draft",
      ]),
    );
    if (create.status !== 0) {
      fail([
        `could not create the draft release ${tag}: ${create.stderr.trim() || "gh release create failed"}`,
      ]);
    }

    const upload = run(
      args.ghBin,
      ghArgs(args, ["release", "upload", tag, "--repo", repo, ...files]),
    );
    if (upload.status !== 0) {
      fail([
        `could not upload the release payload for ${tag}: ${upload.stderr.trim() || "gh release upload failed"}`,
      ]);
    }

    const view = run(
      args.ghBin,
      ghArgs(args, [
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "id,tagName,isDraft,targetCommitish,assets",
      ]),
    );
    if (view.status !== 0) {
      fail([
        `could not read back release ${tag} after upload: ${view.stderr.trim() || "gh release view failed"}`,
      ]);
    }
    let inventory: GhReleaseViewInventory;
    try {
      inventory = parseGhReleaseViewInventory(JSON.parse(view.stdout));
    } catch {
      fail([`release ${tag} readback was not valid JSON; treating it as unresolved`]);
    }
    if (inventory.tagName !== tag || inventory.isDraft !== true) {
      fail([
        `release readback for ${tag} did not report the expected draft '${tag}' (tag '${inventory.tagName || "(missing)"}', isDraft ${JSON.stringify(inventory.isDraft)}); treating it as unresolved`,
      ]);
    }
    const expected = files.map((file) => ({
      name: NodePath.basename(file),
      size: NodeFS.statSync(file).size,
    }));
    const readback = uploadReadbackFailures(inventory, expected);
    if (readback.length > 0) fail(readback);

    const download = run(
      args.ghBin,
      ghArgs(args, ["release", "download", tag, "--repo", repo, "--dir", downloadDir]),
    );
    if (download.status !== 0) {
      fail([
        `could not download release ${tag} for byte verification: ${download.stderr.trim() || "gh release download failed"}`,
      ]);
    }

    const downloaded = new Map<string, string>();
    const byteProblems: string[] = [];
    for (const file of files) {
      const name = NodePath.basename(file);
      const path = NodePath.join(downloadDir, name);
      if (!NodeFS.existsSync(path)) {
        byteProblems.push(`downloaded release is missing ${name}`);
        continue;
      }
      const remote = sha256File(path);
      downloaded.set(name, remote);
      const local = sha256File(file);
      if (remote !== local) {
        byteProblems.push(`downloaded ${name} has sha256 ${remote}, uploaded bytes were ${local}`);
      }
    }

    const downloadedChecksums = NodePath.join(downloadDir, SHA256SUMS_FILE_NAME);
    if (!NodeFS.existsSync(downloadedChecksums)) {
      byteProblems.push(
        `downloaded release is missing ${SHA256SUMS_FILE_NAME}; a consumer cannot validate the runtime`,
      );
    } else {
      const manifest = JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(args.candidateDir!, CANDIDATE_MANIFEST_FILE_NAME),
          "utf8",
        ),
      ) as { readonly assets: ReadonlyArray<{ readonly name: string }> };
      const checksums = parseChecksumsFile(NodeFS.readFileSync(downloadedChecksums, "utf8"));
      const observed = manifest.assets.flatMap((asset) => {
        const digest = downloaded.get(asset.name);
        return digest === undefined ? [] : [{ name: asset.name, sha256: digest }];
      });
      byteProblems.push(...checksumCoverageFailures(checksums, observed));
    }
    if (byteProblems.length > 0) fail(byteProblems);

    const finalize = run(
      args.ghBin,
      ghArgs(args, ["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]),
    );
    if (finalize.status !== 0) {
      fail([
        `all published bytes verified, but finalizing ${tag} failed: ${finalize.stderr.trim() || "gh release edit failed"}`,
      ]);
    }

    const confirm = run(
      args.ghBin,
      ghArgs(args, [
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "id,tagName,isDraft,targetCommitish,assets",
      ]),
    );
    if (confirm.status !== 0) {
      fail([
        `could not confirm the final release ${tag}: ${confirm.stderr.trim() || "gh release view failed"}`,
      ]);
    }
    let final: GhReleaseViewInventory;
    try {
      final = parseGhReleaseViewInventory(JSON.parse(confirm.stdout));
    } catch {
      fail([`final release ${tag} readback was not valid JSON; not reporting success`]);
    }
    // A syntactically valid JSON object is not a confirmation: require an
    // explicit boolean non-draft state, the expected tag identity, and the
    // complete expected asset inventory at the expected sizes.
    const confirmationProblems = [
      ...finalReleaseConfirmationFailures(final, tag, args.sha),
      ...uploadReadbackFailures(final, expected),
    ];
    if (confirmationProblems.length > 0) fail(confirmationProblems);
    finalized = true;
  } finally {
    NodeFS.rmSync(notesFile, { force: true });
    NodeFS.rmSync(downloadDir, { recursive: true, force: true });
  }
  if (finalized) {
    console.log(
      `Published v${args.version} from the frozen local candidate (${files.length} verified file(s)).`,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspectRelease !== undefined) {
    runInspectRelease(args);
  }

  // Fixture isolation: a `--preflight-json` fixture can only be used in the
  // clearly-labeled offline mode with an offline mock transport, so fabricated
  // preflight claims can never reach the live publisher.
  if (args.preflightJson !== undefined && !args.simulate) {
    fail([
      "--preflight-json is a labeled fixture and requires --simulate; it must never drive the live publisher",
    ]);
  }
  if (args.simulate && args.preflightJson === undefined) {
    fail(["--simulate requires --preflight-json and an offline mock transport"]);
  }
  if (args.simulate && args.ghPrefix.length === 0) {
    fail([
      "--simulate requires an offline mock transport (--gh-bin <node> --gh-prefix <mock>); refusing to use the live gh",
    ]);
  }
  // V9-F4: `--simulate` must not be able to fall back to the real `gh` binary.
  // A non-empty prefix alone does not prove the transport is offline.
  const ghBinName = NodePath.basename(args.ghBin).toLowerCase();
  if (args.simulate && (ghBinName === "gh" || ghBinName === "gh.exe")) {
    fail([
      `--simulate refuses --gh-bin '${args.ghBin}': an offline mock transport is required, not the live gh binary`,
    ]);
  }

  if (args.candidateDir === undefined) {
    fail(["--candidate-dir is required (or use --inspect-release <id>)"]);
  }
  if (args.sha.trim() === "") {
    fail(["--sha is required for the local candidate handoff"]);
  }
  const manifestPath = NodePath.join(args.candidateDir, CANDIDATE_MANIFEST_FILE_NAME);
  if (!NodeFS.existsSync(manifestPath)) {
    fail([`candidate is missing ${manifestPath}; run the aggregate freeze first`]);
  }

  const frozenManifestDigest = sha256File(manifestPath);
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
    repository: string;
    version: string;
    sourceSha: string;
    assets: ReadonlyArray<{ name: string; sha256: string }>;
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
  const probeProblems = publicationProbeFailures(probe);
  if (probeProblems.length > 0) fail(probeProblems);

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

  const payload = publicationPayload(args, manifest);
  if (payload.problems.length > 0) fail(payload.problems);

  // The evidence used for acceptance must be part of what is published, or be
  // rejected before any GitHub mutation (V9-F2). This is checked before the dry
  // run so an operator sees the layout error without --execute.
  const evidenceProblems = evidenceLayoutFailures({
    candidateDir: args.candidateDir,
    nativeReceipts: args.nativeReceipts,
    inspectionEvidence: args.inspectionEvidence,
    publishedFiles: payload.files,
  });
  if (evidenceProblems.length > 0) fail(evidenceProblems);

  if (!args.execute) {
    console.log("PROMOTION READY (dry run — no GitHub write performed).");
    console.log(`Publication payload (${payload.files.length} enumerated file(s)):`);
    for (const file of payload.files) console.log(`  - ${NodePath.basename(file)}`);
    console.log(`Next, with explicit approval of digest ${frozenManifestDigest}:`);
    for (const line of plannedCommandLines(args, payload.files)) console.log(`  ${line}`);
    console.log(
      `Re-run with --execute --approve ${frozenManifestDigest} to publish (still unauthorized in this task).`,
    );
    return;
  }

  publish(args, payload.files);
}

main();
