import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTaskPlacementPolicy,
  SecretRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { encodePendingTask } from "./webhookDedupe.ts";
import { writeOwnedSchedule } from "./storedSchedule.ts";

// Phase 1 of owned (automatically placed) tasks is inert: a task an accepted placement owns, or
// one stored by a newer version, is held on every legacy path. These cases seed such rows and run
// the real service and its scheduler workers; launch, threads, secrets and folders are doubles.
const now = "2026-11-18T12:00:00.000Z";
const policy: ScheduledTaskPlacementPolicy = {
  revision: 1,
  placement: "auto",
  originEnvironmentId: EnvironmentId.make("environment-origin"),
  destinations: [
    { environmentId: EnvironmentId.make("environment-origin"), linkIncarnation: null },
  ],
  runtimeModeCeiling: "full-access",
  interactionModeCeiling: "default",
  acceptedVia: "native",
  acceptedAt: now,
};
const ownedInterval = writeOwnedSchedule({
  schedule: { type: "interval", everyMs: 60_000 },
  incarnation: "incarnation-owned",
  policy,
});
const ownedHook = writeOwnedSchedule({
  schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
  incarnation: "incarnation-hook",
  policy,
});
const newerFormat = JSON.stringify({
  format: "t3.scheduled-task.placement",
  version: 9,
  schedule: { type: "interval", everyMs: 60_000 },
});
const HELD = ["task:owned", "task:owned-hook", "task:future"];
const OWNED_TASK_HELD =
  "This task's automatic placement is not available on this server yet, so it is held.";

