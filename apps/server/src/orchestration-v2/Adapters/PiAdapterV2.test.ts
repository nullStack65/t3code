import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { makePiAdapterV2, PI_PROVIDER } from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  /** Inject exactly one stdout chunk, without adding delimiters. */
  readonly emitRaw: (chunk: string | Uint8Array) => Effect.Effect<void>;
  /** Emit all records as newline-delimited JSON in one stdout chunk. */
  readonly emitBatch: (records: ReadonlyArray<PiRpcRecord>) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  /** Wait for the get_state request that was explicitly deferred. */
  readonly takeDeferredState: Effect.Effect<PiRpcRecord>;
  /** Hold the next switch_session response until explicitly resolved. */
  readonly deferNextSwitch: () => void;
  /** Capture the actual deferred switch request, including its generated id. */
  readonly takeDeferredSwitch: Effect.Effect<PiRpcRecord>;
  /**
   * Resolve the oldest held switch and emit before/response/after in one chunk.
   * Defaults preserve the normal successful ack, including any queued veto.
   * Returns the emitted response for explicit duplicate-response injection.
   */
  readonly resolveDeferredSwitch: (options?: {
    readonly success?: boolean;
    readonly cancelled?: boolean;
    readonly command?: string;
    readonly error?: unknown;
    readonly before?: ReadonlyArray<PiRpcRecord>;
    readonly after?: ReadonlyArray<PiRpcRecord>;
  }) => Effect.Effect<PiRpcRecord>;
  /** Data returned by the next `get_entries` acks, consumed in order. */
  readonly queueEntries: (data: unknown) => void;
  /** Data returned by the next active-branch `get_messages` acks. */
  readonly queueMessages: (data: unknown) => void;
  /** Make the next `switch_session` ack report an extension veto. */
  readonly vetoNextSwitch: () => void;
  /** Data returned by the next `get_state` acks, consumed in order. */
  readonly queueState: (data: unknown) => void;
  /** Hold the next `get_state` response until the test resolves it. */
  readonly deferNextState: () => void;
  /** Resolve the held `get_state` request. */
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  /** Reject the next `get_state` request. */
  readonly failNextState: () => void;
  /** Every request received by the fake process. */
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  /** Data returned by the next `get_session_stats` acks, consumed in order. */
  readonly queueStats: (data: unknown) => void;
  /** Data returned by the next `get_commands` acks, consumed in order. */
  readonly queueCommands: (data: unknown) => void;
  /** Make the next `get_commands` ack fail. */
  readonly failNextCommands: () => void;
  /** Make the next abort request return a negative RPC response. */
  readonly failNextAbort: () => void;
  /** Hold the next abort response while native events accumulate. */
  readonly deferNextAbort: () => void;
  readonly takeDeferredAbort: Effect.Effect<PiRpcRecord>;
  readonly resolveDeferredAbort: (success?: boolean) => Effect.Effect<void>;
  /** Close the fake process stdout stream. */
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  };
}

/**
 * In-process fake `pi --mode rpc`: captures every stdin record, auto-acks
 * requests with canned data, and lets tests push protocol events to stdout.
 */
const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const deferredStateRequests = yield* Queue.unbounded<PiRpcRecord>();
  const deferredSwitchRequests = yield* Queue.unbounded<PiRpcRecord>();
  const deferredAbortRequests = yield* Queue.unbounded<PiRpcRecord>();
  const pendingSwitches: Array<{
    readonly request: PiRpcRecord;
    readonly cancelled: boolean;
  }> = [];
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<unknown> = [];
  const statsQueue: Array<unknown> = [];
  const commandsQueue: Array<{ readonly success: boolean; readonly data?: unknown }> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateRequest: PiRpcRecord | undefined;
  let deferSwitch = false;
  let failState = false;
  let failAbort = false;
  let deferAbort = false;
  let deferredAbortRequest: PiRpcRecord | undefined;
  let vetoSwitch = false;
  let currentModel: { provider: string; id: string } | null = null;
  let currentSessionFile = FAKE_SESSION_FILE;
  let stdinBuffer = "";

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const emitRaw = (chunk: string | Uint8Array): Effect.Effect<void> =>
    Queue.offer(
      stdout,
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice(),
    ).pipe(Effect.asVoid);

  const emitBatch = (records: ReadonlyArray<PiRpcRecord>): Effect.Effect<void> =>
    emitRaw(records.map((record) => `${encodeJsonLine(record)}\n`).join(""));

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (typeof record["id"] !== "string") return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failState) {
          failState = false;
          return { ...base, success: false, error: "state unavailable" };
        }
        const queuedState = stateQueue.shift();
        return {
          ...base,
          data: {
            model: currentModel,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            autoCompactionEnabled: true,
            sessionFile: currentSessionFile,
            sessionId: "abc",
            ...(queuedState !== null && typeof queuedState === "object" ? queuedState : {}),
          },
        };
      case "set_model":
        currentModel = {
          provider: String(record["provider"]),
          id: String(record["modelId"]),
        };
        return { ...base, data: { model: currentModel } };
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        if (!cancelled && typeof record["sessionPath"] === "string") {
          currentSessionFile = record["sessionPath"];
        }
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "get_commands":
        return { ...base, ...(commandsQueue.shift() ?? { data: { commands: [] } }) };
      case "abort":
        if (failAbort) {
          failAbort = false;
          return { ...base, success: false, error: "abort rejected" };
        }
        return base;
      case "fork":
        return { ...base, data: { cancelled: false, message: "forked" } };
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        allRequests.push(record);
        if (record["type"] === "get_state" && deferState) {
          deferState = false;
          deferredStateRequest = record;
          yield* Queue.offer(deferredStateRequests, record);
        } else if (record["type"] === "switch_session" && deferSwitch) {
          deferSwitch = false;
          assert.isString(record["id"]);
          pendingSwitches.push({ request: record, cancelled: vetoSwitch });
          vetoSwitch = false;
          yield* Queue.offer(deferredSwitchRequests, record);
        } else if (record["type"] === "abort" && deferAbort) {
          deferAbort = false;
          deferredAbortRequest = record;
          yield* Queue.offer(deferredAbortRequests, record);
        } else {
          const response = respondTo(record);
          if (response !== null) yield* emit(response);
        }
        yield* Queue.offer(requests, record);
      }
    });

  let lastSpawn: { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args,
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    emit,
    emitRaw,
    emitBatch,
    takeRequest,
    takeDeferredState: Queue.take(deferredStateRequests),
    deferNextSwitch: () => {
      deferSwitch = true;
    },
    takeDeferredSwitch: Queue.take(deferredSwitchRequests),
    resolveDeferredSwitch: (options = {}) =>
      Effect.gen(function* () {
        const pending = pendingSwitches[0];
        assert.isDefined(pending);
        const record = pending!.request;
        assert.isString(record["id"]);
        const success = options.success ?? true;
        const cancelled = options.cancelled ?? pending!.cancelled;
        const response: PiRpcRecord = {
          type: "response",
          id: record["id"],
          command: options.command ?? "switch_session",
          success,
          data: { cancelled },
          ...(success ? {} : { error: options.error ?? "switch unavailable" }),
        };
        const batch = [...(options.before ?? []), response, ...(options.after ?? [])];
        const chunk = batch.map((item) => `${encodeJsonLine(item)}\n`).join("");
        pendingSwitches.shift();
        if (success && !cancelled && typeof record["sessionPath"] === "string") {
          currentSessionFile = record["sessionPath"];
        }
        yield* emitRaw(chunk);
        return response;
      }),
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: () => {
      deferState = true;
    },
    resolveDeferredState: (data) =>
      Effect.gen(function* () {
        const record = deferredStateRequest;
        assert.isDefined(record);
        deferredStateRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "get_state",
          success: true,
          data,
        });
      }),
    failNextState: () => {
      failState = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    queueState: (data) => stateQueue.push(data),
    queueStats: (data) => statsQueue.push(data),
    queueCommands: (data) => commandsQueue.push({ success: true, data }),
    failNextCommands: () => commandsQueue.push({ success: false }),
    failNextAbort: () => {
      failAbort = true;
    },
    deferNextAbort: () => {
      deferAbort = true;
    },
    takeDeferredAbort: Queue.take(deferredAbortRequests),
    resolveDeferredAbort: (success = true) =>
      Effect.gen(function* () {
        const record = deferredAbortRequest;
        assert.isDefined(record);
        deferredAbortRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "abort",
          success,
          ...(success ? {} : { error: "abort rejected" }),
        });
      }),
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (fake: FakePi, launchArgs = "", forkFake?: FakePi) {
  const idAllocator = yield* IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs, customModels: [] },
    environment: {},
    spawner:
      forkFake === undefined
        ? fake.spawner
        : ChildProcessSpawner.make((command) =>
            ChildProcess.isStandardCommand(command) && command.args.includes("--fork")
              ? forkFake.spawner.spawn(command)
              : fake.spawner.spawn(command),
          ),
    fileSystem,
    idAllocator,
    serverConfig,
  });
});

