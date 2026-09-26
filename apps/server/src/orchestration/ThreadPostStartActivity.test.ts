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
});
