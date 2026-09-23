// @effect-diagnostics nodeBuiltinImport:off
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";

function runtimeRow(overrides: { threadId: ThreadId; lastSeenAt: string; resumeCursor: unknown }) {
  return {
    threadId: overrides.threadId,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
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
              reason: "measured canary cohort",
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

      const declared = events.find((event) => event.eventId === "evt-canary-1");
      assert.ok(declared);
      assert.equal(declared.routeEventKind, "canary");
      assert.equal(declared.taskStratum, "implementation");
      assert.equal(declared.managerId, "ROUTE6-1");
      assert.equal(declared.agentId, "T3");
      assert.equal(declared.escalationReason, "measured canary cohort");
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
});
