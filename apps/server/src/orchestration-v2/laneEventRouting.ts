/**
 * Lane-event routing (Closura CLO-1302). A port of `scripts/lane_event_routing.py` in
 * nullStack65/closura-agent-config; both must agree with `laneEventRouting.conformance.json`.
 */

export type LaneThreadState = "running" | "idle" | "settled" | "archived" | "deleted" | "missing";

export interface LaneCondition {
  readonly outcome?: string | null;
  readonly error?: string | null;
  readonly open_prs?: ReadonlyArray<string> | null;
  readonly question?: string | null;
}

export interface LaneEvent {
  readonly child_thread_id: string;
  readonly owner?: string | null;
  readonly requester?: string | null;
  readonly kind?: string;
  readonly superseded?: boolean;
  readonly condition?: LaneCondition | null;
  readonly set_state?: Readonly<Record<string, { readonly state?: string }>>;
}

export interface LaneWorld {
  readonly threads: Readonly<Record<string, { readonly state?: string }>>;
  readonly delivered: ReadonlyArray<string>;
}

export type LaneAction = "drop" | "digest" | "wake" | "code-handler";

export interface LaneDecision {
  readonly action: LaneAction;
  readonly recipient: string | null;
  readonly reason: string;
  readonly handler?: "merge-queue";
  readonly deliveredKey?: string;
}

/** The agent-only role that receives detached digests; it never starts a turn. */
export const LANE_DIGEST_ROLE = "ops-bus";

const INACTIVE_STATES = new Set(["settled", "archived", "deleted", "missing"]);
const CODE_HANDLED_KINDS = new Set(["pr-checks-passed", "pr-merged"]);
const WAKING_KINDS = new Set(["pr-checks-failed", "review-requested", "founder-question"]);
const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const PROVIDER_LIMIT = /usage limit|quota|rate.?limit|out of usage|\b429\b|capacity/;

export const laneFailureClass = (error: string | null | undefined): string => {
  const text = (error ?? "").toLowerCase().replace(UUID, "");
  if (PROVIDER_LIMIT.test(text)) return "provider-limit";
  const normalized = text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
  return normalized === "" ? "none" : normalized;
};

export const laneConditionKey = (event: LaneEvent): string => {
  const condition = event.condition ?? {};
  const prs = [...(condition.open_prs ?? [])].map(String).toSorted().join(",");
  return `${condition.outcome || "ended"}|${laneFailureClass(condition.error)}|${prs}`;
};

export const laneDeliveredKey = (recipient: string, event: LaneEvent): string =>
  `${recipient}>${event.child_thread_id}>${laneConditionKey(event)}`;

export const laneThreadState = (
  shell: {
    readonly deletedAt: unknown;
    readonly archivedAt: unknown;
    readonly settledOverride: string | null;
    readonly activeRunId: unknown;
    readonly activityRunStatus?: unknown;
  } | null,
): LaneThreadState => {
  if (shell === null) return "missing";
  if (shell.deletedAt !== null) return "deleted";
  if (shell.archivedAt !== null) return "archived";
  if (shell.settledOverride === "settled") return "settled";
  if (shell.activeRunId !== null || (shell.activityRunStatus ?? null) !== null) return "running";
  return "idle";
};

const recipientOf = (event: LaneEvent): string | null => event.owner || event.requester || null;

export const decideLaneEvent = (event: LaneEvent, world: LaneWorld): LaneDecision => {
  const delivered = new Set(world.delivered);
  const kind = event.kind ?? "lane-ended";

  if (world.threads[event.child_thread_id]?.state === "running" || event.superseded) {
    return { action: "drop", recipient: null, reason: "target running or superseded" };
  }

  const recipient = recipientOf(event);
  const state = recipient ? (world.threads[recipient]?.state ?? "missing") : "missing";
  if (INACTIVE_STATES.has(state)) {
    const key = laneDeliveredKey(LANE_DIGEST_ROLE, event);
    if (delivered.has(key)) {
      return {
        action: "drop",
        recipient: LANE_DIGEST_ROLE,
        reason: "digest already delivered for condition",
      };
    }
    return {
      action: "digest",
      recipient: LANE_DIGEST_ROLE,
      reason: `recipient ${state}; detached`,
      deliveredKey: key,
    };
  }

  const owner = recipient as string;
  const key = laneDeliveredKey(owner, event);
  if (delivered.has(key)) {
    return { action: "drop", recipient: owner, reason: "already delivered for condition" };
  }
  if (CODE_HANDLED_KINDS.has(kind)) {
    return {
      action: "code-handler",
      recipient: owner,
      handler: "merge-queue",
      reason: "pr event handled by code",
      deliveredKey: key,
    };
  }
  if (WAKING_KINDS.has(kind)) {
    return { action: "wake", recipient: owner, reason: kind, deliveredKey: key };
  }
  const condition = event.condition ?? {};
  if ((condition.open_prs ?? []).length === 0 && !condition.error && !condition.question) {
    return {
      action: "digest",
      recipient: owner,
      reason: "only action is to re-settle",
      deliveredKey: key,
    };
  }
  return {
    action: "wake",
    recipient: owner,
    reason: "open work or failure on the lane",
    deliveredKey: key,
  };
};

export const replayLaneEvents = (
  events: ReadonlyArray<LaneEvent>,
  world: LaneWorld,
): ReadonlyArray<LaneDecision> => {
  const threads: Record<string, { readonly state?: string }> = { ...world.threads };
  const delivered = [...world.delivered];
  return events.map((event) => {
    for (const [id, patch] of Object.entries(event.set_state ?? {})) threads[id] = patch;
    const decision = decideLaneEvent(event, { threads, delivered });
    if (decision.deliveredKey) delivered.push(decision.deliveredKey);
    return decision;
  });
};
