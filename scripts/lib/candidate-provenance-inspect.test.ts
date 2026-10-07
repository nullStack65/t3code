// @effect-diagnostics nodeBuiltinImport:off - This test creates disposable synthetic files and a stub executable to verify the host-only DMG extraction boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { inspectCandidateProvenance } from "./candidate-provenance-inspect.ts";
import { verifyTargetPackagedProvenance } from "./fork-release-manifest.ts";

const VERSION = "0.0.44";
const SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";
const EXPECTED_RECORD = {
  repository: "nullStack65/t3code",
  sourceSha: SHA,
  version: VERSION,
  platform: "mac",
  arch: "x64",
};

it("leaves an unopenable nonnative DMG for digest-bound native inspection", () => {
  if (HostProcessPlatform.defaultValue() !== "linux") return;

  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mac-inspection-test-"));
  const tools = NodePath.join(root, "tools");
  const candidate = NodePath.join(root, "candidate");
  NodeFS.mkdirSync(tools);
  NodeFS.mkdirSync(candidate);
  const dmgName = `T3-Code-${VERSION}-x64.dmg`;
  const dmgPath = NodePath.join(candidate, dmgName);
  NodeFS.writeFileSync(dmgPath, "synthetic DMG bytes");

  // Force the non-native extraction attempt to fail without depending on a
  // runner's installed 7-Zip version or whether that build supports HFS.
  const sevenZip = NodePath.join(tools, "7z");
  const which = NodePath.join(tools, "which");
  NodeFS.writeFileSync(sevenZip, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  NodeFS.writeFileSync(
    which,
    `#!/bin/sh\nif [ "$1" = "7z" ]; then echo "${sevenZip}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}:${originalPath ?? ""}`;
  try {
    const inspection = inspectCandidateProvenance({
      candidateDir: candidate,
      version: VERSION,
      targets: "mac",
      includeMacosArm64: false,
    });
    assert.equal(inspection.provenance.macDmg, undefined);

    const observedAssets = [
      {
        name: dmgName,
        sha256: inspection.evidence.digests.macDmg!,
        size: NodeFS.statSync(dmgPath).size,
      },
    ];
    const evidence = {
      ...inspection.evidence,
      host: "darwin-x64",
      records: { macDmg: EXPECTED_RECORD },
      digests: { macDmg: inspection.evidence.digests.macDmg! },
    };
    const expected = { repository: "nullStack65/t3code", version: VERSION, sourceSha: SHA };

    const missingEvidence = verifyTargetPackagedProvenance({
      provenance: inspection.provenance,
      evidence: [],
      observedAssets,
      expected,
      targets: "mac",
      includeMacosArm64: false,
    });
    assert.equal(missingEvidence.ok, false);
    assert.match(
      missingEvidence.failures.join("\n"),
      /no digest-bound inspection evidence matched/,
    );

    const matched = verifyTargetPackagedProvenance({
      provenance: inspection.provenance,
      evidence: [evidence],
      observedAssets,
      expected,
      targets: "mac",
      includeMacosArm64: false,
    });
    assert.deepEqual(matched, { ok: true, failures: [] });

    const stale = verifyTargetPackagedProvenance({
      provenance: inspection.provenance,
      evidence: [{ ...evidence, digests: { macDmg: "f".repeat(64) } }],
      observedAssets,
      expected,
      targets: "mac",
      includeMacosArm64: false,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.failures.join("\n"), /inspection evidence is bound to digest/);

    const nativeUnreadable = verifyTargetPackagedProvenance({
      provenance: { macDmg: null },
      evidence: [evidence],
      observedAssets,
      expected,
      targets: "mac",
      includeMacosArm64: false,
    });
    assert.equal(nativeUnreadable.ok, false);
    assert.match(
      nativeUnreadable.failures.join("\n"),
      /Intel macOS DMG has no readable packaged provenance/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
