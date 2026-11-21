import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { prepareSubscribe, pullRequestSelectorKey } from "../orchestration-v2/eventSubscription.ts";
import * as EventSubscriptionStore from "./EventSubscriptions.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const THREAD = ThreadId.make("thread-1");
const OTHER = ThreadId.make("thread-2");

describe("EventSubscriptionStore", () => {
  it.effect("lists the caller, updates the same selector, and unsubscribes idempotently", () =>
    Effect.gen(function* () {
      const store = yield* EventSubscriptionStore.EventSubscriptionStore;
      const prepared = prepareSubscribe({
        id: "evt_1",
        subscriberThreadId: THREAD,
        selector: {
          entity: "pull_request",
          by: "url",
          url: "https://github.com/T3Tools/t3code/pull/12",
        },
        events: [{ name: "comment.human" }],
        createdAt: "2026-11-21T15:30:00.000Z",
      });
      assert.strictEqual(prepared.ok, true);
      if (!prepared.ok) return;
      yield* store.put(prepared.subscription);
      const again = yield* store.put({ ...prepared.subscription, id: "evt_replaced" });
      assert.strictEqual(again.id, "evt_1");
      const listed = yield* store.listForSubscriber(THREAD);
      assert.strictEqual(listed.length, 1);
      assert.deepEqual(yield* store.listForSubscriber(OTHER), []);
      const removed = yield* store.remove(THREAD, "evt_1");
      assert.strictEqual(removed.removed, true);
      assert.strictEqual((yield* store.remove(THREAD, "evt_1")).removed, false);
      assert.strictEqual((yield* store.remove(OTHER, "evt_1")).removed, false);
      const closed = yield* store.put({
        ...prepared.subscription,
        delivery: { ...prepared.subscription.delivery, autoExpireOnClose: true },
      });
      const key = pullRequestSelectorKey(
        closed.selector.entity === "pull_request" && closed.selector.by === "url"
          ? closed.selector.url
          : "",
      );
      assert.ok(key !== null);
      if (key === null) return;
      const expired = yield* store.removeKey(THREAD, key);
      assert.strictEqual(expired.removed, true);
      assert.deepEqual(yield* store.listForSubscriber(THREAD), []);
    }).pipe(
      Effect.provide(
        EventSubscriptionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  );
});
