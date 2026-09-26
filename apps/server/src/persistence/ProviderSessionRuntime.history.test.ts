// @effect-diagnostics nodeBuiltinImport:off
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";

function runtimeRow(overrides: {
  threadId: ThreadId;
  lastSeenAt: string;
  resumeCursor: unknown;
  providerName?: string;
  providerInstanceId?: ProviderInstanceId | null;
}) {
  return {
    threadId: overrides.threadId,
    providerName: overrides.providerName ?? "codex",
    providerInstanceId:
      overrides.providerInstanceId === undefined
        ? ProviderInstanceId.make("codex")
        : overrides.providerInstanceId,
    adapterKey: "codex",
    runtimeMode: "full-access" as const,
    status: "running" as const,
    lastSeenAt: overrides.lastSeenAt,
    resumeCursor: overrides.resumeCursor,
    runtimePayload: null,
  };
}

const layer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
);

interface HistoryRow {
  readonly nativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly origin: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

function historyRows(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql<HistoryRow>`
    SELECT
      native_session_id AS "nativeSessionId",
      parent_native_session_id AS "parentNativeSessionId",
      origin,
      first_seen_at AS "firstSeenAt",
      last_seen_at AS "lastSeenAt"
    FROM provider_session_history
    WHERE thread_id = ${threadId}
    ORDER BY first_seen_at ASC, native_session_id ASC
  `;
}

interface HistoryIdentityRow {
  readonly nativeSessionId: string;
  readonly providerInstanceId: string | null;
  readonly providerInstanceKey: string;
  readonly lastSeenAt: string;
}

function historyIdentityRows(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql<HistoryIdentityRow>`
    SELECT
      native_session_id AS "nativeSessionId",
      provider_instance_id AS "providerInstanceId",
      provider_instance_key AS "providerInstanceKey",
      last_seen_at AS "lastSeenAt"
    FROM provider_session_history
    WHERE thread_id = ${threadId}
    ORDER BY provider_instance_key ASC, native_session_id ASC
  `;
}

interface RequestEventRow {
  readonly eventId: string;
  readonly requestedProvider: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly selectionConflict: number;
}

function requestEventRows(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql<RequestEventRow>`
    SELECT
      event_id AS "eventId",
      requested_provider AS "requestedProvider",
      requested_model AS "requestedModel",
      requested_effort AS "requestedEffort",
      selection_conflict AS "selectionConflict"
    FROM thread_route_events
    WHERE thread_id = ${threadId} AND route_event_kind IS NULL
    ORDER BY event_id ASC
  `;
}

it.layer(layer)("ProviderSessionRuntime durable history", (it) => {
  it.effect("retains every native session when the resume cursor changes", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-history-resume");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:00:00.000Z",
          resumeCursor: { threadId: "session-a" },
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:30:00.000Z",
          resumeCursor: { threadId: "session-b" },
        }),
        { attribution: { parentNativeSessionId: "session-a" } },
      );

