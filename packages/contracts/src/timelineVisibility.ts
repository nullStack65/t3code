import * as Schema from "effect/Schema";

/**
 * Where a turn item or message belongs in the chat timeline, independent of who started its run.
 * `agent_fold` joins the "N agent updates" group; `user_timeline` stands on its own and breaks any
 * group around it. This is not the projected item's `visibility` (`local | inherited | synthetic`),
 * which says whose history an item came from.
 */
export const OrchestrationV2TimelineVisibility = Schema.Literals(["user_timeline", "agent_fold"]);
export type OrchestrationV2TimelineVisibility = typeof OrchestrationV2TimelineVisibility.Type;

/** Whether a person or an agent (an agent message, automation, or notification) started the run. */
export type OrchestrationV2TimelineOrigin = "agent" | "user";

/**
 * The one place a timeline decides fold or not. A stamp on the item is honored strictly, so an
 * agent-started run can still surface a message (`send_to_user`, a fail-open fallback). Without
 * one, the run's origin decides, which is how every item stored before the stamp existed renders.
 */
export function resolveTimelineVisibility(
  subject: { readonly timelineVisibility?: OrchestrationV2TimelineVisibility | undefined },
  origin: OrchestrationV2TimelineOrigin,
): OrchestrationV2TimelineVisibility {
  return subject.timelineVisibility ?? (origin === "agent" ? "agent_fold" : "user_timeline");
}
