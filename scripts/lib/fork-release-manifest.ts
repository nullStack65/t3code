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
 * Two correctness rules drive the shape of this module:
 *
 *  1. Every required native *target* (Windows x64, Intel macOS x64, Linux x64)
 *     is bound to the actual artifact(s) it is responsible for. A receipt that
 *     names the wrong artifact is rejected even if its result is `pass`.
 *  2. Acceptance requires an unambiguous passing result per target. A
 *     conflicting `fail` receipt for a target makes the candidate unqualified;
 *     no PASS is allowed to win over a FAIL.
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

/**
 * The exact artifact(s) each required native target must accept. A receipt for
 * `win32-x64` names the Windows installer, not (say) the Linux tarball; this is
 * what makes "both receipts named the Linux tarball" a rejected candidate.
 *
 * Rule 1 of the module header: a target is bound to its own artifact.
 */
export function nativeTargetAssetNames(target: string, version: string): ReadonlyArray<string> {
  if (target === "win32-x64") return [`T3-Code-${version}-x64.exe`];
  if (target === "darwin-x64") return [`T3-Code-${version}-x64.dmg`];
  if (target === "linux-x64") return [`t3-${version}-linux-x64.tar.gz`];
  if (target === "darwin-arm64") return [`T3-Code-${version}-arm64.dmg`];
  return [];
}

/** Which of `all`/`linux`/`win`/`mac` targets an invocation covers. */
export type CandidateTargetSelection = "all" | "linux" | "win" | "mac";

/** The required assets for a target selection (subset during per-target builds). */
export function requiredReleaseAssetNamesForTargets(
  version: string,
  targets: CandidateTargetSelection,
  options: { readonly includeMacosArm64?: boolean } = {},
): ReadonlyArray<string> {
  if (targets === "all") {
    return requiredReleaseAssetNames(version, options);
  }
  if (targets === "linux") return [`t3-${version}-linux-x64.tar.gz`];
  if (targets === "win") {
    return [`T3-Code-${version}-x64.exe`, `t3-${version}-win32-x64.zip`];
  }
  const names = [`T3-Code-${version}-x64.dmg`];
  if (options.includeMacosArm64 === true) names.push(`T3-Code-${version}-arm64.dmg`);
  return names;
}

/** The native targets whose receipts a target selection requires. */
export function requiredNativeTargetsForSelection(
  targets: CandidateTargetSelection,
): ReadonlyArray<string> {
  if (targets === "all") return [...REQUIRED_NATIVE_TARGETS];
  if (targets === "win") return ["win32-x64"];
  if (targets === "mac") return ["darwin-x64"];
  return [];
}

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

/**
 * The provenance actually observed inside the distributed artifacts.
 *
 * `undefined` means "not inspected" (for example during promotion, where the
 * artifacts are re-downloaded but the packaged-provenance extraction happened
 * at qualify time). An explicit `null` means "inspected and absent", which is a
 * failure for a required artifact.
 */
export interface PackagedProvenance {
  readonly windowsInstaller?: PackagedProvenanceRecord | null;
  readonly linuxArchive?: PackagedProvenanceRecord | null;
  readonly windowsZip?: PackagedProvenanceRecord | null;
  readonly macDmg?: PackagedProvenanceRecord | null;
  readonly macArm64Dmg?: PackagedProvenanceRecord | null;
  /** Byte-identity of the WSL archive embedded in the installer vs the Linux archive. */
  readonly embeddedWslEqualsStandalone?: boolean;
}

export interface PackagedProvenanceRecord {
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}

export interface InspectProvenanceInput {
  readonly version: string;
  readonly targets: CandidateTargetSelection;
  readonly artifacts: {
    readonly hasWindowsInstaller: boolean;
    readonly hasMacDmg: boolean;
    readonly hasLinuxArchive: boolean;
    readonly hasWindowsZip: boolean;
    readonly hasMacArm64Dmg: boolean;
  };
}

/**
 * Pure decision table for which artifacts must carry inspected provenance for a
 * target selection. The impure extraction (unpacking tarballs/zip/NSIS) lives
 * in the caller; this function only says what must be verified.
 */
