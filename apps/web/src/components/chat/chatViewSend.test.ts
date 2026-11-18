import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

// The server's side of uploads: the session may read, and the stored uploads still exist.
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  verifyPersistedAttachmentUpload: async () => ({ status: "verified" as const }),
}));

// Node has no FileReader; this one reads the real bytes, after `gate` when one is set.
let gate: Promise<void> | null = null;
class BlobFileReader extends EventTarget {
  result: string | null = null;
  error: unknown = null;
  async readAsDataURL(blob: Blob) {
    const bytes = await blob.arrayBuffer();
    if (gate) await gate;
    this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
    this.dispatchEvent(new Event("load"));
  }
}

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-send"));
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

async function openTab() {
  return {
    store: await import("../../composerDraftStore"),
    send: await import("./chatViewSend"),
    logic: await import("./composerSend.logic"),
    uploads: await import("../../lib/attachmentUploadQueue"),
  };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

async function withReloadableStorage(run: () => Promise<void>) {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("FileReader", BlobFileReader);
  vi.useFakeTimers();
  vi.resetModules();
  try {
    await run();
  } finally {
    gate = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

/** The renderer dies: the next tab reads only what storage holds. */
async function reload() {
  vi.clearAllTimers();
  vi.resetModules();
  return openTab();
}

const launchRequest = (tab: Tab) =>
  tab.logic.draftLaunchRequest({
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    projectId: projectRef.projectId,
    branch: null,
    worktreePath: null,
    baseBranch: null,
    startFromOrigin: false,
  });

/** A draft holding a just-attached image, whose own background saving has not run. */
function composeDraft(
  tab: Tab,
  name: string,
  parts: { prompt: string; file?: boolean; context?: boolean; uploads?: boolean },
) {
  const store = tab.store.useComposerDraftStore.getState();
  const draftId = tab.store.DraftId.make(`draft-${name}`);
  const threadId = ThreadId.make(`thread-${name}`);
  store.setProjectDraftThreadId(projectRef, draftId, { threadId });
  store.setPrompt(draftId, parts.prompt);
  const shot = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
  store.addImages(draftId, [
    {
      type: "image",
      id: "shot-1",
      name: shot.name,
      mimeType: shot.type,
      sizeBytes: shot.size,
      previewUrl: "blob:shot-1",
      file: shot,
    },
  ]);
  if (parts.file) {
    const report = new File(["report bytes"], "report.pdf", { type: "application/pdf" });
    store.addFiles(draftId, [
      {
        type: "file",
        id: "file-1",
        name: report.name,
        mimeType: report.type,
        sizeBytes: report.size,
        file: report,
      },
    ]);
    store.setFileUpload(draftId, "file-1", environmentId, "upload-file-1");
  }
  if (parts.context) {
    store.addThreadContexts(draftId, [
      threadContextRecord(
        scopeThreadRef(environmentId, ThreadId.make("login-thread")),
        "Fix login flow",
      ),
    ]);
  }
  if (parts.uploads) {
    tab.uploads.useAttachmentUploadStore.setState({
      uploadsByImageId: {
        "shot-1": { status: "ready", environmentId, attachmentId: "upload-shot-1" },
        ...(parts.file
          ? { "file-1": { status: "ready", environmentId, attachmentId: "upload-file-1" } }
          : {}),
      },
    });
  }
  expect(store.getComposerDraft(draftId)?.persistedAttachments).toEqual([]);
  return { draftId, threadId };
}

/**
 * A first send in the composer hook's order: read the composer, start preparing attachments,
 * read the sent composer whole, bind, commit the turn, clear. `edit` runs while reads are pending.
 */
async function sendDraft(
  tab: Tab,
  draft: ReturnType<typeof composeDraft>,
  options: { uploads: boolean; stopAfterBind?: boolean; edit?: () => void },
) {
  const store = tab.store.useComposerDraftStore.getState();
  const sentRef = scopeThreadRef(environmentId, draft.threadId);
  const before = store.getComposerDraft(draft.draftId)!;
  const plan = tab.logic.resolveDraftLaunch(
    store.getDraftSession(draft.draftId)?.pendingLaunch,
    launchRequest(tab),
    tab.store.composerDraftCopySignature(before),
  );
  expect(plan.type).toBe("new");
  const operation = {
    commandId: `command-${draft.threadId}`,
    messageId: `message-${draft.threadId}`,
    createdAt: "2026-11-18T11:00:00.000Z",
    request: launchRequest(tab),
  };
  const prepared = tab.send.prepareTurnAttachments({
    environmentId,
    attachments: [...before.images, ...before.files],
    usesAttachmentUploads: options.uploads,
    draftTarget: draft.draftId,
  });
  const sentComposer = tab.send.readSentComposer(before);
  if (options.edit) {
    await vi.advanceTimersByTimeAsync(0);
    options.edit();
    gate = null;
  }
  const composer = await sentComposer;
  expect(tab.store.markPromotedDraftThreadByRef(sentRef, { ...operation, composer })).toBe(true);
  if (options.stopAfterBind) return null;
  const turn = {
    environmentId,
    input: {
      commandId: CommandId.make(operation.commandId),
      threadId: draft.threadId,
      message: {
        messageId: MessageId.make(operation.messageId),
        role: "user" as const,
        text: before.prompt,
        attachments: await prepared,
      },
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: operation.createdAt,
    },
  };
  expect(tab.store.commitPendingLaunchPayload(sentRef, operation.commandId, turn)).toBe(true);
  const cleared = tab.send.clearSentComposerContent(draft.draftId, before);
  return { turn, cleared, before };
}

function sendAgain(tab: Tab, draftId: ReturnType<typeof composeDraft>["draftId"]) {
  const store = tab.store.useComposerDraftStore.getState();
  const composer = store.getComposerDraft(draftId);
  return {
    composer,
    plan: tab.logic.resolveDraftLaunch(
      store.getDraftSession(draftId)?.pendingLaunch,
      launchRequest(tab),
      tab.store.composerDraftCopySignature(composer ?? undefined),
    ),
  };
}

describe("a draft launch interrupted by a reload", () => {
  it("brings back an image-only send after its clear was stored, and resends exactly its turn", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "image-only", { prompt: "" });
      const sent = (await sendDraft(tab, draft, { uploads: false }))!;
      expect(sent.cleared).toBe(true);
      await vi.advanceTimersByTimeAsync(300);

      const { composer, plan } = sendAgain(await reload(), draft.draftId);
      expect(composer?.images.map((image) => image.id)).toEqual(["shot-1"]);
      expect(composer?.persistedAttachments.map((image) => image.dataUrl)).toEqual([
        "data:image/png;base64,AQIDBA==",
      ]);
      expect(plan.type).toBe("retry");
      expect(plan.type === "retry" ? plan.launch.turn : null).toEqual(
        JSON.parse(JSON.stringify(sent.turn)),
      );
    });
  });

  it("recognises a mixed send whose clear was not stored yet as the sent copy", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "mixed", {
        prompt: "Review the report",
        file: true,
        context: true,
        uploads: true,
      });
      const sent = (await sendDraft(tab, draft, { uploads: true }))!;
      expect(sent.turn.input.message.attachments.map((attachment) => attachment.id)).toEqual([
        "upload-shot-1",
        "upload-file-1",
      ]);

      const { composer, plan } = sendAgain(await reload(), draft.draftId);
      expect(composer?.images.map((image) => image.id)).toEqual(["shot-1"]);
      expect(composer?.files.map((file) => file.uploadedAttachmentId)).toEqual(["upload-file-1"]);
      expect(composer?.threadContexts.map((record) => record.title)).toEqual(["Fix login flow"]);
      // A reload links the file inline; the sent message keeps the text it had.
      expect(composer?.prompt).toContain("(t3-context://v1/file/file_file-1)");
      expect(sent.turn.input.message.text).toBe(sent.before.prompt);
      expect(plan.type).toBe("retry");
      expect(plan.type === "retry" ? plan.launch.turn : null).toEqual(
        JSON.parse(JSON.stringify(sent.turn)),
      );
    });
  });

  it("keeps a draft interrupted right after binding, image included, as a new send", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "bound", {
        prompt: "Review the report",
        file: true,
        uploads: true,
      });
      await sendDraft(tab, draft, { uploads: true, stopAfterBind: true });

      const reloaded = await reload();
      const { composer, plan } = sendAgain(reloaded, draft.draftId);
      expect(composer?.images.map((image) => image.id)).toEqual(["shot-1"]);
      expect(composer?.files.map((file) => file.uploadedAttachmentId)).toEqual(["upload-file-1"]);
      // Stored without a turn, it never went out, so sending it is a new launch on that machine.
      expect(plan.type).toBe("new");
      expect(
        reloaded.store.useComposerDraftStore.getState().getDraftSession(draft.draftId)?.sentTo,
      ).toEqual(scopeThreadRef(environmentId, draft.threadId));
    });
  });

  it("keeps an edit made while the send was reading its attachments", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "edited", { prompt: "Describe this" });
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = tab.store.useComposerDraftStore.getState();
      const sent = (await sendDraft(tab, draft, {
        uploads: false,
        edit: () => {
          store.setPrompt(draft.draftId, "Describe this and the logs");
          release();
        },
      }))!;
      // The edit is the user's, so the send leaves the composer as they made it.
      expect(sent.cleared).toBe(false);
      expect(store.getComposerDraft(draft.draftId)?.prompt).toBe("Describe this and the logs");
      // What was sent, and stored to resend, is the message as the send read it.
      expect(sent.turn.input.message.text).toBe("Describe this");
      expect(store.getDraftSession(draft.draftId)?.pendingLaunch?.composer?.prompt).toBe(
        "Describe this",
      );
    });
  });
});
