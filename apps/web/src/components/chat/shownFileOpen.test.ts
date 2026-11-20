import { describe, expect, it } from "vite-plus/test";

import { shownFileTargets, shownFilesToOpen, type ShownFileTarget } from "./shownFileOpen";

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
            toolName: "show_file",
            output: {
              path: "/tmp/answers.md",
              byteSize: 12,
              mediaType: "text/markdown",
              line: 3,
              contents: SECRET,
              message: "Shown in the file viewer. Do not read or quote the file.",
            },
          },
        },
      } as never,
    ]);
    expect(targets).toEqual([{ id: "show-1", path: "/tmp/answers.md", line: 3 }]);
    expect(JSON.stringify(targets)).not.toContain(SECRET);
  });
});

describe("shownFilesToOpen", () => {
  const files: ReadonlyArray<ShownFileTarget> = [
    { id: "show-1", path: "/tmp/answers.md" },
    { id: "show-2", path: "/tmp/notes.md", line: 2 },
  ];
  const nextKey = "show-1\t/tmp/answers.md\t\nshow-2\t/tmp/notes.md\t2";

  it("does not open files already on screen, including after a thread change", () => {
    expect(
      shownFilesToOpen({ threadKey: "env/thread", previous: null, nextKey, files }).open,
    ).toEqual([]);
    const baseline = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey,
      files,
    }).baseline;
    expect(
      shownFilesToOpen({ threadKey: "env/other", previous: baseline, nextKey, files }).open,
    ).toEqual([]);
  });

  it("opens only a file that completed after the thread was on screen", () => {
    const previous = shownFilesToOpen({
      threadKey: "env/thread",
      previous: null,
      nextKey: "show-1\t/tmp/answers.md\t",
      files: files.slice(0, 1),
    }).baseline;
    expect(shownFilesToOpen({ threadKey: "env/thread", previous, nextKey, files }).open).toEqual([
      { id: "show-2", path: "/tmp/notes.md", line: 2 },
    ]);
  });
});
