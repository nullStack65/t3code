import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadPlacementAdmitError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

// A fresh Auto task is admitted at its recorded origin, then rebinds the same queued message to
// the machine it answered with. The outbox, its manager, the drain and the codec are real; only
// network edges (admission, launch, upload preparation), connections and projects are doubles.
const state = vi.hoisted(() => ({
  events: [] as Array<string>,
  /** Files on disk, one per message id, as their stored JSON. */
  stored: new Map<string, string>(),
  failWrites: false,
  admitAnswer: null as null | (() => unknown),
  admitHold: null as null | Promise<void>,
  /** Called as each admission request reaches the origin. */
  onAdmit: null as null | (() => void),
  delivery: null as { readonly drain: () => void; readonly dispose: () => void } | null,
  admit: vi.fn(),
  start: vi.fn(),
  prepare: vi.fn(),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  connection: new Map<string, unknown>(),
  generation: new Map<string, unknown>(),
  config: {
    shellThreadFamilies: false,
    providers: [{ instanceId: "codex", driver: "codex", models: [] }],
    environment: { capabilities: {} },
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: (input: unknown) => unknown, input: unknown) =>
    command(input),
}));
vi.mock("./orchestration", () => ({
  orchestrationEnvironment: { admitThreadPlacement: state.admit },
}));
vi.mock("../connection/catalog", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const family = (map: Map<string, unknown>, initial: () => unknown) => (id: string) => {
    if (!map.has(id)) map.set(id, A.make(initial()).pipe(A.keepAlive));
    return map.get(id);
  };
  return {
    environmentCatalog: {
      stateAtom: family(state.connection, () => R.success({ phase: "connected" })),
      sessionGenerationAtom: family(state.generation, () => 1),
    },
  };
});
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  const sessionStateAtom = Atom.family((_id: string) => Atom.make(true).pipe(Atom.keepAlive));
  const sessionHasScope = (granted: boolean, scope: string) =>
    granted && scope === AuthOrchestrationOperateScope;
  return {
    environmentSession: { sessionStateAtom },
    sessionHasScope,
    readEnvironmentScope: (environmentId: string, scope: string) =>
      sessionHasScope(appAtomRegistry.get(sessionStateAtom(environmentId)), scope),
  };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentProjects: {
      projectsAtom: Atom.make([
        { environmentId: "laptop", id: "project-a", title: "Repo", workspaceRoot: "/a-root" },
        { environmentId: "box", id: "project-b", title: "Repo", workspaceRoot: "/b-root" },
      ]),
    },
  };
});
vi.mock("./workspace", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    workspaceConnections: {
      environmentsAtom: Atom.make([
        { environmentId: "laptop", connectionState: "connected" },
        { environmentId: "box", connectionState: "connected" },
      ]),
    },
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
    environmentServerConfigsAtom: Atom.make(
      new Map([
        ["laptop", state.config],
        ["box", state.config],
      ]),
    ),
  };
});
vi.mock("./threads", async () => {
  const { Atom, AsyncResult: R } = await import("effect/reactivity");
  return {
    threadEnvironment: { startTurn: state.start },
    environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) },
    threadFamilies: { mount: () => () => {}, familyAtom: () => Atom.make(R.success({})) },
    environmentThreadDetails: { stateAtom: () => Atom.make(null) },
  };
});
vi.mock("./git", () => ({ gitEnvironment: {} }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: () => false }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./thread-outbox", async () => {
  const model = await import("./thread-outbox-model");
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({
        messages: [...state.stored.values()].map((raw) =>
          model.decodeQueuedThreadMessage(JSON.parse(raw)),
        ),
        errors: [],
      }),
      write: async (message) => {
        if (state.failWrites) throw new Error("disk full");
        state.stored.set(
          `${encodeURIComponent(message.messageId)}.json`,
          JSON.stringify(model.encodeQueuedThreadMessage(message)),
        );
      },
      remove: async (message) => {
        state.stored.delete(`${encodeURIComponent(message.messageId)}.json`);
      },
    },
  });
  return {
    flattenQueuedThreadMessages: model.flattenQueuedThreadMessages,
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, true>>({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    retryingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    threadOutboxShellStatusesAtom: Atom.make(
      new Map([
        ["laptop", "live"],
        ["box", "live"],
      ]),
    ),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(async () => {}),
    getComposerDraftSnapshot: vi.fn(() => ({ text: "", attachments: [] })),
    mergeComposerDraftContent: vi.fn(async () => {}),
    replaceComposerDraftAttachments: vi.fn(),
    undoComposerDraftMerge: vi.fn(async () => {}),
    updateComposerDraftSettings: vi.fn(),
    waitForComposerDraftsLoaded: vi.fn(async () => {}),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { dispatchingQueuedMessageIdAtom, editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import * as drafts from "./use-composer-drafts";
import { createThreadOutboxDelivery } from "./threadOutboxDelivery";

const laptop = EnvironmentId.make("laptop");
const box = EnvironmentId.make("box");
const shot = {
  id: "shot",
  type: "image" as const,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "data:image/png;base64,YWJj",
};

function autoTask(): QueuedThreadMessage {
  return {
    environmentId: laptop,
    threadId: ThreadId.make("thread-auto"),
    messageId: MessageId.make("message-auto"),
    commandId: CommandId.make("command-auto"),
    text: "Fix the build",
    attachments: [shot],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    creation: {
      projectId: ProjectId.make("project-a"),
      projectTitle: "Repo",
      projectCwd: "/a-root",
      workspaceMode: "worktree",
      branch: "main",
      worktreePath: null,
    },
    placement: {
      originEnvironmentId: laptop,
      originProjectId: ProjectId.make("project-a"),
      candidateEnvironmentIds: [laptop, box],
    },
    createdAt: "2026-11-18T16:00:00.000Z",
  };
}

const bindsTo = (environmentId: string, projectId: string) => () =>
  AsyncResult.success({ environmentId, projectId, reason: "capacity", resumed: true });
const refuses =
  (reason: "other-session" | "excluded" | "unavailable" | "no-eligible-environment") => () =>
    AsyncResult.failure(
      Cause.fail(
        new OrchestrationV2ThreadPlacementAdmitError({
          commandId: CommandId.make("command-auto"),
          reason,
          detail: `refused: ${reason}`,
        }),
      ),
    );

const queued = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();
const storedRecords = () =>
  [...state.stored.entries()].map(([file, raw]) => ({ file, record: JSON.parse(raw) as unknown }));
const targetEffects = () => state.events.filter((event) => !event.startsWith("admit"));

const idle = () => appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === null;
/** Resolves when the outbox and its delivery slot reach this state; checked on each change. */
function until(predicate: () => boolean): Promise<void> {
  const done = Promise.withResolvers<void>();
  const check = () => {
    if (predicate()) done.resolve();
  };
  const stops = [
    appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, check),
    appAtomRegistry.subscribe(state.manager.queuedMessagesByThreadKeyAtom, check),
  ];
  check();
  return done.promise.finally(() => {
    for (const stop of stops) stop();
  });
}

function startDelivery() {
  if (state.delivery === null) state.delivery = createThreadOutboxDelivery();
  else state.delivery.drain();
}

function setConnected(environmentId: string, connected: boolean) {
  const atom = state.connection.get(environmentId) as Atom.Writable<unknown>;
  appAtomRegistry.set(
    atom,
    AsyncResult.success({ phase: connected ? "connected" : "disconnected" }),
  );
}

beforeEach(() => {
  state.events.length = 0;
  state.stored.clear();
  state.failWrites = false;
  state.admitAnswer = bindsTo("box", "project-b");
  state.admitHold = null;
  state.onAdmit = null;
  for (const environmentId of state.connection.keys()) setConnected(environmentId, true);
  for (const atom of state.generation.values())
    appAtomRegistry.set(atom as Atom.Writable<number>, 1);
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {});
  state.admit
    .mockReset()
    .mockImplementation(
      async (target: {
        environmentId: string;
        input: { candidateEnvironmentIds: ReadonlyArray<string> };
      }) => {
        state.events.push(
          `admit:${target.environmentId}:${target.input.candidateEnvironmentIds.join(",")}`,
        );
        state.onAdmit?.();
        if (state.admitHold) await state.admitHold;
        return state.admitAnswer!();
      },
    );
  state.prepare
    .mockReset()
    .mockImplementation(
      async (input: { environmentId: string; attachments: ReadonlyArray<unknown> }) => {
        state.events.push(`prepare:${input.environmentId}`);
        return {
          status: "ready",
          attachments: [],
          draftAttachments: input.attachments,
          pendingAttachmentIds: [],
        };
      },
    );
  state.start.mockReset().mockImplementation(async (target: { environmentId: string }) => {
    state.events.push(`start:${target.environmentId}`);
    return AsyncResult.success({});
  });
  vi.mocked(drafts.mergeComposerDraftContent).mockClear();
});

afterEach(() => {
  state.delivery?.dispose();
  state.delivery = null;
  vi.useRealTimers();
});

describe("a fresh Auto task's admission and binding", () => {
  it("asks its origin first, rebinds the same message, then uploads and launches only at B", async () => {
    const message = autoTask();
    await state.manager.enqueue(message);
    // Origin admission, then B's own delivery pass (asked again before upload and before launch).
    startDelivery();
    await until(() => queued().length === 0 && idle());
    expect(state.events).toEqual([
      "admit:laptop:laptop,box",
      "admit:laptop:box",
      "prepare:box",
      "admit:laptop:box",
      "start:box",
    ]);
    // Every admission is the same operation, with the exact request the task was sent with.
    for (const [target] of state.admit.mock.calls) {
      expect(target).toMatchObject({
        environmentId: "laptop",
        input: {
          commandId: "command-auto",
          threadId: "thread-auto",
          projectId: "project-a",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      });
    }
    // B's launch: same IDs, B's project and root; the origin's path is never used there.
    const [launch] = state.start.mock.calls.at(-1)!;
    expect(launch).toMatchObject({
      environmentId: "box",
      input: {
        commandId: "command-auto",
        threadId: "thread-auto",
        message: { messageId: "message-auto" },
        bootstrap: {
          createThread: { projectId: "project-b" },
          prepareWorktree: { projectCwd: "/b-root" },
        },
      },
    });
    expect(queued()).toEqual([]);
  });

  it("persists the binding in the same file before anything reaches B", async () => {
    const launched = Promise.withResolvers<void>();
    state.start.mockImplementation(async () => {
      launched.resolve();
      return new Promise(() => {});
    });
    await state.manager.enqueue(autoTask());
    startDelivery();
    await until(() => queued()[0]?.placement?.bound !== undefined);
    const records = storedRecords();
    expect(records.map(({ file }) => file)).toEqual(["message-auto.json"]);
    const bound = decodeQueuedThreadMessage(records[0]!.record);
    expect(bound).toMatchObject({
      environmentId: "box",
      messageId: "message-auto",
      commandId: "command-auto",
      creation: { projectId: "project-b", projectCwd: "/b-root" },
      placement: {
        originEnvironmentId: "laptop",
        originProjectId: "project-a",
        bound: { environmentId: "box", projectId: "project-b" },
      },
    });
    // The live entry is that bound object, under B's thread key only.
    expect(queued()).toEqual([bound].map((value) => expect.objectContaining(value)));
    expect(Object.keys(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom))).toEqual([
      "box:thread-auto",
    ]);
    // Let this case's own delivery reach B before the next case starts.
    await launched.promise;
  });

  it("never asks its origin when the task could not be written", async () => {
    state.failWrites = true;
    await expect(state.manager.enqueue(autoTask())).rejects.toThrow();
    startDelivery();
    await Promise.resolve();
    expect(state.admit).not.toHaveBeenCalled();
    expect(targetEffects()).toEqual([]);
  });

  it.each(["other-session", "excluded", "unavailable"] as const)(
    "holds the task with the same origin and IDs when its origin answers %s",
    async (reason) => {
      state.admitAnswer = refuses(reason);
      const message = autoTask();
      await state.manager.enqueue(message);
      startDelivery();
      await until(idle);
      expect(targetEffects()).toEqual([]);
      expect(queued()).toEqual([message]);
      expect(drafts.mergeComposerDraftContent).not.toHaveBeenCalled();
    },
  );

  it("hands the task back to its origin's draft when no machine can take it", async () => {
    state.admitAnswer = refuses("no-eligible-environment");
    await state.manager.enqueue(autoTask());
    startDelivery();
    await until(() => queued().length === 0 && idle());
    expect(targetEffects()).toEqual([]);
    expect(queued()).toEqual([]);
    expect(drafts.updateComposerDraftSettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        project: expect.objectContaining({ environmentId: "laptop", projectId: "project-a" }),
        environmentSelection: "auto",
      }),
    );
  });

  it("asks again after a lost answer with the same IDs, never a replacement", async () => {
    vi.useFakeTimers();
    state.admitAnswer = () => AsyncResult.failure(Cause.die("connection lost"));
    const message = autoTask();
    await state.manager.enqueue(message);
    startDelivery();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued()).toEqual([message]);
    state.admitAnswer = bindsTo("box", "project-b");
    await vi.advanceTimersByTimeAsync(threadOutboxRetryDelayMs(1));
    await vi.advanceTimersByTimeAsync(0);
    const asked = state.admit.mock.calls.map(([target]) => target.input);
    expect(new Set(asked.map((input) => input.commandId))).toEqual(new Set(["command-auto"]));
    expect(new Set(asked.map((input) => input.threadId))).toEqual(new Set(["thread-auto"]));
    expect(state.stored.size).toBeLessThanOrEqual(1);
  });

  it.each(["the origin's connection drops", "the task is opened for editing"] as const)(
    "acts on no answer when %s while its origin is asked",
    async (change) => {
      let release!: () => void;
      state.admitHold = new Promise<void>((done) => {
        release = done;
      });
      const message = autoTask();
      await state.manager.enqueue(message);
      const reached = Promise.withResolvers<void>();
      state.onAdmit = reached.resolve;
      startDelivery();
      await reached.promise;
      if (change === "the origin's connection drops") setConnected("laptop", false);
      else appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });
      release();
      await until(idle);
      expect(queued()).toEqual([message]);
      expect(
        decodeQueuedThreadMessage(storedRecords()[0]!.record).placement?.bound,
      ).toBeUndefined();
      expect(targetEffects()).toEqual([]);
    },
  );

  it("uploads and launches nothing at B once its origin refuses the stored binding", async () => {
    state.start.mockImplementation(async () => new Promise(() => {}));
    await state.manager.enqueue(autoTask());
    // Bound first, then its origin excludes B before B's delivery asks again.
    state.admit.mockImplementationOnce(
      async (target: { environmentId: string; input: { candidateEnvironmentIds: string[] } }) => {
        state.events.push(
          `admit:${target.environmentId}:${target.input.candidateEnvironmentIds.join(",")}`,
        );
        state.admitAnswer = refuses("excluded");
        return bindsTo("box", "project-b")();
      },
    );
    startDelivery();
    await until(() => state.admit.mock.calls.length >= 2 && idle());
    expect(targetEffects()).toEqual([]);
    expect(queued()).toHaveLength(1);
  });

  it("resumes a bound task after a restart as the same operation at B", async () => {
    // Its own id: the manager tombstones ids earlier cases removed, and never resurrects them.
    const bound: QueuedThreadMessage = {
      ...autoTask(),
      messageId: MessageId.make("message-restart"),
      environmentId: box,
      creation: {
        ...autoTask().creation!,
        projectId: ProjectId.make("project-b"),
        projectCwd: "/b-root",
      },
      placement: {
        ...autoTask().placement!,
        bound: { environmentId: box, projectId: ProjectId.make("project-b") },
      },
    };
    state.stored.set("message-restart.json", JSON.stringify(encodeQueuedThreadMessage(bound)));
    expect(await state.manager.load()).toBe(true);
    expect(queued()).toEqual([bound]);
    startDelivery();
    await until(() => queued().length === 0 && idle());
    expect(state.events).toEqual([
      "admit:laptop:box",
      "prepare:box",
      "admit:laptop:box",
      "start:box",
    ]);
  });

  it("leaves a legacy fixed creation to its own machine without asking anyone", async () => {
    const { placement: _placement, ...fixed } = autoTask();
    await state.manager.enqueue({ ...fixed, messageId: MessageId.make("message-fixed") });
    startDelivery();
    await until(() => queued().length === 0 && idle());
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.events).toEqual(["prepare:laptop", "start:laptop"]);
  });
});

describe("a bound task's environment clear", () => {
  it("follows its destination B, not its origin", async () => {
    const bound: QueuedThreadMessage = {
      ...autoTask(),
      messageId: MessageId.make("message-clear"),
      environmentId: box,
      placement: {
        ...autoTask().placement!,
        bound: { environmentId: box, projectId: ProjectId.make("project-b") },
      },
    };
    await state.manager.enqueue(bound);
    expect(await state.manager.clearEnvironment(laptop)).toEqual([]);
    expect(await state.manager.clearEnvironment(box)).toEqual([bound]);
  });
});
