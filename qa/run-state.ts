// @effect-diagnostics nodeBuiltinImport:off - Playwright's runner owns this process, outside the server's Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const STATE_DIR = NodePath.join(import.meta.dirname, ".state");
export const STATE_FILE = NodePath.join(STATE_DIR, "run.json");
export const AUTH_FILE = NodePath.join(STATE_DIR, "auth.json");

export interface RunState {
  readonly origin: string;
  /** `local` runs a throwaway app of this checkout; `remote` drives a deployment. */
  readonly mode: "local" | "remote";
  readonly environmentId: string;
  /** Seeded replay threads by key (local mode only). */
  readonly threads: Readonly<Record<string, string>>;
  readonly projectPath: string;
}

export const readRunState = (): RunState =>
  JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as RunState;
