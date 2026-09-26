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
import { requiredReleaseAssetNames } from "./fork-release-manifest.ts";

export interface GitHubPublicationProbe {
  readonly releaseExists: boolean;
  readonly tagExists: boolean;
  /** Comma-separated existing release versions, as the verifier expects. */
  readonly latestVersion: string | undefined;
  readonly authorizationGateReviewers: number;
  readonly onForkMain: boolean;
}

/**
 * Parses a `--preflight-json` fixture. Unknown/missing fields fall back to the
 * conservative value (conflict → true is deliberately not assumed: absence is
 * "not found", which the live probe also reports).
 */
export function parsePublicationProbe(raw: unknown): GitHubPublicationProbe {
  const value = (raw ?? {}) as Record<string, unknown>;
  const bool = (key: string): boolean => value[key] === true;
  const reviewers = value["authorizationGateReviewers"];
  return {
    releaseExists: bool("releaseExists"),
    tagExists: bool("tagExists"),
    latestVersion:
      typeof value["latestVersion"] === "string" ? (value["latestVersion"] as string) : undefined,
    authorizationGateReviewers:
      typeof reviewers === "number" && Number.isFinite(reviewers) ? reviewers : 0,
    onForkMain: bool("onForkMain"),
  };
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
  for (const asset of inventory.assets) {
    if (asset.size <= 0) {
      problems.push(`asset ${asset.name} is empty in release ${inventory.id}`);
    }
  }
  return problems;
}
