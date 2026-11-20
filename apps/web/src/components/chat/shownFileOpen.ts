import * as DateTime from "effect/DateTime";
import { showFileFromToolItem } from "@t3tools/shared/toolOutput";

import type { TimelineEntry } from "../../session-logic";

export interface ShownFileTarget {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
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
      createdAt:
        item.completedAt === null || item.completedAt === undefined
          ? entry.createdAt
          : DateTime.formatIso(item.completedAt),
      ...(shown.line === undefined ? {} : { line: shown.line }),
    });
  }
  return targets;
}

export function latestTimelineCreatedAt(entries: ReadonlyArray<{ createdAt: string }>): string {
  let latest = "";
  for (const entry of entries) {
    if (entry.createdAt > latest) latest = entry.createdAt;
  }
  return latest;
}

export function shownFileKey(files: ReadonlyArray<ShownFileTarget>): string {
  return files
    .map((file) => `${file.id}\t${file.path}\t${file.line ?? ""}\t${file.createdAt}`)
    .join("\n");
}

export function shownFilesToOpen(input: {
  readonly threadKey: string;
  readonly previous: string | null;
  readonly nextKey: string;
  readonly files: ReadonlyArray<ShownFileTarget>;
  readonly entryCount: number;
  readonly latestCreatedAt: string;
}): { readonly baseline: string; readonly open: ReadonlyArray<ShownFileTarget> } {
  const pending = `${input.threadKey}\n`;
  if (input.entryCount === 0) return { baseline: pending, open: [] };
  const ready = `${input.threadKey}\n${input.latestCreatedAt}\n${input.nextKey}`;
  if (
    input.previous === null ||
    input.previous === pending ||
    !input.previous.startsWith(`${input.threadKey}\n`)
  ) {
    return { baseline: ready, open: [] };
  }
  const first = input.threadKey.length;
  const second = input.previous.indexOf("\n", first + 1);
  if (second === -1) return { baseline: ready, open: [] };
  const watermark = input.previous.slice(first + 1, second);
  const seen = new Set(
    input.previous
      .slice(second + 1)
      .split("\n")
      .filter((row) => row.length > 0)
      .map((row) => row.slice(0, row.indexOf("\t"))),
  );
  return {
    baseline: ready,
    open: input.files.filter((file) => !seen.has(file.id) && file.createdAt > watermark),
  };
}
