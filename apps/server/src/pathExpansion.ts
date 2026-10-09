// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { effectiveHomeDirectory } from "@t3tools/shared/isolationRoot";

import type * as Path from "effect/Path";

/**
 * Expand a leading `~` (or `~/…`, `~\…`) in a user-supplied path to the
 * current user's home directory. Spawned processes don't get shell
 * expansion, so env vars like `CODEX_HOME=~/.codex-work` would be passed
 * verbatim and treated as relative paths by the receiver.
 *
 * Matches the behavior of the other `expandHomePath` helpers in the
 * workspace layers and CLI bootstrap: `~` alone and both `~/` and `~\`
 * separators are handled. Returns the input unchanged if it doesn't
 * start with `~` or is empty. Does not handle `~user` (other-user)
 * expansion.
 */
export function expandHomePath(value: string): string {
  return expandHomePathFrom(value, effectiveHomeDirectory(process.env, []));
}

/** Pure expansion form for callers that already hold an explicitly selected home directory. */
export function expandHomePathFrom(value: string, homeDirectory: string): string {
  if (!value) return value;
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(homeDirectory, value.slice(2));
  }
  return value;
}

/**
 * Same expansion as `expandHomePath`, but joins with a caller-supplied
 * `Path.Path` service instead of `node:path`. Use this inside Effect code that
 * already has `Path.Path` in context so the platform layer stays in control of
 * separator handling.
 */
export function expandHomePathWith(value: string, path: Path.Path): string {
  return expandHomePathFromWith(value, effectiveHomeDirectory(process.env, []), path);
}

export function expandHomePathFromWith(
  value: string,
  homeDirectory: string,
  path: Path.Path,
): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}