const openRuntime = Effect.fnUntraced(function* (
  fake: FakePi,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
  forkFake?: FakePi,
) {
  const adapter = yield* makeAdapter(fake, "", forkFake);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello pi",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

const errorText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    parts.push(String(current));
    if (typeof current !== "object" || current === null) break;
    if (Cause.isCause(current)) {
      parts.push(Cause.pretty(current));
      if ("error" in current) {
        current = current.error;
        continue;
      }
    }
    if ("cause" in current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return parts.join("\n");
};

const expectModelFailure = (errorMessage: string) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const { runtime, takeEvent } = yield* openRuntime(fake);
    const providerThread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    yield* startTurn(runtime, providerThread);
    yield* fake.takeRequest("prompt");
    yield* fake.emit({ type: "agent_start" });
    yield* fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      },
    });
    yield* fake.emit({ type: "agent_settled" });

    const sessionError = yield* takeEvent(
      (event) =>
        event.type === "provider_session.updated" && event.providerSession.status === "error",
    );
    assert.isTrue(
      sessionError.type === "provider_session.updated" &&
        sessionError.providerSession.lastError === errorMessage,
    );
    const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
    assert.isTrue(
      terminal.type === "turn.terminal" &&
        terminal.status === "failed" &&
        terminal.failure.message === errorMessage,
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer));