const insertTask = (
  sql: SqlClient.SqlClient,
  row: {
    id: string;
    scheduleJson: string;
    next?: string | null;
    status?: string;
    enabled?: number;
    threadId?: string | null;
    threadMode?: string;
    token?: string | null;
  },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: row.id,
    prompt: "Run task",
    enabled: row.enabled ?? 1,
    schedule_json: row.scheduleJson,
    project_id: "project:test",
    thread_id: row.threadId ?? null,
    thread_mode: row.threadMode ?? "new_thread",
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next ?? null,
    last_run_at: row.status === "running" ? now : null,
    last_run_status: row.status ?? "never",
    last_run_error: null,
    run_count: 0,
    webhook_token: row.token ?? null,
    webhook_secret: null,
  })}`;

const insertPending = (
  sql: SqlClient.SqlClient,
  row: { id: string; taskId: string; state: string; taskJson?: string; dueAt?: number },
) =>
  sql`INSERT INTO scheduled_task_webhook_pending ${sql.insert({
    delivery_id: row.id,
    task_id: row.taskId,
    coalesce_key: row.id,
    due_at: row.dueAt ?? 0,
    state: row.state,
    task_json: row.taskJson ?? "{}",
    request_json: JSON.stringify({
      method: "POST",
      path: "/",
      query: "",
      headers: {},
      bodyText: "{}",
    }),
    delivery_ids_json: JSON.stringify([row.id]),
  })}`;

/** Everything a held task owns, as stored: it must be byte-identical across every legacy path. */
const heldState = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  Effect.all({
    tasks: sql`SELECT * FROM scheduled_tasks WHERE task_id IN ${sql.in(ids)} ORDER BY task_id`,
    pending: sql`SELECT * FROM scheduled_task_webhook_pending WHERE task_id IN ${sql.in(ids)} ORDER BY delivery_id`,
    deliveries: sql`SELECT * FROM scheduled_task_webhook_deliveries WHERE task_id IN ${sql.in(ids)}`,
    relay: sql`SELECT * FROM scheduled_task_webhook_relay_deliveries WHERE task_id IN ${sql.in(ids)}`,
    replay: sql`SELECT * FROM scheduled_task_webhook_replay_keys WHERE task_id IN ${sql.in(ids)}`,
    occurrences: sql`SELECT * FROM scheduled_task_occurrences ORDER BY occurrence_id`,
  });

/** Holds the next call through it once armed, until the test releases it. */
interface Gate {
  armed: boolean;
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeGate = Effect.gen(function* () {
  const gate: Gate = {
    armed: false,
    started: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  return gate;
});
const pass = (gate: Gate | undefined) =>
  Effect.suspend(() => {
    if (gate === undefined || !gate.armed) return Effect.void;
    gate.armed = false;
    return Deferred.succeed(gate.started, undefined).pipe(
      Effect.andThen(Deferred.await(gate.release)),
      Effect.asVoid,
    );
  });

/** Runs `work` and waits until a span named `name` it started has ended, forked work included. */
const waitForSpan = <A, E, R>(work: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === name) Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    const result = yield* work.pipe(Effect.withTracer(tracer));
    yield* Deferred.await(done);
    return result;
  });

const makeService = (input: {
  readonly launches: Ref.Ref<number>;
  readonly consumed: Ref.Ref<number>;
  readonly workers: Map<string, Effect.Effect<void>>;
  readonly launchStarted?: Deferred.Deferred<void>;
  readonly launchGate?: Deferred.Deferred<void>;
  /** The token check's digest: after the row is read, before any admission write. */
  readonly digestGate?: Gate;
  /** The webhook origin read inside a task lookup: after its row is read, before it decodes. */
  readonly originGate?: Gate;
  /** A destination thread lookup during a save, and the shell it answers. */
  readonly shellGate?: Gate;
  readonly shell?: unknown;
}) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          Digest.Digest,
          Effect.gen(function* () {
            const real = yield* Digest.Digest;
            return {
              ...real,
              digest: (algorithm: Digest.Algorithm, data: Uint8Array) =>
                pass(input.digestGate).pipe(Effect.andThen(real.digest(algorithm, data))),
            } as typeof real;
          }),
        ).pipe(Layer.provide(NodeCrypto.layer)),
        Layer.succeed(
          ScheduledTaskService.ScheduledTaskWebhookOrigin,
          pass(input.originGate).pipe(Effect.as({ relayHookBaseUrl: null })),
        ),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Ref.update(input.launches, (n) => n + 1).pipe(
              Effect.andThen(
                input.launchStarted === undefined
                  ? Effect.void
                  : Deferred.succeed(input.launchStarted, undefined),
              ),
              Effect.andThen(
                input.launchGate === undefined ? Effect.void : Deferred.await(input.launchGate),
              ),
              Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
            ),
          isNonGitProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            pass(input.shellGate).pipe(Effect.as((input.shell ?? null) as never)),
          getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({
          consume: () => Ref.update(input.consumed, (n) => n + 1).pipe(Effect.as("secret")),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Layer.succeed(Scheduler.Scheduler, {
          register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const context = yield* Effect.context<R>();
              input.workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
            }),
        }),
      ),
    ),
  );

const upsertInput = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: ScheduledTaskId.make(id),
  title: "Renamed",
  prompt: "Run task",
  enabled: true,
  schedule: { type: "interval" as const, everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" as const },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...overrides,
});

it.effect("holds owned and newer-format tasks on every legacy path, recovery included", () =>
  Effect.gen(function* () {
    // The seeded rows are due at `now`.
    yield* TestClock.setTime(Date.parse(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, {
      id: "task:legacy",
      scheduleJson: '{"type":"interval","everyMs":60000}',
      next: now,
    });
    yield* insertTask(sql, {
      id: "task:legacy-bound",
      scheduleJson: '{"type":"interval","everyMs":60000}',
      enabled: 0,
      threadId: "thread:shared",
      threadMode: "continue",
    });
    // Left running by a build that ran it: legacy restart recovery must not touch it.
    yield* insertTask(sql, {
      id: "task:owned",
      scheduleJson: ownedInterval,
      next: now,
      status: "running",
      threadId: "thread:shared",
      threadMode: "continue",
    });
    yield* insertTask(sql, { id: "task:owned-hook", scheduleJson: ownedHook, token: "tok-owned" });
    yield* insertTask(sql, {
      id: "task:future",
      scheduleJson: newerFormat,
      next: now,
      status: "running",
      threadId: "thread:shared",
      threadMode: "continue",
      token: "tok-future",
    });
    yield* insertPending(sql, {
      id: "delivery:held-pending",
      taskId: "task:owned-hook",
      state: "pending",
    });
    yield* insertPending(sql, {
      id: "delivery:held-failed",
      taskId: "task:owned-hook",
      state: "failed",
    });
    yield* sql`INSERT INTO scheduled_task_occurrences ${sql.insert({
      occurrence_id: "occurrence:owned-1",
      origin_environment_id: "environment-origin",
      task_id: "task:owned",
      task_incarnation: "incarnation-owned",
      trigger_kind: "timer",
      trigger_key: now,
      owner_ref: null,
      command_id: "command:owned-1",
      message_id: "message:owned-1",
      request_key: "request:owned-1",
      policy_revision: 1,
      snapshot_json: "{}",
      state: "pending",
      created_at: now,
      updated_at: now,
    })}`;
    const seeded = yield* heldState(sql, HELD);

    const launches = yield* Ref.make(0);
    const consumed = yield* Ref.make(0);
    const workers = new Map<string, Effect.Effect<void>>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      // Startup recovery ran when the service was built.
      assert.deepStrictEqual(yield* heldState(sql, HELD), seeded);

      // Listed and visible, without being read as runnable work.
      const listed = yield* service.list();
      const owned = listed.tasks.find((task) => task.id === "task:owned");
      assert.strictEqual(owned?.placement?.incarnation, "incarnation-owned");
      assert.strictEqual(owned?.blockedByPolicy, OWNED_TASK_HELD);
      assert.deepStrictEqual(
        (listed.unsupported ?? []).map((task) => task.id),
        ["task:future"],
      );

      // The timer tick runs the due legacy task only.
      yield* workers.get("scheduled-tasks")!;
      assert.strictEqual(yield* Ref.get(launches), 1);

      for (const [id, message] of [
        ["task:owned", OWNED_TASK_HELD],
        [
          "task:future",
          "This task was saved by another version of T3 Code and is kept unchanged here.",
        ],
      ] as const) {
        assert.strictEqual(
          (yield* service.runNow({ id: ScheduledTaskId.make(id) }).pipe(Effect.flip)).message,
          message,
        );
      }
      // A legacy save, even title-only, never rewrites them or spends a secret.
      for (const id of HELD) {
        yield* service.upsert(upsertInput(id)).pipe(Effect.flip);
      }
      yield* service
        .upsert(
          upsertInput("task:owned-hook", {
            schedule: {
              type: "webhook",
              signature: {
                header: "x-signature",
                encoding: "hex",
                prefix: "",
                secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001"),
              },
            },
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(yield* Ref.get(consumed), 0);
      assert.strictEqual(
        (yield* service
          .rotateWebhookToken({ id: ScheduledTaskId.make("task:owned-hook") })
          .pipe(Effect.flip)).message,
        OWNED_TASK_HELD,
      );

      // Webhooks: answered as a paused hook before any claim, log, dedupe or dispatch.
      for (const [hookId, token] of [
        ["task:owned-hook", "tok-owned"],
        ["task:future", "tok-future"],
      ] as const) {
        const result = yield* service.triggerWebhook({
          hookId,
          token,
          method: "POST",
          path: `/api/hooks/${hookId}`,
          query: "",
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode("{}"),
          bodyText: "{}",
          relayDeliveryId: `relay-${hookId}`,
        });
        assert.deepStrictEqual(result, { _tag: "disabled" });
      }
      // The pending worker neither promotes, cleans up nor sends a held task's rows.
      yield* workers.get("webhook-coalescing")!;

      // Thread cleanup and moves are legacy-only.
      yield* service.deleteForThread(ThreadId.make("thread:shared"));
      yield* service.moveThreadTasks({
        threadIds: [ThreadId.make("thread:shared")],
        projectId: ProjectId.make("project:other"),
      });
      const remaining = yield* sql<{
        task_id: string;
      }>`SELECT task_id FROM scheduled_tasks ORDER BY task_id`;
      assert.deepStrictEqual(
        remaining.map((row) => row.task_id),
        ["task:future", "task:legacy", "task:owned", "task:owned-hook"],
      );

      assert.strictEqual(yield* Ref.get(launches), 1);
      assert.deepStrictEqual(yield* heldState(sql, HELD), seeded);

      // An explicit pause keeps its rules and the envelope; resuming owned work is held.
      const paused = yield* service.setEnabled({
        id: ScheduledTaskId.make("task:owned"),
        enabled: false,
      });
      assert.isFalse(paused.task.enabled);
      const [pausedRow] = yield* sql<{ schedule_json: string; enabled: number }>`
        SELECT schedule_json, enabled FROM scheduled_tasks WHERE task_id = 'task:owned'`;
      assert.deepStrictEqual(pausedRow, { schedule_json: ownedInterval, enabled: 0 });
      yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:owned"), enabled: true })
        .pipe(Effect.flip);
      assert.strictEqual(
        (yield* sql<{
          enabled: number;
        }>`SELECT enabled FROM scheduled_tasks WHERE task_id = 'task:owned'`)[0]?.enabled,
        0,
      );

      // An explicit delete removes the task; its occurrence record stays to recognize earlier work.
      yield* service.delete({ id: ScheduledTaskId.make("task:owned") });
      yield* service.delete({ id: ScheduledTaskId.make("task:future") });
      assert.lengthOf(
        yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id IN ('task:owned', 'task:future')`,
        0,
      );
      assert.deepStrictEqual(
        (yield* sql<{
          occurrence_id: string;
        }>`SELECT occurrence_id FROM scheduled_task_occurrences`).map((row) => row.occurrence_id),
        ["occurrence:owned-1"],
      );
    }).pipe(Effect.provide(makeService({ launches, consumed, workers })));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "never promotes or sends a pending delivery whose saved snapshot is an owned task's",
  () =>
    Effect.gen(function* () {
      // The seeded rows are due at `now`.
      yield* TestClock.setTime(Date.parse(now));
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, {
        id: "task:hook",
        scheduleJson: '{"type":"webhook","signature":null,"maxDeliveryAgeMinutes":null}',
        token: "tok-hook",
      });
      const launches = yield* Ref.make(0);
      const consumed = yield* Ref.make(0);
      const workers = new Map<string, Effect.Effect<void>>();
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const legacy = (yield* service.list()).tasks.find((task) => task.id === "task:hook")!;
        // A current legacy task is no authority for a snapshot an owned task saved.
        yield* insertPending(sql, {
          id: "delivery:owned-snapshot",
          taskId: "task:hook",
          state: "pending",
          taskJson: yield* encodePendingTask({
            ...legacy,
            placement: { incarnation: "incarnation-hook", policy },
          }),
        });
        const before = yield* heldState(sql, ["task:hook"]);
        yield* workers.get("webhook-coalescing")!;
        assert.deepStrictEqual(yield* heldState(sql, ["task:hook"]), before);
        assert.strictEqual(yield* Ref.get(launches), 0);
      }).pipe(Effect.provide(makeService({ launches, consumed, workers })));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a legacy run's late bookkeeping never writes a row that became owned meanwhile", () =>
  Effect.gen(function* () {
    // The seeded rows are due at `now`.
    yield* TestClock.setTime(Date.parse(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, {
      id: "task:stale",
      scheduleJson: '{"type":"interval","everyMs":60000}',
      next: now,
      threadMode: "continue",
    });
    const launches = yield* Ref.make(0);
    const consumed = yield* Ref.make(0);
    const workers = new Map<string, Effect.Effect<void>>();
    const launchStarted = yield* Deferred.make<void>();
    const launchGate = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const tick = yield* Effect.forkChild(workers.get("scheduled-tasks")!);
      yield* Deferred.await(launchStarted);
      // The run is in flight when the row becomes an owned task.
      yield* sql`UPDATE scheduled_tasks SET schedule_json = ${ownedInterval} WHERE task_id = 'task:stale'`;
      const [owned] = yield* sql`SELECT * FROM scheduled_tasks WHERE task_id = 'task:stale'`;
      yield* Deferred.succeed(launchGate, undefined);
      yield* Fiber.join(tick);
      // Completion, first-thread binding and release all left the owned row as it was.
      const [after] = yield* sql`SELECT * FROM scheduled_tasks WHERE task_id = 'task:stale'`;
      assert.deepStrictEqual(after, owned);
      assert.strictEqual(yield* Ref.get(launches), 1);
    }).pipe(
      Effect.provide(makeService({ launches, consumed, workers, launchStarted, launchGate })),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// PR76 R1 (F1–F5): a held record's bookkeeping is classified from the current raw task row and
// the raw saved snapshot at each write, not from an earlier read or a decoded object.
const plainHook = '{"type":"webhook","signature":null,"maxDeliveryAgeMinutes":null}';
const coalescingHook =
  '{"type":"webhook","signature":null,"maxDeliveryAgeMinutes":null,"dedupe":{"coalesceKey":"{{body.pr}}","coalesceWindowSeconds":60}}';
const replayHook =
  '{"type":"webhook","signature":null,"maxDeliveryAgeMinutes":null,"dedupe":{"replayKey":"{{body.id}}"}}';
const ownedOf = (scheduleJson: string) =>
  writeOwnedSchedule({
    schedule: JSON.parse(scheduleJson),
    incarnation: "incarnation-race",
    policy,
  });
const hookRequest = (hookId: string, token: string, body: unknown, relayDeliveryId?: string) => {
  const bodyText = JSON.stringify(body);
  return {
    hookId,
    token,
    method: "POST",
    path: `/api/hooks/${hookId}`,
    query: "",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(bodyText),
    bodyText,
    ...(relayDeliveryId === undefined ? {} : { relayDeliveryId }),
  };
};
const insertDelivery = (sql: SqlClient.SqlClient, id: string, taskId: string) =>
  sql`INSERT INTO scheduled_task_webhook_deliveries ${sql.insert({
    delivery_id: id,
    task_id: taskId,
    received_at: now,
    method: "POST",
    query: "",
    headers_json: "{}",
    body: "{}",
    body_bytes: 2,
    body_truncated: 0,
    outcome: "accepted",
    signature_verified: 0,
    missing_fields_json: "[]",
    rendered_prompt: null,
    error: null,
  })}`;
const setSchedule = (sql: SqlClient.SqlClient, id: string, scheduleJson: string) =>
  sql`UPDATE scheduled_tasks SET schedule_json = ${scheduleJson} WHERE task_id = ${id}`;
const services = Effect.gen(function* () {
  return {
    launches: yield* Ref.make(0),
    consumed: yield* Ref.make(0),
    workers: new Map<string, Effect.Effect<void>>(),
  };
});

it.effect(
  "F1: a legacy task's held pending snapshots keep their bytes through every worker branch",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, { id: "task:hook", scheduleJson: plainHook, token: "tok-hook" });
      const deps = yield* services;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const legacy = (yield* service.list()).tasks.find((task) => task.id === "task:hook")!;
        const snapshot = JSON.parse(yield* encodePendingTask(legacy)) as Record<string, unknown>;
        const owned = JSON.stringify({
          ...snapshot,
          placement: { incarnation: "incarnation-hook", policy },
        });
        const unsupported = JSON.stringify({
          ...snapshot,
          placement: { incarnation: "", policy: { ...policy, placement: "everywhere" } },
        });
        // Legacy-shaped, but marked as the owned schedule family: still not legacy work.
        const marked = JSON.stringify({
          ...snapshot,
          schedule: { ...(snapshot.schedule as object), format: "t3.scheduled-task.placement" },
        });
        const held = [
          { id: "delivery:held-completed", state: "completed", taskJson: owned },
          { id: "delivery:relay:held-failed", state: "failed", taskJson: owned },
          { id: "delivery:held-unsupported", state: "dispatching", taskJson: unsupported },
          { id: "delivery:held-marked", state: "running", taskJson: marked },
        ];
        for (const [index, row] of held.entries()) {
          yield* insertPending(sql, { ...row, taskId: "task:hook", dueAt: index });
        }
        yield* insertDelivery(sql, "delivery:relay:held-failed", "task:hook");
        yield* sql`INSERT INTO scheduled_task_webhook_replay_keys (task_id, replay_key, delivery_id, expires_at)
        VALUES ('task:hook', 'key-held', 'delivery:relay:held-failed', ${Date.parse(now) + 60_000})`;
        yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries (relay_delivery_id, task_id, seen_at)
        VALUES ('held-failed', 'task:hook', ${now})`;
        // An ordinary malformed legacy row behind them is still failed and removed, as before.
        yield* insertPending(sql, {
          id: "delivery:malformed",
          taskId: "task:hook",
          state: "dispatching",
          taskJson: "{}",
          dueAt: 10,
        });
        yield* insertDelivery(sql, "delivery:malformed", "task:hook");
        const heldRows = () =>
          Effect.all({
            pending: sql`SELECT * FROM scheduled_task_webhook_pending WHERE delivery_id IN ${sql.in(held.map((row) => row.id))} ORDER BY delivery_id`,
            delivery: sql`SELECT * FROM scheduled_task_webhook_deliveries WHERE delivery_id = 'delivery:relay:held-failed'`,
            replay: sql`SELECT * FROM scheduled_task_webhook_replay_keys`,
            relay: sql`SELECT * FROM scheduled_task_webhook_relay_deliveries`,
          });
        const before = yield* heldRows();
        yield* waitForSpan(
          deps.workers.get("webhook-coalescing")!,
          "ScheduledTaskService.dispatchPendingWebhook",
        );
        assert.deepStrictEqual(yield* heldRows(), before);
        assert.strictEqual(yield* Ref.get(deps.launches), 0);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = 'delivery:malformed'`,
          0,
        );
        const [malformed] = yield* sql<{ outcome: string }>`
        SELECT outcome FROM scheduled_task_webhook_deliveries WHERE delivery_id = 'delivery:malformed'`;
        assert.strictEqual(malformed?.outcome, "dispatch_failed");
      }).pipe(Effect.provide(makeService(deps)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("F1: a new request never coalesces into a window whose saved snapshot is held", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, {
      id: "task:coalesce",
      scheduleJson: coalescingHook,
      token: "tok-coalesce",
    });
    const deps = yield* services;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const first = yield* service.triggerWebhook(
        hookRequest("task:coalesce", "tok-coalesce", { pr: 1 }),
      );
      assert.strictEqual(first._tag, "accepted");
      const [window] = yield* sql<{
        task_json: string;
      }>`SELECT task_json FROM scheduled_task_webhook_pending`;
      const snapshot = JSON.parse(window!.task_json) as Record<string, unknown>;
      yield* sql`UPDATE scheduled_task_webhook_pending SET task_json = ${JSON.stringify({ ...snapshot, placement: { incarnation: "incarnation-hook", policy } })}`;
      const before = yield* heldState(sql, ["task:coalesce"]);
      const second = yield* service.triggerWebhook(
        hookRequest("task:coalesce", "tok-coalesce", { pr: 1 }, "relay-second"),
      );
      assert.deepStrictEqual(second, { _tag: "disabled" });
      assert.deepStrictEqual(yield* heldState(sql, ["task:coalesce"]), before);
      assert.strictEqual(yield* Ref.get(deps.launches), 0);
    }).pipe(Effect.provide(makeService(deps)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

for (const admission of ["immediate", "coalescing"] as const) {
  for (const becomes of ["owned", "unsupported"] as const) {
    it.effect(
      `F2: ${admission} admission writes nothing once the task became ${becomes} after its read`,
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(now));
          const sql = yield* SqlClient.SqlClient;
          const scheduleJson = admission === "immediate" ? replayHook : coalescingHook;
          yield* insertTask(sql, { id: "task:race", scheduleJson, token: "tok-race" });
          const deps = yield* services;
          const digestGate = yield* makeGate;
          yield* Effect.gen(function* () {
            const service = yield* ScheduledTaskService.ScheduledTaskService;
            digestGate.armed = true;
            const fiber = yield* Effect.forkChild(
              service.triggerWebhook(
                hookRequest("task:race", "tok-race", { id: "a", pr: 1 }, "relay-race"),
              ),
            );
            // The row was read as legacy; it changes before any admission write.
            yield* Deferred.await(digestGate.started);
            yield* setSchedule(
              sql,
              "task:race",
              becomes === "owned" ? ownedOf(scheduleJson) : newerFormat,
            );
            const before = yield* heldState(sql, ["task:race"]);
            yield* Deferred.succeed(digestGate.release, undefined);
            assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "disabled" });
            assert.deepStrictEqual(yield* heldState(sql, ["task:race"]), before);
            assert.strictEqual(yield* Ref.get(deps.launches), 0);
          }).pipe(Effect.provide(makeService({ ...deps, digestGate })));
        }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
    );
  }
}

