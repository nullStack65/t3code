import {
  EventSubscription,
  type EventSubscription as EventSubscriptionDocument,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { selectorKey } from "../orchestration-v2/eventSubscription.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type EventSubscriptionStoreError = PersistenceDecodeError | PersistenceSqlError;

const DocumentRow = Schema.Struct({
  document: Schema.fromJsonString(EventSubscription),
});

const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(EventSubscription));

export class EventSubscriptionStore extends Context.Service<
  EventSubscriptionStore,
  {
    readonly put: (
      subscription: EventSubscriptionDocument,
    ) => Effect.Effect<EventSubscriptionDocument, EventSubscriptionStoreError>;
    readonly get: (
      subscriberThreadId: ThreadId,
      key: string,
    ) => Effect.Effect<EventSubscriptionDocument | null, EventSubscriptionStoreError>;
    readonly listForSubscriber: (
      subscriberThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<EventSubscriptionDocument>, EventSubscriptionStoreError>;
    readonly listForSelector: (
      key: string,
    ) => Effect.Effect<ReadonlyArray<EventSubscriptionDocument>, EventSubscriptionStoreError>;
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<EventSubscriptionDocument>,
      EventSubscriptionStoreError
    >;
    readonly remove: (
      subscriberThreadId: ThreadId,
      id: string,
    ) => Effect.Effect<{ readonly removed: boolean }, EventSubscriptionStoreError>;
    readonly removeKey: (
      subscriberThreadId: ThreadId,
      key: string,
    ) => Effect.Effect<{ readonly removed: boolean }, EventSubscriptionStoreError>;
  }
>()("t3/persistence/EventSubscriptions/EventSubscriptionStore") {}

function toError(operation: string) {
  return (cause: unknown): EventSubscriptionStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.Struct({ subscriberThreadId: Schema.String, selectorKey: Schema.String }),
    Result: DocumentRow,
    execute: ({ subscriberThreadId, selectorKey: key }) =>
      sql`
        SELECT document_json AS "document"
        FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId} AND selector_key = ${key}
      `,
  });

  const listBySubscriber = SqlSchema.findAll({
    Request: Schema.Struct({ subscriberThreadId: Schema.String }),
    Result: DocumentRow,
    execute: ({ subscriberThreadId }) =>
      sql`
        SELECT document_json AS "document"
        FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId}
        ORDER BY created_at, id
      `,
  });

  const listBySelector = SqlSchema.findAll({
    Request: Schema.Struct({ selectorKey: Schema.String }),
    Result: DocumentRow,
    execute: ({ selectorKey: key }) =>
      sql`
        SELECT document_json AS "document"
        FROM event_subscriptions
        WHERE selector_key = ${key}
        ORDER BY created_at, id
      `,
  });

  const listEvery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: DocumentRow,
    execute: () =>
      sql`
        SELECT document_json AS "document"
        FROM event_subscriptions
        ORDER BY created_at, id
      `,
  });

  const read = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(NodeSqliteClient.readOnly, Effect.mapError(toError(operation)));

  const get = Effect.fn("EventSubscriptionStore.get")(function* (
    subscriberThreadId: ThreadId,
    key: string,
  ) {
    const row = yield* read(
      "getEventSubscription",
      findOne({ subscriberThreadId, selectorKey: key }),
    );
    return Option.getOrNull(Option.map(row, (found) => found.document));
  });

  return EventSubscriptionStore.of({
    get,
    listForSubscriber: Effect.fn("EventSubscriptionStore.listForSubscriber")(
      function* (subscriberThreadId) {
        const rows = yield* read(
          "listEventSubscriptions",
          listBySubscriber({ subscriberThreadId }),
        );
        return rows.map((row) => row.document);
      },
    ),
    listForSelector: Effect.fn("EventSubscriptionStore.listForSelector")(function* (key) {
      const rows = yield* read(
        "listEventSubscriptionsBySelector",
        listBySelector({ selectorKey: key }),
      );
      return rows.map((row) => row.document);
    }),
    listAll: Effect.fn("EventSubscriptionStore.listAll")(function* () {
      const rows = yield* read("listAllEventSubscriptions", listEvery({}));
      return rows.map((row) => row.document);
    }),
    put: Effect.fn("EventSubscriptionStore.put")(function* (subscription) {
      const key = selectorKey(subscription.selector);
      if (key === null) {
        return yield* new PersistenceDecodeError({
          operation: "putEventSubscription",
          issue: "selector is not storable",
        });
      }
      const existing = yield* get(subscription.subscriberThreadId, key);
      const stored =
        existing === null
          ? subscription
          : { ...subscription, id: existing.id, createdAt: existing.createdAt };
      const documentJson = yield* encodeDocument(stored).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("putEventSubscription", cause),
        ),
      );
      yield* sql`
        INSERT INTO event_subscriptions (
          id,
          subscriber_thread_id,
          selector_key,
          document_json,
          created_at
        )
        VALUES (
          ${stored.id},
          ${stored.subscriberThreadId},
          ${key},
          ${documentJson},
          ${stored.createdAt}
        )
        ON CONFLICT (subscriber_thread_id, selector_key)
        DO UPDATE SET document_json = excluded.document_json
      `.pipe(Effect.mapError(toError("putEventSubscription")));
      return stored;
    }),
    remove: Effect.fn("EventSubscriptionStore.remove")(
      function* (subscriberThreadId, id) {
        const existing = yield* sql<{ readonly id: string }>`
        SELECT id AS "id"
        FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId} AND id = ${id}
      `;
        if (existing.length === 0) return { removed: false };
        yield* sql`
        DELETE FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId} AND id = ${id}
      `.pipe(Effect.asVoid);
        return { removed: true };
      },
      Effect.mapError(toError("removeEventSubscription")),
    ),
    removeKey: Effect.fn("EventSubscriptionStore.removeKey")(
      function* (subscriberThreadId, key) {
        const existing = yield* sql<{ readonly id: string }>`
        SELECT id AS "id"
        FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId} AND selector_key = ${key}
      `;
        if (existing.length === 0) return { removed: false };
        yield* sql`
        DELETE FROM event_subscriptions
        WHERE subscriber_thread_id = ${subscriberThreadId} AND selector_key = ${key}
      `.pipe(Effect.asVoid);
        return { removed: true };
      },
      Effect.mapError(toError("removeEventSubscription")),
    ),
  });
});

export const layer = Layer.effect(EventSubscriptionStore, make);
