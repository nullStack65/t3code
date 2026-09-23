#!/usr/bin/env node
/**
 * Fork release candidate manifest and promotion verification.
 *
 * A release is only trustworthy if the bytes that were qualified are the bytes
 * that get published. The candidate is therefore frozen as an immutable
 * workflow artifact plus a manifest that records the source SHA, version,
 * complete asset list, per-asset SHA-256, and the native acceptance receipts.
 * Promotion re-reads that artifact and verifies it instead of rebuilding.
 *
 * Everything here is pure: the caller supplies the manifest and the observed
 * hashes, so the rules can be exercised without a network or a build.
 */
import * as NodeCrypto from "node:crypto";

export const CANDIDATE_MANIFEST_FILE_NAME = "fork-release-manifest.json";
export const NATIVE_RECEIPTS_FILE_NAME = "fork-native-receipts.json";
export const SHA256SUMS_FILE_NAME = "SHA256SUMS";
export const CANDIDATE_ARTIFACT_NAME = "fork-release-candidate";
export const NATIVE_RECEIPTS_ARTIFACT_NAME = "fork-release-native-receipts";

export const RELEASE_REPOSITORY = "nullStack65/t3code";
export const RELEASE_ENVIRONMENT = "fork-release";

export const CANDIDATE_SCHEMA_VERSION = 1;
export const NATIVE_RECEIPTS_SCHEMA_VERSION = 1;

export interface ReleaseAsset {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

export interface NativeReceipt {
  readonly schemaVersion: 1;
  /** Who ran the acceptance: `W` (Windows/WSL) or `M` (macOS). */
  readonly owner: string;
  /** Target the receipt accepts, for example `win32-x64` or `darwin-x64`. */
  readonly target: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly assetName: string;
  readonly assetSha256: string;
  readonly result: "pass" | "fail";
  readonly notes?: string | undefined;
}

export interface ReleaseCandidateManifest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly version: string;
  readonly sourceSha: string;
  readonly workflowRevision: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: string;
  readonly channel: string;
  readonly createdAt: string;
  readonly assets: ReadonlyArray<ReleaseAsset>;
  readonly nativeReceipts: ReadonlyArray<NativeReceipt>;
}

export interface CandidateExpectations {
  readonly repository: string;
  readonly version: string;
  readonly sourceSha: string;
}

/** The native targets whose acceptance a first release requires. */
export const REQUIRED_NATIVE_TARGETS = ["win32-x64", "darwin-x64"] as const;

