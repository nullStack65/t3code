import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

// The network edges of an upload: the session may operate, and each upload cycle is recorded.
const uploads = vi.hoisted(() => ({ to: [] as Array<{ environmentId: string; name: string }> }));
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
    return { status: "uploaded" as const, attachmentId: `upload-${uploads.to.length}` };
  },
}));

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
  try {
    await run();
  } finally {
    storageFaults.drops = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

/** The composer's upload effect, as ChatView configures it for this draft now. */
async function uploadEffect(tab: Tab, draftId: string, automatic: boolean) {
  const id = tab.store.DraftId.make(draftId);
  const state = tab.store.useComposerDraftStore.getState();
  const session = state.getDraftSession(id);
  const composer = state.getComposerDraft(id)!;
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
  return started;
}

async function composeAutoDraft(tab: Tab, name: string) {
  const id = tab.store.DraftId.make(`draft-${name}`);
  const store = tab.store.useComposerDraftStore.getState();
  // The client's own pick: not a binding.
  store.setProjectDraftThreadId(scopeProjectRef(origin, projectHere), id, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: origin,
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
      expect(await uploadEffect(tab, id, true)).toBe(0);
      expect(uploads.to).toEqual([]);

      // Storage cannot hold the operation: nothing is asked, nothing uploaded.
      storageFaults.drops = true;
      const unsaved = await place(tab, id, (async () =>
        AsyncResult.failure(Cause.die("never asked"))) as never);
      storageFaults.drops = false;
      expect(unsaved.type).toBe("failed");
      expect(await uploadEffect(tab, id, true)).toBe(0);

      // Its admission's answer is lost: reserved, unbound, still nothing uploaded.
      const lost = await place(tab, id, (async () =>
        AsyncResult.failure(Cause.die("connection lost"))) as never);
      expect(lost.type).toBe("failed");
      expect(await uploadEffect(tab, id, true)).toBe(0);
      const reserved = tab.store.useComposerDraftStore
        .getState()
        .getDraftSession(id)!.placementOperation!;

      vi.clearAllTimers();
      vi.resetModules();
      const reloaded = await openTab();
      expect(await uploadEffect(reloaded, id, true)).toBe(0);
      const asked: Array<string> = [];
      const placed = await place(reloaded, id, (async ({
        input,
      }: {
        input: { commandId: string };
      }) => {
        asked.push(input.commandId);
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
      expect(await uploadEffect(reloaded, id, true)).toBe(0);
      // The routing hook moves it to B; only then do its attachments upload, to B.
      reloaded.store.useComposerDraftStore.getState().setDraftThreadContext(id, {
        projectRef: scopeProjectRef(box, projectThere),
        environmentSelection: "auto",
        loadBalancedEnvironmentId: box,
      });
      // The image uploads, to B; the file lost its bytes in the reload and needs attaching again.
      expect(await uploadEffect(reloaded, id, true)).toBe(1);
      expect(uploads.to).toEqual([{ environmentId: box, name: "shot.png" }]);
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
      expect(await uploadEffect(tab, id, false)).toBe(2);
      expect(uploads.to.map(({ environmentId }) => environmentId)).toEqual([origin, origin]);
    });
  });
});
