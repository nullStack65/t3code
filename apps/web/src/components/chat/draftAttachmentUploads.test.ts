import {
  EnvironmentId,
  OrchestrationV2ThreadPlacementAdmitError,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

// The network edges of an upload: the session may operate, and each upload cycle is recorded.
const uploads = vi.hoisted(() => ({
  to: [] as Array<{ environmentId: string; name: string }>,
  /** Origin admissions asked by the queue and upload cycles, in the order they happened. */
  sequence: [] as Array<string>,
}));
// The origin's own record of the launches it bound, which its admission handler answers again.
const originServer = vi.hoisted(() => ({
  bound: [] as Array<{
    environmentId: string;
    commandId: string;
    threadId: string;
    projectId: string;
    destination: string;
    destinationProjectId: string;
  }>,
  /** The queue's own admission requests, as the origin received them. */
  queueAsked: [] as Array<{
    environmentId: string;
    commandId: string;
    threadId: string;
    projectId: string;
    candidateEnvironmentIds: ReadonlyArray<string>;
  }>,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async (input: {
    readonly environmentId: string;
    readonly upload: { readonly name: string };
  }) => {
    uploads.to.push({ environmentId: input.environmentId, name: input.upload.name });
    uploads.sequence.push(`upload:${input.environmentId}`);
    return { status: "uploaded" as const, attachmentId: `upload-${uploads.to.length}` };
  },
}));
// Both machines connected, on their first established session, as the queue's checks read them.
vi.mock("../../connection/catalog", async () => {
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  const family = (initial: () => unknown) => {
    const atoms = new Map<string, unknown>();
    return (environmentId: string) => {
      if (!atoms.has(environmentId)) atoms.set(environmentId, A.make(initial()));
      return atoms.get(environmentId);
    };
  };
  return {
    environmentCatalog: {
      stateAtom: family(() => Result.success({ phase: "connected" })),
      sessionGenerationAtom: family(() => 1),
    },
  };
});
// The queue asks the origin itself, over its admission RPC: answered from what the origin bound.
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { AsyncResult: Result } = await import("effect/reactivity");
  const CauseModule = await import("effect/Cause");
  return {
    ...real,
    runAtomCommand: async (registry: never, command: never, target: never) => {
      const { environmentId, input } = target as {
        environmentId: string;
        input?: {
          commandId: string;
          threadId: string;
          projectId: string;
          candidateEnvironmentIds?: ReadonlyArray<string>;
        };
      };
      if (input?.candidateEnvironmentIds === undefined)
        return real.runAtomCommand(registry, command, target);
      const asked = {
        environmentId,
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        candidateEnvironmentIds: [...input.candidateEnvironmentIds],
      };
      originServer.queueAsked.push(asked);
      uploads.sequence.push(`admit:${environmentId}`);
      const bound = originServer.bound.find(
        (launch) =>
          launch.environmentId === asked.environmentId &&
          launch.commandId === asked.commandId &&
          launch.threadId === asked.threadId &&
          launch.projectId === asked.projectId,
      );
      if (
        !bound ||
        asked.candidateEnvironmentIds.length !== 1 ||
        asked.candidateEnvironmentIds[0] !== bound.destination
      )
        return Result.failure(CauseModule.die("not bound at this origin"));
      return Result.success({
        environmentId: bound.destination,
        projectId: bound.destinationProjectId,
        reason: "capacity",
        resumed: true,
      });
    },
  };
});

/** The origin records the launch it just bound, as its admission handler does. */
function boundAtOrigin(
  target: {
    environmentId: string;
    input: { commandId: string; threadId: string; projectId: string };
  },
  destination: EnvironmentId,
  destinationProjectId: ProjectId,
) {
  originServer.bound.push({
    environmentId: target.environmentId,
    commandId: target.input.commandId,
    threadId: target.input.threadId,
    projectId: target.input.projectId,
    destination,
    destinationProjectId,
  });
}

const origin = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");
const projectHere = ProjectId.make("project:laptop");
const projectThere = ProjectId.make("project:box");
const request = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  multipleModels: false,
} as const;
const storageFaults = { drops: false };

