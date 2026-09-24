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
export const PACKAGED_INSPECTION_FILE_NAME = "fork-inspection-evidence.json";
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

export interface PackagedProvenanceRecord {
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}

/** The metadata the Windows `server.asar` sidecar actually records. */
export interface BundledServerRecord {
  readonly name: string;
  readonly version: string;
}

/**
 * Every packaged component whose provenance is inspected independently. The
 * Windows desktop application's own build info (`windowsDesktop`, read from
 * `resources/app.asar`) is deliberately distinct from the WSL runtime embedded
 * beside it (`embeddedWsl`, a Linux build) and from the bundled server sidecar
 * (`windowsServerBundle`). Conflating desktop and WSL provenance is what let a
 * wrong-source desktop pass on a correct WSL payload.
 */
export type PackagedProvenanceKey =
  | "windowsDesktop"
  | "windowsServerBundle"
  | "embeddedWsl"
  | "linuxArchive"
  | "windowsZip"
  | "macDmg"
  | "macArm64Dmg";

/**
 * The provenance actually observed inside the distributed artifacts.
 *
 * `undefined` means "not inspected" (the host or its extraction tool could not
 * read it), and an explicit `null` means "inspected and unreadable/absent".
 * Both are failures for a required component; neither may silently pass.
 */
export interface PackagedProvenance {
  readonly windowsDesktop?: PackagedProvenanceRecord | null | undefined;
  readonly windowsServerBundle?: BundledServerRecord | null | undefined;
  readonly embeddedWsl?: PackagedProvenanceRecord | null | undefined;
  readonly linuxArchive?: PackagedProvenanceRecord | null | undefined;
  readonly windowsZip?: PackagedProvenanceRecord | null | undefined;
  readonly macDmg?: PackagedProvenanceRecord | null | undefined;
  readonly macArm64Dmg?: PackagedProvenanceRecord | null | undefined;
  /** Byte-identity of the WSL archive embedded in the installer vs the Linux archive. */
  readonly embeddedWslEqualsStandalone?: boolean | undefined;
}

export const PACKAGED_PROVENANCE_LABELS: Record<PackagedProvenanceKey, string> = {
  windowsDesktop: "Windows desktop application",
  windowsServerBundle: "Windows bundled server",
  embeddedWsl: "Windows installer embedded WSL runtime",
  linuxArchive: "Linux runtime archive",
  windowsZip: "Windows CLI archive",
  macDmg: "Intel macOS DMG",
  macArm64Dmg: "Apple Silicon DMG",
};

/**
 * The `platform` string the writers actually record in `t3code-build-info.json`.
 *
 * This is the *packaging* vocabulary (`mac`/`win`/`linux`), not Node's runtime
 * vocabulary (`darwin`/`win32`/`linux`). Mapping it deliberately, rather than
 * guessing `darwin` for a DMG, is what makes the Intel DMG check meaningful.
 */
export const PACKAGED_PLATFORM: Partial<Record<PackagedProvenanceKey, string>> = {
  windowsDesktop: "win",
  embeddedWsl: "linux",
  windowsZip: "win",
  linuxArchive: "linux",
  macDmg: "mac",
  macArm64Dmg: "mac",
};

/** The architecture string the writers record per packaged component. */
export const PACKAGED_ARCH: Partial<Record<PackagedProvenanceKey, string>> = {
  windowsDesktop: "x64",
  embeddedWsl: "x64",
  windowsZip: "x64",
  linuxArchive: "x64",
  macDmg: "x64",
  macArm64Dmg: "arm64",
};

export interface ProvenanceArtifactAvailability {
  readonly hasWindowsInstaller: boolean;
  readonly hasMacDmg: boolean;
  readonly hasLinuxArchive: boolean;
  readonly hasWindowsZip: boolean;
  readonly hasMacArm64Dmg: boolean;
}

/** The release asset a packaged component's provenance is read from. */
export function provenanceArtifactName(key: PackagedProvenanceKey, version: string): string {
  switch (key) {
    case "windowsDesktop":
    case "windowsServerBundle":
    case "embeddedWsl":
      return `T3-Code-${version}-x64.exe`;
    case "windowsZip":
      return `t3-${version}-win32-x64.zip`;
    case "linuxArchive":
      return `t3-${version}-linux-x64.tar.gz`;
    case "macDmg":
      return `T3-Code-${version}-x64.dmg`;
    case "macArm64Dmg":
      return `T3-Code-${version}-arm64.dmg`;
  }
}

