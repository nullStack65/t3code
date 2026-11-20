import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  shownFileKey,
  shownFileTargets,
  shownFilesToOpen,
  type ShownFileTarget,
} from "./shownFileOpen";

const SECRET = "SECRET_FILE_BYTES_9f3a";

describe("shownFileTargets", () => {
  it("opens from path, size, and type and drops file bytes", () => {
    const targets = shownFileTargets([
      {
        id: "show-1",
        kind: "work",
        createdAt: "2026-01-01T00:00:00.000Z",
        entry: {
          id: "show-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          label: "Show a file",
          tone: "tool",
          structuredPayload: {
            type: "dynamic_tool",
            status: "completed",
            completedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
            toolName: "show_file",
            output: {
              showFile: {
                path: "/tmp/answers.md",
                byteSize: 12,
                mediaType: "text/markdown",
                line: 3,
                contents: SECRET,
              },
              message: "Shown in the file viewer. Do not read or quote the file.",
            },
          },
        },
      } as never,
    ]);
    expect(targets).toEqual([
      { id: "show-1", path: "/tmp/answers.md", createdAt: "2026-01-01T00:00:00.000Z", line: 3 },
    ]);
    expect(JSON.stringify(targets)).not.toContain(SECRET);
  });
});

describe("shownFilesToOpen", () => {
  const files: ReadonlyArray<ShownFileTarget> = [
    { id: "show-1", path: "/tmp/answers.md", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "show-2", path: "/tmp/notes.md", createdAt: "2026-01-03T00:00:00.000Z", line: 2 },
  ];
  const nextKey = shownFileKey(files);

  it("does not open files already on screen, including after a thread change", () => {
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous: null,
        nextKey,
        files,
        entryCount: 2,
        latestCreatedAt: "2026-01-03T00:00:00.000Z",
      }).open,
    ).toEqual([]);
    const baseline = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey,
      files,
      entryCount: 2,
      latestCreatedAt: "2026-01-03T00:00:00.000Z",
    }).baseline;
    expect(
      shownFilesToOpen({
        threadKey: "env/other",
        previous: baseline,
        nextKey,
        files,
        entryCount: 2,
        latestCreatedAt: "2026-01-03T00:00:00.000Z",
      }).open,
    ).toEqual([]);
  });

  it("does not open history that arrives after an empty timeline", () => {
    const pending = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: "",
      files: [],
      entryCount: 0,
      latestCreatedAt: "",
    }).baseline;
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous: pending,
        nextKey,
        files,
        entryCount: 2,
        latestCreatedAt: "2026-01-03T00:00:00.000Z",
      }).open,
    ).toEqual([]);
  });

  it("does not open an older file that shows up after the thread is open", () => {
    const first = files.slice(0, 1);
    const previous = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: shownFileKey(first),
      files: first,
      entryCount: 1,
      latestCreatedAt: "2026-01-02T00:00:00.000Z",
    }).baseline;
    const older: ShownFileTarget = {
      id: "show-old",
      path: "/tmp/old.md",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous,
        nextKey: shownFileKey([older, ...first]),
        files: [older, ...first],
        entryCount: 2,
        latestCreatedAt: "2026-01-02T00:00:00.000Z",
      }).open,
    ).toEqual([]);
  });

  it("opens a file that completes in the same millisecond it started", () => {
    const sameTick = "2026-01-02T00:00:00.000Z";
    const running: ShownFileTarget = {
      id: "reasoning-1",
      path: "/tmp/unused.md",
      createdAt: sameTick,
    };
    const previous = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: shownFileKey([running]),
      files: [],
      entryCount: 1,
      latestCreatedAt: sameTick,
    }).baseline;
    const completed: ShownFileTarget = {
      id: "show-1",
      path: "/tmp/answers.md",
      createdAt: "2026-01-02T00:00:00.001Z",
    };
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous,
        nextKey: shownFileKey([completed]),
        files: [completed],
        entryCount: 1,
        latestCreatedAt: sameTick,
      }).open,
    ).toEqual([completed]);
  });

  it("opens a file that finishes after one which completed earlier, even though a row started later", () => {
    const first = files[0]!;
    const previous = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: shownFileKey([first]),
      files: [first],
      entryCount: 2,
      latestCreatedAt: first.createdAt,
    }).baseline;
    const slow: ShownFileTarget = {
      id: "show-slow",
      path: "/tmp/slow.md",
      createdAt: "2026-01-02T00:00:00.500Z",
    };
    expect(slow.createdAt > first.createdAt).toBe(true);
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous,
        nextKey: shownFileKey([first, slow]),
        files: [first, slow],
        entryCount: 3,
        latestCreatedAt: slow.createdAt,
      }).open,
    ).toEqual([slow]);
  });

  it("opens only a file that completed after the newest item already on screen", () => {
    const first = files.slice(0, 1);
    const previous = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: shownFileKey(first),
      files: first,
      entryCount: 1,
      latestCreatedAt: "2026-01-02T00:00:00.000Z",
    }).baseline;
    expect(
      shownFilesToOpen({
        threadKey: "env/thread",
        previous,
        nextKey,
        files,
        entryCount: 2,
        latestCreatedAt: "2026-01-03T00:00:00.000Z",
      }).open,
    ).toEqual([files[1]]);
  });
});
