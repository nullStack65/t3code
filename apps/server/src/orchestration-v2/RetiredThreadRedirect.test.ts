import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  REDIRECT_LEDGER_ENV,
  recordRedirectHit,
  resolveWakeTarget,
} from "./RetiredThreadRedirect.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  // A retired thread must never reach a provider; opening a session here fails the test loudly.
  openSession: () => Effect.die("A retired thread must not open a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "retired-thread-redirect" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:retired-redirect"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

let commandCounter = 0;
const retire = (threadId: ThreadId, replacedByThreadId: ThreadId | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    commandCounter += 1;
    return yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`retire:${threadId}:${commandCounter}`),
      threadId,
      replacedByThreadId,
    });
  });

const sendMessage = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    commandCounter += 1;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${commandCounter}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${commandCounter}`),
      text: "wake up",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

/** Runs the body with the redirect ledger pointed at a fresh temporary file, then removes it. */
const withLedger = <A, E, R>(body: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-redirect-ledger-"));
      const previous = process.env[REDIRECT_LEDGER_ENV];
      process.env[REDIRECT_LEDGER_ENV] = NodePath.join(dir, "redirects.jsonl");
      return { dir, previous };
    }),
    ({ dir }) => body(NodePath.join(dir, "redirects.jsonl")),
    ({ dir, previous }) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[REDIRECT_LEDGER_ENV];
        else process.env[REDIRECT_LEDGER_ENV] = previous;
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
  );

const readLedger = (path: string) =>
  NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

it.layer(layerTest)("retired thread tombstone", (it) => {
  it.effect("sets and clears the tombstone, keeping the original retirement time", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const old = ThreadId.make("thread:tomb-old");
      const first = ThreadId.make("thread:tomb-first");
      const second = ThreadId.make("thread:tomb-second");
      yield* createThread(old);
      yield* createThread(first);
      yield* createThread(second);

      yield* retire(old, first);
      const retired = yield* projections.getThreadShell(old);
      assert.equal(retired?.replacedByThreadId, first);
      assert.isNotNull(retired?.retiredAt ?? null);

      yield* retire(old, second);
      const repointed = yield* projections.getThreadShell(old);
      assert.equal(repointed?.replacedByThreadId, second);
      assert.deepEqual(repointed?.retiredAt, retired?.retiredAt);

      yield* retire(old, null);
      const cleared = yield* projections.getThreadShell(old);
      assert.isNull(cleared?.replacedByThreadId ?? null);
      assert.isNull(cleared?.retiredAt ?? null);
    }),
  );

  it.effect("rejects a self-redirect, a cycle, and a missing replacement", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const a = ThreadId.make("thread:link-a");
      const b = ThreadId.make("thread:link-b");
      const c = ThreadId.make("thread:link-c");
      yield* createThread(a);
      yield* createThread(b);
      yield* createThread(c);
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      const self = yield* Effect.flip(retire(a, a));
      assert.equal(self._tag, "OrchestratorDispatchError");

      yield* retire(a, b);
      yield* retire(b, c);
      const cycle = yield* Effect.flip(retire(c, a));
      assert.equal(cycle._tag, "OrchestratorDispatchError");
      const direct = yield* Effect.flip(retire(b, a));
      assert.equal(direct._tag, "OrchestratorDispatchError");

      const missing = yield* Effect.flip(retire(c, ThreadId.make("thread:link-missing")));
      assert.equal(missing._tag, "OrchestratorDispatchError");

      // None of the refused links were recorded.
      assert.isNull((yield* projections.getThreadShell(c))?.replacedByThreadId ?? null);
      assert.equal((yield* projections.getThreadShell(b))?.replacedByThreadId, c);
    }),
  );

  it.effect("rejects a link that would make the chain longer than the hop limit", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 11 }, (_, index) => ThreadId.make(`thread:deep-${index}`));
      for (const id of ids) yield* createThread(id);
      // Link 0 -> 1 -> ... -> 8: eight hops, the longest allowed.
      for (let index = 0; index < 8; index += 1) yield* retire(ids[index]!, ids[index + 1]!);
      // Putting another thread in front would make nine.
      const tooLong = yield* Effect.flip(retire(ids[10]!, ids[0]!));
      assert.equal(tooLong._tag, "OrchestratorDispatchError");
    }),
  );

  it.effect("resolves multi-hop chains and records one ledger line with ids only", () =>
    withLedger((path) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const a = ThreadId.make("thread:chain-a");
        const b = ThreadId.make("thread:chain-b");
        const c = ThreadId.make("thread:chain-c");
        const caller = ThreadId.make("thread:chain-caller");
        yield* createThread(a);
        yield* createThread(b);
        yield* createThread(c);
        yield* retire(a, b);
        yield* retire(b, c);

        const wake = yield* resolveWakeTarget((id) => orchestrator.getThreadShell(id), a, {
          sourceKind: "thread_send",
          callerThreadId: caller,
        });
        assert.equal(wake.threadId, c);
        assert.equal(wake.hopCount, 2);
        assert.isTrue(wake.redirected);

        const lines = readLedger(path);
        assert.equal(lines.length, 1);
        assert.deepEqual(Object.keys(lines[0]!).toSorted(), [
          "callerThreadId",
          "hopCount",
          "redirectedToThreadId",
          "retiredThreadId",
          "sourceKind",
          "timestamp",
        ]);
        assert.equal(lines[0]!.retiredThreadId, a);
        assert.equal(lines[0]!.redirectedToThreadId, c);
        assert.equal(lines[0]!.sourceKind, "thread_send");
        assert.equal(lines[0]!.callerThreadId, caller);
        assert.equal(lines[0]!.hopCount, 2);
        assert.isFalse(Number.isNaN(Date.parse(lines[0]!.timestamp as string)));

        // A live thread resolves to itself and writes nothing.
        const live = yield* resolveWakeTarget((id) => orchestrator.getThreadShell(id), c, {
          sourceKind: "event",
        });
        assert.isFalse(live.redirected);
        assert.equal(readLedger(path).length, 1);
      }),
    ),
  );

  it.effect("fails closed on a dead end and writes no ledger line", () =>
    withLedger((path) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const old = ThreadId.make("thread:dead-old");
        const next = ThreadId.make("thread:dead-next");
        yield* createThread(old);
        yield* createThread(next);
        yield* retire(old, next);
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete:thread:dead-next"),
          threadId: next,
        });
        const error = yield* Effect.flip(
          resolveWakeTarget((id) => orchestrator.getThreadShell(id), old, { sourceKind: "event" }),
        );
        assert.equal(error._tag, "ThreadRedirectError");
        assert.equal(readLedger(path).length, 0);
      }),
    ),
  );

  it.effect("refuses a message to a retired thread and starts no run there", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const old = ThreadId.make("thread:backstop-old");
      const next = ThreadId.make("thread:backstop-next");
      yield* createThread(old);
      yield* createThread(next);
      yield* retire(old, next);

      const refused = yield* Effect.flip(sendMessage(old));
      assert.equal(refused._tag, "OrchestratorDispatchError");
      const projection = yield* orchestrator.getThreadRecords(old, ["runs", "messages"]);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.messages.length, 0);

      // Clearing the tombstone makes the thread an ordinary target again.
      yield* retire(old, null);
      assert.isNull((yield* projections.getThreadShell(old))?.replacedByThreadId ?? null);
    }),
  );
});

it.effect("recordRedirectHit never fails the wake when the ledger cannot be written", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-redirect-ledger-"));
    const previous = process.env[REDIRECT_LEDGER_ENV];
    // A file where a directory is needed: the append must fail.
    const blocker = NodePath.join(dir, "blocker");
    NodeFS.writeFileSync(blocker, "");
    process.env[REDIRECT_LEDGER_ENV] = NodePath.join(blocker, "nested", "redirects.jsonl");
    try {
      yield* recordRedirectHit({
        retiredThreadId: ThreadId.make("thread:ledger-old"),
        redirectedToThreadId: ThreadId.make("thread:ledger-new"),
        sourceKind: "pr_watch",
        hopCount: 1,
      });
    } finally {
      if (previous === undefined) delete process.env[REDIRECT_LEDGER_ENV];
      else process.env[REDIRECT_LEDGER_ENV] = previous;
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }),
);

it.effect("recordRedirectHit appends one line per hit and clips long fields", () =>
  withLedger((path) =>
    Effect.gen(function* () {
      yield* recordRedirectHit({
        retiredThreadId: ThreadId.make("thread:l-old"),
        redirectedToThreadId: ThreadId.make("thread:l-new"),
        sourceKind: "event",
        subscriptionId: "s".repeat(2000),
        prUrl: "https://github.com/o/r/pull/1",
        hopCount: 1,
      });
      yield* recordRedirectHit({
        retiredThreadId: ThreadId.make("thread:l-old"),
        redirectedToThreadId: ThreadId.make("thread:l-new"),
        sourceKind: "schedule",
        taskId: "task:1",
        hopCount: 1,
      });
      const lines = readLedger(path);
      assert.equal(lines.length, 2);
      assert.equal((lines[0]!.subscriptionId as string).length, 512);
      assert.equal(lines[0]!.prUrl, "https://github.com/o/r/pull/1");
      assert.equal(lines[1]!.taskId, "task:1");
      assert.equal(NodeFS.statSync(path).mode & 0o777, 0o600);
    }),
  ),
);