export function provenanceArtifactsForSelection(
  input: InspectProvenanceInput,
): ReadonlyArray<"windowsInstaller" | "linuxArchive" | "windowsZip" | "macDmg" | "macArm64Dmg"> {
  const wanted: Array<
    "windowsInstaller" | "linuxArchive" | "windowsZip" | "macDmg" | "macArm64Dmg"
  > = [];
  const wantsAll = input.targets === "all";
  if ((wantsAll || input.targets === "win") && input.artifacts.hasWindowsInstaller) {
    wanted.push("windowsInstaller");
    wanted.push("windowsZip");
  }
  if ((wantsAll || input.targets === "linux") && input.artifacts.hasLinuxArchive) {
    wanted.push("linuxArchive");
  }
  if ((wantsAll || input.targets === "mac") && input.artifacts.hasMacDmg) {
    wanted.push("macDmg");
  }
  if ((wantsAll || input.targets === "mac") && input.artifacts.hasMacArm64Dmg) {
    wanted.push("macArm64Dmg");
  }
  return wanted;
}

/**
 * Thin wrapper the CLI uses: it does not extract bytes itself (that needs real
 * archives on disk), so it returns an empty inspection and lets the separate
 * `verify-windows-installer.ts` / archive extraction steps supply the records.
 * Kept for interface stability; the CLI merges real records in.
 */
export function inspectCandidateProvenance(input: InspectProvenanceInput): PackagedProvenance {
  void input;
  return {};
}

export interface VerifyCandidateInput {
  readonly manifest: ReleaseCandidateManifest;
  readonly expected: CandidateExpectations;
  /** Observed `sha256` and byte size for each file actually present. */
  readonly observedAssets: ReadonlyArray<ReleaseAsset>;
  readonly includeMacosArm64?: boolean;
  readonly targets?: CandidateTargetSelection;
  readonly requireNativeReceipts?: boolean;
  /** Provenance read from the actual packaged bytes, when it was inspected. */
  readonly packagedProvenance?: PackagedProvenance | undefined;
}

/**
 * Verifies a candidate's manifest against the bytes on disk and the expected
 * source. Every required asset must be present with a matching digest, the
 * manifest must not disagree with the expected source, and each native receipt
 * must bind to the same source, the right artifact for its target, and the same
 * asset digest. Conflicting or ambiguous acceptance is rejected.
 */
