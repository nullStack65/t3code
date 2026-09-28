#!/usr/bin/env node
/**
 * Fork release versioning.
 *
 * The fork publishes its own GitHub Releases, so its versions must sort
 * strictly above everything already published on the fork and above the
 * upstream base the build came from. A plain `X.Y.Z` line does that: SemVer
 * build metadata is ignored when ordering, and a prerelease identifier such as
 * `-preview` sorts *below* the matching release, so neither can be the update
 * mechanism. Fork releases are therefore plain `X.Y.Z`, and each one is
 * `bumpPatch(max(upstreamBase, every existing fork release))`.
 *
 *   upstream base 0.0.42, no fork release yet      -> 0.0.43
 *   upstream base 0.0.42, fork 0.0.43 exists       -> 0.0.44
 *   upstream base 0.0.45, fork 0.0.44 exists       -> 0.0.46
 *
 * Preview and nightly identifiers are rejected outright: a fork preview build
 * is a manual download and must never be discoverable as an update.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export interface ForkVersionOrdering {
  readonly upstreamBase: string;
  readonly existingForkVersions: readonly string[];
}

export class InvalidUpstreamBaseVersionError extends Schema.TaggedError<InvalidUpstreamBaseVersionError>()(
  "InvalidUpstreamBaseVersionError",
  { version: Schema.String },
) {
  override get message(): string {
    return `Upstream base version '${this.version}' is not a plain X.Y.Z version.`;
  }
}

export class InvalidForkReleaseVersionError extends Schema.TaggedError<InvalidForkReleaseVersionError>()(
  "InvalidForkReleaseVersionError",
  { version: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Fork release version '${this.version}' is not acceptable: ${this.reason}.`;
  }
}

export interface ParsedStableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseStableVersion(version: string): ParsedStableVersion | undefined {
  const match = STABLE_VERSION_PATTERN.exec(version.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatStableVersion(version: ParsedStableVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** Ordering for plain X.Y.Z versions; a non-version sorts lowest. */
export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const bumpPatch = (version: ParsedStableVersion): ParsedStableVersion => ({
  major: version.major,
  minor: version.minor,
  patch: version.patch + 1,
});

const validExisting = (versions: readonly string[]): string[] =>
  versions
    .map((version) => version.trim())
    .filter((version) => parseStableVersion(version) !== undefined);

/**
 * The next fork release version: one patch above the highest of the upstream
 * base and every existing fork release. Returns a failure for a base that is
 * not plain `X.Y.Z`.
 */
export const nextForkReleaseVersion = (input: ForkVersionOrdering) =>
  Effect.gen(function* () {
    const base = parseStableVersion(input.upstreamBase);
    if (base === undefined) {
      return yield* new InvalidUpstreamBaseVersionError({ version: input.upstreamBase });
    }
    const highest = validExisting(input.existingForkVersions).reduce(
      (winner, candidate) => (compareStableVersions(candidate, winner) > 0 ? candidate : winner),
      formatStableVersion(base),
    );
    const highestParsed = parseStableVersion(highest);
    if (highestParsed === undefined) {
      return yield* new InvalidUpstreamBaseVersionError({ version: input.upstreamBase });
    }
    return formatStableVersion(bumpPatch(highestParsed));
  });

/**
 * Rejects a version the fork must not publish: a prerelease/build identifier
 * (preview or nightly), one at or below an existing fork release, or one at or
 * below the upstream base it was built from.
 */
export function validateForkReleaseVersion(
  version: string,
  input: ForkVersionOrdering,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (parseStableVersion(version) === undefined) {
    return {
      ok: false,
      reason: "must be a plain X.Y.Z version with no prerelease or build identifier",
    };
  }
  if (parseStableVersion(input.upstreamBase) === undefined) {
    return {
      ok: false,
      reason: `upstream base '${input.upstreamBase}' is not a plain X.Y.Z version`,
    };
  }
  if (compareStableVersions(version, input.upstreamBase) <= 0) {
    return { ok: false, reason: `must be newer than the upstream base ${input.upstreamBase}` };
  }
  const conflicting = validExisting(input.existingForkVersions).find(
    (existing) => compareStableVersions(version, existing) <= 0,
  );
  if (conflicting !== undefined) {
    return { ok: false, reason: `must be newer than the existing fork release ${conflicting}` };
  }
  return { ok: true };
}

const parseExisting = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const command = Command.make(
  "fork-release-version",
  {
    upstreamBase: Flag.String("upstream-base").pipe(
      Flag.withDescription("Upstream stable version the fork build is based on, e.g. 0.0.42."),
    ),
    existing: Flag.String("existing").pipe(
      Flag.withDescription("Comma-separated versions already published on the fork."),
      Flag.optional,
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription("Version to validate. Omit to compute the next one."),
      Flag.optional,
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Append version=<value> to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ upstreamBase, existing, version, githubOutput }) =>
    Effect.gen(function* () {
      const ordering: ForkVersionOrdering = {
        upstreamBase,
        existingForkVersions: parseExisting(Option.getOrUndefined(existing)),
      };
      const requested = Option.getOrUndefined(version)?.trim();
      let resolved: string;
      if (requested === undefined || requested === "") {
        resolved = yield* nextForkReleaseVersion(ordering);
      } else {
        const verdict = validateForkReleaseVersion(requested, ordering);
        if (!verdict.ok) {
          return yield* new InvalidForkReleaseVersionError({
            version: requested,
            reason: verdict.reason,
          });
        }
        resolved = requested;
      }

      if (githubOutput) {
        const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(outputPath, `version=${resolved}\n`, { flag: "a" });
      } else {
        yield* Console.log(`version=${resolved}`);
      }
    }),
).pipe(Command.withDescription("Compute or validate a fork release version."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