/**
 * Pure decision table for which packaged components MUST carry inspected
 * provenance for a target selection, given which artifacts are actually present.
 * A missing record for one of these keys is a failure, never a silent skip.
 */
export function requiredProvenanceKeysForSelection(input: {
  readonly targets: CandidateTargetSelection;
  readonly artifacts: ProvenanceArtifactAvailability;
  readonly includeMacosArm64: boolean;
}): ReadonlyArray<PackagedProvenanceKey> {
  const wanted: PackagedProvenanceKey[] = [];
  const wantsAll = input.targets === "all";
  if ((wantsAll || input.targets === "win") && input.artifacts.hasWindowsInstaller) {
    wanted.push("windowsDesktop", "windowsServerBundle", "embeddedWsl");
  }
  if ((wantsAll || input.targets === "win") && input.artifacts.hasWindowsZip) {
    wanted.push("windowsZip");
  }
  if ((wantsAll || input.targets === "linux") && input.artifacts.hasLinuxArchive) {
    wanted.push("linuxArchive");
  }
  if ((wantsAll || input.targets === "mac") && input.artifacts.hasMacDmg) {
    wanted.push("macDmg");
  }
  if (
    (wantsAll || input.targets === "mac") &&
    input.includeMacosArm64 &&
    input.artifacts.hasMacArm64Dmg
  ) {
    wanted.push("macArm64Dmg");
  }
  return wanted;
}

/** Derives artifact availability from the assets actually observed on disk. */
export function provenanceAvailabilityFromAssets(
  version: string,
  observedAssets: ReadonlyArray<ReleaseAsset>,
): ProvenanceArtifactAvailability {
  const names = new Set(observedAssets.map((asset) => asset.name));
  return {
    hasWindowsInstaller: names.has(`T3-Code-${version}-x64.exe`),
    hasMacDmg: names.has(`T3-Code-${version}-x64.dmg`),
    hasLinuxArchive: names.has(`t3-${version}-linux-x64.tar.gz`),
    hasWindowsZip: names.has(`t3-${version}-win32-x64.zip`),
    hasMacArm64Dmg: names.has(`T3-Code-${version}-arm64.dmg`),
  };
}

/**
 * A native inspection a different machine performed, bound to the exact
 * artifact digest it read. This is the existing evidence mechanism the aggregate
 * may consume instead of re-inspecting an artifact it cannot open; it is not a
 * signing service, and a digest mismatch simply makes the record unusable.
 */
export interface PackagedInspectionEvidence {
  readonly schemaVersion: 1;
  readonly host: string;
  readonly records: Partial<Record<PackagedProvenanceKey, PackagedInspectionRecord>>;
  readonly digests: Partial<Record<PackagedProvenanceKey, string>>;
  readonly embeddedWslEqualsStandalone?: boolean;
}

/** A component record as read by an inspector: build info, server metadata, absent, or not inspected. */
export type PackagedInspectionRecord =
  | PackagedProvenanceRecord
  | BundledServerRecord
  | null
  | undefined;

export interface MergePackagedInspectionInput {
  readonly provenance: PackagedProvenance;
  readonly evidence: ReadonlyArray<PackagedInspectionEvidence | undefined>;
  readonly observedAssets: ReadonlyArray<ReleaseAsset>;
  readonly version: string;
  readonly requiredKeys: ReadonlyArray<PackagedProvenanceKey>;
}

export interface MergePackagedInspectionResult {
  readonly provenance: PackagedProvenance;
  readonly problems: ReadonlyArray<string>;
}

/**
 * Fills components the local host could not inspect from digest-bound evidence,
 * and reports a problem when a required component is neither inspected locally
 * nor covered by evidence for the artifact's exact bytes. This is what stops
 * changed bytes after inspection from reusing an old passing inspection.
 */
