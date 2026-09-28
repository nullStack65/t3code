import { assert, it } from "@effect/vitest";

import { verifyEmbeddedWslRuntime, type EmbeddedBuildInfo } from "./wsl-payload.ts";

const SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";
const VERSION = "0.0.43";
const expected = {
  repository: "nullStack65/t3code",
  sourceSha: SHA,
  version: VERSION,
  arch: "x64",
};

const info: EmbeddedBuildInfo = {
  repository: "nullStack65/t3code",
  sourceSha: SHA,
  version: VERSION,
  platform: "linux",
  arch: "x64",
};

const bytes = new TextEncoder().encode("runtime-archive-bytes");

it("accepts an embedded runtime identical to the standalone archive", () => {
  const result = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: info,
    standaloneInfo: info,
    expected,
  });
  assert.deepEqual(result, { ok: true, failures: [] });
});

it("rejects an embedded runtime that is not byte-identical to the standalone archive", () => {
  const result = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: new TextEncoder().encode("a different archive"),
    embeddedInfo: info,
    standaloneInfo: info,
    expected,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /does not equal the standalone Linux archive/);
});

it("rejects wrong-source, wrong-arch, and wrong-version embedded provenance", () => {
  const wrongSource = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: { ...info, sourceSha: "a".repeat(40) },
    standaloneInfo: info,
    expected,
  });
  assert.match(wrongSource.failures.join("\n"), /sourceSha/);

  const wrongArch = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: { ...info, arch: "arm64" },
    standaloneInfo: info,
    expected,
  });
  assert.match(wrongArch.failures.join("\n"), /arch/);

  const wrongVersion = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: { ...info, version: "0.0.42" },
    standaloneInfo: info,
    expected,
  });
  assert.match(wrongVersion.failures.join("\n"), /version/);
});

it("rejects a missing embedded archive or provenance file", () => {
  const missingArchive = verifyEmbeddedWslRuntime({
    embeddedArchive: undefined,
    standaloneArchive: bytes,
    embeddedInfo: info,
    standaloneInfo: info,
    expected,
  });
  assert.match(missingArchive.failures.join("\n"), /no embedded WSL runtime archive/);

  const missingInfo = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: undefined,
    standaloneInfo: info,
    expected,
  });
  assert.match(missingInfo.failures.join("\n"), /no t3code-build-info\.json/);
});

it("rejects provenance that differs from the standalone archive", () => {
  const result = verifyEmbeddedWslRuntime({
    embeddedArchive: bytes,
    standaloneArchive: bytes,
    embeddedInfo: { ...info, repository: "someone/else" },
    standaloneInfo: info,
    expected,
  });
  assert.match(result.failures.join("\n"), /provenance differs/);
});
