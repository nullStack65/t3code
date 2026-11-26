import {
  EventSubscriptionInvalidError,
  PullRequestUnavailableError,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { prepareSubscribe } from "../../../orchestration-v2/eventSubscription.ts";
import * as EventSubscriptionStore from "../../../persistence/EventSubscriptions.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  PullRequestHostRequiredError,
  PullRequestRepositoryInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestUrlInvalidError,
  PullRequestUrlUnavailableError,
} from "../../../pullRequest/pullRequestTarget.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import { EventsToolkit, type EventSubscribeInput } from "./tools.ts";

const unavailable = () =>
  new EventSubscriptionInvalidError({
    detail: "Event subscriptions are not available on this server.",
  });

type WatchPullRequestError =
  | PullRequestWatchService.PullRequestWatchFailedError
  | PullRequestWatchService.PullRequestWatchFromSubagentError
  | PullRequestWatchService.PullRequestWatchThreadNotFoundError
  | PullRequestUrlInvalidError
  | PullRequestTargetIncompleteError
  | PullRequestHostRequiredError
  | PullRequestRepositoryInvalidError
  | PullRequestUrlUnavailableError
  | PullRequestUnavailableError;

export const subscribeEvent = Effect.fn("EventsToolkit.subscribe")(function* (input: {
  readonly callerThreadId: ThreadId;
  readonly request: EventSubscribeInput;
  readonly store: EventSubscriptionStore.EventSubscriptionStore["Service"] | null;
  readonly watchPullRequest: (url: string) => Effect.Effect<void, WatchPullRequestError>;
  readonly id: string;
  readonly createdAt: string;
}) {
  const prepared = prepareSubscribe({
    id: input.id,
    subscriberThreadId: input.callerThreadId,
    selector: input.request.selector,
    events: input.request.events,
    ignoreAuthors: input.request.ignoreAuthors,
    delivery: input.request.delivery,
    createdAt: input.createdAt,
  });
  if (!prepared.ok) return yield* prepared.error;
  if (input.store === null) return yield* unavailable();
  const selector = prepared.subscription.selector;
  if (selector.entity === "pull_request" && selector.by === "url") {
    yield* input.watchPullRequest(selector.url);
  }
  return yield* input.store.put(prepared.subscription);
});

export const layer = McpToolAccess.toLayer(
  EventsToolkit,
  Effect.gen(function* () {
    const subscriptions = yield* Effect.serviceOption(
      EventSubscriptionStore.EventSubscriptionStore,
    );
    const watches = yield* PullRequestWatchService.PullRequestWatchService;
    const random = yield* SecureRandom.SecureRandom;
    const store = Option.getOrNull(subscriptions);

    const callerThreadId = Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = scope.thread?.threadId;
      if (threadId === undefined) {
        return yield* new EventSubscriptionInvalidError({
          detail: "This tool must be called from a thread.",
        });
      }
      return threadId;
    });

    return {
      t3_event_subscribe: McpToolAccess.actsAsCaller((request) =>
        Effect.gen(function* () {
          const callerThreadId_ = yield* callerThreadId;
          const id = `evt_${yield* random.uuidV4().pipe(Effect.orDie)}`;
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          return yield* subscribeEvent({
            callerThreadId: callerThreadId_,
            request,
            store,
            id,
            createdAt,
            watchPullRequest: (url) =>
              watches
                .setWatching({
                  threadId: callerThreadId_,
                  target: { url },
                  watching: true,
                })
                .pipe(Effect.asVoid),
          });
        }),
      ),
      t3_event_unsubscribe: McpToolAccess.actsAsCaller(({ id }) =>
        Effect.gen(function* () {
          if (store === null) return yield* unavailable();
          return yield* store.remove(yield* callerThreadId, id);
        }),
      ),
      t3_event_list: McpToolAccess.readsAsCaller(() =>
        Effect.gen(function* () {
          if (store === null) return yield* unavailable();
          return { subscriptions: yield* store.listForSubscriber(yield* callerThreadId) };
        }),
      ),
    };
  }),
);
