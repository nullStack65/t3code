import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  POST_START_SILENCE_THRESHOLD_MS,
  derivePostStartActivityAnchors,
  isProviderActivityKind,
  resolvePostStartActivity,
  type DerivePostStartActivityInput,
} from "./postStartActivity.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const BASE = DateTime.makeUnsafe(T0);
const T = (ms: number) => DateTime.formatIso(DateTime.add({ milliseconds: ms })(BASE));
const MIN = 60_000;
const TURN_ID = TurnId.make("turn-1");
const OLD_TURN_ID = TurnId.make("turn-0");
const REMOTE_TURN_ID = TurnId.make("turn-remote");

function activity(
  overrides: Partial<OrchestrationThreadActivity> & Pick<OrchestrationThreadActivity, "kind">,
): OrchestrationThreadActivity {
  return {
    id: overrides.id ?? EventId.make(`${overrides.kind}:${overrides.createdAt ?? T0}`),
    tone: overrides.tone ?? "tool",
    kind: overrides.kind,
    summary: overrides.summary ?? overrides.kind,
    payload: overrides.payload ?? {},
    turnId: overrides.turnId !== undefined ? overrides.turnId : TURN_ID,
    createdAt: overrides.createdAt ?? T0,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

function turnTool(
  toolCallId: string,
  at: string,
  kind: "tool.started" | "tool.updated" | "tool.completed",
  input: { title?: string; status?: string; sequence?: number } = {},
): OrchestrationThreadActivity {
  return activity({
    kind,
    createdAt: at,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    payload: {
      toolCallId,
      itemType: "command_execution",
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
}

const RUNNING_TURN = {
  turnId: TURN_ID,
  state: "running" as const,
  requestedAt: T0,
  startedAt: T0,
  completedAt: null,
};

function anchorsFor(
  input: Partial<DerivePostStartActivityInput> & {
    activities: ReadonlyArray<OrchestrationThreadActivity>;
  },
) {
  return derivePostStartActivityAnchors({
    activities: input.activities,
    latestTurn: input.latestTurn ?? RUNNING_TURN,
    session: input.session ?? { status: "running", activeTurnId: TURN_ID },
    ...(input.knownWait !== undefined ? { knownWait: input.knownWait } : {}),
  });
}

describe("isProviderActivityKind", () => {
  it("counts tool/task/provider/runtime progress", () => {
    for (const kind of [
      "tool.started",
      "tool.progress",
      "tool.updated",
      "tool.completed",
      "task.started",
      "task.progress",
      "task.completed",
      "turn.plan.updated",
      "context-compaction",
      "runtime.error",
      "provider.turn.start.failed",
      "runtime.warning",
    ]) {
      expect(isProviderActivityKind(kind), kind).toBe(true);
    }
  });

  it("rejects user, approval, metadata, checkpoint and scaffolding events", () => {
    for (const kind of [
      "user-input.requested",
      "user-input.resolved",
      "user-input.answer-submitted",
      "approval.requested",
      "approval.resolved",
      "tool.denied",
      "context-window.updated",
      "checkpoint.captured",
      "checkpoint.capture.failed",
      "thread.state.changed",
      "project-upserted",
      "setup-script.started",
    ]) {
      expect(isProviderActivityKind(kind), kind).toBe(false);
    }
  });
});

describe("derivePostStartActivityAnchors", () => {
  it("is inactive with no running turn", () => {
    const anchors = derivePostStartActivityAnchors({
      activities: [activity({ kind: "tool.started", createdAt: T0 })],
      latestTurn: { ...RUNNING_TURN, state: "completed", completedAt: T(5 * MIN) },
      session: { status: "ready", activeTurnId: null },
    });
    expect(anchors.active).toBe(false);
    expect(anchors.turnId).toBeNull();
    expect(anchors.outstandingTool).toBeNull();
  });

  it("scopes last activity and completion to the current turn only", () => {
    const anchors = anchorsFor({
      activities: [
        turnTool("old", T(-30 * MIN), "tool.started", { title: "old" }),
        turnTool("old", T(-30 * MIN), "tool.completed", { title: "old" }),
        activity({
          kind: "tool.updated",
          createdAt: T(2 * MIN),
          id: EventId.make("a"),
          payload: { toolCallId: "x", title: "run" },
        }),
        turnTool("y", T(MIN), "tool.completed", { title: "done" }),
      ],
    });
    expect(anchors.lastProviderActivityAt).toBe(T(2 * MIN));
    expect(anchors.lastToolCompletedAt).toBe(T(MIN));
  });

  it("ignores metadata-only activity for recency", () => {
    const anchors = anchorsFor({
      activities: [
        turnTool("x", T(MIN), "tool.started", { title: "run" }),
        turnTool("x", T(2 * MIN), "tool.completed", { title: "run" }),
        activity({
          kind: "context-window.updated",
          createdAt: T(4 * MIN),
          id: EventId.make("ctx"),
        }),
      ],
    });
    expect(anchors.lastProviderActivityAt).toBe(T(2 * MIN));
  });

  it("correlates overlapping tools by toolCallId and never cross-clears", () => {
    const anchors = anchorsFor({
      activities: [
        turnTool("a", T0, "tool.started", { title: "A" }),
        turnTool("b", T(1 * MIN), "tool.started", { title: "B" }),
        turnTool("a", T(2 * MIN), "tool.completed", { title: "A" }),
      ],
    });
    expect(anchors.outstandingTools.map((tool) => tool.toolCallId)).toEqual(["b"]);
    expect(anchors.lastToolCompletedAt).toBe(T(2 * MIN));
    expect(anchors.outstandingTool?.title).toBe("B");
    expect(anchors.outstandingTool?.startedAt).toBe(T(1 * MIN));
  });

  it("treats a terminal tool.updated status as completion", () => {
    const anchors = anchorsFor({
      activities: [
        turnTool("a", T0, "tool.started", { title: "A" }),
        turnTool("a", T(3 * MIN), "tool.updated", { title: "A", status: "failed" }),
      ],
    });
    expect(anchors.outstandingTools).toEqual([]);
  });

  it("never fabricates tool completion from a terminal turn or closed connection", () => {
    const anchors = derivePostStartActivityAnchors({
      activities: [
        turnTool("a", T0, "tool.started", { title: "A" }),
        activity({ kind: "provider.turn.start.failed", createdAt: T(1 * MIN) }),
      ],
      latestTurn: { ...RUNNING_TURN, state: "error", completedAt: T(2 * MIN) },
      session: { status: "error", activeTurnId: null },
    });
    expect(anchors.lastToolCompletedAt).toBeNull();
    expect(anchors.active).toBe(false);
  });

  it("excludes late activities from an earlier turn", () => {
    const anchors = derivePostStartActivityAnchors({
      activities: [
        activity({
          kind: "tool.started",
          createdAt: T(10 * MIN),
          turnId: OLD_TURN_ID,
          payload: { toolCallId: "a", title: "late-old" },
        }),
        turnTool("b", T(1 * MIN), "tool.started", { title: "current" }),
      ],
      latestTurn: RUNNING_TURN,
      session: { status: "running", activeTurnId: TURN_ID },
    });
    expect(anchors.lastProviderActivityAt).toBe(T(1 * MIN));
    expect(anchors.outstandingTools.map((tool) => tool.title)).toEqual(["current"]);
  });
});

describe("resolvePostStartActivity", () => {
  it("does not warn on a fresh turn with recent activity", () => {
    const anchors = anchorsFor({ activities: [turnTool("a", T(1 * MIN), "tool.started")] });
    const observation = resolvePostStartActivity(anchors, Date.parse(T(1 * MIN)));
    expect(observation.status).toBe("active");
    expect(observation.episodeKey).toBeNull();
  });

  it("warns at the threshold even when the turn never produced an event", () => {
    const anchors = anchorsFor({ activities: [] });
    expect(resolvePostStartActivity(anchors, Date.parse(T(5 * MIN - 1))).status).toBe("active");
    const atThreshold = resolvePostStartActivity(anchors, Date.parse(T(5 * MIN)));
    expect(atThreshold.status).toBe("quiet");
    expect(atThreshold.quietSinceAt).toBe(T0);
    expect(atThreshold.episodeKey).toBe(`turn-1:${T0}`);
  });

  it("carries the outstanding tool identity and its own age", () => {
    const anchors = anchorsFor({
      activities: [
        turnTool("a", T0, "tool.started", { title: "npm test" }),
        turnTool("a", T(2 * MIN), "tool.updated", { title: "npm test" }),
      ],
    });
    const observation = resolvePostStartActivity(anchors, Date.parse(T(8 * MIN)));
    expect(observation.status).toBe("quiet");
    expect(observation.outstandingTool?.title).toBe("npm test");
    expect(observation.outstandingToolAgeMs).toBe(6 * MIN);
    expect(observation.lastProviderActivityAgeMs).toBe(6 * MIN);
  });

  it("resets on resumption and opens a new episode on a later silence", () => {
    const firstAnchor = anchorsFor({ activities: [turnTool("a", T0, "tool.started")] });
    const first = resolvePostStartActivity(firstAnchor, Date.parse(T(6 * MIN)));
    expect(first.status).toBe("quiet");

    const resumedAnchor = anchorsFor({
      activities: [turnTool("a", T0, "tool.started"), turnTool("a", T(6 * MIN), "tool.updated")],
    });
    expect(resolvePostStartActivity(resumedAnchor, Date.parse(T(6 * MIN + 1))).status).toBe(
      "active",
    );

    const second = resolvePostStartActivity(resumedAnchor, Date.parse(T(12 * MIN)));
    expect(second.status).toBe("quiet");
    expect(second.episodeKey).not.toBe(first.episodeKey);
    expect(second.quietSinceAt).toBe(T(6 * MIN));
  });

  it("does not warn while a user decision is pending", () => {
    const anchors = anchorsFor({ activities: [], knownWait: "approval" });
    const observation = resolvePostStartActivity(anchors, Date.parse(T(30 * MIN)));
    expect(observation.status).toBe("waiting");
    expect(observation.episodeKey).toBeNull();
  });

  it("reports observation uncertainty when disconnected instead of asserting a stop", () => {
    const anchors = anchorsFor({ activities: [turnTool("a", T(MIN), "tool.started")] });
    const observation = resolvePostStartActivity(anchors, Date.parse(T(30 * MIN)), {
      connection: "disconnected",
    });
    expect(observation.status).toBe("unknown");
    expect(observation.episodeKey).toBeNull();
    expect(observation.lastProviderActivityAt).toBe(T(MIN));
  });

  it("keeps background-only work from resurrecting a finished turn's warning", () => {
    // Foreground turn completed; background liveness is carried elsewhere and
    // must not reopen this turn's episode.
    const anchors = derivePostStartActivityAnchors({
      activities: [turnTool("a", T0, "tool.started"), turnTool("a", T(MIN), "tool.completed")],
      latestTurn: { ...RUNNING_TURN, state: "completed", completedAt: T(2 * MIN) },
      session: { status: "ready", activeTurnId: null },
    });
    const observation = resolvePostStartActivity(anchors, Date.parse(T(60 * MIN)));
    expect(observation.status).toBe("inactive");
    expect(observation.episodeKey).toBeNull();
  });

  it("handles timezone-equivalent, invalid, missing and future timestamps", () => {
    // 05:00+05:00 === 00:00Z; the later absolute instant (00:01Z) wins even
    // though its wall-clock string sorts earlier.
    const equivalent = anchorsFor({
      activities: [
        turnTool("a", "2026-01-01T05:00:00.000+05:00", "tool.started"),
        turnTool("b", "2026-01-01T00:01:00.000Z", "tool.started"),
      ],
    });
    expect(equivalent.lastProviderActivityAt).toBe("2026-01-01T00:01:00.000Z");
    expect(Date.parse("2026-01-01T05:00:00.000+05:00")).toBe(Date.parse(T0));

    const invalid = anchorsFor({
      activities: [turnTool("a", "not-a-date", "tool.started")],
    });
    // Invalid activity timestamps cannot anchor the clock; the turn origin is used.
    expect(invalid.lastProviderActivityAt).toBeNull();
    expect(resolvePostStartActivity(invalid, Date.parse(T(6 * MIN))).quietSinceAt).toBe(T0);

    const future = anchorsFor({
      activities: [turnTool("a", T(10 * MIN), "tool.started")],
    });
    // A future (clock-skewed) activity must not produce a negative age.
    expect(resolvePostStartActivity(future, Date.parse(T(3 * MIN))).status).toBe("active");

    const noOrigin = derivePostStartActivityAnchors({
      activities: [],
      latestTurn: {
        turnId: TURN_ID,
        state: "running",
        requestedAt: "bad",
        startedAt: "also-bad",
        completedAt: null,
      },
      session: { status: "running", activeTurnId: TURN_ID },
    });
    expect(resolvePostStartActivity(noOrigin, Date.parse(T(6 * MIN))).status).toBe("unknown");
  });

  it("ages from the persisted origin, so opening an old turn does not restart it", () => {
    // The quiet origin is the last persisted activity, not the time the client
    // mounted, so an hours-old quiet turn is already past the threshold.
    const anchors = anchorsFor({ activities: [turnTool("a", T0, "tool.started")] });
    const hoursLater = Date.parse(T(3 * 60 * MIN));
    const observation = resolvePostStartActivity(anchors, hoursLater);
    expect(observation.status).toBe("quiet");
    expect(observation.quietForMs).toBe(3 * 60 * MIN);
  });

  it("keeps one stable episode key across ticks and threshold defaults to five minutes", () => {
    const anchors = anchorsFor({ activities: [turnTool("a", T0, "tool.started")] });
    const atThreshold = resolvePostStartActivity(anchors, Date.parse(T(5 * MIN)));
    const later = resolvePostStartActivity(anchors, Date.parse(T(6 * MIN)));
    expect(later.episodeKey).toBe(atThreshold.episodeKey);
    expect(POST_START_SILENCE_THRESHOLD_MS).toBe(5 * MIN);
    // A caller-supplied threshold overrides the default for tests/tuning.
    expect(
      resolvePostStartActivity(anchors, Date.parse(T(2 * MIN)), { thresholdMs: MIN }).status,
    ).toBe("quiet");
  });

  it("keeps local and remote environments isolated by turn scoping", () => {
    const local = anchorsFor({ activities: [turnTool("a", T(4 * MIN), "tool.started")] });
    const remote = derivePostStartActivityAnchors({
      activities: [turnTool("a", T(4 * MIN), "tool.started")],
      latestTurn: { ...RUNNING_TURN, turnId: REMOTE_TURN_ID },
      session: { status: "running", activeTurnId: REMOTE_TURN_ID },
    });
    // Same event shape, different turn identity: the remote anchors only see
    // rows belonging to the remote turn, so they do not inherit the local one.
    expect(local.turnId).toBe("turn-1");
    expect(local.lastProviderActivityAt).toBe(T(4 * MIN));
    expect(remote.turnId).toBe("turn-remote");
    expect(remote.lastProviderActivityAt).toBeNull();
    expect(resolvePostStartActivity(remote, Date.parse(T(10 * MIN))).quietSinceAt).toBe(T0);
  });
});
