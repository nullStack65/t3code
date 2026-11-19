import type { ThreadStatusPill } from "../Sidebar.logic";
import type { BotAvatarState } from "./BotAvatar";

export interface BotPresence {
  readonly avatarState: BotAvatarState;
  /** Second line: what the bot is doing, or its role when there is nothing newer. */
  readonly line: string | null;
  /** The trailing badge: a count-free dot for needs-you or unread. */
  readonly badge: "needs-you" | "unread" | null;
}

const NEEDS_YOU = new Set(["Pending Approval", "Awaiting Input", "Guest Request", "Plan Ready"]);

/** Maps the thread's status pill onto a bot's quieter vocabulary. */
export function resolveBotPresence(
  pill: Pick<ThreadStatusPill, "label"> | null,
  role: string | null | undefined,
): BotPresence {
  const label = pill?.label ?? null;
  if (label !== null && NEEDS_YOU.has(label))
    return { avatarState: "needs-you", line: label, badge: "needs-you" };
  if (label === "Working" || label === "Connecting")
    return { avatarState: "running", line: label, badge: null };
  if (label === "Failed") return { avatarState: "failed", line: "Failed", badge: null };
  if (label === "Completed")
    return { avatarState: "idle", line: role ?? "New reply", badge: "unread" };
  if (label === "Waiting") return { avatarState: "idle", line: "Waiting", badge: null };
  return { avatarState: "idle", line: role ?? null, badge: null };
}

/** Bots list alphabetically by persona name, so their places never move. */
export function sortBotThreads<
  T extends { readonly standing: { readonly name: string } | null; readonly id: string },
>(threads: readonly T[]): T[] {
  return threads.toSorted(
    (left, right) =>
      (left.standing?.name ?? "").localeCompare(right.standing?.name ?? "", undefined, {
        sensitivity: "base",
      }) || left.id.localeCompare(right.id),
  );
}

/**
 * Splits standing bots out of the sidebar's thread list. Bots go to their own group whatever
 * their pin, settle or snooze state; everything else continues to the ordinary sections.
 */
export function splitStandingThreads<T extends { readonly standing: unknown }>(
  threads: readonly T[],
): { readonly bots: T[]; readonly rest: T[] } {
  const bots: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) (thread.standing != null ? bots : rest).push(thread);
  return { bots, rest };
}
