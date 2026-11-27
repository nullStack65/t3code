import { RunId, ScheduledTaskId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
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

describe("hiddenSilentRuns", () => {
  const toolItem = (
    id: string,
    runId: RunId,
    toolName: string,
    overrides: Partial<{ status: "completed" | "failed"; output: unknown }> = {},
  ) =>
    ({
      id,
      runId,
      type: "dynamic_tool",
      status: overrides.status ?? "completed",
      toolName,
      output: overrides.output,
    }) as unknown as OrchestrationV2TurnItem;

  it("marks agent and automation wakes ending in silent_ack or pure agent routing as hidden", () => {
    const silentAckRun = RunId.make("silent-ack-run");
    const threadSendRun = RunId.make("thread-send-run");
    const askAgentRun = RunId.make("ask-agent-run");
    const automationSilentRun = RunId.make("automation-silent-run");
    const automationMsg = {
      role: "user",
      text: "cron tick",
      scheduledTaskId: ScheduledTaskId.make("sched-1"),
    };

    const ctx = chatActivityContext(
      [
        { createdAt: at, runId: silentAckRun, message: relay },
        {
          createdAt: at,
          runId: silentAckRun,
          item: toolItem("t1", silentAckRun, "mcp__t3-code__silent_ack"),
        },
        { createdAt: at, runId: threadSendRun, message: relay },
        {
          createdAt: at,
          runId: threadSendRun,
          item: toolItem("t2", threadSendRun, "t3_thread_send"),
        },
        { createdAt: at, runId: askAgentRun, message: relay },
        {
          createdAt: at,
          runId: askAgentRun,
          item: toolItem("t3", askAgentRun, "mcp__t3-code__ask_agent"),
        },
        { createdAt: at, runId: automationSilentRun, message: automationMsg },
        {
          createdAt: at,
          runId: automationSilentRun,
          item: toolItem("t4", automationSilentRun, "silent_ack"),
        },
      ],
      [],
      false,
    );

    expect(ctx.hiddenSilentRuns.has(silentAckRun)).toBe(true);
    expect(ctx.hiddenSilentRuns.has(threadSendRun)).toBe(true);
    expect(ctx.hiddenSilentRuns.has(askAgentRun)).toBe(true);
    expect(ctx.hiddenSilentRuns.has(automationSilentRun)).toBe(true);
  });

  it("never hides runs that call send_to_user, user-triggered runs, or failed/active runs", () => {
    const sentToUserRun = RunId.make("sent-to-user-run");
    const sentCardRun = RunId.make("sent-card-run");
    const userRun = RunId.make("user-run");
    const failedToolRun = RunId.make("failed-tool-run");
    const activeRun = RunId.make("active-run");

    const ctx = chatActivityContext(
      [
        { createdAt: at, runId: sentToUserRun, message: relay },
        {
          createdAt: at,
          runId: sentToUserRun,
          item: toolItem("t1", sentToUserRun, "t3_thread_send"),
        },
        {
          createdAt: at,
          runId: sentToUserRun,
          item: toolItem("t2", sentToUserRun, "mcp__t3-code__send_to_user", {
            output: { sentMessage: "Heads up" },
          }),
        },
        { createdAt: at, runId: sentCardRun, message: relay },
        {
          createdAt: at,
          runId: sentCardRun,
          item: toolItem("t3", sentCardRun, "t3_thread_send"),
        },
        { createdAt: at, runId: sentCardRun, surfacesToUser: true },
        { createdAt: at, runId: userRun, message: person },
        { createdAt: at, runId: userRun, item: toolItem("t4", userRun, "silent_ack") },
        { createdAt: at, runId: failedToolRun, message: relay },
        {
          createdAt: at,
          runId: failedToolRun,
          item: toolItem("t5", failedToolRun, "silent_ack", { status: "failed" }),
        },
        { createdAt: at, runId: activeRun, message: relay },
        {
          createdAt: at,
          runId: activeRun,
          item: toolItem("t6", activeRun, "t3_thread_send"),
        },
      ],
      [{ id: activeRun, status: "running" }],
      false,
    );

    expect(ctx.hiddenSilentRuns.has(sentToUserRun)).toBe(false);
    expect(ctx.hiddenSilentRuns.has(sentCardRun)).toBe(false);
    expect(ctx.hiddenSilentRuns.has(userRun)).toBe(false);
    expect(ctx.hiddenSilentRuns.has(failedToolRun)).toBe(false);
    expect(ctx.hiddenSilentRuns.has(activeRun)).toBe(false);
  });

  it("does not let a trailing silent_ack turn hijack keepLatestReply in a founder inbox", () => {
    const visibleRun = RunId.make("visible-run");
    const silentRun = RunId.make("silent-run");
    const ctx = chatActivityContext(
      [
        { createdAt: at, runId: visibleRun, message: relay },
        { createdAt: at, runId: visibleRun, message: { role: "assistant", text: "Report ready" } },
        { createdAt: at, runId: silentRun, message: relay },
        {
          createdAt: at,
          runId: silentRun,
          item: toolItem("ack", silentRun, "silent_ack"),
        },
        { createdAt: at, runId: silentRun, message: { role: "assistant", text: "Acknowledged." } },
      ],
      [],
      false,
      undefined,
      true,
    );

    expect(ctx.hiddenSilentRuns.has(silentRun)).toBe(true);
    expect(ctx.decisionRuns.has(silentRun)).toBe(false);
    expect(ctx.decisionRuns.has(visibleRun)).toBe(true);
  });

  it("never hides a silent/routed run whose wake or reply @-mentions a founder", () => {
    const replyMentionRun = RunId.make("reply-mention-run");
    const wakeMentionRun = RunId.make("wake-mention-run");
    const ctx = chatActivityContext(
      [
        { createdAt: at, runId: replyMentionRun, message: relay },
        {
          createdAt: at,
          runId: replyMentionRun,
          item: toolItem("t1", replyMentionRun, "t3_thread_send"),
        },
        {
          createdAt: at,
          runId: replyMentionRun,
          message: { role: "assistant", text: "@kameron this needs your call." },
        },
        {
          createdAt: at,
          runId: wakeMentionRun,
          message: { ...relay, text: "@jeff please take a look" },
        },
        {
          createdAt: at,
          runId: wakeMentionRun,
          item: toolItem("t2", wakeMentionRun, "silent_ack"),
        },
      ],
      [],
      false,
    );

    expect(ctx.hiddenSilentRuns.has(replyMentionRun)).toBe(false);
    expect(ctx.hiddenSilentRuns.has(wakeMentionRun)).toBe(false);
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

  it("treats a completed command with a failing exit code as a failure in both directions", () => {
    for (const failing of [{ exitCode: 1 }, { outputIndicatesFailure: true }]) {
      const recovered = attention([
        toolItem("fail", "completed", failing),
        toolItem("ok", "completed"),
      ]);
      expect(recovered.attentionByRun.size).toBe(0);
      expect([...recovered.recoveredItemIds]).toEqual(["fail"]);
      const trailing = attention([
        toolItem("fail", "failed"),
        toolItem("ok", "completed"),
        toolItem("late", "completed", failing),
      ]);
      expect([...(trailing.attentionByRun.get(run) ?? [])]).toEqual(["late"]);
      expect(trailing.recoveredRuns.has(run)).toBe(false);
    }
  });

  it("flags an unrecovered exit-code failure on its own", () => {
    const ctx = attention([toolItem("fail", "completed", { exitCode: 1 })]);
    expect([...(ctx.attentionByRun.get(run) ?? [])]).toEqual(["fail"]);
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
