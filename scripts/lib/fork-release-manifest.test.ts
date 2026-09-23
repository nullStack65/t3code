import { assert, it } from "@effect/vitest";

import {
  CANDIDATE_ARTIFACT_NAME,
  RELEASE_ENVIRONMENT,
  compareStableVersions,
  renderChecksums,
  requiredReleaseAssetNames,
  verifyCandidate,
  verifyPromotion,
  type NativeReceipt,
  type ReleaseAsset,
  type ReleaseCandidateManifest,
} from "./fork-release-manifest.ts";

const VERSION = "0.0.43";
const SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";
const DISPATCH = "89369420870a3086051fb01462193c805ecc2aaa";

const assets: ReleaseAsset[] = requiredReleaseAssetNames(VERSION).map((name, index) => ({
  name,
  sha256: `${index}`.repeat(64).slice(0, 64),
  size: 100 + index,
}));

const receipts: NativeReceipt[] = [
  {
    schemaVersion: 1,
    owner: "W",
    target: "win32-x64",
    sourceSha: SHA,
    version: VERSION,
    assetName: `T3-Code-${VERSION}-x64.exe`,
    assetSha256: assets[0]!.sha256,
    result: "pass",
  },
  {
    schemaVersion: 1,
    owner: "M",
    target: "darwin-x64",
    sourceSha: SHA,
    version: VERSION,
    assetName: `T3-Code-${VERSION}-x64.dmg`,
    assetSha256: assets[1]!.sha256,
    result: "pass",
  },
];

const manifest: ReleaseCandidateManifest = {
  schemaVersion: 1,
  repository: "nullStack65/t3code",
  version: VERSION,
  sourceSha: SHA,
  workflowRevision: DISPATCH,
  workflowRunId: "123",
  workflowRunAttempt: "1",
  channel: "stable",
  createdAt: "2026-09-23T00:00:00.000Z",
  assets,
  nativeReceipts: receipts,
};

const expected = { repository: "nullStack65/t3code", version: VERSION, sourceSha: SHA };

it("requires the first-release target set", () => {
  assert.deepEqual(requiredReleaseAssetNames(VERSION), [
    `T3-Code-${VERSION}-x64.exe`,
    `T3-Code-${VERSION}-x64.dmg`,
    `t3-${VERSION}-linux-x64.tar.gz`,
    `t3-${VERSION}-win32-x64.zip`,
  ]);
  assert.include(
    requiredReleaseAssetNames(VERSION, { includeMacosArm64: true }),
    `T3-Code-${VERSION}-arm64.dmg`,
  );
  assert.equal(CANDIDATE_ARTIFACT_NAME, "fork-release-candidate");
  assert.equal(RELEASE_ENVIRONMENT, "fork-release");
});

it("accepts a complete, self-consistent candidate with receipts", () => {
  const result = verifyCandidate({
    manifest,
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
  });
  assert.deepEqual(result, { ok: true, failures: [] });
});

