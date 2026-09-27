#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Pure decision helpers for the local/draft promotion handoff.
/**
 * Pure decisions for taking a locally frozen candidate to publication without a
 * CI run. The byte-level checks live in `verify-fork-candidate.ts --promote`;
 * this module adds only the gates a local handoff must add on top:
 *
 *   - fork-main eligibility (a candidate-mode PR head is not promotable);
 *   - candidate-specific approval bound to the frozen manifest digest;
 *   - an existing release's required-asset completeness.
 *
 * Keeping these pure lets the entry point exercise them against labeled
 * fixtures while its live path stays read-only until `--execute`.
 */
import {
  CANDIDATE_MANIFEST_FILE_NAME,
  SHA256SUMS_FILE_NAME,
  requiredReleaseAssetNames,
} from "./fork-release-manifest.ts";

/**
 * The outcome of one live GitHub read. `unresolved` is deliberately distinct
 * from `absent`: a failed read (auth, permission, network, rate limit, malformed
 * response) is not evidence that no release/tag/version/job exists, so it must
 * block publication rather than masquerade as a clean preflight.
 */
export type ProbeReadState = "present" | "absent" | "unresolved";

export interface GitHubPublicationProbe {
  readonly releaseExists: boolean;
  readonly releaseRead: ProbeReadState;
  readonly tagExists: boolean;
  readonly tagRead: ProbeReadState;
  /** Comma-separated existing release versions, as the verifier expects. */
  readonly latestVersion: string | undefined;
  readonly latestRead: ProbeReadState;
  readonly authorizationGateReviewers: number;
  readonly authorizationGateRead: ProbeReadState;
  readonly onForkMain: boolean;
  readonly onForkMainRead: ProbeReadState;
}

/**
 * Parses a `--preflight-json` fixture. A fixture may set the explicit
 * `*Read` field to exercise failed reads; when it only sets the legacy boolean,
 * `true` is `present` and `false` is a **confirmed** `absent`, matching what a
 * clean live probe reports. `unresolved` is never inferred from a boolean.
 */
export function parsePublicationProbe(raw: unknown): GitHubPublicationProbe {
  const value = (raw ?? {}) as Record<string, unknown>;
  const bool = (key: string): boolean => value[key] === true;
  const readState = (key: string, fallback: ProbeReadState): ProbeReadState => {
    const candidate = value[key];
    return candidate === "present" || candidate === "absent" || candidate === "unresolved"
      ? candidate
      : fallback;
  };
  const reviewers = value["authorizationGateReviewers"];
  const latestVersion =
    typeof value["latestVersion"] === "string" ? (value["latestVersion"] as string) : undefined;
  const releaseRead = readState("releaseRead", bool("releaseExists") ? "present" : "absent");
  const tagRead = readState("tagRead", bool("tagExists") ? "present" : "absent");
  const latestRead = readState("latestRead", latestVersion === undefined ? "absent" : "present");
  const gateReviewers = typeof reviewers === "number" && Number.isFinite(reviewers) ? reviewers : 0;
  const authorizationGateRead = readState(
    "authorizationGateRead",
    gateReviewers > 0 ? "present" : "absent",
  );
  const onForkMainRead = readState("onForkMainRead", bool("onForkMain") ? "present" : "absent");
  return {
    releaseExists: releaseRead === "present",
    releaseRead,
    tagExists: tagRead === "present",
    tagRead,
    latestVersion,
    latestRead,
    authorizationGateReviewers: gateReviewers,
    authorizationGateRead,
    onForkMain: onForkMainRead === "present",
    onForkMainRead,
  };
}

/** Fails when any live read could not be resolved, rather than treating it as absence. */
export function publicationProbeFailures(probe: GitHubPublicationProbe): ReadonlyArray<string> {
  const problems: string[] = [];
  const check = (label: string, state: ProbeReadState): void => {
    if (state === "unresolved") {
      problems.push(
        `${label} could not be read from GitHub; a failed read is not evidence that it does not exist`,
      );
    }
  };
  check("the release lookup", probe.releaseRead);
  check("the tag lookup", probe.tagRead);
  check("the existing-release list", probe.latestRead);
  check("the authorization environment lookup", probe.authorizationGateRead);
  check("the fork-main lookup", probe.onForkMainRead);
  return problems;
}

/**
 * Parses `sha256sum`-style checksum text (hex, optional `*` binary marker) into a
 * name → digest map. Used to prove a *downloaded* `SHA256SUMS` still validates
 * the downloaded runtime.
 */
export function parseChecksumsFile(text: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null) map.set(match[2]!, match[1]!.toLowerCase());
  }
  return map;
}

/** Requires `SHA256SUMS` to list every distributed asset with its exact digest. */
export function checksumCoverageFailures(
  checksums: ReadonlyMap<string, string>,
  expected: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const asset of expected) {
    const recorded = checksums.get(asset.name);
    if (recorded === undefined) {
      problems.push(`${SHA256SUMS_FILE_NAME} does not list ${asset.name}`);
    } else if (recorded !== asset.sha256.toLowerCase()) {
      problems.push(
        `${SHA256SUMS_FILE_NAME} digest for ${asset.name} is ${recorded}, expected ${asset.sha256}`,
      );
    }
  }
  return problems;
}

/**
 * Metadata that must accompany the distributed assets. It is deliberately not
 * itself checksummed by `SHA256SUMS` (that would be a self-referential cycle);
 * the frozen manifest is the approval digest and `SHA256SUMS` covers the runtime
 * artifacts only.
 */
