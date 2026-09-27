import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { make } from "./ThreadPostStartActivity.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const BASE = DateTime.makeUnsafe(T0);
const T = (ms: number) => DateTime.formatIso(DateTime.add({ milliseconds: ms })(BASE));
const MIN = 60_000;

describe("ThreadPostStartActivityService", () => {
  it("advances last provider activity on meaningful progress only", () => {
    const service = make();
    service.recordActivity("thread-1", T(0), {
      kind: "tool.started",
      payload: { toolCallId: "a", title: "Bash" },
    });
    service.recordActivity("thread-1", T(MIN), {
      kind: "task.progress",
      payload: { taskId: "t1", usageSnapshot: true, typedUsage: { inputTokens: 1 } },
    });
    service.recordContentProgress("thread-1", T(2 * MIN));

    const state = service.getThreadPostStartActivity("thread-1");
    expect(state?.lastProviderActivityAt).toBe(T(2 * MIN));
  });

  it("correlates tool progress by toolUseId and completes on terminal updates", () => {
    const service = make();
    service.recordActivity("thread-1", T(0), {
      kind: "tool.started",
      payload: { toolUseId: "claude-1", title: "Bash" },
    });
    service.recordActivity("thread-1", T(4 * MIN), {
      kind: "tool.progress",
      payload: { toolUseId: "claude-1", toolName: "Bash", elapsedSeconds: 240 },
    });
    expect(service.getThreadPostStartActivity("thread-1")?.outstandingTools).toHaveLength(1);
    expect(
      service.getThreadPostStartActivity("thread-1")?.outstandingTools[0]?.lastObservedAt,
    ).toBe(T(4 * MIN));

    service.recordActivity("thread-1", T(5 * MIN), {
      kind: "tool.updated",
      payload: { toolUseId: "claude-1", status: "completed" },
    });
    const completed = service.getThreadPostStartActivity("thread-1");
    expect(completed?.outstandingTools).toHaveLength(0);
    expect(completed?.lastToolCompletedAt).toBe(T(5 * MIN));
  });

  it("keeps overlapping tools independent and clears on session end", () => {
    const service = make();
    service.recordActivity("thread-1", T(0), {
      kind: "tool.started",
      payload: { toolCallId: "a", title: "A" },
    });
    service.recordActivity("thread-1", T(MIN), {
      kind: "tool.started",
      payload: { toolCallId: "b", title: "B" },
    });
    service.recordActivity("thread-1", T(2 * MIN), {
      kind: "tool.completed",
      payload: { toolCallId: "a" },
    });
    expect(
      service.getThreadPostStartActivity("thread-1")?.outstandingTools.map((t) => t.toolCallId),
    ).toEqual(["b"]);

    service.clearThread("thread-1");
    expect(service.getThreadPostStartActivity("thread-1")).toBeNull();
  });

  it("reports null for a thread it has never observed", () => {
    const service = make();
    expect(service.getThreadPostStartActivity("thread-none")).toBeNull();
  });

  it("resets on a superseding turn and ignores the old turn's traffic", () => {
    const service = make();
    service.beginTurn("thread-1", "turn-a");
    service.recordActivity(
      "thread-1",
      T(0),
      { kind: "tool.started", payload: { toolCallId: "a", title: "A" } },
      "turn-a",
    );
    service.recordContentProgress("thread-1", T(MIN), "turn-a");
    expect(service.getThreadPostStartActivity("thread-1")?.outstandingTools).toHaveLength(1);

    service.beginTurn("thread-1", "turn-b");
    const fresh = service.getThreadPostStartActivity("thread-1");
    expect(fresh?.outstandingTools).toEqual([]);
    expect(fresh?.lastProviderActivityAt).toBeNull();

    // Late A content and tool traffic must not refresh B.
    service.recordContentProgress("thread-1", T(2 * MIN), "turn-a");
    service.recordActivity(
      "thread-1",
      T(2 * MIN),
      { kind: "tool.started", payload: { toolCallId: "a", title: "A" } },
      "turn-a",
    );
    const stale = service.getThreadPostStartActivity("thread-1");
    expect(stale?.lastProviderActivityAt).toBeNull();
    expect(stale?.outstandingTools).toEqual([]);

    // B's own traffic is observed.
    service.recordContentProgress("thread-1", T(3 * MIN), "turn-b");
    expect(service.getThreadPostStartActivity("thread-1")?.lastProviderActivityAt).toBe(T(3 * MIN));
  });

  it("does not reopen a completed tool on a later update", () => {
    const service = make();
    service.beginTurn("thread-1", "turn-a");
    service.recordActivity(
      "thread-1",
      T(0),
      { kind: "tool.started", payload: { toolCallId: "a", title: "A" } },
      "turn-a",
    );
    service.recordActivity(
      "thread-1",
      T(2 * MIN),
      { kind: "tool.completed", payload: { toolCallId: "a" } },
      "turn-a",
    );
    service.recordActivity(
      "thread-1",
      T(3 * MIN),
      { kind: "tool.progress", payload: { toolCallId: "a", title: "A" } },
      "turn-a",
    );
    const state = service.getThreadPostStartActivity("thread-1");
    expect(state?.outstandingTools).toEqual([]);
    expect(state?.lastToolCompletedAt).toBe(T(2 * MIN));
  });

  it("exposes completed tool ids for client-side reconciliation", () => {
    const service = make();
    service.beginTurn("thread-1", "turn-a");
    service.recordActivity(
      "thread-1",
      T(0),
      { kind: "tool.started", payload: { toolUseId: "claude-1", title: "Bash" } },
      "turn-a",
    );
    service.recordActivity(
      "thread-1",
      T(MIN),
      { kind: "tool.updated", payload: { toolUseId: "claude-1", status: "completed" } },
      "turn-a",
    );
    expect(service.getThreadPostStartActivity("thread-1")?.completedToolIds).toEqual(["claude-1"]);
  });

  it("treats beginTurn for the current turn as a no-op", () => {
    const service = make();
    service.beginTurn("thread-1", "turn-a");
    service.recordContentProgress("thread-1", T(MIN), "turn-a");
    service.beginTurn("thread-1", "turn-a");
    expect(service.getThreadPostStartActivity("thread-1")?.lastProviderActivityAt).toBe(T(MIN));
  });
});