export function mergePackagedInspection(
  input: MergePackagedInspectionInput,
): MergePackagedInspectionResult {
  const merged: Record<string, unknown> = { ...input.provenance };
  const problems: string[] = [];
  const observed = new Map(input.observedAssets.map((asset) => [asset.name, asset]));

  for (const key of input.requiredKeys) {
    if (merged[key] !== undefined) continue; // Already inspected locally.
    const label = PACKAGED_PROVENANCE_LABELS[key];
    const artifactName = provenanceArtifactName(key, input.version);
    const artifact = observed.get(artifactName);
    if (artifact === undefined) {
      problems.push(`${label} provenance was not inspected and ${artifactName} is absent`);
      continue;
    }
    let found = false;
    for (const evidence of input.evidence) {
      if (evidence === undefined) continue;
      const record = evidence.records[key];
      if (record === undefined) continue;
      const boundDigest = evidence.digests[key];
      if (boundDigest?.toLowerCase() !== artifact.sha256.toLowerCase()) {
        problems.push(
          `${label} inspection evidence is bound to digest ${boundDigest ?? "none"}, but ${artifactName} is ${artifact.sha256}`,
        );
        continue;
      }
      merged[key] = record;
      if (key === "embeddedWsl" && evidence.embeddedWslEqualsStandalone !== undefined) {
        merged.embeddedWslEqualsStandalone = evidence.embeddedWslEqualsStandalone;
      }
      found = true;
      break;
    }
    if (!found) {
      problems.push(
        `${label} provenance is required but was not inspected and no digest-bound inspection evidence matched ${artifactName}`,
      );
    }
  }
  return { provenance: merged as PackagedProvenance, problems };
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
  /**
   * Digest-bound inspections performed on another machine, usable for a
   * component this host could not open. Only consumed when it matches the
   * observed artifact digest exactly.
   */
  readonly inspectionEvidence?: ReadonlyArray<PackagedInspectionEvidence | undefined>;
  /**
   * When true, every packaged component of the selected target(s) whose artifact
   * is present must have a completed inspection (locally or via digest-bound
   * evidence). A missing/unreadable/unperformed required inspection fails.
   */
  readonly requirePackagedProvenance?: boolean;
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

  if (input.requirePackagedProvenance === true) {
    const requiredKeys = requiredProvenanceKeysForSelection({
      targets,
      artifacts: provenanceAvailabilityFromAssets(expected.version, input.observedAssets),
      includeMacosArm64: input.includeMacosArm64 === true,
    });
    const suppliedEvidence = input.inspectionEvidence ?? [];
    if (input.packagedProvenance === undefined && suppliedEvidence.length === 0) {
      problems.push(
        "packaged provenance inspection is required but no inspection and no evidence were supplied",
      );
    } else {
      const merged = mergePackagedInspection({
        provenance: input.packagedProvenance ?? {},
        evidence: suppliedEvidence,
        observedAssets: input.observedAssets,
        version: expected.version,
        requiredKeys,
      });
      problems.push(...merged.problems);
      verifyPackagedProvenance({
        problems,
        provenance: merged.provenance,
        expected,
        targets,
        includeMacosArm64: input.includeMacosArm64 === true,
        requiredKeys,
      });
    }
  } else if (input.packagedProvenance !== undefined) {
    verifyPackagedProvenance({
      problems,
      provenance: input.packagedProvenance,
      expected,
      targets,
      includeMacosArm64: input.includeMacosArm64 === true,
      requiredKeys: [],
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

/**
 * Requires inspected provenance to name the same repository/source/version/
 * platform/architecture for every packaged component.
 *
 * A record of `undefined` for a `requiredKeys` entry is a failure: the
 * inspection was required but did not happen (missing tool, unsupported host,
 * or a skipped step). `null` is "inspected and unreadable". The platform string
 * is mapped through `PACKAGED_PLATFORM` because the writers use the packaging
 * vocabulary (`mac`), not Node's runtime vocabulary (`darwin`).
 */
export function verifyPackagedProvenance(input: {
  readonly problems: string[];
  readonly provenance: PackagedProvenance;
  readonly expected: CandidateExpectations;
  readonly targets: CandidateTargetSelection;
  readonly includeMacosArm64: boolean;
  readonly requiredKeys: ReadonlyArray<PackagedProvenanceKey>;
}): void {
  const { problems, provenance, expected, targets, requiredKeys } = input;
  const required = new Set(requiredKeys);
  const recordChecks: ReadonlyArray<
    readonly [PackagedProvenanceKey, PackagedProvenanceRecord | null | undefined]
  > = [
    ["windowsDesktop", provenance.windowsDesktop],
    ["embeddedWsl", provenance.embeddedWsl],
    ["windowsZip", provenance.windowsZip],
    ["linuxArchive", provenance.linuxArchive],
    ["macDmg", provenance.macDmg],
    ["macArm64Dmg", provenance.macArm64Dmg],
  ];
  for (const [key, record] of recordChecks) {
    const label = PACKAGED_PROVENANCE_LABELS[key];
    if (record === undefined) {
      if (required.has(key)) {
        problems.push(`${label} provenance was required but was not inspected`);
      }
      continue;
    }
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
    const platform = PACKAGED_PLATFORM[key];
    if (platform !== undefined && record.platform !== platform) {
      problems.push(`${label} provenance platform is ${record.platform}, expected ${platform}`);
    }
    const arch = PACKAGED_ARCH[key];
    if (arch !== undefined && record.arch !== arch) {
      problems.push(`${label} provenance arch is ${record.arch}, expected ${arch}`);
    }
  }

  // The bundled server sidecar records name+version only (no repository/SHA).
  const serverLabel = PACKAGED_PROVENANCE_LABELS.windowsServerBundle;
  if (provenance.windowsServerBundle !== undefined) {
    const server = provenance.windowsServerBundle;
    if (server === null) {
      problems.push(`${serverLabel} has no readable packaged metadata`);
    } else {
      if (server.name !== "t3code-server") {
        problems.push(`${serverLabel} name is ${server.name}, expected t3code-server`);
      }
      if (server.version !== expected.version) {
        problems.push(`${serverLabel} version is ${server.version}, expected ${expected.version}`);
      }
    }
  } else if (required.has("windowsServerBundle")) {
    problems.push(`${serverLabel} provenance was required but was not inspected`);
  }

  if (targets === "all" && provenance.embeddedWslEqualsStandalone === false) {
    problems.push(
      "the WSL runtime embedded in the Windows installer is not byte-identical to the standalone Linux archive",
    );
  }
  if (
    targets === "all" &&
    required.has("embeddedWsl") &&
    required.has("linuxArchive") &&
    provenance.embeddedWslEqualsStandalone === undefined
  ) {
    problems.push(
      "the Windows installer was inspected but its embedded WSL runtime was not compared to the standalone Linux archive",
    );
  }
}

/**
 * Per-target packaged-provenance verification for a host that is building one
 * platform before the aggregate exists. It requires only that platform's own
 * components, and accepts digest-bound evidence for any it cannot open.
 */
export function verifyTargetPackagedProvenance(input: {
  readonly provenance: PackagedProvenance;
  readonly evidence: ReadonlyArray<PackagedInspectionEvidence | undefined>;
  readonly observedAssets: ReadonlyArray<ReleaseAsset>;
  readonly expected: CandidateExpectations;
  readonly targets: CandidateTargetSelection;
  readonly includeMacosArm64: boolean;
}): VerificationResult {
  const problems: string[] = [];
  const requiredKeys = requiredProvenanceKeysForSelection({
    targets: input.targets,
    artifacts: provenanceAvailabilityFromAssets(input.expected.version, input.observedAssets),
    includeMacosArm64: input.includeMacosArm64,
  });
  const merged = mergePackagedInspection({
    provenance: input.provenance,
    evidence: input.evidence,
    observedAssets: input.observedAssets,
    version: input.expected.version,
    requiredKeys,
  });
  problems.push(...merged.problems);
  verifyPackagedProvenance({
    problems,
    provenance: merged.provenance,
    expected: input.expected,
    targets: input.targets,
    includeMacosArm64: input.includeMacosArm64,
    requiredKeys,
  });
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
  // Promotion must not qualify bytes that were never inspected: it either
  // re-inspects the downloaded artifacts or consumes digest-bound evidence.
  const candidate = verifyCandidate({
    ...input,
    targets: "all",
    requirePackagedProvenance: input.requirePackagedProvenance ?? true,
  });
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