export function verifyCandidate(input: VerifyCandidateInput): VerificationResult {
  const problems: string[] = [];
  const { manifest, expected } = input;
  const targets: CandidateTargetSelection = input.targets ?? "all";

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
  const required = requiredReleaseAssetNamesForTargets(expected.version, targets, {
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

  verifyReceipts({
    problems,
    receipts: manifest.nativeReceipts,
    expected,
    manifestAssets,
    targets,
    requireNativeReceipts: input.requireNativeReceipts === true,
    includeMacosArm64: input.includeMacosArm64 === true,
  });

  if (input.packagedProvenance !== undefined) {
    verifyPackagedProvenance({
      problems,
      provenance: input.packagedProvenance,
      expected,
      targets,
      includeMacosArm64: input.includeMacosArm64 === true,
    });
  }

  return failures(problems);
}

/**
 * Binds every receipt to its target's actual artifact, to the candidate source
 * and version, and to the observed digest. Then requires exactly one
 * unambiguous verdict per required target: at least one `pass`, and no `fail`.
 */
export function verifyReceipts(input: {
  readonly problems: string[];
  readonly receipts: ReadonlyArray<NativeReceipt>;
  readonly expected: CandidateExpectations;
  readonly manifestAssets: ReadonlyMap<string, ReleaseAsset>;
  readonly targets: CandidateTargetSelection;
  readonly requireNativeReceipts: boolean;
  readonly includeMacosArm64: boolean;
}): void {
  const {
    problems,
    receipts,
    expected,
    manifestAssets,
    targets,
    requireNativeReceipts,
    includeMacosArm64,
  } = input;

  const allowedTargets = new Set<string>([
    ...requiredNativeTargetsForSelection(targets),
    ...(targets === "all" || targets === "mac" ? ["linux-x64"] : []),
    ...(includeMacosArm64 && (targets === "all" || targets === "mac") ? ["darwin-arm64"] : []),
  ]);

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
    if (receipt.target !== "" && !allowedTargets.has(receipt.target) && targets !== "all") {
      problems.push(`receipt names target ${receipt.target}, which this build did not produce`);
    }

    // Rule 1: a target may only accept the artifact(s) it owns. A Windows
    // receipt naming the Linux tarball is wrong-target evidence, not a pass.
    const owned = nativeTargetAssetNames(receipt.target, expected.version);
    if (owned.length > 0 && !owned.includes(receipt.assetName)) {
      problems.push(
        `receipt for ${receipt.target} names ${receipt.assetName}, but that target must accept ${owned.join(" or ")}`,
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

  if (!requireNativeReceipts) return;

  const requiredTargets = [
    ...requiredNativeTargetsForSelection(targets),
    ...(includeMacosArm64 && targets === "all" ? ["darwin-arm64"] : []),
  ];
  for (const target of requiredTargets) {
    const matching = receipts.filter((receipt) => receipt.target === target);
    if (matching.length === 0) {
      problems.push(`no native acceptance receipt for ${target}`);
      continue;
    }
    // Rule 2: ambiguity and conflict both fail closed. A FAIL for the target
    // is disqualifying even when a PASS also exists.
    const passes = matching.filter((receipt) => receipt.result === "pass");
    const fails = matching.filter((receipt) => receipt.result === "fail");
    if (fails.length > 0) {
      problems.push(
        `native acceptance for ${target} is conflicting: ${fails.length} fail receipt(s) and ${passes.length} pass receipt(s)`,
      );
      continue;
    }
    if (passes.length === 0) {
      problems.push(`no passing native acceptance receipt for ${target}`);
      continue;
    }
    const distinctAssets = new Set(passes.map((receipt) => receipt.assetName));
    if (distinctAssets.size > 1) {
      problems.push(
        `native acceptance for ${target} is ambiguous: passes name ${[...distinctAssets].join(", ")}`,
      );
    }
    if (distinctAssets.size === 1) {
      const assetName = [...distinctAssets][0]!;
      const owned = nativeTargetAssetNames(target, expected.version);
      if (owned.length > 0 && !owned.includes(assetName)) {
        problems.push(
          `native acceptance for ${target} accepted ${assetName}, but that target owns ${owned.join(" or ")}`,
        );
      }
    }
  }
}

/** Requires inspected provenance to name the same repository/source/version/platform. */
export function verifyPackagedProvenance(input: {
  readonly problems: string[];
  readonly provenance: PackagedProvenance;
  readonly expected: CandidateExpectations;
  readonly targets: CandidateTargetSelection;
  readonly includeMacosArm64: boolean;
}): void {
  const { problems, provenance, expected, targets, includeMacosArm64 } = input;
  const wantsOptional = targets === "all" && includeMacosArm64;
  const checks: Array<[string, PackagedProvenanceRecord | null | undefined, string, string]> = [
    ["Windows installer", provenance.windowsInstaller, "win", "x64"],
    ["Windows CLI archive", provenance.windowsZip, "win", "x64"],
    ["Linux runtime archive", provenance.linuxArchive, "linux", "x64"],
    ["Intel macOS DMG", provenance.macDmg, "darwin", "x64"],
  ];
  if (wantsOptional) {
    checks.push(["Apple Silicon DMG", provenance.macArm64Dmg, "darwin", "arm64"]);
  }
  // Only enforced when the WSL payload was actually inspected. `undefined`
  // means the caller did not extract it (for example a pure manifest check).
  if (targets === "all" && provenance.embeddedWslEqualsStandalone === false) {
    problems.push(
      "the WSL runtime embedded in the Windows installer is not byte-identical to the standalone Linux archive",
    );
  }
  if (
    targets === "all" &&
    provenance.windowsInstaller !== undefined &&
    provenance.linuxArchive !== undefined &&
    provenance.embeddedWslEqualsStandalone === undefined
  ) {
    problems.push(
      "the Windows installer was inspected but its embedded WSL runtime was not compared to the standalone Linux archive",
    );
  }
  for (const [label, record, platform, arch] of checks) {
    if (record === undefined) continue; // Not inspected in this invocation.
    if (record === null) {
      problems.push(`${label} has no readable packaged provenance`);
      continue;
    }
    if (record.repository !== expected.repository) {
      problems.push(`${label} provenance repository is ${record.repository}`);
    }
    if (record.sourceSha !== expected.sourceSha) {
      problems.push(`${label} provenance sourceSha is ${record.sourceSha}`);
    }
    if (record.version !== expected.version) {
      problems.push(`${label} provenance version is ${record.version}`);
    }
    if (record.platform !== platform) {
      problems.push(`${label} provenance platform is ${record.platform}, expected ${platform}`);
    }
    if (record.arch !== arch) {
      problems.push(`${label} provenance arch is ${record.arch}, expected ${arch}`);
    }
  }
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
  const candidate = verifyCandidate({ ...input, targets: "all", packagedProvenance: undefined });
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
      `publication authorization gate (environment '${RELEASE_ENVIRONMENT}') is not configured with required reviewers`,
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
