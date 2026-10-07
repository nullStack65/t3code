import { assert, it } from "@effect/vitest";

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
} from "./fork-promotion.ts";

const SHA = "929b63795e7696855ada61de5fd359dc2f51da78";
const DIGEST = "a".repeat(64);

it("parses a preflight fixture conservatively and derives read states", () => {
  const probe = parsePublicationProbe({
    releaseExists: true,
    tagExists: false,
    latestVersion: "0.0.42,0.0.41",
    authorizationGateReviewers: 2,
    onForkMain: true,
  });
  assert.equal(probe.releaseExists, true);
  assert.equal(probe.releaseRead, "present");
  assert.equal(probe.tagExists, false);
  assert.equal(probe.tagRead, "absent");
  assert.equal(probe.latestVersion, "0.0.42,0.0.41");
  assert.equal(probe.latestRead, "present");
  assert.equal(probe.authorizationGateReviewers, 2);
  assert.equal(probe.authorizationGateRead, "present");
  assert.equal(probe.onForkMain, true);
  assert.equal(probe.onForkMainRead, "present");

  const empty = parsePublicationProbe(undefined);
  assert.equal(empty.releaseExists, false);
  assert.equal(empty.releaseRead, "absent");
  assert.equal(empty.tagRead, "absent");
  assert.equal(empty.authorizationGateReviewers, 0);
  assert.equal(empty.latestVersion, undefined);
  assert.equal(empty.latestRead, "absent");
  assert.equal(empty.onForkMain, false);
  assert.equal(empty.onForkMainRead, "absent");
});

it("treats a failed read as unresolved, never as absence", () => {
  const probe = parsePublicationProbe({
    releaseRead: "unresolved",
    tagRead: "absent",
    latestRead: "unresolved",
    authorizationGateRead: "unresolved",
    onForkMainRead: "unresolved",
  });
  const failures = publicationProbeFailures(probe);
  assert.equal(failures.length, 4);
  assert.match(failures.join("\n"), /release lookup/);
  assert.match(failures.join("\n"), /existing-release list/);
  assert.match(failures.join("\n"), /authorization environment lookup/);
  assert.match(failures.join("\n"), /fork-main lookup/);
  assert.notMatch(failures.join("\n"), /tag lookup/);
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

it("parses checksum text and requires coverage of every distributed asset", () => {
  const checksums = parseChecksumsFile(
    [
      `${"1".repeat(64)}  t3-0.0.43-linux-x64.tar.gz`,
      `${"2".repeat(64)} *t3-0.0.43-win32-x64.zip`,
    ].join("\n") + "\n",
  );
  assert.equal(checksums.get("t3-0.0.43-linux-x64.tar.gz"), "1".repeat(64));
  assert.equal(checksums.get("t3-0.0.43-win32-x64.zip"), "2".repeat(64));

  const failures = checksumCoverageFailures(checksums, [
    { name: "t3-0.0.43-linux-x64.tar.gz", sha256: "1".repeat(64) },
    { name: "t3-0.0.43-win32-x64.zip", sha256: "3".repeat(64) },
    { name: "T3-Code-0.0.43-x64.exe", sha256: "4".repeat(64) },
  ]);
  assert.equal(failures.length, 2);
  assert.match(failures.join("\n"), /digest for t3-0\.0\.43-win32-x64\.zip/);
  assert.match(failures.join("\n"), /does not list T3-Code-0\.0\.43-x64\.exe/);
});

it("requires SHA256SUMS and the frozen manifest to publish", () => {
  const missing = publicationMetadataFailures({ hasChecksums: false, hasManifest: false });
  assert.equal(missing.length, 2);
  assert.match(missing.join("\n"), /SHA256SUMS/);
  assert.match(missing.join("\n"), /fork-release-manifest\.json/);
  assert.deepStrictEqual(
    publicationMetadataFailures({ hasChecksums: true, hasManifest: true }),
    [],
  );
});

it("detects a partial upload or an unenumerated asset on readback", () => {
  const expected = [
    { name: "a.bin", size: 3 },
    { name: "b.bin", size: 4 },
  ];
  const missing = parseRemoteReleaseInventory({
    id: 7,
    tag_name: "v0.0.43",
    assets: [{ name: "a.bin", size: 3, state: "uploaded" }],
  });
  const failures = uploadReadbackFailures(missing, expected);
  assert.match(failures.join("\n"), /uploaded asset b\.bin is missing/);

  const wrongSize = parseRemoteReleaseInventory({
    id: 7,
    tag_name: "v0.0.43",
    assets: [
      { name: "a.bin", size: 3, state: "uploaded" },
      { name: "b.bin", size: 9, state: "uploaded" },
    ],
  });
  assert.match(uploadReadbackFailures(wrongSize, expected).join("\n"), /is 9 bytes on GitHub/);

  const extra = parseRemoteReleaseInventory({
    id: 7,
    tag_name: "v0.0.43",
    assets: [
      { name: "a.bin", size: 3, state: "uploaded" },
      { name: "b.bin", size: 4, state: "uploaded" },
      { name: "terminal-history.txt", size: 1, state: "uploaded" },
    ],
  });
  assert.match(
    uploadReadbackFailures(extra, expected).join("\n"),
    /unexpected asset terminal-history\.txt/,
  );
});

it("rejects the real R4 draft's incomplete inventory and missing metadata", () => {
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
      { name: "SHA256SUMS-mac.txt", size: 89, state: "uploaded" },
      { name: "pty-terminal.png", size: 304444, state: "uploaded" },
      { name: "terminal-history.txt", size: 333, state: "uploaded" },
      { name: "stage4-report.json", size: 1714, state: "uploaded" },
    ],
  });
  const failures = releaseInventoryFailures(inventory, "0.0.43");
  assert.match(failures.join("\n"), /T3-Code-0\.0\.43-x64\.exe is absent/);
  assert.match(failures.join("\n"), /t3-0\.0\.43-win32-x64\.zip is absent/);
  assert.match(failures.join("\n"), /required metadata SHA256SUMS is absent/);
  assert.match(failures.join("\n"), /required metadata fork-release-manifest\.json is absent/);
});

