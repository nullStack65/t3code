import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { explicitTimelineVisibilityFromToolItem } from "@t3tools/shared/toolOutput";

/**
 * Every provider's turn items pass through the event sink before they are stored, so stamping
 * here covers all adapters at once. Only a finished tool call is stamped, because its output is
 * what says the call reached the user; a stamp already on the item is left alone.
 */
export function withExplicitTimelineVisibility<Item extends OrchestrationV2TurnItem>(
  item: Item,
): Item {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return item;
  if (item.timelineVisibility !== undefined) return item;
  const timelineVisibility = explicitTimelineVisibilityFromToolItem(item);
  return timelineVisibility === undefined ? item : { ...item, timelineVisibility };
}
