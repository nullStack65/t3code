import { assert, it } from "@effect/vitest";

import {
  parsePublicationProbe,
  parseRemoteReleaseInventory,
  promotionGateFailures,
  releaseInventoryFailures,
} from "./fork-promotion.ts";

const SHA = "929b63795e7696855ada61de5fd359dc2f51da78";
const DIGEST = "a".repeat(64);

it("parses a preflight fixture conservatively", () => {
  const probe = parsePublicationProbe({
    releaseExists: true,
    tagExists: false,
    latestVersion: "0.0.42,0.0.41",
    authorizationGateReviewers: 2,
    onForkMain: true,
  });
  assert.deepStrictEqual(probe, {
    releaseExists: true,
    tagExists: false,
    latestVersion: "0.0.42,0.0.41",
    authorizationGateReviewers: 2,
    onForkMain: true,
  });

  const empty = parsePublicationProbe(undefined);
  assert.equal(empty.releaseExists, false);
  assert.equal(empty.tagExists, false);
  assert.equal(empty.authorizationGateReviewers, 0);
  assert.equal(empty.latestVersion, undefined);
  assert.equal(empty.onForkMain, false);
});

it("blocks a candidate-only SHA from public publication", () => {
  const failures = promotionGateFailures({
    onForkMain: false,
    forkRemote: "fork",
    sourceSha: SHA,
    frozenManifestDigest: DIGEST,
    approvalDigest: DIGEST,
    execute: false,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /not an ancestor of fork\/main/);
});

it("requires candidate-specific approval only to execute", () => {
  const base = {
    onForkMain: true,
    forkRemote: "fork",
    sourceSha: SHA,
    frozenManifestDigest: DIGEST,
    execute: true,
  };
  assert.match(promotionGateFailures({ ...base, approvalDigest: undefined })[0]!, /--approve/);
  assert.match(
    promotionGateFailures({ ...base, approvalDigest: "b".repeat(64) })[0]!,
    /does not match/,
  );
  assert.deepStrictEqual(promotionGateFailures({ ...base, approvalDigest: DIGEST }), []);
  // A dry run reports readiness without an approval.
  assert.deepStrictEqual(
    promotionGateFailures({ ...base, execute: false, approvalDigest: undefined }),
    [],
  );
});

it("rejects the real R4 draft's incomplete asset inventory", () => {
  // Captured read-only from release 395230248 (draft, candidate-r4-v0.0.43-929b63795).
  const inventory = parseRemoteReleaseInventory({
    id: 395230248,
    tag_name: "candidate-r4-v0.0.43-929b63795",
    name: "R4 candidate staging — v0.0.43 @ 929b63795 (incomplete)",
    draft: true,
    target_commitish: SHA,
    assets: [
      { name: "t3-0.0.43-linux-x64.tar.gz", size: 64106782, state: "uploaded" },
      { name: "T3-Code-0.0.43-x64.dmg", size: 140516937, state: "uploaded" },
      { name: "fork-inspection-evidence-linux.json", size: 382, state: "uploaded" },
      { name: "fork-inspection-evidence-mac.json", size: 369, state: "uploaded" },
    ],
  });
  const failures = releaseInventoryFailures(inventory, "0.0.43");
  assert.equal(failures.length, 2);
  assert.match(failures.join("\n"), /T3-Code-0\.0\.43-x64\.exe is absent/);
  assert.match(failures.join("\n"), /t3-0\.0\.43-win32-x64\.zip is absent/);
});

it("accepts a complete remote asset inventory", () => {
  const inventory = parseRemoteReleaseInventory({
    id: 1,
    tag_name: "v0.0.43",
    draft: false,
    assets: [
      { name: "T3-Code-0.0.43-x64.exe", size: 1, state: "uploaded" },
      { name: "T3-Code-0.0.43-x64.dmg", size: 1, state: "uploaded" },
      { name: "t3-0.0.43-linux-x64.tar.gz", size: 1, state: "uploaded" },
      { name: "t3-0.0.43-win32-x64.zip", size: 1, state: "uploaded" },
    ],
  });
  assert.deepStrictEqual(releaseInventoryFailures(inventory, "0.0.43"), []);
});