it("accepts a complete remote asset inventory with metadata", () => {
  const inventory = parseRemoteReleaseInventory({
    id: 1,
    tag_name: "v0.0.43",
    draft: false,
    assets: [
      { name: "T3-Code-0.0.43-x64.exe", size: 1, state: "uploaded" },
      { name: "T3-Code-0.0.43-x64.dmg", size: 1, state: "uploaded" },
      { name: "t3-0.0.43-linux-x64.tar.gz", size: 1, state: "uploaded" },
      { name: "t3-0.0.43-win32-x64.zip", size: 1, state: "uploaded" },
      { name: "SHA256SUMS", size: 1, state: "uploaded" },
      { name: "fork-release-manifest.json", size: 1, state: "uploaded" },
    ],
  });
  assert.deepStrictEqual(releaseInventoryFailures(inventory, "0.0.43"), []);
});

it("parses the camelCase gh release view shape distinctly from REST", () => {
  const view = parseGhReleaseViewInventory({
    id: 4242,
    tagName: "v0.0.43",
    name: "T3 Code (fork) v0.0.43",
    isDraft: false,
    targetCommitish: SHA,
    assets: [{ name: "a.bin", size: 3, state: "uploaded" }],
  });
  assert.equal(view.id, 4242);
  assert.equal(view.tagName, "v0.0.43");
  assert.equal(view.isDraft, false);
  assert.equal(view.draft, false);
  assert.equal(view.targetCommitish, SHA);
  assert.equal(view.assets[0]!.name, "a.bin");

  // A REST snake_case object is not silently treated as a release view response.
  const restAsView = parseGhReleaseViewInventory({ tag_name: "v0.0.43", draft: false });
  assert.equal(restAsView.tagName, "");
  assert.equal(restAsView.isDraft, undefined);
  assert.equal(restAsView.draft, false);
});

it("fails the final confirmation on missing, non-boolean, wrong-tag or draft responses", () => {
  const complete = {
    id: 1,
    tagName: "v0.0.43",
    name: "x",
    targetCommitish: SHA,
    assets: [{ name: "a.bin", size: 3, state: "uploaded" }],
  };
  assert.deepStrictEqual(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: false }),
      "v0.0.43",
    ),
    [],
  );
  assert.match(
    finalReleaseConfirmationFailures(parseGhReleaseViewInventory(complete), "v0.0.43").join("\n"),
    /explicit boolean isDraft=false/,
  );
  assert.match(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: "true" }),
      "v0.0.43",
    ).join("\n"),
    /explicit boolean isDraft=false/,
  );
  assert.match(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: true }),
      "v0.0.43",
    ).join("\n"),
    /still a draft/,
  );
  assert.match(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: false, tagName: "vWRONG" }),
      "v0.0.43",
    ).join("\n"),
    /expected 'v0\.0\.43'/,
  );
  // Expected source identity is enforced when supplied.
  assert.match(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: false, targetCommitish: "f".repeat(40) }),
      "v0.0.43",
      SHA,
    ).join("\n"),
    /target commitish/,
  );
  assert.deepStrictEqual(
    finalReleaseConfirmationFailures(
      parseGhReleaseViewInventory({ ...complete, isDraft: false }),
      "v0.0.43",
      SHA,
    ),
    [],
  );
});

it("requires acceptance evidence to be in the enumerated publication payload", () => {
  const candidateDir = "/tmp/candidate";
  const published = [
    "/tmp/candidate/fork-inspection-evidence.json",
    "/tmp/candidate/fork-native-receipts.json",
  ];
  assert.deepStrictEqual(
    evidenceLayoutFailures({
      candidateDir,
      nativeReceipts: "/tmp/candidate/fork-native-receipts.json",
      inspectionEvidence: ["/tmp/candidate/fork-inspection-evidence.json"],
      publishedFiles: published,
    }),
    [],
  );
  const external = evidenceLayoutFailures({
    candidateDir,
    nativeReceipts: "/tmp/elsewhere/receipts.json",
    inspectionEvidence: ["/tmp/elsewhere/evidence.json"],
    publishedFiles: published,
  });
  assert.equal(external.length, 2);
  assert.match(external.join("\n"), /--inspection-evidence .* not part of the publication payload/);
  assert.match(external.join("\n"), /--native-receipts .* not part of the publication payload/);
});
