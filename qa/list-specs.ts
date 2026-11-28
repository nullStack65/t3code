// @effect-diagnostics nodeBuiltinImport:off - a plain Node script, outside the server's Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export interface SpecEntry {
  readonly id: string;
  readonly file: string;
}

interface Suite {
  readonly file?: string;
  readonly suites?: ReadonlyArray<Suite>;
  readonly specs?: ReadonlyArray<{
    readonly file: string;
    readonly tests: ReadonlyArray<{
      readonly annotations: ReadonlyArray<{ readonly type: string; readonly description?: string }>;
    }>;
  }>;
}

/** The feature ids Playwright actually registers, so loop-built specs count. No app is started. */
export const listSpecs = (): ReadonlyArray<SpecEntry> => {
  const out = NodeChildProcess.execFileSync(
    NodePath.join(import.meta.dirname, "node_modules/.bin/playwright"),
    ["test", "--list", "--reporter=json", "--project=desktop-light"],
    {
      cwd: import.meta.dirname,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, T3_QA_LIST: "1" },
    },
  );
  const found = new Map<string, string>();
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const id = test.annotations.find(
          (annotation) => annotation.type === "feature",
        )?.description;
        if (id !== undefined) found.set(id, spec.file);
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(out) as { suites: ReadonlyArray<Suite> }).suites) walk(suite);
  return [...found].map(([id, file]) => ({ id, file }));
};