export function publicationMetadataFailures(input: {
  readonly hasChecksums: boolean;
  readonly hasManifest: boolean;
}): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!input.hasChecksums) {
    problems.push(
      `${SHA256SUMS_FILE_NAME} is required to publish: installers verify the downloaded runtime against it`,
    );
  }
  if (!input.hasManifest) {
    problems.push(
      `${CANDIDATE_MANIFEST_FILE_NAME} is required to publish: it records the source, version and accepted digests`,
    );
  }
  return problems;
}

export interface UploadedAssetExpectation {
  readonly name: string;
  readonly size: number;
}

/**
 * Verifies the remote inventory after upload against the exact local payload:
 * every expected file present at the exact size and in `uploaded` state, and no
 * unexpected file (so a wildcard cannot silently add screenshots or logs).
 */
export function uploadReadbackFailures(
  inventory: RemoteReleaseInventory,
  expected: ReadonlyArray<UploadedAssetExpectation>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const byName = new Map(inventory.assets.map((asset) => [asset.name, asset]));
  for (const want of expected) {
    const got = byName.get(want.name);
    if (got === undefined) {
      problems.push(`uploaded asset ${want.name} is missing from release ${inventory.id}`);
      continue;
    }
    if (got.state !== "uploaded") {
      problems.push(`uploaded asset ${want.name} is in state '${got.state}', not 'uploaded'`);
    }
    if (got.size !== want.size) {
      problems.push(
        `uploaded asset ${want.name} is ${got.size} bytes on GitHub, local file is ${want.size}`,
      );
    }
  }
  const expectedNames = new Set(expected.map((entry) => entry.name));
  for (const asset of inventory.assets) {
    if (!expectedNames.has(asset.name)) {
      problems.push(
        `release ${inventory.id} carries unexpected asset ${asset.name}; publication must not add unenumerated files`,
      );
    }
  }
  return problems;
}

export interface PromotionGateInput {
  readonly onForkMain: boolean;
  readonly forkRemote: string;
  readonly sourceSha: string;
  readonly frozenManifestDigest: string;
  readonly approvalDigest: string | undefined;
  readonly execute: boolean;
}

/**
 * The gates that are not already enforced by the promotion verifier. Approval is
 * required only to *execute*: a dry run reports readiness without one, but the
 * digest is candidate-specific so a generic `--execute` cannot publish.
 */
export function promotionGateFailures(input: PromotionGateInput): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!input.onForkMain) {
    problems.push(
      `source ${input.sourceSha} is not an ancestor of ${input.forkRemote}/main; public publication requires fork-main eligibility and candidate-mode PR heads are not promotable`,
    );
  }
  if (input.execute) {
    const approval = input.approvalDigest?.trim().toLowerCase();
    if (approval === undefined || approval === "") {
      problems.push(
        `--execute requires --approve <frozen manifest sha256> (${input.frozenManifestDigest})`,
      );
    } else if (approval !== input.frozenManifestDigest.trim().toLowerCase()) {
      problems.push(
        `--approve digest ${approval} does not match the frozen candidate manifest digest ${input.frozenManifestDigest}`,
      );
    }
  }
  return problems;
}

export interface RemoteReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly state: string;
}

export interface RemoteReleaseInventory {
  readonly id: number;
  readonly tagName: string;
  readonly name: string;
  readonly draft: boolean;
  readonly targetCommitish: string;
  readonly assets: ReadonlyArray<RemoteReleaseAsset>;
}

/** Maps a raw `gh api repos/<repo>/releases/<id>` response to the fields used. */
export function parseRemoteReleaseInventory(raw: unknown): RemoteReleaseInventory {
  const value = (raw ?? {}) as Record<string, unknown>;
  const assets = Array.isArray(value["assets"]) ? (value["assets"] as unknown[]) : [];
  return {
    id: typeof value["id"] === "number" ? (value["id"] as number) : 0,
    tagName: typeof value["tag_name"] === "string" ? (value["tag_name"] as string) : "",
    name: typeof value["name"] === "string" ? (value["name"] as string) : "",
    draft: value["draft"] === true,
    targetCommitish:
      typeof value["target_commitish"] === "string" ? (value["target_commitish"] as string) : "",
    assets: assets.map((entry) => {
      const asset = (entry ?? {}) as Record<string, unknown>;
      return {
        name: typeof asset["name"] === "string" ? (asset["name"] as string) : "",
        size: typeof asset["size"] === "number" ? (asset["size"] as number) : 0,
        state: typeof asset["state"] === "string" ? (asset["state"] as string) : "",
      };
    }),
  };
}

/**
 * Whether an already-existing release carries the complete required asset set
 * for a version. Used to exercise the real incomplete draft as a negative case
 * without any writes; a missing required asset is the failure.
 */
export function releaseInventoryFailures(
  inventory: RemoteReleaseInventory,
  version: string,
  options: { readonly includeMacosArm64?: boolean } = {},
): ReadonlyArray<string> {
  const present = new Set(inventory.assets.map((asset) => asset.name));
  const problems: string[] = [];
  for (const name of requiredReleaseAssetNames(version, {
    includeMacosArm64: options.includeMacosArm64 === true,
  })) {
    if (!present.has(name)) {
      problems.push(`required asset ${name} is absent from release ${inventory.id}`);
    }
  }
  for (const name of [SHA256SUMS_FILE_NAME, CANDIDATE_MANIFEST_FILE_NAME]) {
    if (!present.has(name)) {
      problems.push(`required metadata ${name} is absent from release ${inventory.id}`);
    }
  }
  for (const asset of inventory.assets) {
    if (asset.size <= 0) {
      problems.push(`asset ${asset.name} is empty in release ${inventory.id}`);
    }
  }
  return problems;
}
