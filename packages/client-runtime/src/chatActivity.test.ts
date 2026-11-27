import { RunId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activityItemNeedsAttention,
  chatActivityContext,
  combineTimelineVisibilityStamps,
  isChatActivityMessage,
} from "./chatActivity.ts";

const botRun = RunId.make("bot-run");
const directRun = RunId.make("direct-run");
const at = "2026-01-01T00:00:00.000Z";
const relay = { role: "user", text: "relay", createdBy: "agent" as const };
const person = {
  role: "user",
  text: "hi",
  sentBy: {
    sessionId: "session" as never,
    device: "laptop",
    deviceType: "desktop" as const,
    founder: "kameron" as const,
  },
};
const context = chatActivityContext(
  [
    { createdAt: at, runId: botRun, message: relay },
    { createdAt: at, runId: directRun, message: person },
  ],
  [],
  false,
);

describe("isChatActivityMessage with a timeline stamp", () => {
  it("keeps the run-based default for messages without a stamp", () => {
    const reply = { role: "assistant", text: "done" };
    expect(isChatActivityMessage(reply, botRun, context)).toBe(true);
    expect(isChatActivityMessage(reply, directRun, context)).toBe(false);
    expect(isChatActivityMessage(relay, botRun, context)).toBe(true);
    expect(isChatActivityMessage(person, directRun, context)).toBe(false);
  });

  it("lets user_timeline lift a message out of an agent-started run", () => {
    const reply = { role: "assistant", text: "done", timelineVisibility: "user_timeline" } as const;
    expect(isChatActivityMessage(reply, botRun, context)).toBe(false);
    expect(
      isChatActivityMessage({ ...relay, timelineVisibility: "user_timeline" }, botRun, context),
    ).toBe(false);
  });

  it("lets agent_fold fold a message the default would show", () => {
    const reply = { role: "assistant", text: "done", timelineVisibility: "agent_fold" } as const;
    expect(isChatActivityMessage(reply, directRun, context)).toBe(true);
  });
});

describe("combineTimelineVisibilityStamps", () => {
  it.each([
    [[], undefined],
    [[undefined, undefined], undefined],
    [[undefined, "agent_fold"], "agent_fold"],
    [["agent_fold", "user_timeline", undefined], "user_timeline"],
    [["user_timeline", "agent_fold"], "user_timeline"],
  ] as const)("%j combines to %s", (stamps, expected) => {
    expect(combineTimelineVisibilityStamps(stamps)).toBe(expected);
  });
});

describe("chatActivityContext failed tool calls", () => {
  const run = RunId.make("tool-run");
  const otherRun = RunId.make("other-run");
  const toolItem = (
    id: string,
    status: "failed" | "completed" | "running",
    extra: Record<string, unknown> = {},
    runId: RunId = run,
  ) =>
    ({
      id,
      runId,
      type: "command_execution",
      status,
      input: "pnpm test",
      ...extra,
    }) as unknown as OrchestrationV2TurnItem;
  const entries = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
    items.map((item, index) => ({
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      runId: item.runId,
      item,
    }));
  const attention = (
    items: ReadonlyArray<OrchestrationV2TurnItem>,
    runs: Parameters<typeof chatActivityContext>[1] = [],
  ) => chatActivityContext(entries(items), runs, false);

  it("clears a failure that the next call in the same run retried successfully", () => {
    const ctx = attention([toolItem("fail", "failed"), toolItem("retry", "completed")]);
    expect(ctx.attentionByRun.size).toBe(0);
    expect([...ctx.recoveredItemIds]).toEqual(["fail"]);
    expect(ctx.recoveredRuns.has(run)).toBe(true);
  });

  it("recovers across tool kinds, since the agent moved on with a clean call", () => {
    const ctx = attention([
      toolItem("fail", "failed"),
      { ...toolItem("edit", "completed"), type: "file_change" } as OrchestrationV2TurnItem,
    ]);
    expect(ctx.attentionByRun.size).toBe(0);
  });

  it("keeps a failure that is the last tool call of the run", () => {
    const ctx = attention([toolItem("ok", "completed"), toolItem("fail", "failed")]);
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual(["fail"]);
    expect(ctx.recoveredItemIds.size).toBe(0);
  });

  it("does not count a call that is still running or finished with a failing result", () => {
    for (const later of [
      toolItem("later", "running"),
      toolItem("later", "completed", { exitCode: 1 }),
      toolItem("later", "completed", { outputIndicatesFailure: true }),
      toolItem("later", "failed"),
    ]) {
      const ctx = attention([toolItem("fail", "failed"), later]);
      expect(ctx.attentionByRun.get(run)?.has("fail")).toBe(true);
    }
  });

  it("does not recover a failure through a success in another run", () => {
    const ctx = attention([
      toolItem("fail", "failed"),
      toolItem("elsewhere", "completed", {}, otherRun),
    ]);
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual(["fail"]);
  });

  it("clears every failure before a success and keeps the ones after it", () => {
    const ctx = attention([
      toolItem("fail-1", "failed"),
      toolItem("fail-2", "failed"),
      toolItem("ok", "completed"),
      toolItem("fail-3", "failed"),
    ]);
    expect([...ctx.recoveredItemIds].sort()).toEqual(["fail-1", "fail-2"]);
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual(["fail-3"]);
  });

  it("clears the run's attention only when all of its failures recover", () => {
    const all = attention([
      toolItem("fail-1", "failed"),
      toolItem("ok-1", "completed"),
      toolItem("fail-2", "failed"),
      toolItem("ok-2", "completed"),
    ]);
    expect(all.attentionByRun.size).toBe(0);
    const some = attention([
      toolItem("fail-1", "failed"),
      toolItem("ok-1", "completed"),
      toolItem("fail-2", "failed"),
    ]);
    expect([...(some.attentionByRun.get(run) ?? [])]).toEqual(["fail-2"]);
  });

  it("still flags a recovered failure when the run itself failed", () => {
    const ctx = attention(
      [toolItem("fail", "failed"), toolItem("retry", "completed")],
      [{ id: run, status: "failed" }],
    );
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual([run]);
  });

  it("never recovers errors, which are not tool calls", () => {
    const error = { id: "err", runId: run, type: "error", status: "completed" };
    const ctx = attention([
      error as unknown as OrchestrationV2TurnItem,
      toolItem("retry", "completed"),
    ]);
    expect(activityItemNeedsAttention(error as unknown as OrchestrationV2TurnItem)).toBe(true);
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual(["err"]);
  });
});
