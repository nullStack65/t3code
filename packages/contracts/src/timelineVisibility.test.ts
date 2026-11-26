import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";
import {
  OrchestrationV2TimelineVisibility,
  resolveTimelineVisibility,
} from "./timelineVisibility.ts";

const isTimelineVisibility = Schema.is(OrchestrationV2TimelineVisibility);

describe("resolveTimelineVisibility", () => {
  it.each([
    // Items stored before the stamp existed keep the rendering they always had.
    [undefined, "agent", "agent_fold"],
    [undefined, "user", "user_timeline"],
    // An explicit stamp wins over whoever started the run.
    ["user_timeline", "agent", "user_timeline"],
    ["user_timeline", "user", "user_timeline"],
    ["agent_fold", "agent", "agent_fold"],
    ["agent_fold", "user", "agent_fold"],
  ] as const)("stamp %s on a %s-started run resolves to %s", (stamp, origin, expected) => {
    expect(resolveTimelineVisibility({ timelineVisibility: stamp }, origin)).toBe(expected);
    expect(resolveTimelineVisibility({}, origin)).toBe(
      origin === "agent" ? "agent_fold" : "user_timeline",
    );
  });
});

describe("timelineVisibility on turn items", () => {
  const item = (extra: Record<string, unknown>) => ({
    id: "item-1",
    type: "dynamic_tool",
    threadId: "thread-1",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    toolName: "send_to_user",
    input: { message: "hi" },
    ...extra,
  });
  const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

  it("decodes an item stored without the stamp and one carrying it", () => {
    expect(decode(item({}))).not.toHaveProperty("timelineVisibility");
    expect(decode(item({ timelineVisibility: "user_timeline" }))).toMatchObject({
      timelineVisibility: "user_timeline",
    });
    expect(decode(item({ timelineVisibility: "agent_fold" }))).toMatchObject({
      timelineVisibility: "agent_fold",
    });
  });

  it("rejects a stamp that is not a known visibility, never mistaking it for the projection's", () => {
    expect(() => decode(item({ timelineVisibility: "local" }))).toThrow();
    expect(isTimelineVisibility("inherited")).toBe(false);
  });
});