it.effect(
  "F3: a webhook run whose row became owned before it is marked running keeps its delivery",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, { id: "task:late", scheduleJson: replayHook, token: "tok-late" });
      const deps = yield* services;
      const originGate = yield* makeGate;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        originGate.armed = true;
        const fiber = yield* Effect.forkChild(
          waitForSpan(
            service.triggerWebhook(hookRequest("task:late", "tok-late", { id: "x" }, "relay-late")),
            "ScheduledTaskService.runWebhookDelivery",
          ),
        );
        // The run's fresh lookup has read the legacy row; it becomes owned before markRunning.
        yield* Deferred.await(originGate.started);
        yield* setSchedule(sql, "task:late", ownedOf(replayHook));
        const before = yield* heldState(sql, ["task:late"]);
        yield* Deferred.succeed(originGate.release, undefined);
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "accepted");
        assert.deepStrictEqual(yield* heldState(sql, ["task:late"]), before);
        assert.strictEqual(yield* Ref.get(deps.launches), 0);
      }).pipe(Effect.provide(makeService({ ...deps, originGate })));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "F3: a pending window whose task became unsupported while it was prepared keeps its delivery",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, { id: "task:late", scheduleJson: coalescingHook, token: "tok-late" });
      const deps = yield* services;
      const originGate = yield* makeGate;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.triggerWebhook(
          hookRequest("task:late", "tok-late", { pr: 1 }, "relay-late"),
        );
        yield* TestClock.setTime(Date.parse(now) + 61_000);
        originGate.armed = true;
        const fiber = yield* Effect.forkChild(
          waitForSpan(
            deps.workers.get("webhook-coalescing")!,
            "ScheduledTaskService.dispatchPendingWebhook",
          ),
        );
        // The worker's lookup has read the legacy row; it becomes unsupported before dispatch.
        yield* Deferred.await(originGate.started);
        yield* setSchedule(sql, "task:late", newerFormat);
        const before = yield* heldState(sql, ["task:late"]);
        yield* Deferred.succeed(originGate.release, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(yield* heldState(sql, ["task:late"]), before);
        assert.strictEqual(yield* Ref.get(deps.launches), 0);
      }).pipe(Effect.provide(makeService({ ...deps, originGate })));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