describe("PiAdapterV2", () => {
  it.effect("refuses a stale explicit model before sending and allows a clean retry", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({
        model: { provider: "wrong", id: "stale" },
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      const refused = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "should not run",
        modelSelection("openai/gpt-5"),
      ).pipe(Effect.flip);
      assert.match(errorText(refused), /readiness model does not match/);
      assert.equal(fake.allRequests().filter((request) => request["type"] === "prompt").length, 0);
      assert.equal(fake.allRequests().filter((request) => request["type"] === "compact").length, 0);

      fake.queueState({
        model: { provider: "openai", id: "gpt-5" },
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "retry works",
        modelSelection("openai/gpt-5"),
        2,
      );
      assert.equal((yield* fake.takeRequest("prompt"))["message"], "retry works");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("blocks prompt and compact after a startup extension error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextState();
      const started = yield* startTurn(runtime, providerThread).pipe(Effect.forkScoped);
      yield* fake.takeDeferredState;
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "startup hook failed",
      });
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      const promptResult = yield* Effect.exit(Fiber.join(started));
      assert.isTrue(promptResult._tag === "Failure");
      if (promptResult._tag === "Failure") {
        assert.match(errorText(promptResult.cause), /startup extension failure/);
      }
      assert.equal(fake.allRequests().filter((request) => request["type"] === "prompt").length, 0);
      const compactResult = yield* Effect.exit(
        startTurn(runtime, providerThread, "default", [], "/compact", undefined, 2),
      );
      assert.isTrue(compactResult._tag === "Failure");
      if (compactResult._tag === "Failure") {
        assert.match(errorText(compactResult.cause), /startup extension failure/);
      }
      assert.equal(fake.allRequests().filter((request) => request["type"] === "prompt").length, 0);
      assert.equal(fake.allRequests().filter((request) => request["type"] === "compact").length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("latches a startup extension error during deferred readiness", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextState();
      const started = yield* startTurn(runtime, providerThread).pipe(Effect.forkScoped);
      yield* fake.takeDeferredState;
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "deferred startup hook failed",
      });
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      const result = yield* Effect.exit(Fiber.join(started));
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.match(errorText(result.cause), /deferred startup hook failed/);
      }
      assert.equal(fake.allRequests().filter((request) => request["type"] === "prompt").length, 0);
      assert.equal(fake.allRequests().filter((request) => request["type"] === "compact").length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("aborts an active turn after a before_agent_start extension error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "captured prompt");
      assert.equal((yield* fake.takeRequest("prompt")).message, "captured prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "active startup hook failed",
      });

      assert.equal((yield* fake.takeRequest("abort")).type, "abort");
      const diagnostic = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        diagnostic.type === "turn_item.updated" &&
          diagnostic.turnItem.type === "error" &&
          diagnostic.turnItem.failure.retryable === false &&
          diagnostic.turnItem.failure.message.includes("active startup hook failed"),
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("active startup hook failed") &&
          terminal.failure.retryable === false,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("terminates Pi and preserves the startup failure when abort is rejected", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "captured prompt");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      fake.failNextAbort();
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "abort fallback startup failure",
      });

      assert.equal((yield* fake.takeRequest("abort")).type, "abort");
      // Model the process exit after the failed abort so transport teardown
      // finalizes the active turn through the fallback path.
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("abort fallback startup failure") &&
          terminal.failure.retryable === false,
      );
      const stopped = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
      assert.equal(stopped.type, "provider_session.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a startup failure through queued retry and compaction recovery events", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "captured prompt");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      fake.deferNextAbort();
      yield* fake.emitBatch([
        {
          type: "extension_error",
          extensionPath: "/workspace/omp-extension.ts",
          event: "before_agent_start",
          error: "queued recovery startup failure",
        },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "temporary" },
        { type: "auto_retry_end", attempt: 1, success: true },
        { type: "compaction_start" },
        {
          type: "compaction_end",
          willRetry: true,
          result: { summary: "recovered context", estimatedTokensAfter: 12 },
        },
        { type: "agent_settled" },
      ]);

      yield* fake.takeDeferredAbort;
      yield* fake.resolveDeferredAbort();
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("queued recovery startup failure") &&
          terminal.failure.retryable === false,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("protects parser-admitted prompt writes and recovers after a session reset", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      fake.deferNextState();
      const starting = yield* startTurn(runtime, providerThread).pipe(Effect.forkScoped);
      yield* fake.takeDeferredState;
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "parser-admitted startup failure",
      });
      const result = yield* Effect.exit(Fiber.join(starting));
      assert.isTrue(result._tag === "Failure");
      assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 0);

      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-positive",
        method: "confirm",
        title: "Continue?",
        message: "The dialog remains ordinary transport.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      const dialogResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(dialogResponse.type, "extension_ui_response");
      assert.equal(dialogResponse.id, "ui-positive");
      assert.equal(dialogResponse.confirmed, true);

      yield* runtime.resumeThread({ providerThread });
      yield* fake.takeRequest("switch_session");
      yield* startTurn(runtime, providerThread, "default", [], "clean recovery");
      assert.equal((yield* fake.takeRequest("prompt"))["message"], "clean recovery");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restores the prior compact flag when parser intake refuses a steer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      if (running.type !== "provider_turn.updated") return;
      yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      const steering = yield* runtime
        .steerTurn({
          threadId: THREAD_ID,
          runId: RunId.make("run:thread-pi-test:1"),
          providerThread,
          providerTurnId: running.providerTurn.id,
          message: {
            messageId: "message:thread-pi-test:parser-compact" as never,
            text: "/compact parser race",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* fake.takeDeferredState;
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: FAKE_SESSION_FILE,
      });
      yield* fake.emit({
        type: "extension_error",
        extensionPath: "/workspace/omp-extension.ts",
        event: "before_agent_start",
        error: "steer compact refused",
      });
      const result = yield* Effect.exit(Fiber.join(steering));
      assert.isTrue(result._tag === "Failure");
      assert.equal(fake.allRequests().filter((request) => request.type === "compact").length, 0);

      yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
      assert.equal((yield* fake.takeRequest("abort")).type, "abort");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects every nonzero or malformed pending message count", () =>
    Effect.gen(function* () {
      for (const pendingMessageCount of [undefined, "0", -1, 1]) {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.queueState({
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount,
          sessionFile: FAKE_SESSION_FILE,
        });
        fake.queueState({
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount,
          sessionFile: FAKE_SESSION_FILE,
        });
        const promptFailure = yield* startTurn(runtime, providerThread).pipe(Effect.flip);
        assert.match(errorText(promptFailure), /not positively ready/);
        const compactFailure = yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          "/compact",
          undefined,
          2,
        ).pipe(Effect.flip);
        assert.match(errorText(compactFailure), /not positively ready/);
        assert.equal(
          fake.allRequests().filter((request) => request["type"] === "prompt").length,
          0,
        );
        assert.equal(
          fake.allRequests().filter((request) => request["type"] === "compact").length,
          0,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops provider-initiated work that has no T3 turn owner", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* fake.emit({ type: "agent_start" });

      const sessionError = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.isTrue(
        sessionError.type === "provider_session.updated" &&
          sessionError.providerSession.lastError?.includes("invisible tool execution") === true,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-pi-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-pi-token",
        browserToolsAvailable: true,
      });
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.isTrue(spawn.args.includes("--extension"));
      const extensions = spawn.args.flatMap((arg, index) =>
        arg === "--extension" ? [spawn.args[index + 1]] : [],
      );
      assert.isFalse(spawn.args.includes("--no-extensions"));
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
      assert.equal(spawn.env.T3_PI_RUNTIME_MODE, "full-access");
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("registers the thread from get_state and resumes via switch_session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.equal(providerThread.driver, PI_PROVIDER);
      assert.isFalse(fake.lastSpawn().args.includes("--no-extensions"));

      yield* runtime.resumeThread({ providerThread });
      const switchRequest = yield* fake.takeRequest("switch_session");
      assert.equal(switchRequest["sessionPath"], FAKE_SESSION_FILE);

      yield* startTurn(runtime, providerThread, "anthropic/claude-sonnet");
      const setModel = yield* fake.takeRequest("set_model");
      assert.equal(setModel["provider"], "anthropic");
      assert.equal(runtime.providerSession.model, "anthropic/claude-sonnet");
      yield* fake.takeRequest("prompt");
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(error.cause), /while a turn is active/);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("adopts the run's provider thread identity instead of minting a second row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const now = yield* DateTime.now;
      // The placeholder row the orchestrator creates for a first run: no
      // native identity yet. The adapter must bind the pi session to this
      // row instead of registering a second session-file-keyed row, or the
      // projection ends up with two live rows per app thread.
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:pi:native-thread:pending:run:thread-pi-test:1"),
        driver: PI_PROVIDER,
        providerInstanceId: PI_INSTANCE_ID,
        providerSessionId: SESSION_ID,
        appThreadId: THREAD_ID,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: placeholder,
      });
      assert.equal(providerThread.id, placeholder.id);
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      const updated = yield* takeEvent((event) => event.type === "provider_thread.updated");
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === placeholder.id,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resets applied thinking when returning to Pi default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "medium",
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      // An explicit effort on a concrete model.
      yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
        instanceId: PI_INSTANCE_ID,
        model: "xai/grok-4.6",
        options: [{ id: "thinking", value: "high" }],
      });
      const modelRequest = yield* fake.takeRequest("set_model");
      assert.equal(modelRequest["provider"], "xai");
      assert.equal(modelRequest["modelId"], "grok-4.6");
      const levelRequest = yield* fake.takeRequest("set_thinking_level");
      assert.equal(levelRequest["level"], "high");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      // Back to Pi default with no explicit thinking choice of its own.
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        {
          instanceId: PI_INSTANCE_ID,
          model: "default",
        },
        2,
      );
      const replayModel = yield* fake.takeRequest("set_model");
      assert.equal(replayModel["provider"], "xai");
      assert.equal(replayModel["modelId"], "grok-4.6");
      const resetLevel = yield* fake.takeRequest("set_thinking_level");
      assert.equal(resetLevel["level"], "medium");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("expands a selected $ skill through Pi's native skill command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            description: "Review this repository.",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Review this change please $repo-review",
      );
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review Review this change please");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("expands every selected $ skill through Pi native skill commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "skill:deploy",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/deploy/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "use $repo-review and $deploy");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review /skill:deploy use  and");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("streams assistant text and settles a completed turn on agent_settled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      // The model's context window is what live usage is measured against.
      fake.queueState({
        model: { provider: "openai", id: "gpt-5", contextWindow: 200_000 },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Hello pi");
      // Fire-and-forget: extension slash commands can hold the ack open on a
      // user dialog, so the prompt must carry no correlation id to await.
      assert.equal(prompt["id"], undefined);

      // A normal prompt ack only confirms that Pi accepted the command. Agent
      // activity may follow it, so the adapter must still wait for settlement.
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
      const streamedUsage = {
        input: 1_000,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_002,
      };
      // Providers that report no usage until completion stream zeros first.
      yield* fake.emit({
        type: "message_update",
        usage: zeroUsage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      });
      yield* fake.emit({
        type: "message_update",
        usage: streamedUsage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
      });
      // An unchanged total must not re-emit the turn.
      yield* fake.emit({
        type: "message_update",
        usage: streamedUsage,
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          stopReason: "stop",
        },
      });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      fake.queueStats({
        tokens: { input: 12_000, output: 500, cacheRead: 8_000, cacheWrite: 0, total: 20_500 },
        toolCalls: 3,
        contextUsage: { tokens: 20_500, contextWindow: 200_000, percent: 10.25 },
      });
      yield* fake.emit({ type: "agent_settled" });

      const startedTurn = yield* takeEvent((event) => event.type === "provider_turn.updated");
      assert.isTrue(
        startedTurn.type === "provider_turn.updated" &&
          startedTurn.providerTurn.status === "running" &&
          startedTurn.providerTurn.tokenUsage === undefined,
      );
      // Streaming usage moves the meter while the turn is still running.
      const liveTurn = yield* takeEvent((event) => event.type === "provider_turn.updated");
      const { updatedAt: liveUpdatedAt, ...liveUsage } =
        liveTurn.type === "provider_turn.updated" ? (liveTurn.providerTurn.tokenUsage ?? {}) : {};
      assert.isTrue(
        liveTurn.type === "provider_turn.updated" && liveTurn.providerTurn.status === "running",
      );
      assert.isString(liveUpdatedAt);
      assert.deepEqual(liveUsage, {
        usedTokens: 1_002,
        maxTokens: 200_000,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 2,
      });
      // The repeated total emits nothing: the next turn or item event is the
      // completed assistant message, not another usage update.
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" ||
          (event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.streaming === false),
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Hello",
      );
      // Session stats ride on the settled provider turn so the shared meter
      // picks them up through the base's per-turn `tokenUsage` (#8144).
      const completedTurn = yield* takeEvent((event) => event.type === "provider_turn.updated");
      assert.isTrue(
        completedTurn.type === "provider_turn.updated" &&
          completedTurn.providerTurn.status === "completed",
      );
      const { updatedAt, ...tokenUsage } =
        completedTurn.type === "provider_turn.updated"
          ? (completedTurn.providerTurn.tokenUsage ?? {})
          : {};
      assert.isString(updatedAt);
      assert.deepEqual(tokenUsage, {
        usedTokens: 20_500,
        maxTokens: 200_000,
        inputTokens: 12_000,
        cachedInputTokens: 8_000,
        outputTokens: 500,
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      // An acknowledged stats request can still omit usable window values.
      // That turn then carries no report, so the meter keeps the last one.
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      fake.queueStats({ contextUsage: { tokens: null, contextWindow: 200_000 } });
      yield* fake.emit({ type: "agent_settled" });
      const unreportedTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.isUndefined(
        unreportedTurn.type === "provider_turn.updated"
          ? unreportedTurn.providerTurn.tokenUsage
          : null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("captures session-tree refs at turn boundaries and rolls back via fork", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      // First get_entries ack baselines the leaf during ensureThread; the
      // second answers the finalize capture with this turn's user entry.
      fake.queueEntries({ entries: [], leafId: "leaf-0" });
      fake.queueEntries({
        entries: [{ type: "message", id: "u1", message: { role: "user" } }],
        leafId: "a1",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const finalTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        finalTurn.type === "provider_turn.updated" &&
          finalTurn.providerTurn.nativeTurnRef?.nativeId === "u1" &&
          finalTurn.providerTurn.nativeTurnRef.strength === "strong",
      );

      const turnRef = (ordinal: number, nativeId: string): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`provider-turn:test:${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node:test:${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const forkFile = "/fake/rolled-back.jsonl";
      fake.queueState({ sessionFile: forkFile });
      const rollbackSnapshot = yield* runtime.rollbackThread({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:test:1"),
          appRunOrdinal: 1,
          providerTurn: turnRef(1, "u1"),
        },
        providerThreadTurns: [turnRef(1, "u1"), turnRef(2, "u2")],
      });
      const fork = yield* fake.takeRequest("fork");
      assert.equal(fork["entryId"], "u2");
      assert.equal(rollbackSnapshot.providerThread.id, providerThread.id);
      assert.equal(rollbackSnapshot.providerThread.nativeThreadRef?.nativeId, forkFile);
      yield* runtime.resumeThread({ providerThread: rollbackSnapshot.providerThread });
      const resume = yield* fake.takeRequest("switch_session");
      assert.equal(resume["sessionPath"], forkFile);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const historical of [false, true]) {
    it.effect(
      `natively forks ${historical ? "a historical turn" : "the latest turn"} into an independent session`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFakePi;
          const forkFake = yield* makeFakePi;
          const forkFile = "/fake/forked.jsonl";
          const { runtime, takeEvent } = yield* openRuntime(
            fake,
            "default",
            THREAD_ID,
            SESSION_ID,
            forkFake,
          );
          const source = yield* runtime.ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
          });
          const turn = (ordinal: number): OrchestrationV2ProviderTurn => ({
            id: ProviderTurnId.make(`turn-${ordinal}`),
            providerThreadId: source.id,
            nodeId: NodeId.make(`node-${ordinal}`),
            runAttemptId: null,
            nativeTurnRef: { driver: PI_PROVIDER, nativeId: `u${ordinal}`, strength: "strong" },
            ordinal,
            status: "completed",
            startedAt: null,
            completedAt: null,
          });
          forkFake.queueState({ sessionFile: forkFile });
          fake.queueState({ sessionFile: forkFile });
          const target = ThreadId.make("fork-target");
          const forked = yield* runtime.forkThread({
            sourceProviderThread: source,
            sourceProviderTurns: historical ? [turn(1), turn(2)] : [turn(1)],
            providerTurnId: turn(1).id,
            targetThreadId: target,
          });
          assert.equal(forked.appThreadId, target);
          assert.equal(forked.nativeThreadRef?.nativeId, forkFile);
          assert.notEqual(forked.id, source.id);
          assert.equal(source.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
          const args = forkFake.lastSpawn().args;
          assert.equal(args[args.indexOf("--fork") + 1], FAKE_SESSION_FILE);
          assert.include(args, "--no-extensions");
          assert.include(args, "--no-tools");
          assert.notInclude(args, "--no-session");
          assert.deepEqual(
            forkFake
              .allRequests()
              .filter((request) => request.type === "fork")
              .map((request) => request.entryId),
            historical ? ["u2"] : [],
          );
          assert.isFalse(
            fake
              .allRequests()
              .some((request) => request.type === "fork" || request.type === "clone"),
          );
          // ProviderTurnStartService adopts the fork into its pending row.
          const adopted = { ...forked, id: ProviderThreadId.make("pending-fork-row") };
          yield* startTurn(runtime, adopted, "default", [], "Continue", undefined, 1, target);
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "agent_settled" });
          const updated = yield* takeEvent(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.appThreadId === target,
          );
          assert.isTrue(
            updated.type === "provider_thread.updated" && updated.providerThread.id === adopted.id,
          );
          yield* takeEvent((event) => event.type === "turn.terminal");
          yield* runtime.resumeThread({ providerThread: adopted });
          assert.equal(
            fake.allRequests().findLast((request) => request.type === "switch_session")
              ?.sessionPath,
            forkFile,
          );
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  it.effect("observes official subagent results without inventing child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                sessionFile: "/ignored/custom-extension-session.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === null,
      );

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" &&
          doneCard.subagent.result === "repo has one file" &&
          doneCard.subagent.childThreadId === null,
      );
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles a command-only prompt from its deferred ack and idle probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/command-only");
      yield* fake.takeRequest("prompt");
      // A pure extension command: dialog + notify, then the deferred ack —
      // pi emits no agent_start/agent_settled at all.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "done",
        notifyType: "info",
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      // The adapter probes get_state (auto-acked idle by the fake), then
      // settles the turn as completed.
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sends RPC compact for /compact instead of a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact keep the auth rewrite");
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the auth rewrite");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        completed.type === "turn_item.updated" &&
          completed.turnItem.type === "compaction" &&
          completed.turnItem.title === "Context compacted",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("compacts a bare /compact routed through compactThread", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const appThread = yield* makeAppThread("default", THREAD_ID);
      const runId = RunId.make(`run:${THREAD_ID}:1`);
      // The run executor sends a bare /compact to compactThread, never to
      // startTurn, so the adapter must expose it or the command fails.
      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        appThread,
        threadId: THREAD_ID,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
        rootNodeId: NodeId.make(`node:${runId}:root`),
        providerThread,
        message: {
          messageId: `message:${THREAD_ID}:1` as never,
          text: "/compact",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const compact = yield* fake.takeRequest("compact");
      assert.isUndefined(compact["customInstructions"]);
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("leaves /compacted as an ordinary prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compacted please");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/compacted please");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "compact"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a too-small compact as a failed compaction item", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: null,
        aborted: false,
        errorMessage: "Compaction failed: Nothing to compact (session too small)",
      });
      const failed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        failed.type === "turn_item.updated" &&
          failed.turnItem.type === "compaction" &&
          failed.turnItem.title === "Context compaction failed",
      );
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a compact that never started", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "Nothing to compact (session too small)",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restarts Pi when Stop interrupts a user compact", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers /compact as RPC compact instead of a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer-compact" as never,
          text: "/compact keep the tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the tests");
      assert.isUndefined(compact["streamingBehavior"]);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("persists current xAI capacity text for the thread error banner", () =>
    expectModelFailure("The model is currently at capacity due to high demand."),
  );

  it.effect("persists extension-normalized xAI capacity text for the thread error banner", () =>
    expectModelFailure(
      "Provider overloaded: The model is currently at capacity due to high demand.",
    ),
  );

  it.effect("stops with restart by aborting and then terminating the process", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: providerTurnId!,
        requestRuntimeRestart: true,
      });
      yield* fake.takeRequest("abort");
      // The fake process cannot die; pi settling still closes the turn as
      // interrupted rather than failed.
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.closeStdout;
      const stopped = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
      assert.equal(
        stopped.type === "provider_session.updated" ? stopped.providerSession.lastError : undefined,
        null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("remembers session approvals only for identical confirmation content", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        decision: "acceptForSession",
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust-again",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["id"], "ui-trust-again");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-other",
        method: "confirm",
        title: "Run project extensions?",
        message: "A different project.",
      });
      const other = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        other.type === "runtime_request.updated" &&
          other.runtimeRequest.nativeRequestRef?.nativeId === "ui-other",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("offers an explicit empty value for extension input dialogs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title: "Optional value",
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
        return;
      assert.equal(event.turnItem.questions[0]?.options[0]?.value, "");
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-input": "" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], "");
      assert.isUndefined(response["cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("raises bridge edit confirmations as file-change approvals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      for (const [id, title, requestKind] of [
        ["ui-edit", "Allow edit?", "file-change"],
        ["ui-bash", "Allow bash?", "command"],
        ["ui-ext", "Deploy to staging?", "command"],
      ] as const) {
        yield* fake.emit({ type: "extension_ui_request", id, method: "confirm", title });
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isTrue(
          item.type === "turn_item.updated" &&
            item.turnItem.type === "approval_request" &&
            item.turnItem.requestKind === requestKind,
          `${title} should be ${requestKind}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads a thread snapshot from pi's active branch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueMessages({
        messages: [
          {
            role: "user",
            content: "hello pi",
            timestamp: 1700000000000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello back" }],
            timestamp: 1700000001000,
          },
          { role: "toolResult", content: [] },
        ],
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[0]!.role, "user");
      assert.equal(snapshot.messages[0]!.text, "hello pi");
      assert.equal(snapshot.messages[1]!.role, "assistant");
      assert.equal(snapshot.messages[1]!.text, "hello back");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps snapshot message identities distinct across native sessions", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const first = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const messages = {
        messages: [{ role: "user", content: "same text", timestamp: 1700000000000 }],
      };
      fake.queueMessages(messages);
      const a = yield* runtime.readThreadSnapshot({ providerThread: first });
      fake.queueState({ sessionFile: "/fake/another-session.jsonl" });
      const second = yield* runtime.ensureThread({
        threadId: ThreadId.make("second-thread"),
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: {
          ...first,
          nativeThreadRef: {
            driver: PI_PROVIDER,
            nativeId: "/fake/another-session.jsonl",
            strength: "strong",
          },
        },
      });
      fake.queueMessages(messages);
      const b = yield* runtime.readThreadSnapshot({ providerThread: second });
      assert.notEqual(a.messages[0]!.id, b.messages[0]!.id);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects a nonpersistent session UUID instead of treating it as a resumable path", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      fake.queueState({ sessionId: "not-a-session-file", sessionFile: undefined });
      const result = yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers the active turn through pi's native steer command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer" as never,
          text: "Focus on tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* fake.takeRequest("prompt");
      assert.equal(steer["message"], "Focus on tests");
      assert.equal(steer["streamingBehavior"], "steer");

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:command" as never,
          text: "/my-command",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const command = yield* fake.takeRequest("prompt");
      assert.equal(command["message"], "/my-command");

      yield* fake.emit({ type: "agent_settled" });
      const firstTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(firstTerminal.type === "turn.terminal" && firstTerminal.status === "completed");

      yield* startTurn(runtime, providerThread, "default", [], "Second turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      // The slash command's response belongs to the settled first turn. It
      // must not consume or fail the second turn's prompt acknowledgement.
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "late command rejection",
      });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const secondTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        secondTerminal.type === "turn.terminal" && secondTerminal.status === "completed",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows compaction progress and completes the same activity row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });

      const runningNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const runningItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          runningNode.node.status === "running" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          runningItem.turnItem.status === "running" &&
          runningItem.turnItem.title === "Compacting context...",
      );

      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      const completedNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const completedItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          completedNode.type === "node.updated" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          completedItem.type === "turn_item.updated" &&
          completedItem.turnItem.type === "compaction" &&
          completedNode.node.id === runningNode.node.id &&
          completedNode.node.status === "completed" &&
          completedItem.turnItem.id === runningItem.turnItem.id &&
          completedItem.turnItem.ordinal === runningItem.turnItem.ordinal &&
          completedItem.turnItem.startedAt === runningItem.turnItem.startedAt &&
          completedItem.turnItem.status === "completed" &&
          completedItem.turnItem.title === "Context compacted" &&
          completedItem.turnItem.beforeTokenCount === 200_000 &&
          completedItem.turnItem.afterTokenCount === 3_400,
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("uses distinct compaction IDs for first turns in separate threads", () =>
    Effect.gen(function* () {
      const firstFake = yield* makeFakePi;
      const { runtime: firstRuntime, takeEvent: takeFirstEvent } = yield* openRuntime(firstFake);
      const firstProviderThread = yield* firstRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(firstRuntime, firstProviderThread);
      yield* firstFake.takeRequest("prompt");
      yield* firstFake.emit({ type: "agent_start" });
      yield* firstFake.emit({ type: "compaction_start", reason: "threshold" });
      const first = yield* takeFirstEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      const secondThreadId = ThreadId.make("thread-pi-test-second");
      const secondFake = yield* makeFakePi;
      const { runtime: secondRuntime, takeEvent: takeSecondEvent } = yield* openRuntime(
        secondFake,
        "default",
        secondThreadId,
        ProviderSessionId.make("provider-session-pi-test-second"),
      );
      const secondProviderThread = yield* secondRuntime.ensureThread({
        threadId: secondThreadId,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(
        secondRuntime,
        secondProviderThread,
        "default",
        [],
        "Hello from another thread",
        undefined,
        1,
        secondThreadId,
      );
      yield* secondFake.takeRequest("prompt");
      yield* secondFake.emit({ type: "agent_start" });
      yield* secondFake.emit({ type: "compaction_start", reason: "threshold" });
      const second = yield* takeSecondEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      assert.isTrue(
        first.type === "turn_item.updated" &&
          first.turnItem.type === "compaction" &&
          second.type === "turn_item.updated" &&
          second.turnItem.type === "compaction" &&
          first.turnItem.ordinal === second.turnItem.ordinal &&
          first.turnItem.id !== second.turnItem.id,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows aborted compactions as stopped", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: null,
        aborted: true,
      });
      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "compaction" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "compaction" &&
          stopped.turnItem.id === running.turnItem.id &&
          stopped.turnItem.status === "cancelled" &&
          stopped.turnItem.title === "Context compaction stopped",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the turn open and updates one retry row through final failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: true });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 3_000,
        errorMessage: "529 overloaded",
      });
      const firstRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          firstRetry.turnItem.status === "running" &&
          firstRetry.turnItem.title === "Provider retry" &&
          firstRetry.turnItem.failure.retryable === true &&
          firstRetry.turnItem.retry?.attempt === 1 &&
          firstRetry.turnItem.retry.maxAttempts === 3 &&
          firstRetry.turnItem.retry.retryDelayMs === 3_000,
      );

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 3,
        maxAttempts: 3,
        delayMs: 12_000,
        errorMessage: "529 still overloaded",
      });
      const lastRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          lastRetry.type === "turn_item.updated" &&
          lastRetry.turnItem.type === "error" &&
          lastRetry.turnItem.id === firstRetry.turnItem.id &&
          lastRetry.turnItem.startedAt === firstRetry.turnItem.startedAt &&
          lastRetry.turnItem.retry?.attempt === 3,
      );

      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "529 overloaded",
      });
      const failedRetry = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          failedRetry.type === "turn_item.updated" &&
          failedRetry.turnItem.type === "error" &&
          failedRetry.turnItem.id === firstRetry.turnItem.id &&
          failedRetry.turnItem.title === "Provider error" &&
          failedRetry.turnItem.failure.retryable === false &&
          failedRetry.turnItem.retry?.attempt === 3 &&
          failedRetry.turnItem.retry.maxAttempts === 3,
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("overloaded") &&
          terminal.retry?.attempt === 3 &&
          terminal.retry.maxAttempts === 3 &&
          terminal.retryStartedAt === firstRetry.turnItem.startedAt,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves exhausted retry failure through non-retrying compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 5,
        maxAttempts: 5,
        delayMs: 48_000,
        errorMessage: "socket timed out",
      });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 5,
        finalError: "socket timed out",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "socket timed out" &&
          terminal.retry?.attempt === 5 &&
          terminal.retry.maxAttempts === 5,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("marks retry progress recovered when Pi succeeds", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "temporary network failure",
        },
      });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 5,
        delayMs: 3_000,
        errorMessage: "temporary network failure",
      });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      const recovered = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "error" &&
          recovered.type === "turn_item.updated" &&
          recovered.turnItem.type === "error" &&
          recovered.turnItem.id === running.turnItem.id &&
          recovered.turnItem.status === "completed" &&
          recovered.turnItem.title === "Provider recovered",
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops active retry progress when the turn is interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const runningTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        runningTurn.type === "provider_turn.updated" ? runningTurn.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 6_000,
        errorMessage: "temporary network failure",
      });
      const retrying = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      yield* fake.emit({ type: "agent_settled" });

      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        retrying.type === "turn_item.updated" &&
          retrying.turnItem.type === "error" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "error" &&
          stopped.turnItem.id === retrying.turnItem.id &&
          stopped.turnItem.status === "interrupted" &&
          stopped.turnItem.title === "Provider retry stopped",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps extension-started compaction and recovery in the settled turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      // Extension ctx.compact() waits for this first settlement, then starts
      // compaction in a detached continuation.
      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps working after a settle probe fails before detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      fake.failNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restarts Pi when Stop interrupts detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers through an atomic prompt that can restart an idle Pi run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer" as never,
          text: "Focus on tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* fake.takeRequest("prompt");
      assert.equal(steer["message"], "Focus on tests");
      assert.equal(steer["streamingBehavior"], "steer");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ignores an idle snapshot made stale by a steer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:late-steer" as never,
          text: "Continue after settlement",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered" }],
          stopReason: "stop",
        },
      });
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Recovered",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiRpc framing", () => {
  it.effect("reassembles records across chunk boundaries and strips CR", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const stdin = yield* Queue.unbounded<Uint8Array>();
      let intakeFailure: string | undefined;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk) => Queue.offer(stdin, chunk)),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        onEventIntake: (record) => {
          if (record.type === "extension_error" && record.event === "before_agent_start") {
            intakeFailure = "startup extension failure";
          }
        },
        protectedSendGuard: () => intakeFailure,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      yield* push("x".repeat(8 * 1024 * 1024));
      yield* push('x{"type":"must_not_emit"}\n{"type":"after_oversized"}\n');

      yield* push('{"type":"extension_error","event":"before_agent_start"}\n');
      yield* Effect.yieldNow;
      const refused = yield* connection
        .send({ type: "prompt", message: "must not write" }, { protected: true })
        .pipe(Effect.flip);
      assert.equal(refused.operation, "protected-send");
      assert.equal(refused.detail, "startup extension failure");
      assert.equal((yield* Queue.poll(stdin))._tag, "None");

      yield* connection.send({ type: "extension_ui_response", id: "dialog", confirmed: true });
      const ordinaryWrite = yield* Queue.take(stdin);
      assert.deepEqual(decodeJsonLine(new TextDecoder().decode(ordinaryWrite)), {
        type: "extension_ui_response",
        id: "dialog",
        confirmed: true,
      });

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
      assert.equal((yield* Queue.take(connection.events))["type"], "after_oversized");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not re-latch a pre-response error while switched state is deferred", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextSwitch();
      fake.deferNextState();
      const resuming = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkScoped);
      const switchRequest = yield* fake.takeDeferredSwitch;
      assert.isString(switchRequest.id);
      const response = yield* fake.resolveDeferredSwitch({
        command: "get_state",
        before: [
          {
            type: "extension_error",
            event: "before_agent_start",
            error: "outgoing startup error",
          },
        ],
        after: [
          {
            type: "extension_ui_request",
            id: "stale-drained",
            method: "confirm",
            title: "Continue after switching?",
          },
        ],
      });
      assert.equal(response.id, switchRequest.id);
      yield* fake.takeDeferredState;
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.nativeRequestRef?.nativeId === "stale-drained",
      );
      assert.equal(pending.type, "runtime_request.updated");
      if (pending.type !== "runtime_request.updated") throw new Error("Missing switch dialog");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      const dialog = yield* fake.takeRequest("extension_ui_response");
      assert.equal(dialog.id, "stale-drained");
      assert.equal(dialog.confirmed, true);
      yield* fake.resolveDeferredState({
        sessionFile: FAKE_SESSION_FILE,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });
      const resumed = yield* Fiber.join(resuming);
      const result = yield* Effect.exit(
        startTurn(runtime, resumed, "default", [], "clean boundary"),
      );
      assert.equal(result._tag, "Success");
      assert.equal((yield* fake.takeRequest("prompt")).message, "clean boundary");
      assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "delivers an ordinary idle extension error on the next turn and permits later compact work",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emitBatch([
          {
            type: "extension_error",
            extensionPath: "/workspace/idle-notification.ts",
            event: "session_start",
            error: "idle notification handler failed",
          },
          {
            type: "extension_ui_request",
            id: "idle-error-drained",
            method: "confirm",
            title: "Continue after the idle diagnostic?",
          },
        ]);
        // The following dialog is handled by the same sequential event pump,
        // establishing that the preceding error was handled without a turn.
        const pending = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.nativeRequestRef?.nativeId === "idle-error-drained",
        );
        if (pending.type !== "runtime_request.updated") throw new Error("Missing idle dialog");
        assert.equal(pending.runtimeRequest.providerTurnId, null);
        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          decision: "accept",
        });
        const dialog = yield* fake.takeRequest("extension_ui_response");
        assert.equal(dialog.id, "idle-error-drained");
        assert.equal(dialog.confirmed, true);

        yield* startTurn(runtime, providerThread, "default", [], "work after idle diagnostic");
        assert.equal((yield* fake.takeRequest("prompt")).message, "work after idle diagnostic");
        const running = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (running.type !== "provider_turn.updated") throw new Error("Missing running turn");
        const diagnostic = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
        );
        if (diagnostic.type !== "turn_item.updated" || diagnostic.turnItem.type !== "error") {
          throw new Error("Missing idle extension diagnostic");
        }
        assert.equal(diagnostic.turnItem.providerTurnId, running.providerTurn.id);
        assert.equal(diagnostic.turnItem.status, "failed");
        assert.equal(diagnostic.turnItem.title, "idle-notification");
        assert.equal(
          diagnostic.turnItem.failure.message,
          "idle-notification failed during session_start.\n\nidle notification handler failed",
        );
        yield* fake.emitBatch([{ type: "agent_start" }, { type: "agent_settled" }]);
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          terminal.type === "turn.terminal" &&
            terminal.providerTurnId === running.providerTurn.id &&
            terminal.status === "completed" &&
            terminal.failure === null,
        );

        yield* startTurn(runtime, providerThread, "default", [], "/compact", undefined, 2);
        assert.equal((yield* fake.takeRequest("compact")).type, "compact");
        yield* fake.emit({ type: "response", command: "compact", success: true });
        const compactTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          compactTerminal.type === "turn.terminal" &&
            compactTerminal.providerTurnId !== running.providerTurn.id &&
            compactTerminal.status === "completed" &&
            compactTerminal.failure === null,
        );
        assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 1);
        assert.equal(fake.allRequests().filter((request) => request.type === "compact").length, 1);
        assert.equal(
          fake.allRequests().filter((request) => request.type === "switch_session").length,
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves a post-response startup error across deferred switch refresh", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextSwitch();
      fake.deferNextState();
      const resuming = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkScoped);
      const switchRequest = yield* fake.takeDeferredSwitch;
      const response = yield* fake.resolveDeferredSwitch({
        after: [
          {
            type: "extension_error",
            event: "before_agent_start",
            error: "incoming startup error",
          },
          {
            type: "extension_ui_request",
            id: "incoming-drained",
            method: "confirm",
            title: "Incoming session dialog",
          },
        ],
      });
      assert.equal(response.id, switchRequest.id);
      yield* fake.takeDeferredState;
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.nativeRequestRef?.nativeId === "incoming-drained",
      );
      assert.equal(pending.type, "runtime_request.updated");
      if (pending.type !== "runtime_request.updated") throw new Error("Missing incoming dialog");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response")).confirmed, true);
      yield* fake.emitBatch([
        response,
        {
          type: "response",
          id: "unmatched-switch-response",
          command: "switch_session",
          success: true,
          data: { cancelled: false },
        },
      ]);
      yield* fake.resolveDeferredState({
        sessionFile: FAKE_SESSION_FILE,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });
      const resumed = yield* Fiber.join(resuming);
      for (const text of ["must refuse incoming prompt", "/compact"]) {
        const result = yield* Effect.exit(startTurn(runtime, resumed, "default", [], text));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.match(errorText(result.cause), /incoming startup error/);
        }
      }
      assert.equal(
        fake
          .allRequests()
          .filter((request) => request.type === "prompt" || request.type === "compact").length,
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const mode of ["start", "steer"] as const) {
    for (const text of ["refused raw prompt", "/compact raw refusal"]) {
      it.effect(`refuses ${mode} ${text} after split and coalesced parser intake`, () =>
        Effect.gen(function* () {
          const fake = yield* makeFakePi;
          const { runtime, takeEvent } = yield* openRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
          });
          let providerTurnId: OrchestrationV2ProviderTurn["id"] | undefined;
          if (mode === "steer") {
            yield* startTurn(runtime, providerThread);
            yield* fake.takeRequest("prompt");
            const running = yield* takeEvent(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            );
            assert.equal(running.type, "provider_turn.updated");
            if (running.type !== "provider_turn.updated") throw new Error("Missing active turn");
            providerTurnId = running.providerTurn.id;
          }
          const writesBefore = fake.allRequests().length;
          fake.deferNextState();
          const work =
            mode === "start"
              ? startTurn(runtime, providerThread, "default", [], text)
              : runtime.steerTurn({
                  threadId: THREAD_ID,
                  runId: RunId.make("run:thread-pi-test:1"),
                  providerThread,
                  providerTurnId: providerTurnId!,
                  message: {
                    messageId: "message:raw-refusal" as never,
                    text,
                    attachments: [],
                    createdBy: "user",
                    creationSource: "web",
                  },
                });
          const working = yield* work.pipe(Effect.forkScoped);
          const stateRequest = yield* fake.takeDeferredState;
          yield* fake.emitRaw('{"type":"extension_');
          yield* fake.emitRaw(
            'error","event":"before_agent_start","error":"raw startup failure"}\r\n' +
              encodeJsonLine({
                type: "response",
                id: stateRequest.id,
                command: "get_state",
                success: true,
                data: {
                  sessionFile: FAKE_SESSION_FILE,
                  isStreaming: false,
                  isCompacting: false,
                  pendingMessageCount: 0,
                },
              }) +
              "\n",
          );
          const result = yield* Effect.exit(Fiber.join(working));
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.match(errorText(result.cause), /raw startup failure/);
          }
          assert.equal(
            fake
              .allRequests()
              .slice(writesBefore)
              .filter((request) => request.type === "prompt" || request.type === "compact").length,
            0,
          );
          if (mode === "steer") {
            yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
            assert.equal((yield* fake.takeRequest("abort")).type, "abort");
          }
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
      );
    }
  }

  for (const outcome of ["cancelled", "failed"] as const) {
    it.effect(`retains outgoing startup failure after a ${outcome} switch`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.deferNextSwitch();
        const resuming = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkScoped);
        yield* fake.takeDeferredSwitch;
        yield* fake.resolveDeferredSwitch({
          success: outcome !== "failed",
          cancelled: outcome === "cancelled",
          before: [
            {
              type: "extension_error",
              event: "before_agent_start",
              error: "outgoing failure retained",
            },
          ],
        });
        const resumeResult = yield* Effect.exit(Fiber.join(resuming));
        assert.equal(resumeResult._tag, "Failure");
        for (const text of ["refused after unsuccessful switch", "/compact"]) {
          const result = yield* Effect.exit(
            startTurn(runtime, providerThread, "default", [], text),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.match(errorText(result.cause), /outgoing failure retained/);
          }
        }
        assert.equal(
          fake
            .allRequests()
            .filter((request) => request.type === "prompt" || request.type === "compact").length,
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }
});

// This fails before a provider transcript exists, so a replay fixture is not
// an honest fit. The boundary is the stdio transport seeing stdout end.
describe("PiRpc early process exit", () => {
  const makeHandle = (options: {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stderr: Stream.Stream<Uint8Array>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: options.exitCode,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: options.stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("reports a nonzero exit code instead of an unexplained stdout close", () =>
    Effect.gen(function* () {
      const secret = "API_KEY=super-secret\n";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.fromIterable([new TextEncoder().encode(secret)]),
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the unexplained stdout-close message when the process has not exited", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
            stderr: Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process closed stdout");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the exit-code diagnosis when stdin breaks while exit is still pending", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.sleep(Duration.millis(50)).pipe(
              Effect.andThen(Effect.succeed(ChildProcessSpawner.ExitCode(1))),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "stdin",
                description: "broken pipe",
              }),
            ),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