export function requiredReleaseAssetNames(
  version: string,
  options: { readonly includeMacosArm64?: boolean } = {},
): ReadonlyArray<string> {
  const names = [
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.dmg`,
    `t3-${version}-linux-x64.tar.gz`,
    `t3-${version}-win32-x64.zip`,
  ];
  if (options.includeMacosArm64 === true) {
    names.push(`T3-Code-${version}-arm64.dmg`);
  }
  return names;
}

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
}

const ok = (): VerificationResult => ({ ok: true, failures: [] });

const failures = (list: ReadonlyArray<string>): VerificationResult =>
  list.length === 0 ? ok() : { ok: false, failures: list };

export interface VerifyCandidateInput {
  readonly manifest: ReleaseCandidateManifest;
  readonly expected: CandidateExpectations;
  /** Observed `sha256` and byte size for each file actually present. */
  readonly observedAssets: ReadonlyArray<ReleaseAsset>;
  readonly includeMacosArm64?: boolean;
  readonly requireNativeReceipts?: boolean;
}

/**
 * Verifies a candidate's manifest against the bytes on disk and the expected
 * source. Every required asset must be present with a matching digest, the
 * manifest must not disagree with the expected source, and each native receipt
 * must bind to the same source and the same asset digest.
 */
export function verifyCandidate(input: VerifyCandidateInput): VerificationResult {
  const problems: string[] = [];
  const { manifest, expected } = input;

  if (manifest.schemaVersion !== CANDIDATE_SCHEMA_VERSION) {
    problems.push(`manifest schemaVersion is ${manifest.schemaVersion}`);
  }
  if (manifest.repository !== expected.repository) {
    problems.push(`manifest repository is ${manifest.repository}, expected ${expected.repository}`);
  }
  if (manifest.version !== expected.version) {
    problems.push(`manifest version is ${manifest.version}, expected ${expected.version}`);
  }
  if (manifest.sourceSha !== expected.sourceSha) {
    problems.push(`manifest sourceSha is ${manifest.sourceSha}, expected ${expected.sourceSha}`);
  }

  const observed = new Map(input.observedAssets.map((asset) => [asset.name, asset]));
  const required = requiredReleaseAssetNames(expected.version, {
    includeMacosArm64: input.includeMacosArm64 === true,
  });
  const manifestAssets = new Map(manifest.assets.map((asset) => [asset.name, asset]));

  for (const name of required) {
    if (!observed.has(name)) {
      problems.push(`required asset ${name} is missing from the candidate`);
    }
    if (!manifestAssets.has(name)) {
      problems.push(`required asset ${name} is missing from the manifest`);
    }
  }

  for (const asset of input.observedAssets) {
    const recorded = manifestAssets.get(asset.name);
    if (recorded === undefined) {
      problems.push(`asset ${asset.name} is present but not recorded in the manifest`);
      continue;
    }
    if (recorded.sha256.toLowerCase() !== asset.sha256.toLowerCase()) {
      problems.push(
        `asset ${asset.name} sha256 is ${asset.sha256}, manifest recorded ${recorded.sha256}`,
      );
    }
    if (recorded.size !== asset.size) {
      problems.push(
        `asset ${asset.name} size is ${asset.size}, manifest recorded ${recorded.size}`,
      );
    }
  }

  for (const recorded of manifest.assets) {
    if (!observed.has(recorded.name)) {
      problems.push(`manifest lists ${recorded.name} but it is not present`);
    }
  }

  const receipts = manifest.nativeReceipts;
  if (input.requireNativeReceipts === true) {
    for (const target of REQUIRED_NATIVE_TARGETS) {
      const matching = receipts.filter((receipt) => receipt.target === target);
      if (matching.length === 0) {
        problems.push(`no native acceptance receipt for ${target}`);
        continue;
      }
      if (!matching.some((receipt) => receipt.result === "pass")) {
        problems.push(`no passing native acceptance receipt for ${target}`);
      }
    }
  }
  for (const receipt of receipts) {
    if (receipt.schemaVersion !== NATIVE_RECEIPTS_SCHEMA_VERSION) {
      problems.push(`receipt for ${receipt.target} has schemaVersion ${receipt.schemaVersion}`);
    }
    if (receipt.sourceSha !== expected.sourceSha) {
      problems.push(
        `receipt for ${receipt.target} is for source ${receipt.sourceSha}, expected ${expected.sourceSha}`,
      );
    }
    if (receipt.version !== expected.version) {
      problems.push(
        `receipt for ${receipt.target} is for version ${receipt.version}, expected ${expected.version}`,
      );
    }
    const asset = manifestAssets.get(receipt.assetName);
    if (asset === undefined) {
      problems.push(`receipt for ${receipt.target} names unknown asset ${receipt.assetName}`);
    } else if (asset.sha256.toLowerCase() !== receipt.assetSha256.toLowerCase()) {
      problems.push(
        `receipt for ${receipt.target} accepted ${receipt.assetSha256}, asset is ${asset.sha256}`,
      );
    }
  }

  return failures(problems);
}

export interface VerifyPromotionInput extends VerifyCandidateInput {
  readonly tagTargetSha: string;
  readonly releaseExists: boolean;
  readonly tagExists: boolean;
  readonly latestExistingVersion: string | undefined;
  readonly authorizationGateExists: boolean;
}

/**
 * Promotion adds the release-level checks on top of candidate verification:
 * the tag target must be the source, nothing may be overwritten, the version
 * must stay ahead of the latest published release, and the environment
 * authorization gate must actually exist.
 */
export function verifyPromotion(input: VerifyPromotionInput): VerificationResult {
  const candidate = verifyCandidate(input);
  const problems = [...candidate.failures];

  if (input.tagTargetSha !== input.expected.sourceSha) {
    problems.push(
      `tag target ${input.tagTargetSha} does not match source ${input.expected.sourceSha}`,
    );
  }
  if (input.releaseExists) {
    problems.push(`release for v${input.expected.version} already exists`);
  }
  if (input.tagExists) {
    problems.push(`tag v${input.expected.version} already exists`);
  }
  if (input.latestExistingVersion !== undefined) {
    const comparison = compareStableVersions(input.expected.version, input.latestExistingVersion);
    if (comparison <= 0) {
      problems.push(
        `version ${input.expected.version} is not newer than the latest published ${input.latestExistingVersion}`,
      );
    }
  }
  if (!input.authorizationGateExists) {
    problems.push(
      `publication authorization gate (environment '${RELEASE_ENVIRONMENT}') is not configured with protection rules`,
    );
  }

  return failures(problems);
}

/** Plain `X.Y.Z` ordering; a non-version sorts lowest. */
export function compareStableVersions(left: string, right: string): number {
  const parse = (value: string): readonly [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Renders `sha256sum`-style checksums from a manifest's asset list. */
export function renderChecksums(assets: ReadonlyArray<ReleaseAsset>): string {
  return (
    assets
      .map((asset) => `${asset.sha256}  ${asset.name}`)
      .sort()
      .join("\n") + "\n"
  );
}