for (const becomes of ["owned", "unsupported"] as const) {
  it.effect(
    `F3: a webhook run's late completion leaves a task that became ${becomes} as it is`,
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask(sql, {
          id: "task:late",
          scheduleJson: coalescingHook,
          token: "tok-late",
        });
        const deps = yield* services;
        const launchStarted = yield* Deferred.make<void>();
        const launchGate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          yield* service.triggerWebhook(
            hookRequest("task:late", "tok-late", { pr: 1 }, "relay-late"),
          );
          yield* TestClock.setTime(Date.parse(now) + 61_000);
          const fiber = yield* Effect.forkChild(
            waitForSpan(
              deps.workers.get("webhook-coalescing")!,
              "ScheduledTaskService.dispatchPendingWebhook",
            ),
          );
          yield* Deferred.await(launchStarted);
          yield* setSchedule(
            sql,
            "task:late",
            becomes === "owned" ? ownedOf(coalescingHook) : newerFormat,
          );
          const before = yield* heldState(sql, ["task:late"]);
          yield* Deferred.succeed(launchGate, undefined);
          yield* Fiber.join(fiber);
          assert.deepStrictEqual(yield* heldState(sql, ["task:late"]), before);
          assert.strictEqual(yield* Ref.get(deps.launches), 1);
        }).pipe(Effect.provide(makeService({ ...deps, launchStarted, launchGate })));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
}

