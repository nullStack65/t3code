import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

// PR74-R1-F4 (caller disposition D3): every upload of an admitted draft is qualified by its origin
// at the queue itself. One page and one real queue stay alive throughout; only network edges are
// doubles: the origin's admission answer, the upload cycle and persisted-upload verification.
const net = vi.hoisted(() => ({
  origin: { answer: "bound" as "bound" | "other-session" | "excluded" | "lost" },
  admissions: [] as Array<{ environmentId: string; commandId: string }>,
  /** Held admission answers, released by the test. */
  hold: null as null | Promise<void>,
  cycles: [] as Array<{ environmentId: string; name: string }>,
  verifications: [] as Array<{ environmentId: string; attachmentId: string }>,
  failNextCycle: false,
  /** Machines where this client's operate access was revoked. */
  denied: new Set<string>(),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: (environmentId: string) => !net.denied.has(environmentId),
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  verifyPersistedAttachmentUpload: async (input: {
    readonly environmentId: string;
    readonly attachmentId: string;
  }) => {
    net.verifications.push({
      environmentId: input.environmentId,
      attachmentId: input.attachmentId,
    });
    return { status: "verified" as const };
  },
  runAttachmentUploadCycle: async (input: {
    readonly environmentId: string;
    readonly upload: { readonly name: string };
  }) => {
    net.cycles.push({ environmentId: input.environmentId, name: input.upload.name });
    if (net.failNextCycle) {
      net.failNextCycle = false;
      return { status: "failed" as const, step: "transfer" as const, error: new Error("lost") };
    }
    return { status: "uploaded" as const, attachmentId: `upload-${net.cycles.length}` };
  },
}));
// Connection state and session generation per machine, which the test changes.
const connection = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  generation: new Map<string, unknown>(),
}));
vi.mock("../../connection/catalog", async () => {
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  const family = (map: Map<string, unknown>, initial: () => unknown) => (environmentId: string) => {
    if (!map.has(environmentId)) map.set(environmentId, A.make(initial()));
    return map.get(environmentId);
  };
  return {
    environmentCatalog: {
      stateAtom: family(connection.state, () => Result.success({ phase: "connected" })),
      sessionGenerationAtom: family(connection.generation, () => 1),
    },
  };
});
// The origin's admission RPC, answered as `net.origin.answer` says.
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { AsyncResult: Result } = await import("effect/reactivity");
  const CauseModule = await import("effect/Cause");
  const { OrchestrationV2ThreadPlacementAdmitError: AdmitError } =
    await import("@t3tools/contracts");
  return {
    ...real,
    runAtomCommand: async (registry: never, command: never, target: never) => {
      const admission = (
        target as { input?: { candidateEnvironmentIds?: unknown; commandId?: string } }
      ).input;
      if (admission?.candidateEnvironmentIds === undefined)
        return real.runAtomCommand(registry, command, target);
      const { environmentId } = target as { environmentId: string };
      net.admissions.push({ environmentId, commandId: admission.commandId! });
      if (net.hold) await net.hold;
      if (net.origin.answer === "lost") return Result.failure(CauseModule.die("connection lost"));
      if (net.origin.answer !== "bound")
        return Result.failure(
          CauseModule.fail(
            new AdmitError({
              commandId: admission.commandId as never,
              reason: net.origin.answer,
              detail: `refused: ${net.origin.answer}`,
            }),
          ),
        );
      return Result.success({
        environmentId: "environment-box",
        projectId: "project:box",
        reason: "capacity",
        resumed: true,
      });
    },
  };
});

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

// Only one test may own the fake clock. A timed-out test keeps running, and its
// finally used to uninstall the next test's timers (and its late upload landed
// in the next test's hoisted doubles).
let timerScope = 0;

