import { showFileFromToolItem } from "@t3tools/shared/toolOutput";

import type { TimelineEntry } from "../../session-logic";

export interface ShownFileTarget {
  readonly id: string;
  readonly path: string;
  readonly line?: number;
}

export function shownFileTargets(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<ShownFileTarget> {
  const targets: ShownFileTarget[] = [];
  for (const entry of entries) {
    if (entry.kind !== "work") continue;
    const item = entry.entry.structuredPayload;
    if (item?.type !== "dynamic_tool" || item.status !== "completed") continue;
    const shown = showFileFromToolItem(item);
    if (shown === undefined) continue;
    targets.push({
      id: entry.id,
      path: shown.path,
      ...(shown.line === undefined ? {} : { line: shown.line }),
    });
  }
  return targets;
}

export function shownFileKey(files: ReadonlyArray<ShownFileTarget>): string {
  return files.map((file) => `${file.id}\t${file.path}\t${file.line ?? ""}`).join("\n");
}

export function shownFilesToOpen(input: {
  readonly threadKey: string;
  readonly previous: string | null;
  readonly nextKey: string;
  readonly files: ReadonlyArray<ShownFileTarget>;
}): { readonly baseline: string; readonly open: ReadonlyArray<ShownFileTarget> } {
  const baseline = `${input.threadKey}\n${input.nextKey}`;
  if (input.previous === null || !input.previous.startsWith(`${input.threadKey}\n`)) {
    return { baseline, open: [] };
  }
  if (input.previous === baseline) return { baseline, open: [] };
  const seen = new Set(
    input.previous
      .slice(input.threadKey.length + 1)
      .split("\n")
      .filter((row) => row.length > 0)
      .map((row) => row.slice(0, row.indexOf("\t"))),
  );
  return { baseline, open: input.files.filter((file) => !seen.has(file.id)) };
}
