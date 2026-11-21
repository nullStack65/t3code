import { founderName } from "./botAttention.ts";
import { Founder, type Founder as FounderName } from "./threadInbox.ts";

/** A typing beat older than this is gone. Clients refresh inside the window. */
export const TYPING_TTL_MS = 4000;

export interface TypingBeat {
  readonly founder: FounderName | null;
  readonly at: number;
}

export type TypingRoster = ReadonlyMap<string, TypingBeat>;

/** Latest founders typing on each thread. An empty list deletes the thread. */
export type TypingByThread = Readonly<Record<string, ReadonlyArray<FounderName>>>;

export interface TypingSnapshot {
  readonly threadId: string;
  readonly founders: ReadonlyArray<FounderName>;
}

/**
 * One session's beat. Stopping, or a session assigned to nobody, drops that session.
 * The same roster comes back when nothing changed.
 */
export function rosterAfterReport(
  roster: TypingRoster,
  sessionId: string,
  founder: FounderName | null,
  typing: boolean,
  now: number,
): TypingRoster {
  if (!typing || founder === null) {
    if (!roster.has(sessionId)) return roster;
    const next = new Map(roster);
    next.delete(sessionId);
    return next;
  }
  const current = roster.get(sessionId);
  if (current?.founder === founder && current.at === now) return roster;
  const next = new Map(roster);
  next.set(sessionId, { founder, at: now });
  return next;
}

/** Founders with a beat inside the window, Kameron then Jeff. A null founder is nobody. */
export function liveFounders(
  roster: TypingRoster,
  now: number,
  ttl = TYPING_TTL_MS,
): ReadonlyArray<FounderName> {
  const live = new Set<FounderName>();
  for (const beat of roster.values()) {
    if (beat.founder === null || now - beat.at >= ttl) continue;
    live.add(beat.founder);
  }
  return Founder.literals.filter((founder) => live.has(founder));
}

/** Fold one thread's snapshot into the map the sidebar and the composer both read. */
export function applyTypingSnapshot(state: TypingByThread, event: TypingSnapshot): TypingByThread {
  if (event.founders.length === 0) {
    if (!(event.threadId in state)) return state;
    const next = { ...state };
    delete next[event.threadId];
    return next;
  }
  return { ...state, [event.threadId]: event.founders };
}

/** "Jeff is typing", or both names. Nothing when nobody else is typing. */
export function typingLabel(founders: ReadonlyArray<FounderName>): string | null {
  if (founders.length === 0) return null;
  const names = founders.map(founderName);
  if (names.length === 1) return `${names[0]} is typing`;
  return `${names[0]} and ${names[1]} are typing`;
}