it.effect("F4: another hook's traffic expires only legacy replay and relay records", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, {
      id: "task:legacy-replay",
      scheduleJson: replayHook,
      token: "tok-replay",
    });
    yield* insertTask(sql, { id: "task:owned-hook", scheduleJson: ownedHook, token: "tok-owned" });
    for (const taskId of ["task:legacy-replay", "task:owned-hook"]) {
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys (task_id, replay_key, delivery_id, expires_at)
        VALUES (${taskId}, 'expired', ${`delivery:old:${taskId}`}, 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries (relay_delivery_id, task_id, seen_at)
        VALUES (${`old:${taskId}`}, ${taskId}, '2026-01-01T00:00:00.000Z')`;
    }
    const deps = yield* services;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const result = yield* service.triggerWebhook(
        hookRequest("task:legacy-replay", "tok-replay", { id: "fresh" }, "relay-fresh"),
      );
      assert.strictEqual(result._tag, "accepted");
      const replay = yield* sql<{ task_id: string; replay_key: string }>`
        SELECT task_id, replay_key FROM scheduled_task_webhook_replay_keys ORDER BY task_id, replay_key`;
      assert.deepStrictEqual(replay, [
        {
          task_id: "task:legacy-replay",
          replay_key: replay.find((row) => row.task_id === "task:legacy-replay")!.replay_key,
        },
        { task_id: "task:owned-hook", replay_key: "expired" },
      ]);
      assert.notStrictEqual(replay[0]!.replay_key, "expired");
      const relay = yield* sql<{ relay_delivery_id: string }>`
        SELECT relay_delivery_id FROM scheduled_task_webhook_relay_deliveries ORDER BY relay_delivery_id`;
      assert.deepStrictEqual(
        relay.map((row) => row.relay_delivery_id),
        ["old:task:owned-hook", "relay-fresh"],
      );
    }).pipe(Effect.provide(makeService(deps)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("F5: a save whose task became owned while its thread was checked spends no secret", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, { id: "task:secret", scheduleJson: plainHook, token: "tok-secret" });
    const deps = yield* services;
    const shellGate = yield* makeGate;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      shellGate.armed = true;
      const fiber = yield* Effect.forkChild(
        service
          .upsert(
            upsertInput("task:secret", {
              schedule: {
                type: "webhook",
                signature: {
                  header: "x-signature",
                  encoding: "hex",
                  prefix: "",
                  secretRef: SecretRef.make("secret-ref:00000000000000000000000000000002"),
                },
              },
              threadId: ThreadId.make("thread:dest"),
            }),
          )
          .pipe(Effect.flip),
      );
      yield* Deferred.await(shellGate.started);
      yield* setSchedule(sql, "task:secret", ownedOf(plainHook));
      const before = yield* heldState(sql, ["task:secret"]);
      yield* Deferred.succeed(shellGate.release, undefined);
      const refused = yield* Fiber.join(fiber);
      assert.strictEqual(
        refused.message,
        "This task is placed automatically, so it can't be changed with this form.",
      );
      assert.strictEqual(yield* Ref.get(deps.consumed), 0);
      assert.deepStrictEqual(yield* heldState(sql, ["task:secret"]), before);
    }).pipe(
      Effect.provide(
        makeService({
          ...deps,
          shellGate,
          shell: { projectId: ProjectId.make("project:test"), archivedAt: null, deletedAt: null },
        }),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
