import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

// PR75-R1-F1: a placed task reopened from Home follows its message to the machine its origin binds.
// The pending-list handler, the list model and both route readers are real; navigation, thread
// detail, entities and the outbox store are doubles.
const harness = vi.hoisted(() => ({
  params: undefined as undefined | Record<string, unknown>,
  setParams: vi.fn(),
  detailReads: [] as Array<string>,
  queue: null as unknown as Atom.Writable<Record<string, ReadonlyArray<unknown>>>,
}));
vi.mock("@react-navigation/native", () => ({
  useRoute: () => ({ params: harness.params }),
  useNavigation: () => ({ setParams: harness.setParams }),
}));
vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useQuietThreadShell: () => null,
}));
vi.mock("../../state/threads", async () => {
  const Option = await import("effect/Option");
  return {
    useEnvironmentThread: (environmentId: string | null, threadId: string | null) => {
      if (environmentId !== null) harness.detailReads.push(`${environmentId}:${threadId}`);
      return { data: Option.none() };
    },
  };
});
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => null,
  useSavedRemoteConnection: () => null,
}));
vi.mock("../../state/use-thread-outbox", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const { useAtomValue: read } = await import("@effect/atom-react");
  harness.queue = A.make<Record<string, ReadonlyArray<unknown>>>({}).pipe(A.keepAlive);
  return {
    useThreadOutboxMessages: () => read(harness.queue),
    editingQueuedMessageIdsAtom: A.make({}),
    holdEditingQueuedMessage: vi.fn(),
    releaseEditingQueuedMessage: vi.fn(),
  };
});
vi.mock("../../state/thread-outbox-removal", () => ({ removeThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-composer-drafts", () => ({ clearComposerDraftContent: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./thread-dismissal", () => ({ withThreadDismissal: vi.fn() }));

import { appAtomRegistry } from "../../state/atom-registry";
import { buildPendingNewTasks } from "../../state/pending-new-tasks-model";
import { pendingThreadCreationOutcomesAtom } from "../../state/pending-thread-creation";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { useFollowPendingRoute, useThreadSelection } from "../../state/use-thread-selection";
import { usePendingTaskListActions } from "./usePendingTaskListActions";

const laptop = EnvironmentId.make("laptop");
const box = EnvironmentId.make("box");
function task(overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage {
  return {
    environmentId: laptop,
    threadId: ThreadId.make("thread-auto"),
    messageId: MessageId.make("message-auto"),
    commandId: CommandId.make("command-auto"),
    text: "Fix the build",
    attachments: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    creation: {
      projectId: ProjectId.make("project-a"),
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
    ...overrides,
  };
}
const keyed = (...messages: QueuedThreadMessage[]) =>
  Object.fromEntries(
    messages.map((message) => [`${message.environmentId}:${message.threadId}`, [message]]),
  );

/** Opens the task as the Home list does: the real list model and the real handler. */
function openFromHome(message: QueuedThreadMessage) {
  const [pending] = buildPendingNewTasks({
    queuedMessages: [message],
    drafts: {},
    sendGate: {
      connectedEnvironmentIds: new Set(),
      operableEnvironmentIds: new Set(),
      shellStatuses: new Map(),
      retryingMessageIds: {},
    },
  });
  if (pending?.kind !== "pending") throw new Error("Home lists no pending task for this message");
  let open!: ReturnType<typeof usePendingTaskListActions>["openPendingTask"];
  function Handler() {
    const actions = usePendingTaskListActions((params) => {
      harness.params = params as Record<string, unknown>;
    });
    useLayoutEffect(() => {
      open = actions.openPendingTask;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Handler />));
  act(() => open(pending));
  act(() => root.unmount());
}

function renderReaders() {
  const seen = {
    selection: null as null | ReturnType<typeof useThreadSelection>,
    route: null as null | ReturnType<typeof useFollowPendingRoute>,
  };
  function Readers() {
    // The two readers the live route uses: the thread selection and the route controller's.
    const selection = useThreadSelection();
    const route = useFollowPendingRoute(harness.params);
    useAtomValue(harness.queue);
    useLayoutEffect(() => {
      seen.selection = selection;
      seen.route = route;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Readers />
        </RegistryContext.Provider>,
      ),
    );
  render();
  return { seen, render, [Symbol.dispose]: () => act(() => root.unmount()) };
}

function reset() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.params = undefined;
  harness.setParams.mockReset();
  harness.detailReads.length = 0;
  appAtomRegistry.set(harness.queue, {});
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {});
}

describe("PR75-R1-F1: a placed task reopened from Home", () => {
  it("follows its message from A to B through both readers, and keeps B once it is delivered", () => {
    reset();
    const queued = task();
    appAtomRegistry.set(harness.queue, keyed(queued));
    openFromHome(queued);
    expect(harness.params).toEqual({
      environmentId: "laptop",
      threadId: "thread-auto",
      pendingMessageId: "message-auto",
    });
    using readers = renderReaders();
    expect(readers.seen.selection?.selectedThreadRef).toEqual({
      environmentId: "laptop",
      threadId: "thread-auto",
    });
    expect(readers.seen.route?.routeFollowsBinding).toBe(true);

    // Its origin binds it to B: the same message moves to B's key.
    const bound = task({
      environmentId: box,
      placement: {
        ...queued.placement!,
        bound: { environmentId: box, projectId: ProjectId.make("project-b") },
      },
    });
    act(() => appAtomRegistry.set(harness.queue, keyed(bound)));
    expect(readers.seen.selection?.selectedThreadRef).toEqual({
      environmentId: "box",
      threadId: "thread-auto",
    });
    expect(readers.seen.route).toMatchObject({ environmentId: "box", routeFollowsBinding: false });
    expect(harness.setParams.mock.calls).toEqual([
      [{ environmentId: "box", threadId: "thread-auto" }],
    ]);
    // The route moves only its own params; the navigator applies them.
    harness.params = { ...harness.params, environmentId: "box" };
    readers.render();
    expect(readers.seen.route?.routeFollowsBinding).toBe(true);

    // Delivered at B: the queue entry goes, the outcome stays under B, then is collected.
    act(() => {
      appAtomRegistry.set(harness.queue, {});
      appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
        "box:thread-auto": { kind: "delivered", message: bound },
      });
    });
    expect(readers.seen.selection?.selectedThreadRef).toEqual({
      environmentId: "box",
      threadId: "thread-auto",
    });
    act(() => appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {}));
    expect(readers.seen.selection?.selectedThreadRef).toEqual({
      environmentId: "box",
      threadId: "thread-auto",
    });
    // Its detail was never read on A, where the thread never exists; B's once delivered.
    expect(harness.detailReads.filter((read) => read.startsWith("laptop:"))).toEqual([]);
    expect(harness.detailReads).toContain("box:thread-auto");
    expect(harness.setParams).toHaveBeenCalledTimes(1);
  });

  it("is not moved by another task's binding or completion", () => {
    reset();
    const queued = task();
    appAtomRegistry.set(harness.queue, keyed(queued));
    openFromHome(queued);
    using readers = renderReaders();
    const other = task({
      environmentId: box,
      messageId: MessageId.make("message-other"),
      threadId: ThreadId.make("thread-other"),
    });
    act(() => {
      appAtomRegistry.set(harness.queue, keyed(queued, other));
      appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
        "box:thread-other": { kind: "delivered", message: other },
      });
    });
    expect(readers.seen.selection?.selectedThreadRef).toEqual({
      environmentId: "laptop",
      threadId: "thread-auto",
    });
    expect(harness.setParams).not.toHaveBeenCalled();
  });

  it("reopens a fixed task as before: its machine and thread only", () => {
    reset();
    const { placement: _placement, ...fixed } = task();
    appAtomRegistry.set(harness.queue, keyed(fixed));
    openFromHome(fixed);
    expect(harness.params).toEqual({ environmentId: "laptop", threadId: "thread-auto" });
  });
});
