import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  compareStableVersions,
  nextForkReleaseVersion,
  parseStableVersion,
  validateForkReleaseVersion,
} from "./fork-release-version.ts";

const ordering = (upstreamBase: string, existingForkVersions: readonly string[] = []) => ({
  upstreamBase,
  existingForkVersions,
});

it.effect("computes the first fork release above today's 0.0.42 install", () =>
  Effect.gen(function* () {
    assert.equal(yield* nextForkReleaseVersion(ordering("0.0.42")), "0.0.43");
  }),
);

it.effect("orders two fork releases on the same upstream version", () =>
  Effect.gen(function* () {
    const first = yield* nextForkReleaseVersion(ordering("0.0.42"));
    const second = yield* nextForkReleaseVersion(ordering("0.0.42", [first]));
    assert.equal(first, "0.0.43");
    assert.equal(second, "0.0.44");
  }),
);

it.effect("jumps above a later upstream base instead of colliding with it", () =>
  Effect.gen(function* () {
    // Fork is at 0.0.44; upstream then ships 0.0.45. The next fork release
    // must clear both, so it never downgrades a fork install back onto a
    // version number an upstream build also uses.
    assert.equal(yield* nextForkReleaseVersion(ordering("0.0.45", ["0.0.43", "0.0.44"])), "0.0.46");
  }),
);

it.effect("ignores malformed entries in the existing fork release list", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* nextForkReleaseVersion(
        ordering("0.0.42", ["", "0.0.43-preview.20260923.1", "0.0.44"]),
      ),
      "0.0.45",
    );
  }),
);

it.effect("reports a non-stable upstream base instead of guessing", () =>
  Effect.gen(function* () {
    const error = yield* nextForkReleaseVersion(ordering("0.0.42-nightly.20260923.1")).pipe(
      Effect.flip,
    );
    assert.equal(error._tag, "InvalidUpstreamBaseVersionError");
  }),
);

it("accepts a plain version newer than the base and every existing release", () => {
  assert.deepStrictEqual(
    validateForkReleaseVersion("0.0.45", ordering("0.0.42", ["0.0.43", "0.0.44"])),
    {
      ok: true,
    },
  );
});

it("rejects preview, nightly, and build-metadata versions", () => {
  for (const version of [
    "0.0.43-preview.20260923.1",
    "0.0.43-nightly.20260923.1",
    "0.0.43+fork.1",
  ]) {
    const verdict = validateForkReleaseVersion(version, ordering("0.0.42"));
    assert.equal(verdict.ok, false);
  }
});

it("rejects a downgrade against an existing fork release or the upstream base", () => {
  const existing = validateForkReleaseVersion("0.0.44", ordering("0.0.42", ["0.0.44"]));
  assert.equal(existing.ok, false);
  if (!existing.ok) {
    assert.include(existing.reason, "existing fork release 0.0.44");
  }

  const atBase = validateForkReleaseVersion("0.0.42", ordering("0.0.42"));
  assert.equal(atBase.ok, false);
  if (!atBase.ok) {
    assert.include(atBase.reason, "upstream base 0.0.42");
  }
});

it("parses and compares stable versions", () => {
  assert.deepStrictEqual(parseStableVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseStableVersion("1.2.3-rc.1"), undefined);
  assert.isBelow(compareStableVersions("0.0.42", "0.0.43"), 0);
  assert.isAbove(compareStableVersions("0.1.0", "0.0.99"), 0);
  assert.equal(compareStableVersions("1.0.0", "1.0.0"), 0);
});