it("rejects a candidate whose source disagrees with the expected source", () => {
  const result = verifyCandidate({
    manifest: { ...manifest, sourceSha: DISPATCH },
    expected,
    observedAssets: assets,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /manifest sourceSha/);
});

it("rejects a missing, corrupt, or replaced asset", () => {
  const missing = verifyCandidate({
    manifest,
    expected,
    observedAssets: assets.slice(1),
  });
  assert.match(missing.failures.join("\n"), /required asset .*x64\.exe is missing/);

  const corrupt = verifyCandidate({
    manifest,
    expected,
    observedAssets: [{ ...assets[0]!, sha256: "f".repeat(64) }, ...assets.slice(1)],
  });
  assert.match(corrupt.failures.join("\n"), /sha256/);

  const replaced = verifyCandidate({
    manifest,
    expected,
    observedAssets: [{ ...assets[0]!, size: assets[0]!.size + 1 }, ...assets.slice(1)],
  });
  assert.match(replaced.failures.join("\n"), /size/);
});

it("rejects an extra unrecorded asset and a manifest entry with no file", () => {
  const extra = verifyCandidate({
    manifest,
    expected,
    observedAssets: [...assets, { name: "surprise.zip", sha256: "a".repeat(64), size: 1 }],
  });
  assert.match(extra.failures.join("\n"), /not recorded in the manifest/);

  const absent = verifyCandidate({
    manifest: {
      ...manifest,
      assets: [...assets, { name: "ghost.zip", sha256: "a".repeat(64), size: 1 }],
    },
    expected,
    observedAssets: assets,
  });
  assert.match(absent.failures.join("\n"), /ghost\.zip .*not present/);
});

it("rejects missing, wrong-source, and wrong-version native receipts", () => {
  const missing = verifyCandidate({
    manifest: { ...manifest, nativeReceipts: [] },
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
  });
  assert.match(missing.failures.join("\n"), /no native acceptance receipt for win32-x64/);

  const wrongSource = verifyCandidate({
    manifest: {
      ...manifest,
      nativeReceipts: receipts.map((receipt) => ({ ...receipt, sourceSha: DISPATCH })),
    },
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
  });
  assert.match(wrongSource.failures.join("\n"), /receipt .* is for source/);

  const wrongVersion = verifyCandidate({
    manifest: {
      ...manifest,
      nativeReceipts: receipts.map((receipt) => ({ ...receipt, version: "0.0.44" })),
    },
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
  });
  assert.match(wrongVersion.failures.join("\n"), /receipt .* is for version/);

  const failed = verifyCandidate({
    manifest: {
      ...manifest,
      nativeReceipts: receipts.map((receipt) => ({ ...receipt, result: "fail" as const })),
    },
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
  });
  assert.match(failed.failures.join("\n"), /no passing native acceptance receipt/);
});

it("promotion refuses overwrite, older versions, and a missing authorization gate", () => {
  const base = {
    manifest,
    expected,
    observedAssets: assets,
    requireNativeReceipts: true,
    tagTargetSha: SHA,
  };

  const good = verifyPromotion({
    ...base,
    releaseExists: false,
    tagExists: false,
    latestExistingVersion: "0.0.42",
    authorizationGateExists: true,
  });
  assert.deepEqual(good, { ok: true, failures: [] });

  const overwrite = verifyPromotion({
    ...base,
    releaseExists: true,
    tagExists: true,
    latestExistingVersion: "0.0.42",
    authorizationGateExists: true,
  });
  assert.match(overwrite.failures.join("\n"), /already exists/);

  const older = verifyPromotion({
    ...base,
    releaseExists: false,
    tagExists: false,
    latestExistingVersion: "0.0.44",
    authorizationGateExists: true,
  });
  assert.match(older.failures.join("\n"), /not newer than the latest published 0.0.44/);

  const noGate = verifyPromotion({
    ...base,
    releaseExists: false,
    tagExists: false,
    latestExistingVersion: "0.0.42",
    authorizationGateExists: false,
  });
  assert.match(noGate.failures.join("\n"), /authorization gate/);

  const wrongTarget = verifyPromotion({
    ...base,
    tagTargetSha: DISPATCH,
    releaseExists: false,
    tagExists: false,
    latestExistingVersion: "0.0.42",
    authorizationGateExists: true,
  });
  assert.match(wrongTarget.failures.join("\n"), /tag target/);
});

it("renders checksums and orders versions", () => {
  assert.equal(
    renderChecksums([
      { name: "b.zip", sha256: "b".repeat(64), size: 2 },
      { name: "a.zip", sha256: "a".repeat(64), size: 1 },
    ]),
    `${"a".repeat(64)}  a.zip\n${"b".repeat(64)}  b.zip\n`,
  );
  assert.isBelow(compareStableVersions("0.0.42", "0.0.43"), 0);
  assert.isAbove(compareStableVersions("1.0.0", "0.9.9"), 0);
});
