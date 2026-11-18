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
  runAttachmentUploadCycle: async () => ({
    status: "uploaded" as const,
    attachmentId: "upload-file-retried",
  }),
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
const otherEnvironmentId = EnvironmentId.make("environment-remote");
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
    view: await import("../ChatView.logic"),
    uploads: await import("../../lib/attachmentUploadQueue"),
  };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

// Storage that can refuse a write, or drop it without saying so.
const storageFaults = { throws: false, drops: false };
function faultyStorage() {
  const memory = createMemoryStorage();
  return {
    getItem: (name: string) => memory.getItem(name),
    removeItem: (name: string) => memory.removeItem(name),
    setItem: (name: string, value: string) => {
      if (storageFaults.throws) throw new Error("QuotaExceededError");
      if (!storageFaults.drops) memory.setItem(name, value);
    },
  };
}

async function withReloadableStorage(run: () => Promise<void>) {
  vi.stubGlobal("localStorage", faultyStorage());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("FileReader", BlobFileReader);
  vi.useFakeTimers();
  vi.resetModules();
  try {
    await run();
  } finally {
    gate = null;
    storageFaults.throws = false;
    storageFaults.drops = false;
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

const launchRequest = (tab: Tab, branch: string | null = null) =>
  tab.logic.draftLaunchRequest({
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    projectId: projectRef.projectId,
    branch,
    worktreePath: null,
    baseBranch: null,
    startFromOrigin: false,
  });

/** A draft holding a just-attached image, whose own background saving has not run. */
function composeDraft(
  tab: Tab,
  name: string,
  parts: {
    prompt: string;
    file?: boolean;
    /** The file's first upload failed: it has no upload yet, and Send retries it. */
    failedUpload?: boolean;
    context?: boolean;
    uploads?: boolean;
  },
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
    if (!parts.failedUpload) store.setFileUpload(draftId, "file-1", environmentId, "upload-file-1");
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
          ? {
              "file-1": parts.failedUpload
                ? { status: "failed", environmentId, reason: "Upload failed" }
                : { status: "ready", environmentId, attachmentId: "upload-file-1" },
            }
          : {}),
      },
    });
  }
  expect(store.getComposerDraft(draftId)?.persistedAttachments).toEqual([]);
  return { draftId, threadId };
}

/**
 * A first send in the composer hook's order: read the composer, start or retry its uploads, start
 * preparing attachments, read the sent composer whole, bind, commit the turn with the uploads its
 * files went out as, clear, and on an uncertain launch error restore the draft. `edit` runs while
 * reads are pending; `commitFault` makes storage refuse or drop the turn's commit.
 */
