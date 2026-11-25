import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * A retired thread carries a tombstone: `replacedByThreadId` names the thread that took over.
 * Every wake aimed at a retired thread follows that chain to the live thread at its end, and no
 * wake ever starts a provider turn on a retired one.
 */

/** The longest chain a wake follows before it fails closed. */
export const MAX_REDIRECT_HOPS = 8;

/** Which wake entrypoint reached a retired thread; recorded in the redirect ledger. */
export const RedirectSourceKind = Schema.Literals(["thread_send", "schedule", "pr_watch", "event"]);
export type RedirectSourceKind = typeof RedirectSourceKind.Type;

/**
 * - `cycle`: the chain revisits a thread.
 * - `too_deep`: the chain is longer than `MAX_REDIRECT_HOPS`.
 * - `dead_end`: a replacement is missing or deleted, so there is no live thread to deliver to.
 */
export const ThreadRedirectFailureReason = Schema.Literals(["cycle", "too_deep", "dead_end"]);
export type ThreadRedirectFailureReason = typeof ThreadRedirectFailureReason.Type;

export class ThreadRedirectError extends Schema.TaggedError<ThreadRedirectError>()(
  "ThreadRedirectError",
  {
    threadId: ThreadId,
    reason: ThreadRedirectFailureReason,
    /** The retired threads visited, in order, ending at the one that failed. */
    chain: Schema.Array(ThreadId),
  },
) {
  override get message(): string {
    const path = this.chain.join(" -> ");
    switch (this.reason) {
      case "cycle":
        return `Thread ${this.threadId} is retired and its redirect chain loops (${path}).`;
      case "too_deep":
        return `Thread ${this.threadId} is retired and its redirect chain is longer than ${MAX_REDIRECT_HOPS} hops (${path}).`;
      case "dead_end":
        return `Thread ${this.threadId} is retired and its replacement is missing or deleted (${path}).`;
    }
  }
}

/** The part of a thread the resolver reads. `null` from a lookup means the thread does not exist. */
export interface ThreadRedirectNode {
  readonly replacedByThreadId?: ThreadId | null | undefined;
  readonly deletedAt?: unknown;
}

export interface ResolvedThreadTarget {
  /** The live thread to deliver to; the input thread itself when it is not retired. */
  readonly threadId: ThreadId;
  /** Number of redirects followed; 0 when the thread is not retired. */
  readonly hopCount: number;
  /** Every retired thread passed through, in order. Empty when `hopCount` is 0. */
  readonly retiredChain: ReadonlyArray<ThreadId>;
}

/**
 * Follows `replacedByThreadId` from `threadId` to the live thread at the end of the chain.
 * Fails closed with a `ThreadRedirectError` on a cycle, a chain longer than `MAX_REDIRECT_HOPS`,
 * or a replacement that is missing or deleted. A thread that is not retired resolves to itself,
 * even if it is missing: the caller's own not-found handling applies there, not a redirect.
 */
export const resolveActiveThreadTargetWith = <E, R>(
  lookup: (threadId: ThreadId) => Effect.Effect<ThreadRedirectNode | null, E, R>,
  threadId: ThreadId,
): Effect.Effect<ResolvedThreadTarget, E | ThreadRedirectError, R> =>
  Effect.gen(function* () {
    const retiredChain: ThreadId[] = [];
    const seen = new Set<ThreadId>();
    let current = threadId;
    let node = yield* lookup(current);
    for (;;) {
      const next = node?.replacedByThreadId ?? null;
      if (next === null) {
        return { threadId: current, hopCount: retiredChain.length, retiredChain };
      }
      seen.add(current);
      retiredChain.push(current);
      const fail = (reason: ThreadRedirectFailureReason) =>
        new ThreadRedirectError({ threadId, reason, chain: [...retiredChain, next] });
      if (seen.has(next)) return yield* fail("cycle");
      if (retiredChain.length > MAX_REDIRECT_HOPS) return yield* fail("too_deep");
      const target = yield* lookup(next);
      if (target === null || (target.deletedAt ?? null) !== null) {
        return yield* fail("dead_end");
      }
      current = next;
      node = target;
    }
  });

/**
 * Write-time check for retiring `threadId` behind `replacementId`. Returns the reason the link is
 * refused, or `null` when it is safe. A self-redirect or a replacement whose chain leads back to
 * `threadId` would loop; a missing or deleted replacement would dead-end every wake.
 */
export const redirectLinkError = <E, R>(
  lookup: (threadId: ThreadId) => Effect.Effect<ThreadRedirectNode | null, E, R>,
  threadId: ThreadId,
  replacementId: ThreadId,
): Effect.Effect<string | null, E, R> =>
  Effect.gen(function* () {
    if (replacementId === threadId) return "A thread cannot be redirected to itself.";
    const replacement = yield* lookup(replacementId);
    if (replacement === null || (replacement.deletedAt ?? null) !== null) {
      return `Replacement thread ${replacementId} was not found.`;
    }
    // Pretend the link exists and walk from the replacement: reaching threadId would close a loop.
    const seen = new Set<ThreadId>([threadId]);
    let current = replacementId;
    // The new link adds one hop in front of the replacement's own chain.
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      if (seen.has(current)) return "That redirect would create a cycle.";
      seen.add(current);
      const node = yield* lookup(current);
      const next = node?.replacedByThreadId ?? null;
      if (next === null) return null;
      current = next;
    }
    return `That redirect chain would be longer than ${MAX_REDIRECT_HOPS} hops.`;
  });