      const rows = yield* historyRows(sql, threadId);
      assert.deepEqual(
        rows.map((row) => row.nativeSessionId),
        ["session-a", "session-b"],
      );
      assert.equal(rows[0]!.parentNativeSessionId, null);
      assert.equal(rows[1]!.parentNativeSessionId, "session-a");
      assert.equal(rows[0]!.origin, "runtimeCursor");
      // The cursor now points at session-b, but session-a is still durable.
      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.deepEqual(runtime.resumeCursor, { threadId: "session-b" });
      expect(rows).toHaveLength(2);
    }),
  );

  it.effect("advances last_seen_at without duplicating a repeated session", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-history-repeat");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:00:00.000Z",
          resumeCursor: { resume: "same-session" },
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:45:00.000Z",
          resumeCursor: { resume: "same-session" },
        }),
      );

      const rows = yield* historyRows(sql, threadId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.firstSeenAt, "2026-09-23T09:00:00.000Z");
      assert.equal(rows[0]!.lastSeenAt, "2026-09-23T09:45:00.000Z");
    }),
  );

  it.effect("does not append history when a conflicting write is ignored", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-history-ignore");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:00:00.000Z",
          resumeCursor: { sessionId: "active" },
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:05:00.000Z",
          resumeCursor: { sessionId: "stale" },
        }),
        { onConflict: "ignore" },
      );

      const rows = yield* historyRows(sql, threadId);
      assert.deepEqual(
        rows.map((row) => row.nativeSessionId),
        ["active"],
      );
    }),
  );

  it.effect("records requested route and declared experiment metadata", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-route-events");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:00:00.000Z",
          resumeCursor: { sessionId: "ses_opencode_1" },
        }),
        {
          attribution: {
            requestedRoute: { provider: "opencode", model: "gpt-6-luna", effort: "high" },
            routeEvent: {
              eventId: "evt-canary-1",
              kind: "canary",
              taskStratum: "implementation",
              experimentId: "canary-2026-09",
              managerId: "ROUTE6-1",
              agentId: "T3",
              reason: "canary_measured",
              requested: { provider: "opencode", model: "gpt-6-luna", effort: "high" },
            },
          },
        },
      );

      const events = yield* sql<{
        eventId: string;
        routeEventKind: string | null;
        taskStratum: string;
        managerId: string | null;
        agentId: string | null;
        requestedModel: string | null;
        escalationReason: string | null;
      }>`
        SELECT
          event_id AS "eventId",
          route_event_kind AS "routeEventKind",
          task_stratum AS "taskStratum",
          manager_id AS "managerId",
          agent_id AS "agentId",
          requested_model AS "requestedModel",
          escalation_reason AS "escalationReason"
        FROM thread_route_events
        WHERE thread_id = ${threadId}
        ORDER BY recorded_at ASC, event_id ASC
      `;

      const declared = events.find(
        (event) => event.eventId === `${threadId}::declared::evt-canary-1`,
      );
      assert.ok(declared);
      assert.equal(declared.routeEventKind, "canary");
      assert.equal(declared.taskStratum, "implementation");
      assert.equal(declared.managerId, "ROUTE6-1");
      assert.equal(declared.agentId, "T3");
      assert.equal(declared.escalationReason, "canary_measured");
      assert.equal(declared.requestedModel, "gpt-6-luna");
      // An automatic request record is written alongside it, unclassified.
      const request = events.find((event) => event.eventId.includes("::request::"));
      assert.ok(request);
      assert.equal(request.routeEventKind, null);
      assert.equal(request.requestedModel, "gpt-6-luna");
      // Repeated writes collapse instead of duplicating.
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T09:10:00.000Z",
          resumeCursor: { sessionId: "ses_opencode_1" },
        }),
        {
          attribution: {
            requestedRoute: { provider: "opencode", model: "gpt-6-luna", effort: "high" },
            routeEvent: {
              eventId: "evt-canary-1",
              kind: "canary",
              taskStratum: "implementation",
              managerId: "ROUTE6-1",
              agentId: "T3",
            },
          },
        },
      );
      const after = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM thread_route_events WHERE thread_id = ${threadId}
      `;
      assert.equal(after[0]!.count, 2);
    }),
  );

  it.effect("rolls back the whole upsert when the history append fails, then retries cleanly", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-atomic-history");

      yield* sql`
        CREATE TRIGGER fail_history_write BEFORE INSERT ON provider_session_history
        BEGIN SELECT RAISE(ABORT, 'injected history failure'); END
      `;

      const failed = yield* Effect.exit(
        repository.upsert(
          runtimeRow({
            threadId,
            lastSeenAt: "2026-09-23T10:00:00.000Z",
            resumeCursor: { threadId: "atomic" },
          }),
        ),
      );
      assert.equal(Exit.isFailure(failed), true);
      // The runtime change must NOT remain: one logical upsert, all-or-nothing.
      assert.equal(Option.isNone(yield* repository.getByThreadId({ threadId })), true);
      assert.equal((yield* historyRows(sql, threadId)).length, 0);

      yield* sql`DROP TRIGGER fail_history_write`;
      // Retry after a rolled-back transaction is safe and idempotent.
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T10:00:00.000Z",
          resumeCursor: { threadId: "atomic" },
        }),
      );
      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.deepEqual(runtime.resumeCursor, { threadId: "atomic" });
      const rows = yield* historyRows(sql, threadId);
      assert.deepEqual(
        rows.map((row) => row.nativeSessionId),
        ["atomic"],
      );
    }),
  );

  it.effect("rolls back the runtime and history when a route event write fails", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-atomic-route");

      yield* sql`
        CREATE TRIGGER fail_route_event_write BEFORE INSERT ON thread_route_events
        BEGIN SELECT RAISE(ABORT, 'injected route event failure'); END
      `;

      const failed = yield* Effect.exit(
        repository.upsert(
          runtimeRow({
            threadId,
            lastSeenAt: "2026-09-23T10:10:00.000Z",
            resumeCursor: { sessionId: "route-atomic" },
          }),
          {
            attribution: {
              requestedRoute: { provider: "codex", model: "gpt-6-luna", effort: "high" },
            },
          },
        ),
      );
      assert.equal(Exit.isFailure(failed), true);
      assert.equal(Option.isNone(yield* repository.getByThreadId({ threadId })), true);
      assert.equal((yield* historyRows(sql, threadId)).length, 0);
      assert.equal((yield* requestEventRows(sql, threadId)).length, 0);

      yield* sql`DROP TRIGGER fail_route_event_write`;
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T10:10:00.000Z",
          resumeCursor: { sessionId: "route-atomic" },
        }),
        {
          attribution: {
            requestedRoute: { provider: "codex", model: "gpt-6-luna", effort: "high" },
          },
        },
      );
      const events = yield* requestEventRows(sql, threadId);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.requestedModel, "gpt-6-luna");
    }),
  );

  it.effect("keeps distinct provider-instance identities for one native session", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-instance-identity");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:00:00.000Z",
          resumeCursor: { sessionId: "ses_shared" },
          providerInstanceId: ProviderInstanceId.make("opencode-go"),
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:05:00.000Z",
          resumeCursor: { sessionId: "ses_shared" },
          providerInstanceId: ProviderInstanceId.make("cliproxy-loopback"),
        }),
      );

      const rows = yield* historyIdentityRows(sql, threadId);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.providerInstanceId),
        ["cliproxy-loopback", "opencode-go"],
      );
      // Both keep the same native session id: instance identity was the only
      // distinguishing axis, and it was not erased.
      assert.deepEqual(
        rows.map((row) => row.nativeSessionId),
        ["ses_shared", "ses_shared"],
      );
    }),
  );

  it.effect("does not let a later provider instance overwrite an earlier instance's row", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-instance-no-erase");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:10:00.000Z",
          resumeCursor: { sessionId: "ses_noerase" },
          providerInstanceId: ProviderInstanceId.make("instance-a"),
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:15:00.000Z",
          resumeCursor: { sessionId: "ses_noerase" },
          providerInstanceId: ProviderInstanceId.make("instance-b"),
        }),
      );

      const rows = yield* historyIdentityRows(sql, threadId);
      assert.equal(rows.length, 2);
      const a = rows.find((row) => row.providerInstanceKey === "instance-a");
      assert.equal(a?.providerInstanceId, "instance-a");
      // The single runtime cursor reflects the latest writer; history retains both.
      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.equal(runtime.providerInstanceId, "instance-b");
    }),
  );

  it.effect("collapses a null/unknown provider instance deterministically", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-instance-null");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:20:00.000Z",
          resumeCursor: { sessionId: "ses_unknown" },
          providerInstanceId: null,
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T11:25:00.000Z",
          resumeCursor: { sessionId: "ses_unknown" },
          providerInstanceId: null,
        }),
      );

      const rows = yield* historyIdentityRows(sql, threadId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.providerInstanceKey, "");
      assert.equal(rows[0]!.providerInstanceId, null);
    }),
  );

  it.effect("monotonically enriches an automatic request record", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-request-enrich");

      const write = (model: string | null, effort: string | null, lastSeenAt: string) =>
        repository.upsert(
          runtimeRow({
            threadId,
            lastSeenAt,
            resumeCursor: { threadId: "ses_request" },
          }),
          { attribution: { requestedRoute: { provider: "codex", model, effort } } },
        );

      // First observation has no model; a later one fills it (null -> non-null).
      yield* write(null, null, "2026-09-23T12:00:00.000Z");
      yield* write("gpt-6-luna", "high", "2026-09-23T12:01:00.000Z");
      let rows = yield* requestEventRows(sql, threadId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.requestedModel, "gpt-6-luna");
      assert.equal(rows[0]!.requestedEffort, "high");
      assert.equal(rows[0]!.selectionConflict, 0);

      // Same value is idempotent.
      yield* write("gpt-6-luna", "high", "2026-09-23T12:02:00.000Z");
      rows = yield* requestEventRows(sql, threadId);
      assert.equal(rows[0]!.requestedModel, "gpt-6-luna");
      assert.equal(rows[0]!.selectionConflict, 0);

      // A model-less recovery/stop write must not erase the known value.
      yield* write(null, null, "2026-09-23T12:03:00.000Z");
      rows = yield* requestEventRows(sql, threadId);
      assert.equal(rows[0]!.requestedModel, "gpt-6-luna");
      assert.equal(rows[0]!.requestedEffort, "high");
      assert.equal(rows[0]!.selectionConflict, 0);

      // A conflicting non-null value is retained (first wins) and surfaced.
      yield* write("gpt-7", "low", "2026-09-23T12:04:00.000Z");
      rows = yield* requestEventRows(sql, threadId);
      assert.equal(rows[0]!.requestedModel, "gpt-6-luna");
      assert.equal(rows[0]!.requestedEffort, "high");
      assert.equal(rows[0]!.selectionConflict, 1);
    }),
  );

  it.effect("scopes a globally reused declared event id per thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadA = ThreadId.make("thread-declared-a");
      const threadB = ThreadId.make("thread-declared-b");
      const declared = {
        eventId: "shared-declared-id",
        kind: "canary" as const,
        taskStratum: "implementation" as const,
      };

      yield* repository.upsert(
        runtimeRow({
          threadId: threadA,
          lastSeenAt: "2026-09-23T12:10:00.000Z",
          resumeCursor: { threadId: "ses-declared-a" },
        }),
        { attribution: { routeEvent: declared } },
      );
      yield* repository.upsert(
        runtimeRow({
          threadId: threadB,
          lastSeenAt: "2026-09-23T12:10:00.000Z",
          resumeCursor: { threadId: "ses-declared-b" },
        }),
        { attribution: { routeEvent: declared } },
      );

      const rows = yield* sql<{ readonly eventId: string; readonly threadId: string }>`
        SELECT event_id AS "eventId", thread_id AS "threadId"
        FROM thread_route_events
        WHERE route_event_kind = 'canary'
          AND thread_id IN (${threadA}, ${threadB})
        ORDER BY thread_id ASC
      `;
      // A shared declared id must not suppress the second thread's event.
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.threadId),
        ["thread-declared-a", "thread-declared-b"],
      );
      assert.equal(new Set(rows.map((row) => row.eventId)).size, 2);
    }),
  );

  it.effect("is idempotent under reordered repeated upserts", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-reorder");

      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T13:00:00.000Z",
          resumeCursor: { threadId: "order-b" },
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T13:05:00.000Z",
          resumeCursor: { threadId: "order-a" },
        }),
      );
      yield* repository.upsert(
        runtimeRow({
          threadId,
          lastSeenAt: "2026-09-23T13:10:00.000Z",
          resumeCursor: { threadId: "order-b" },
        }),
      );

      const rows = yield* historyRows(sql, threadId);
      assert.deepEqual(rows.map((row) => row.nativeSessionId).toSorted(), ["order-a", "order-b"]);
      assert.equal(rows.length, 2);
    }),
  );
});
