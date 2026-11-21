import {
  ThreadId,
  TYPING_TTL_MS,
  liveFounders,
  rosterAfterReport,
  type Founder,
  type OrchestrationV2TypingSnapshot,
  type TypingRoster,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

/**
 * Who is typing, for every socket. The map lives for the server, not for one connection, so
 * Kameron and Jeff see each other. Nothing here is stored.
 */
export interface TypingPresence {
  readonly report: (input: {
    readonly threadId: ThreadId;
    readonly sessionId: string;
    readonly founder: Founder | null;
    readonly typing: boolean;
  }) => Effect.Effect<void, never, Clock.Clock>;
  readonly subscribe: Stream.Stream<OrchestrationV2TypingSnapshot, never, Clock.Clock>;
}

const emptyRoster: TypingRoster = new Map();

export const makeTypingPresence: Effect.Effect<TypingPresence> = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<OrchestrationV2TypingSnapshot>();
  const threads = new Map<string, TypingRoster>();

  const publish = (threadId: ThreadId, now: number) =>
    PubSub.publish(pubsub, {
      threadId,
      founders: liveFounders(threads.get(threadId) ?? emptyRoster, now),
    });

  const report: TypingPresence["report"] = Effect.fn("TypingPresence.report")(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    const current = threads.get(input.threadId) ?? emptyRoster;
    const next = rosterAfterReport(current, input.sessionId, input.founder, input.typing, now);
    if (next === current) return;
    if (next.size === 0) threads.delete(input.threadId);
    else threads.set(input.threadId, next);
    yield* publish(input.threadId, now);
    if (!input.typing || input.founder === null) return;
    const at = next.get(input.sessionId)?.at;
    if (at === undefined) return;
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.sleep(TYPING_TTL_MS);
        const roster = threads.get(input.threadId);
        const beat = roster?.get(input.sessionId);
        if (roster === undefined || beat?.at !== at) return;
        const clearedAt = yield* Clock.currentTimeMillis;
        const cleared = rosterAfterReport(roster, input.sessionId, beat.founder, false, clearedAt);
        if (cleared.size === 0) threads.delete(input.threadId);
        else threads.set(input.threadId, cleared);
        yield* publish(input.threadId, clearedAt);
      }),
    );
  });

  // Subscribe first so a beat between the snapshot and the live stream is a repeat, not a miss.
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      const now = yield* Clock.currentTimeMillis;
      const snapshot: OrchestrationV2TypingSnapshot[] = [];
      for (const [threadId, roster] of threads) {
        const founders = liveFounders(roster, now);
        if (founders.length > 0) snapshot.push({ threadId: ThreadId.make(threadId), founders });
      }
      return Stream.concat(Stream.fromIterable(snapshot), Stream.fromSubscription(subscription));
    }),
  );

  return { report, subscribe };
});
