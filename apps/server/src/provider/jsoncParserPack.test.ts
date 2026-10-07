// @effect-diagnostics nodeBuiltinImport:off - The packaging regression must execute the emitted module from a disposable filesystem fixture.
import { assert, it } from "@effect/vitest";
import { build } from "vite-plus/pack";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { jsoncParserPackInputOptions } from "../../vite.config.ts";

it("starts a bundled JSONC parser and preserves comment/trailing-comma parsing", async () => {
  const workDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-jsonc-pack-"));
  const entry = NodePath.join(workDir, "entry.mjs");
  const outDir = NodePath.join(workDir, "out");

  try {
    await NodeFSP.writeFile(
      entry,
      `import { parse as parseJsonc } from "jsonc-parser";
const errors = [];
const parsed = parseJsonc('{ /* comment */ "provider": "codex", "args": ["--flag",], }', errors, { allowTrailingComma: true });
if (errors.length !== 0 || parsed.provider !== "codex" || parsed.args[0] !== "--flag") {
  throw new Error(JSON.stringify({ errors, parsed }));
}
const malformedErrors = [];
parseJsonc('{ "provider": }', malformedErrors);
if (malformedErrors.length === 0) throw new Error("Malformed JSONC was accepted");
export const jsoncBundleProbe = {
  provider: parsed.provider,
  argument: parsed.args[0],
  malformedErrorCount: malformedErrors.length,
  moduleUrl: import.meta.url,
};
console.log("JSONC_BUNDLE_OK", parsed.provider, parsed.args[0], malformedErrors.length);
`,
    );

    const result = await build({
      cwd: process.cwd(),
      entry,
      outDir,
      format: "esm",
      deps: { alwaysBundle: ["jsonc-parser"] },
      inputOptions: jsoncParserPackInputOptions,
    });
    const entryChunk = result.bundles.flatMap((bundle) => bundle.chunks)[0];
    assert(entryChunk, "The JSONC fixture should produce an entry bundle");
    const bundlePath = NodePath.join(outDir, entryChunk.fileName);
    const bundleSource = await NodeFSP.readFile(bundlePath, "utf8");

    assert(!bundleSource.includes('require("./impl/format")'));
    // Run the artifact with Node itself so the packaging regression exercises
    // the emitted module, not a transformed or mocked source import.
    const execution = NodeChildProcess.spawnSync(process.execPath, [bundlePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const spawnError = execution.error as NodeJS.ErrnoException | undefined;
    if (spawnError?.code === "EPERM") {
      // The managed test sandbox may prohibit child processes. Load the emitted
      // .mjs directly there; CI still gets the independent Node process above.
      const emittedModule = await import(NodeURL.pathToFileURL(bundlePath).href);
      assert.deepEqual(emittedModule.jsoncBundleProbe, {
        provider: "codex",
        argument: "--flag",
        malformedErrorCount: 1,
        moduleUrl: NodeURL.pathToFileURL(bundlePath).href,
      });
    } else {
      assert.equal(execution.status, 0, execution.stderr ?? execution.error?.message);
      assert(execution.stdout.includes("JSONC_BUNDLE_OK codex --flag 1"));
    }
  } finally {
    await NodeFSP.rm(workDir, { recursive: true, force: true });
  }
});