async function sendDraft(
  tab: Tab,
  draft: ReturnType<typeof composeDraft>,
  options: {
    uploads: boolean;
    stopAfterBind?: boolean;
    edit?: () => void;
    launchFails?: boolean;
    commitFault?: "throws" | "drops";
  },
) {
  const store = tab.store.useComposerDraftStore.getState();
  const sentRef = scopeThreadRef(environmentId, draft.threadId);
  const before = store.getComposerDraft(draft.draftId)!;
  const draftThread = store.getDraftSession(draft.draftId)!;
  const snapshot = tab.view.snapshotComposerSend({
    prompt: before.prompt,
    images: before.images,
    files: before.files,
    terminalContexts: before.terminalContexts,
    sendableTerminalContexts: before.terminalContexts,
    previewAnnotations: before.previewAnnotations,
    reviewComments: before.reviewComments,
    threadContexts: before.threadContexts,
    environmentContexts: before.environmentContexts,
    replyTo: before.replyTo,
  });
  const plan = tab.logic.resolveDraftLaunch(
    draftThread.pendingLaunch,
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
  if (options.uploads) {
    for (const attachment of snapshot.attachments) {
      const upload =
        tab.uploads.readAttachmentUpload(attachment.id)?.status === "failed"
          ? tab.uploads.retryAttachmentUpload
          : tab.uploads.startAttachmentUpload;
      upload({ environmentId, image: attachment, draftTarget: draft.draftId });
    }
  }
  const prepared = tab.send.prepareTurnAttachments({
    environmentId,
    attachments: snapshot.attachments,
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
  const attachments = await prepared;
  const turn = {
    environmentId,
    input: {
      commandId: CommandId.make(operation.commandId),
      threadId: draft.threadId,
      message: {
        messageId: MessageId.make(operation.messageId),
        role: "user" as const,
        text: before.prompt,
        attachments,
      },
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: operation.createdAt,
    },
  };
  const fileUploads = tab.send.preparedFileUploads({
    environmentId,
    attachments: snapshot.attachments,
    prepared: attachments,
    usesAttachmentUploads: options.uploads,
  });
  const boundLaunch = store.getDraftSession(draft.draftId)?.pendingLaunch;
  if (options.commitFault) storageFaults[options.commitFault] = true;
  const committed = tab.store.commitPendingLaunchPayload(
    sentRef,
    operation.commandId,
    turn,
    fileUploads,
  );
  storageFaults.throws = false;
  storageFaults.drops = false;
  if (!committed) return { committed, boundLaunch, turn, cleared: false, before, operation };
  const cleared = tab.send.clearSentComposerContent(draft.draftId, before);
  if (options.launchFails) {
    // No launch answer proves the host did not take it: the hook's restore for an emptied draft.
    tab.store.restoreFailedDraftThread(draft.draftId, draftThread, draft.threadId, operation);
    tab.send.restoreComposerDraft(draft.draftId, snapshot);
    tab.store.markRestoredLaunchCopy(draft.draftId);
  }
  return { committed, boundLaunch, turn, cleared, before, operation };
}

function sendAgain(
  tab: Tab,
  draftId: ReturnType<typeof composeDraft>["draftId"],
  branch: string | null = null,
) {
  const store = tab.store.useComposerDraftStore.getState();
  const composer = store.getComposerDraft(draftId);
  return {
    composer,
    plan: tab.logic.resolveDraftLaunch(
      store.getDraftSession(draftId)?.pendingLaunch,
      launchRequest(tab, branch),
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

  it("keeps a draft interrupted right after binding as that operation, image included", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "bound", {
        prompt: "Review the report",
        file: true,
        uploads: true,
      });
      await sendDraft(tab, draft, { uploads: true, stopAfterBind: true });
      const bound = tab.store.useComposerDraftStore
        .getState()
        .getDraftSession(draft.draftId)!.pendingLaunch!;

      const reloaded = await reload();
      const { composer, plan } = sendAgain(reloaded, draft.draftId);
      expect(composer?.images.map((image) => image.id)).toEqual(["shot-1"]);
      expect(composer?.files.map((file) => file.uploadedAttachmentId)).toEqual(["upload-file-1"]);
      // Sent unchanged, it keeps its identity; its turn is still to be prepared.
      expect(plan.type).toBe("retry");
      expect(plan.type === "retry" ? plan.launch : null).toMatchObject({
        commandId: bound.commandId,
        messageId: bound.messageId,
        createdAt: bound.createdAt,
      });
      expect(plan.type === "retry" ? plan.launch.turn : null).toBeUndefined();
      expect(
        reloaded.store.useComposerDraftStore.getState().getDraftSession(draft.draftId)?.sentTo,
      ).toEqual(scopeThreadRef(environmentId, draft.threadId));
    });
  });

  it("starts a changed send afresh after a crash right after binding, on the same machine and thread", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "rebound", { prompt: "Run the suite" });
      await sendDraft(tab, draft, { uploads: false, stopAfterBind: true });

      const reloaded = await reload();
      // Nothing went out, so another branch is a new operation, not a blocked one.
      expect(sendAgain(reloaded, draft.draftId, "other-branch").plan.type).toBe("new");
      // It stays bound: neither balancing nor a manual switch moves its thread elsewhere.
      const store = reloaded.store.useComposerDraftStore.getState();
      const elsewhere = scopeProjectRef(otherEnvironmentId, projectRef.projectId);
      store.setDraftThreadContext(draft.draftId, {
        projectRef: elsewhere,
        environmentSelection: "auto",
        loadBalancedEnvironmentId: otherEnvironmentId,
      });
      store.setProjectDraftThreadId(elsewhere, draft.draftId, { environmentSelection: "manual" });
      expect(
        reloaded.store.useComposerDraftStore.getState().getDraftSession(draft.draftId),
      ).toMatchObject({
        environmentId,
        threadId: draft.threadId,
        sentTo: scopeThreadRef(environmentId, draft.threadId),
      });
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

describe("a draft launch whose file's first upload failed", () => {
  const sentFileUploads = (
    composer:
      | { files: ReadonlyArray<{ id: string; uploadedAttachmentId?: string }> }
      | null
      | undefined,
  ) => composer?.files.map((file) => [file.id, file.uploadedAttachmentId]);

  it("comes back sendable, with the upload its send made, after a crash once its clear was stored", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "retried-upload", {
        prompt: "Review the report",
        file: true,
        failedUpload: true,
        uploads: true,
      });
      const sent = (await sendDraft(tab, draft, { uploads: true }))!;
      // The send read the file before its retried upload finished.
      expect(sent.before.files[0]?.uploadedAttachmentId).toBeUndefined();
      expect(sent.turn.input.message.attachments.map((attachment) => attachment.id)).toEqual([
        "upload-shot-1",
        "upload-file-retried",
      ]);
      await vi.advanceTimersByTimeAsync(300);

      const reloaded = await reload();
      const { composer, plan } = sendAgain(reloaded, draft.draftId);
      expect(sentFileUploads(composer)).toEqual([["file-1", "upload-file-retried"]]);
      expect(composer?.files.some(reloaded.store.composerFileNeedsReattach)).toBe(false);
      expect(plan.type).toBe("retry");
      expect(plan.type === "retry" ? plan.launch : null).toMatchObject({
        commandId: sent.operation.commandId,
        messageId: sent.operation.messageId,
        turn: JSON.parse(JSON.stringify(sent.turn)),
      });
    });
  });

  it("restores an uncertain failed launch with that upload, kept across a reload", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "restored-upload", {
        prompt: "Review the report",
        file: true,
        failedUpload: true,
        uploads: true,
      });
      const sent = (await sendDraft(tab, draft, { uploads: true, launchFails: true }))!;
      const restored = tab.store.useComposerDraftStore.getState().getComposerDraft(draft.draftId);
      expect(sentFileUploads(restored)).toEqual([["file-1", "upload-file-retried"]]);
      await vi.advanceTimersByTimeAsync(300);

      const reloaded = await reload();
      const { composer, plan } = sendAgain(reloaded, draft.draftId);
      expect(sentFileUploads(composer)).toEqual([["file-1", "upload-file-retried"]]);
      expect(composer?.files.some(reloaded.store.composerFileNeedsReattach)).toBe(false);
      expect(plan.type).toBe("retry");
      expect(plan.type === "retry" ? plan.launch : null).toMatchObject({
        commandId: sent.operation.commandId,
        messageId: sent.operation.messageId,
        turn: JSON.parse(JSON.stringify(sent.turn)),
      });
    });
  });

  it.each(["throws", "drops"] as const)(
    "keeps the bound operation, its composer and the draft when storage %s the turn's commit",
    async (fault) => {
      await withReloadableStorage(async () => {
        const tab = await openTab();
        const draft = composeDraft(tab, `fault-${fault}`, {
          prompt: "Review the report",
          file: true,
          failedUpload: true,
          uploads: true,
        });
        const sent = (await sendDraft(tab, draft, { uploads: true, commitFault: fault }))!;
        expect(sent.committed).toBe(false);
        const session = tab.store.useComposerDraftStore.getState().getDraftSession(draft.draftId)!;
        // In memory and in storage: the operation as bound, no turn, no upload on its composer.
        expect(session.pendingLaunch).toEqual(sent.boundLaunch);
        expect(session.pendingLaunch?.turn).toBeUndefined();
        expect(session.pendingLaunch?.composer?.files?.[0]?.attachmentId).toBeUndefined();
        expect(session.promotedTo).toEqual(scopeThreadRef(environmentId, draft.threadId));
        expect(
          tab.store.useComposerDraftStore.getState().getComposerDraft(draft.draftId)?.prompt,
        ).toBe("Review the report");
        const reloaded = await reload();
        const stored = reloaded.store.useComposerDraftStore
          .getState()
          .getDraftSession(draft.draftId);
        expect(stored?.pendingLaunch?.turn).toBeUndefined();
        expect(stored?.pendingLaunch?.commandId).toBe(sent.operation.commandId);
        expect(stored?.sentTo).toEqual(scopeThreadRef(environmentId, draft.threadId));
      });
    },
  );
});