function useScopedFakeTimers() {
  // setImmediate and performance stay real. The loader and fake-timer clock
  // both yield through them; faking them before import leaves the import pending
  // until the 15s test timeout.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

async function importFresh<T>(load: () => Promise<T>): Promise<T> {
  const scope = timerScope;
  const restore = vi.isFakeTimers();
  if (restore) vi.useRealTimers();
  vi.resetModules();
  try {
    return await load();
  } finally {
    if (restore && scope === timerScope) useScopedFakeTimers();
  }
}

async function openPage() {
  return importFresh(async () => ({
    store: await import("../../composerDraftStore"),
    placement: await import("./draftPlacement"),
    queue: await import("../../lib/attachmentUploadQueue"),
    registry: (await import("../../rpc/atomRegistry")).appAtomRegistry,
    catalog: (await import("../../connection/catalog")).environmentCatalog,
  }));
}
type Page = Awaited<ReturnType<typeof openPage>>;

async function withPage(run: (page: Page) => Promise<void>) {
  const scope = ++timerScope;
  const memory = createMemoryStorage();
  const storage = {
    getItem: (name: string) => memory.getItem(name),
    removeItem: (name: string) => memory.removeItem(name),
    setItem: (name: string, value: string) => memory.setItem(name, value),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  useScopedFakeTimers();
  net.origin.answer = "bound";
  net.admissions.length = 0;
  net.cycles.length = 0;
  net.verifications.length = 0;
  net.hold = null;
  net.failNextCycle = false;
  net.denied.clear();
  connection.state.clear();
  connection.generation.clear();
  try {
    await run(await openPage());
  } finally {
    if (scope === timerScope) {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Waits for the queue's own jobs for these attachments, including a retry they started. */
const drain = async (page: {
  queue: { awaitAttachmentUploads: (ids: string[]) => Promise<void> };
}) => {
  await settle();
  await page.queue.awaitAttachmentUploads(["shot", "later"]);
  await settle();
};

function image(id: string) {
  const file = new File([new Uint8Array([1, 2, 3, 4])], `${id}.png`, { type: "image/png" });
  return {
    type: "image" as const,
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

/** An automatic draft with an image, admitted on its origin to B and moved there by routing. */
async function admittedOnBox(page: Page) {
  const id = page.store.DraftId.make("draft-held");
  const store = page.store.useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(origin, projectHere), id, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: null,
  });
  store.setPrompt(id, "Review the screenshot");
  store.addImages(id, [image("shot")]);
  const placed = await page.placement.placeDraftBeforeSend({
    draftId: id,
    request,
    candidateEnvironmentIds: [origin, box],
    pinnedHere: false,
    admit: (async () =>
      AsyncResult.success({
        environmentId: box,
        projectId: projectThere,
        reason: "capacity" as const,
        resumed: false,
      })) as never,
    canLaunchOn: () => true,
    composerUnchanged: () => true,
  });
  expect(placed.type).toBe("placed");
  store.setDraftThreadContext(id, {
    projectRef: scopeProjectRef(box, projectThere),
    environmentSelection: "auto",
    loadBalancedEnvironmentId: box,
  });
  return id;
}

/** The composer's upload effect for the draft as it is now, with ChatView's own Auto rule. */
async function uploadEffect(
  page: Page,
  id: ReturnType<Page["store"]["DraftId"]["make"]>,
  /** False while the origin's answer is held: nothing to wait for yet. */
  wait = true,
) {
  const state = page.store.useComposerDraftStore.getState();
  const session = state.getDraftSession(id)!;
  const composer = state.getComposerDraft(id)!;
  page.placement.startComposerAttachmentUploads({
    environmentId: session.environmentId,
    attachments: [...composer.images, ...composer.files],
    draftTarget: id,
    waitForPlacement: page.placement.attachmentUploadsWaitForPlacement({
      draft: session,
      automatic: page.placement.draftRoutesAutomatically({
        clientSettingsHydrated: true,
        isDraft: true,
        envLocked: false,
        canAutoBalanceEnvironments: true,
        loadBalancingEnabled: true,
        draft: session,
      }),
      environmentId: session.environmentId,
    }),
    start: page.queue.startAttachmentUpload,
  });
  if (wait) await drain(page);
  else await settle();
}

/** B drops its connection and comes back, as the queue's own watcher sees it. */
async function reconnect(page: Page, environmentId: EnvironmentId) {
  const atom = connection.state.get(environmentId) as Atom.Writable<unknown>;
  page.registry.set(atom, AsyncResult.success({ phase: "disconnected" }));
  await settle();
  page.registry.set(atom, AsyncResult.success({ phase: "connected" }));
  await drain(page);
}

const targetEffects = () => [...net.cycles, ...net.verifications];

// The queue's own refusal reasons: a generic failure ("Upload failed") is not one of them.
const STALE = "This draft changed while its placement was confirmed, so nothing was uploaded.";
const UNCONFIRMED = "This draft's placement could not be confirmed, so nothing was uploaded.";
const OWNER_LOST =
  "This upload belonged to a placed launch this draft no longer holds, so nothing was uploaded.";
const reasonOf = (page: Page, attachmentId: string) => {
  const state = page.queue.readAttachmentUpload(attachmentId);
  return state?.status === "failed" ? state.reason : state?.status;
};

describe("PR74-R1-F4: an admitted draft's uploads are qualified by its origin each time", () => {
  it("retries a failed upload on reconnect only after its origin answers with the same binding", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      // The first upload goes out after its origin confirms the binding, and fails on the way.
      net.failNextCycle = true;
      await uploadEffect(page, id);
      expect(net.cycles).toEqual([{ environmentId: box, name: "shot.png" }]);
      expect(page.queue.readAttachmentUpload("shot")?.status).toBe("failed");
      // The origin now refuses (another sign-in, or B excluded) or cannot answer, the page alive.
      for (const answer of ["other-session", "excluded", "lost"] as const) {
        net.origin.answer = answer;
        const before = net.admissions.length;
        await reconnect(page, box);
        expect(net.admissions.length).toBeGreaterThan(before);
        expect(net.cycles).toHaveLength(1);
        const reason = answer === "lost" ? UNCONFIRMED : `refused: ${answer}`;
        expect(reasonOf(page, "shot")).toBe(reason);
        const current = page.store.useComposerDraftStore.getState().getComposerDraft(id)!
          .images[0]!;
        page.queue.retryAttachmentUpload({ environmentId: box, image: current, draftTarget: id });
        await drain(page);
        expect(net.cycles).toHaveLength(1);
        expect(reasonOf(page, "shot")).toBe(reason);
      }
      expect(net.verifications).toEqual([]);
      // Answering with the same binding again, the retry goes out to B, as the same operation.
      net.origin.answer = "bound";
      await reconnect(page, box);
      expect(net.cycles).toEqual([
        { environmentId: box, name: "shot.png" },
        { environmentId: box, name: "shot.png" },
      ]);
      expect(net.admissions.every((asked) => asked.environmentId === origin)).toBe(true);
      const operation = page.store.useComposerDraftStore
        .getState()
        .getDraftSession(id)!.placementOperation!;
      expect(new Set(net.admissions.map((asked) => asked.commandId))).toEqual(
        new Set([operation.commandId]),
      );
    });
  });

  it("sends a newly added attachment nowhere once its origin's answer has changed", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      await uploadEffect(page, id);
      expect(net.cycles).toHaveLength(1);
      net.origin.answer = "other-session";
      page.store.useComposerDraftStore.getState().addImages(id, [image("later")]);
      await uploadEffect(page, id);
      expect(net.cycles).toHaveLength(1);
    });
  });

  it.each([
    "the attachment is removed",
    "the attachment is replaced",
    "the draft moves machine",
    "B's session is replaced",
  ] as const)("releases nothing when %s while its origin is asked", async (change) => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      let release!: () => void;
      net.hold = new Promise<void>((done) => {
        release = done;
      });
      await uploadEffect(page, id, false);
      // Asked, and held there: nothing has gone to B yet.
      expect(net.admissions).toHaveLength(1);
      expect(targetEffects()).toEqual([]);
      const store = page.store.useComposerDraftStore.getState();
      if (change === "the attachment is removed") store.removeImage(id, "shot");
      if (change === "the attachment is replaced") {
        store.removeImage(id, "shot");
        store.addImages(id, [image("shot")], { allowDuplicates: true });
      }
      if (change === "the draft moves machine")
        store.setDraftThreadContext(id, {
          projectRef: scopeProjectRef(origin, projectHere),
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      if (change === "B's session is replaced") {
        const generation = connection.generation.get(box) as Atom.Writable<number>;
        page.registry.set(generation, 2);
      }
      release();
      await drain(page);
      expect(targetEffects()).toEqual([]);
      // Refused by the queue's own check, or released with the attachment: never a crash.
      expect(reasonOf(page, "shot")).not.toBe("Upload failed");
    });
  });

  it.each([
    "the origin's connection drops",
    "the origin's operate access is revoked",
    "the composer's text is edited",
    "the same file is attached again",
  ] as const)("releases nothing when %s while its origin is asked", async (change) => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      let release!: () => void;
      net.hold = new Promise<void>((done) => {
        release = done;
      });
      await uploadEffect(page, id, false);
      expect(net.admissions).toHaveLength(1);
      expect(targetEffects()).toEqual([]);
      const store = page.store.useComposerDraftStore.getState();
      if (change === "the origin's connection drops")
        // Through the catalog itself: the origin's state may not have been read yet.
        page.registry.set(
          page.catalog.stateAtom(origin) as unknown as Atom.Writable<unknown>,
          AsyncResult.success({ phase: "disconnected" }),
        );
      if (change === "the origin's operate access is revoked") net.denied.add(origin);
      if (change === "the composer's text is edited")
        store.setPrompt(id, "Review the screenshot and the logs");
      if (change === "the same file is attached again") {
        const attached = store.getComposerDraft(id)!.images[0]!;
        store.removeImage(id, "shot");
        store.addImages(id, [{ ...attached }], { allowDuplicates: true });
      }
      release();
      await drain(page);
      expect(targetEffects()).toEqual([]);
      expect(reasonOf(page, "shot")).toBe(STALE);
    });
  });

  it("verifies nothing when a stored file's marker is replaced while its origin is asked", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      const store = page.store.useComposerDraftStore.getState();
      // A file already uploaded to B, kept here as its marker: no bytes, its upload's id.
      const marker = {
        type: "file" as const,
        id: "report",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        file: null,
        uploadedAttachmentId: "upload-report",
        uploadEnvironmentId: box,
      };
      store.addFiles(id, [marker]);
      expect(store.getComposerDraft(id)!.files[0]).toMatchObject({
        file: null,
        uploadedAttachmentId: "upload-report",
      });
      let release!: () => void;
      net.hold = new Promise<void>((done) => {
        release = done;
      });
      await uploadEffect(page, id, false);
      store.removeFile(id, "report");
      store.addFiles(id, [{ ...marker }]);
      release();
      await drain(page);
      expect(net.verifications).toEqual([]);
      expect(reasonOf(page, "report")).toBe(STALE);
    });
  });

  it("keeps a queued retry with its placed launch after the draft lets go of that launch", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      net.failNextCycle = true;
      await uploadEffect(page, id);
      expect(net.cycles).toHaveLength(1);
      // The draft starts over under a new thread: its placed launch is no longer its own.
      const store = page.store.useComposerDraftStore.getState();
      page.store.restoreFailedDraftThread(
        id,
        store.getDraftSession(id)!,
        ThreadId.make("thread-new-intent"),
      );
      expect(store.getDraftSession(id)?.placementOperation ?? null).toBeNull();
      // B reconnects and the queue retries the failed upload: it is not an ordinary one now.
      await reconnect(page, box);
      expect(net.cycles).toHaveLength(1);
      expect(reasonOf(page, "shot")).toBe(OWNER_LOST);
    });
  });

  it("checks a stored upload at send only after its origin answers with the same binding", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      await uploadEffect(page, id);
      expect(page.queue.readAttachmentUpload("shot")?.status).toBe("ready");
      const current = () =>
        page.store.useComposerDraftStore.getState().getComposerDraft(id)!.images[0]!;
      // Its origin now refuses: the stored upload is not even verified there.
      net.origin.answer = "excluded";
      await page.queue.refreshExpiredAttachmentUploads({
        environmentId: box,
        images: [current()],
        draftTarget: id,
      });
      expect(net.verifications).toEqual([]);
      expect(page.queue.readAttachmentUpload("shot")?.status).toBe("failed");
    });
  });

  it("sends an unchanged admitted draft's upload to its bound machine after its origin answers", async () => {
    await withPage(async (page) => {
      const id = await admittedOnBox(page);
      await uploadEffect(page, id);
      expect(net.cycles).toEqual([{ environmentId: box, name: "shot.png" }]);
      expect(net.admissions.map((asked) => asked.environmentId)).toEqual([origin]);
    });
  });
});