async function openTab() {
  return {
    store: await import("../../composerDraftStore"),
    placement: await import("./draftPlacement"),
    queue: await import("../../lib/attachmentUploadQueue"),
  };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

async function withStorage(run: () => Promise<void>) {
  const memory = createMemoryStorage();
  const storage = {
    getItem: (name: string) => memory.getItem(name),
    removeItem: (name: string) => memory.removeItem(name),
    setItem: (name: string, value: string) => {
      if (!storageFaults.drops) memory.setItem(name, value);
    },
  };
  vi.stubGlobal("localStorage", storage);
  // The image readback reads `window.localStorage`, as in a browser.
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  vi.useFakeTimers();
  vi.resetModules();
  uploads.to.length = 0;
  uploads.sequence.length = 0;
  originServer.bound.length = 0;
  originServer.queueAsked.length = 0;
  try {
    await run();
  } finally {
    storageFaults.drops = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

/** Whether ChatView treats the draft as automatic work, by its own rule, for this state. */
function routesAutomatically(tab: Tab, draftId: string) {
  const id = tab.store.DraftId.make(draftId);
  const state = tab.store.useComposerDraftStore.getState();
  const composer = state.getComposerDraft(id);
  return tab.placement.draftRoutesAutomatically({
    clientSettingsHydrated: true,
    isDraft: true,
    envLocked: false,
    canAutoBalanceEnvironments: true,
    loadBalancingEnabled: true,
    draft: state.getDraftSession(id),
    composerHasAttachments: (composer?.images.length ?? 0) + (composer?.files.length ?? 0) > 0,
  });
}

/** The composer's upload effect, as ChatView configures it for this draft now. */
async function uploadEffect(tab: Tab, draftId: string) {
  const id = tab.store.DraftId.make(draftId);
  const state = tab.store.useComposerDraftStore.getState();
  const session = state.getDraftSession(id);
  const composer = state.getComposerDraft(id)!;
  const automatic = routesAutomatically(tab, draftId);
  const started = tab.placement.startComposerAttachmentUploads({
    environmentId: session!.environmentId,
    attachments: [...composer.images, ...composer.files],
    draftTarget: id,
    waitForPlacement: tab.placement.attachmentUploadsWaitForPlacement({
      draft: session,
      automatic,
      environmentId: session!.environmentId,
    }),
    start: tab.queue.startAttachmentUpload,
  });
  await vi.advanceTimersByTimeAsync(0);
  // Until the queue's own jobs for these attachments have finished, asked and uploaded or refused.
  await tab.queue.awaitAttachmentUploads(
    [...composer.images, ...composer.files].map((attachment) => attachment.id),
  );
  await vi.advanceTimersByTimeAsync(0);
  return started;
}

async function composeAutoDraft(
  tab: Tab,
  name: string,
  /** The client's own pick, not a binding; null while it is still choosing. */
  picked: EnvironmentId | null = origin,
) {
  const id = tab.store.DraftId.make(`draft-${name}`);
  const store = tab.store.useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(origin, projectHere), id, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: picked,
  });
  store.setPrompt(id, "Review the report");
  const report = new File(["report bytes"], "report.pdf", { type: "application/pdf" });
  store.addFiles(id, [
    {
      type: "file",
      id: `file-${name}`,
      name: report.name,
      mimeType: report.type,
      sizeBytes: report.size,
      file: report,
    },
  ]);
  // An image's bytes are kept here, so it survives a reload; a fresh file's are not.
  const shot = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
  const imageId = `shot-${name}`;
  store.addImages(id, [
    {
      type: "image",
      id: imageId,
      name: shot.name,
      mimeType: shot.type,
      sizeBytes: shot.size,
      previewUrl: `blob:${imageId}`,
      file: shot,
    },
  ]);
  // As the composer's own effect keeps an image's bytes here, before anything is uploaded.
  await store.syncPersistedAttachments(id, [
    {
      id: imageId,
      name: shot.name,
      mimeType: shot.type,
      sizeBytes: shot.size,
      dataUrl: "data:image/png;base64,AQIDBA==",
    },
  ]);
  return id;
}

const place = (tab: Tab, draftId: string, admit: never) =>
  tab.placement.placeDraftBeforeSend({
    draftId: tab.store.DraftId.make(draftId),
    request,
    candidateEnvironmentIds: [origin, box],
    pinnedHere: false,
    admit,
    canLaunchOn: () => true,
    composerUnchanged: () => true,
  });

describe("PR74-R1-F4: a fresh automatic draft's attachments", () => {
  it("upload nowhere before their placement is bound and stored, then only to that machine", async () => {
    await withStorage(async () => {
      const tab = await openTab();
      const id = await composeAutoDraft(tab, "auto");
      expect(
        tab.store.useComposerDraftStore.getState().getComposerDraft(id)?.persistedAttachments,
      ).toHaveLength(1);
      // Attached on an automatic draft: the bytes stay here, nothing is uploaded.
      expect(await uploadEffect(tab, id)).toBe(0);
      expect(uploads.to).toEqual([]);

      // Storage cannot hold the operation: nothing is asked, nothing uploaded.
      storageFaults.drops = true;
      const unsaved = await place(tab, id, (async () =>
        AsyncResult.failure(Cause.die("never asked"))) as never);
      storageFaults.drops = false;
      expect(unsaved.type).toBe("failed");
      expect(await uploadEffect(tab, id)).toBe(0);

      // Its admission's answer is lost: reserved, unbound, still nothing uploaded.
      const lost = await place(tab, id, (async () =>
        AsyncResult.failure(Cause.die("connection lost"))) as never);
      expect(lost.type).toBe("failed");
      expect(await uploadEffect(tab, id)).toBe(0);
      const reserved = tab.store.useComposerDraftStore
        .getState()
        .getDraftSession(id)!.placementOperation!;

      vi.clearAllTimers();
      vi.resetModules();
      const reloaded = await openTab();
      expect(await uploadEffect(reloaded, id)).toBe(0);
      const asked: Array<string> = [];
      const placed = await place(reloaded, id, (async (target: {
        environmentId: string;
        input: { commandId: string; threadId: string; projectId: string };
      }) => {
        asked.push(target.input.commandId);
        boundAtOrigin(target, box, projectThere);
        return AsyncResult.success({
          environmentId: box,
          projectId: projectThere,
          reason: "capacity" as const,
          resumed: true,
        });
      }) as never);
      expect(placed).toEqual({ type: "placed", environmentId: box, projectId: projectThere });
      expect(asked).toEqual([reserved.commandId]);
      // Bound to B, the draft is still on A: nothing uploads to A.
      expect(await uploadEffect(reloaded, id)).toBe(0);
      // The routing hook moves it to B; only then do its attachments upload, to B.
      reloaded.store.useComposerDraftStore.getState().setDraftThreadContext(id, {
        projectRef: scopeProjectRef(box, projectThere),
        environmentSelection: "auto",
        loadBalancedEnvironmentId: box,
      });
      expect(originServer.queueAsked).toEqual([]);
      // The image uploads, to B; the file lost its bytes in the reload and needs attaching again.
      expect(await uploadEffect(reloaded, id)).toBe(1);
      expect(uploads.to).toEqual([{ environmentId: box, name: "shot.png" }]);
      // Only after the queue asked the recorded origin again, for the same command and binding.
      expect(reserved.admittedOn).toBe(origin);
      expect(originServer.queueAsked).toEqual([
        {
          environmentId: origin,
          commandId: reserved.commandId,
          threadId: reloaded.store.useComposerDraftStore.getState().getDraftSession(id)!.threadId,
          projectId: reserved.admittedProjectId,
          candidateEnvironmentIds: [box],
        },
      ]);
      expect(uploads.sequence).toEqual([`admit:${origin}`, `upload:${box}`]);
      // And the launch there goes out as the operation reserved before the reload.
      expect(
        reloaded.placement.heldLaunchFor({
          draft: reloaded.store.useComposerDraftStore.getState().getDraftSession(id),
          environmentId: box,
          projectId: projectThere,
        }),
      ).toMatchObject({
        type: "reserved",
        operation: {
          commandId: reserved.commandId,
          messageId: reserved.messageId,
          createdAt: reserved.createdAt,
          admission: { environmentId: box, projectId: projectThere },
        },
      });
    });
  });

  it("still upload at once on a draft pinned to its machine", async () => {
    await withStorage(async () => {
      const tab = await openTab();
      const id = await composeAutoDraft(tab, "manual");
      tab.store.useComposerDraftStore.getState().setDraftThreadContext(id, {
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      expect(await uploadEffect(tab, id)).toBe(2);
      expect(uploads.to.map(({ environmentId }) => environmentId)).toEqual([origin, origin]);
    });
  });
});

describe("PR74-R1-F4: automatic work's uploads wait for its origin", () => {
  it("keeps an Auto draft automatic when a fresh attachment arrives before the client's pick", async () => {
    await withStorage(async () => {
      const tab = await openTab();
      const id = await composeAutoDraft(tab, "unpicked", null);
      // Still automatic work by ChatView's own rule: nothing pins it, the bytes stay here.
      expect(routesAutomatically(tab, id)).toBe(true);
      expect(await uploadEffect(tab, id)).toBe(0);
      expect(uploads.to).toEqual([]);
      // And its send goes through admission rather than around it.
      expect(
        tab.placement.placesBeforeSend({
          draft: tab.store.useComposerDraftStore.getState().getDraftSession(id),
          automatic: routesAutomatically(tab, id),
          pinnedHere: false,
          request,
        }),
      ).toBe(true);
    });
  });

  it("uploads nothing after a reload on its bound machine until its origin reconciles it", async () => {
    await withStorage(async () => {
      const tab = await openTab();
      const id = await composeAutoDraft(tab, "rebound");
      const bindTo = (async (target: Parameters<typeof boundAtOrigin>[0]) => {
        boundAtOrigin(target, box, projectThere);
        return AsyncResult.success({
          environmentId: box,
          projectId: projectThere,
          reason: "capacity" as const,
          resumed: false,
        });
      }) as never;
      expect((await place(tab, id, bindTo)).type).toBe("placed");
      // The routing hook moves it to B; the renderer dies before the upload or the launch.
      tab.store.useComposerDraftStore.getState().setDraftThreadContext(id, {
        projectRef: scopeProjectRef(box, projectThere),
        environmentSelection: "auto",
        loadBalancedEnvironmentId: box,
      });
      await vi.advanceTimersByTimeAsync(300);
      vi.clearAllTimers();
      vi.resetModules();
      uploads.to.length = 0;
      uploads.sequence.length = 0;
      const reloaded = await openTab();
      const session = () => reloaded.store.useComposerDraftStore.getState().getDraftSession(id)!;
      expect(session().environmentId).toBe(box);
      const reserved = session().placementOperation!;
      // On B, bound to B: still nothing uploads before its origin answers this time.
      expect(await uploadEffect(reloaded, id)).toBe(0);
      // Its origin refuses (replaced sign-in, exclusion) or cannot answer: still nothing.
      for (const answer of [
        AsyncResult.failure(
          Cause.fail(
            new OrchestrationV2ThreadPlacementAdmitError({
              commandId: reserved.commandId as never,
              reason: "other-session",
              detail: "another sign-in",
            }),
          ),
        ),
        AsyncResult.failure(
          Cause.fail(
            new OrchestrationV2ThreadPlacementAdmitError({
              commandId: reserved.commandId as never,
              reason: "excluded",
              detail: "excluded",
            }),
          ),
        ),
        AsyncResult.failure(Cause.die("connection lost")),
      ]) {
        expect((await place(reloaded, id, (async () => answer) as never)).type).toBe("failed");
        expect(await uploadEffect(reloaded, id)).toBe(0);
      }
      expect(uploads.to).toEqual([]);
      // Its origin answers with the same binding for the same command: it uploads, only to B.
      const asked: Array<string> = [];
      const resumed = (async (target: Parameters<typeof boundAtOrigin>[0]) => {
        asked.push(target.input.commandId);
        boundAtOrigin(target, box, projectThere);
        return AsyncResult.success({
          environmentId: box,
          projectId: projectThere,
          reason: "capacity" as const,
          resumed: true,
        });
      }) as never;
      expect(await place(reloaded, id, resumed)).toEqual({
        type: "placed",
        environmentId: box,
        projectId: projectThere,
      });
      expect(asked).toEqual([reserved.commandId]);
      expect(originServer.queueAsked).toEqual([]);
      expect(await uploadEffect(reloaded, id)).toBe(1);
      expect(uploads.to).toEqual([{ environmentId: box, name: "shot.png" }]);
      // Only after the queue asked the recorded origin again, for the same command and binding.
      expect(reserved.admittedOn).toBe(origin);
      expect(originServer.queueAsked).toEqual([
        {
          environmentId: origin,
          commandId: reserved.commandId,
          threadId: session().threadId,
          projectId: reserved.admittedProjectId,
          candidateEnvironmentIds: [box],
        },
      ]);
      expect(uploads.sequence).toEqual([`admit:${origin}`, `upload:${box}`]);
      expect(session().placementOperation).toEqual(reserved);
    });
  });
});
