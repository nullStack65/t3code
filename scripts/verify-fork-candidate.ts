#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalProcessRuntime:off - A self-contained CI verification utility over plain files.
/**
 * Verifies (and optionally freezes) a fork release candidate.
 *
 * Three jobs share this tool so the candidate bytes are checked the same way in
 * all of them:
 *   - per-target local builds verify only their own platform's artifacts
 *     (`--targets linux`) so a Linux-only build can pass before macOS exists;
 *   - `qualify` freezes the candidate: write the manifest, write SHA256SUMS
 *     from the observed bytes, then verify the complete required set;
 *   - `publish` re-verifies the *downloaded* artifact and the promotion-level
 *     rules (tag target, no overwrite, version ordering, authorization gate)
 *     before creating a release.
 *
 * It never builds or mutates an asset; it only reads bytes and writes the
 * manifest/checksum metadata beside them.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { inspectCandidateProvenance } from "./lib/candidate-provenance-inspect.ts";
import {
  CANDIDATE_MANIFEST_FILE_NAME,
  NATIVE_RECEIPTS_FILE_NAME,
  NATIVE_RECEIPTS_SCHEMA_VERSION,
  RELEASE_ENVIRONMENT,
  SHA256SUMS_FILE_NAME,
  compareStableVersions,
  renderChecksums,
  requiredReleaseAssetNames,
  requiredReleaseAssetNamesForTargets,
  sha256Hex,
  verifyCandidate,
  verifyPromotion,
  type CandidateTargetSelection,
  type NativeReceipt,
  type ReleaseAsset,
  type ReleaseCandidateManifest,
} from "./lib/fork-release-manifest.ts";

interface Args {
  candidateDir: string;
  version: string;
  sha: string;
  repository: string;
  includeMacosArm64: boolean;
  targets: CandidateTargetSelection;
  inspectProvenance: boolean;
  requireNativeReceipts: boolean;
  writeManifest: boolean;
  writeChecksums: boolean;
  channel: string;
  runId: string;
  runAttempt: string;
  promote: boolean;
  tagTarget: string | undefined;
  releaseExists: boolean;
  tagExists: boolean;
  latestVersion: string | undefined;
  authorizationGateExists: boolean;
  nativeReceiptsPath: string | undefined;
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
  const bool = (key: string): boolean => {
    const value = values.get(key)?.trim().toLowerCase();
    return flags.has(key) || value === "true" || value === "1";
  };
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") {
      throw new Error(`--${key} is required`);
    }
    return value.trim();
  };
  const targets = (values.get("targets")?.trim() || "all") as CandidateTargetSelection;
  if (!["all", "linux", "win", "mac"].includes(targets)) {
    throw new Error("--targets must be all, linux, win, or mac");
  }
  return {
    candidateDir: required("candidate-dir"),
    version: required("version"),
    sha: required("sha").toLowerCase(),
    repository: required("repository"),
    includeMacosArm64: bool("include-macos-arm64"),
    targets,
    inspectProvenance: !bool("skip-provenance-inspection"),
    requireNativeReceipts: bool("require-native-receipts"),
    writeManifest: bool("write-manifest"),
    writeChecksums: bool("write-checksums"),
    channel: values.get("channel")?.trim() || "stable",
    runId: values.get("run-id")?.trim() || "local",
    runAttempt: values.get("run-attempt")?.trim() || "1",
    promote: bool("promote"),
    tagTarget: values.get("tag-target")?.trim().toLowerCase(),
    releaseExists: bool("release-exists"),
    tagExists: bool("tag-exists"),
    latestVersion: values.get("latest-version")?.trim(),
    authorizationGateExists: bool("authorization-gate-exists"),
    nativeReceiptsPath: values.get("native-receipts")?.trim(),
  };
}

const META_FILES = new Set([
  CANDIDATE_MANIFEST_FILE_NAME,
  NATIVE_RECEIPTS_FILE_NAME,
  SHA256SUMS_FILE_NAME,
]);

function listAssetFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir)
    .filter((name) => !META_FILES.has(name))
    .filter((name) => NodeFS.statSync(NodePath.join(dir, name)).isFile())
    .sort();
}

function observeAssets(dir: string): ReleaseAsset[] {
  return listAssetFiles(dir).map((name) => {
    const bytes = NodeFS.readFileSync(NodePath.join(dir, name));
    return { name, sha256: sha256Hex(bytes), size: bytes.byteLength };
  });
}

function readNativeReceiptsFile(path: string): NativeReceipt[] {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  const list = Array.isArray(parsed) ? parsed : (parsed as { receipts?: unknown }).receipts;
  if (!Array.isArray(list)) {
    throw new Error(`${path} must be an array or { receipts: [] }`);
  }
  return list.map(
    (entry) =>
      ({ schemaVersion: NATIVE_RECEIPTS_SCHEMA_VERSION, ...(entry as object) }) as NativeReceipt,
  );
}

function readNativeReceipts(dir: string): NativeReceipt[] {
  const path = NodePath.join(dir, NATIVE_RECEIPTS_FILE_NAME);
  return NodeFS.existsSync(path) ? readNativeReceiptsFile(path) : [];
}

function fail(problems: ReadonlyArray<string>): never {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

/** Highest plain `X.Y.Z` in a comma-separated list, or undefined when none. */
function highestStableVersion(list: string | undefined): string | undefined {
  const versions = (list ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry));
  return versions.reduce<string | undefined>(
    (highest, candidate) =>
      highest === undefined || compareStableVersions(candidate, highest) > 0 ? candidate : highest,
    undefined,
  );
}

/**
 * Verifies one platform's own artifacts before the aggregate manifest exists.
 * It requires that platform's exact asset names and checks the real embedded
 * provenance; it never demands another platform's bytes.
 */
function verifyPerTargetProvenance(
  args: Args,
  observedAssets: ReadonlyArray<ReleaseAsset>,
): { ok: boolean; failures: ReadonlyArray<string> } {
  const problems: string[] = [];
  const expectedNames = requiredReleaseAssetNamesForTargets(args.version, args.targets, {
    includeMacosArm64: args.includeMacosArm64,
  });
  const observedNames = new Set(observedAssets.map((asset) => asset.name));
  for (const name of expectedNames) {
    if (!observedNames.has(name)) {
      problems.push(`required ${args.targets} asset ${name} is missing`);
    }
    const asset = observedAssets.find((entry) => entry.name === name);
    if (asset !== undefined && asset.size <= 0) {
      problems.push(`${name} is empty`);
    }
  }
  if (args.inspectProvenance) {
    const provenance = inspectCandidateProvenance({
      candidateDir: args.candidateDir,
      version: args.version,
      targets: args.targets,
      includeMacosArm64: args.includeMacosArm64,
    });
    const records: Array<
      [string, { readonly sourceSha: string; readonly version: string } | null | undefined]
    > =
      args.targets === "linux"
        ? [["Linux runtime archive", provenance.linuxArchive]]
        : args.targets === "win"
          ? [
              ["Windows CLI archive", provenance.windowsZip],
              ["Windows installer", provenance.windowsInstaller],
            ]
          : [["Intel macOS DMG", provenance.macDmg]];
    for (const [label, record] of records) {
      if (record === undefined) continue;
      if (record === null) {
        problems.push(`${label} has no readable packaged provenance`);
        continue;
      }
      if (record.sourceSha !== args.sha) {
        problems.push(`${label} provenance sourceSha is ${record.sourceSha}, expected ${args.sha}`);
      }
      if (record.version !== args.version) {
        problems.push(`${label} provenance version is ${record.version}, expected ${args.version}`);
      }
    }
  }
  return problems.length === 0 ? { ok: true, failures: [] } : { ok: false, failures: problems };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const observedAssets = observeAssets(args.candidateDir);
  const manifestPath = NodePath.join(args.candidateDir, CANDIDATE_MANIFEST_FILE_NAME);

  if (args.writeManifest) {
    const manifest: ReleaseCandidateManifest = {
      schemaVersion: 1,
      repository: args.repository,
      version: args.version,
      sourceSha: args.sha,
      workflowRevision: process.env.GITHUB_SHA?.trim() ?? "unknown",
      workflowRunId: process.env.GITHUB_RUN_ID?.trim() ?? args.runId,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() ?? args.runAttempt,
      channel: args.channel,
      createdAt: new Date().toISOString(),
      assets: observedAssets,
      nativeReceipts: readNativeReceipts(args.candidateDir),
    };
    NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${CANDIDATE_MANIFEST_FILE_NAME} with ${manifest.assets.length} assets.`);
  }

  if (args.writeChecksums) {
    NodeFS.writeFileSync(
      NodePath.join(args.candidateDir, SHA256SUMS_FILE_NAME),
      renderChecksums(observedAssets),
    );
    console.log(`Wrote ${SHA256SUMS_FILE_NAME} from ${observedAssets.length} assets.`);
  }

  // Per-target verification runs before the aggregate manifest is frozen: it
  // checks only this platform's own assets and their embedded provenance. The
  // aggregate step (targets: all) is the one that requires the manifest.
  if (!NodeFS.existsSync(manifestPath) && args.targets !== "all") {
    const result = verifyPerTargetProvenance(args, observedAssets);
    if (!result.ok) fail(result.failures);
    console.log(
      `Per-target verification passed: ${observedAssets.length} ${args.targets} asset(s) for ${args.repository} v${args.version} @ ${args.sha}.`,
    );
    return;
  }

  if (!NodeFS.existsSync(manifestPath)) {
    fail([`candidate is missing ${CANDIDATE_MANIFEST_FILE_NAME}`]);
  }
  const parsedManifest = JSON.parse(
    NodeFS.readFileSync(manifestPath, "utf8"),
  ) as ReleaseCandidateManifest;
  const manifest =
    args.nativeReceiptsPath === undefined
      ? parsedManifest
      : {
          ...parsedManifest,
          nativeReceipts: readNativeReceiptsFile(args.nativeReceiptsPath),
        };

  const expected = {
    repository: args.repository,
    version: args.version,
    sourceSha: args.sha,
  };

  const checksumPath = NodePath.join(args.candidateDir, SHA256SUMS_FILE_NAME);
  if (NodeFS.existsSync(checksumPath)) {
    const recorded = new Map(
      NodeFS.readFileSync(checksumPath, "utf8")
        .split(/\r?\n/)
        .map((line) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[2]!, match[1]!.toLowerCase()] as const),
    );
    const mismatches = observedAssets.filter(
      (asset) => recorded.get(asset.name) !== asset.sha256.toLowerCase(),
    );
    if (mismatches.length > 0) {
      fail(
        mismatches.map(
          (asset) =>
            `${SHA256SUMS_FILE_NAME} disagrees with ${asset.name} (recorded ${recorded.get(asset.name) ?? "missing"})`,
        ),
      );
    }
  }

  const result = args.promote
    ? verifyPromotion({
        manifest,
        expected,
        observedAssets,
        includeMacosArm64: args.includeMacosArm64,
        requireNativeReceipts: true,
        tagTargetSha: args.tagTarget ?? "",
        releaseExists: args.releaseExists,
        tagExists: args.tagExists,
        latestExistingVersion: highestStableVersion(args.latestVersion),
        authorizationGateExists: args.authorizationGateExists,
      })
    : verifyCandidate({
        manifest,
        expected,
        observedAssets,
        includeMacosArm64: args.includeMacosArm64,
        targets: args.targets,
        requireNativeReceipts: args.requireNativeReceipts,
        packagedProvenance:
          args.promote || !args.inspectProvenance
            ? undefined
            : inspectCandidateProvenance({
                candidateDir: args.candidateDir,
                version: args.version,
                targets: args.targets,
                includeMacosArm64: args.includeMacosArm64,
              }),
      });

  if (!result.ok) {
    fail(result.failures);
  }
  console.log(
    `Candidate verified: ${observedAssets.length} assets for ${args.repository} v${args.version} @ ${args.sha} (targets: ${args.targets}).`,
  );
  if (args.promote) {
    console.log(
      `Promotion checks passed (tag target ${args.tagTarget}, environment '${RELEASE_ENVIRONMENT}').`,
    );
  }
  console.log(
    `Required assets: ${requiredReleaseAssetNames(args.version, { includeMacosArm64: args.includeMacosArm64 }).join(", ")}`,
  );
}

main();
