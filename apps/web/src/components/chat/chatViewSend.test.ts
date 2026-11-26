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
import * as NodeAsyncHooks from "node:async_hooks";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

// The server's side of uploads: the session may read, and the stored uploads still exist.
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => {
  const { Effect } = await import("effect");
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
    verifyPersistedAttachmentUpload: () => Effect.succeed({ status: "verified" as const }),
    runAttachmentUploadCycle: () =>
      Effect.succeed({ status: "uploaded" as const, attachmentId: "upload-file-retried" }),
  };
});

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

// One test owns the fake clock. setImmediate and performance stay real, or the
// import waits out the 15s timeout. A timed-out test's continuation stops once a
// newer test owns the globals.
const storageRuns = new NodeAsyncHooks.AsyncLocalStorage<number>();
let timerScope = 0;

class SupersededStorageRun {
  readonly _tag = "SupersededStorageRun";
}

function assertStorageOwner() {
  if (storageRuns.getStore() !== timerScope) throw new SupersededStorageRun();
}

function useScopedFakeTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

async function importFresh<T>(load: () => Promise<T>): Promise<T> {
  const owner = storageRuns.getStore();
  if (owner !== undefined && owner !== timerScope) throw new SupersededStorageRun();
  const restore = vi.isFakeTimers();
  if (restore) vi.useRealTimers();
  vi.resetModules();
  try {
    const loaded = await load();
    if (owner !== undefined && owner !== timerScope) throw new SupersededStorageRun();
    return loaded;
  } finally {
    if (restore && owner === timerScope) useScopedFakeTimers();
  }
}

async function openTab() {
  return importFresh(async () => ({
    store: await import("../../composerDraftStore"),
    send: await import("./chatViewSend"),
    logic: await import("./composerSend.logic"),
    view: await import("../ChatView.logic"),
    uploads: await import("../../lib/attachmentUploadQueue"),
  }));
}
type Tab = Awaited<ReturnType<typeof openTab>>;

// Storage that can refuse a write, drop it without saying so, or take it and fail the read after.
const storageFaults = { throws: false, drops: false, landsUnread: false, readFails: false };
function resetStorageFaults() {
  storageFaults.throws = false;
  storageFaults.drops = false;
  storageFaults.landsUnread = false;
  storageFaults.readFails = false;
}
function faultyStorage() {
  const memory = createMemoryStorage();
  return {
    getItem: (name: string) => {
      if (storageFaults.readFails) {
        storageFaults.readFails = false;
        throw new Error("SecurityError");
      }
      return memory.getItem(name);
    },
    removeItem: (name: string) => memory.removeItem(name),
    setItem: (name: string, value: string) => {
      if (storageFaults.throws) throw new Error("QuotaExceededError");
      if (!storageFaults.drops) memory.setItem(name, value);
      if (storageFaults.landsUnread) storageFaults.readFails = true;
    },
  };
}

async function withReloadableStorage(run: () => Promise<void>) {
  const scope = ++timerScope;
  return storageRuns.run(scope, async () => {
    vi.stubGlobal("localStorage", faultyStorage());
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("FileReader", BlobFileReader);
    useScopedFakeTimers();
    try {
      await run();
    } catch (error) {
      if (error instanceof SupersededStorageRun) return;
      throw error;
    } finally {
      if (storageRuns.getStore() === timerScope) {
        gate = null;
        resetStorageFaults();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    }
  });
}

/** The renderer dies: the next tab reads only what storage holds. */
async function reload() {
  assertStorageOwner();
  vi.clearAllTimers();
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
 * A new send in the composer hook's order: read the composer, start or retry its uploads, start
 * preparing attachments, read the sent composer whole, bind, commit the turn with the uploads its
 * files went out as, clear, and on any failure run the hook's own cleanup. `edit` runs while reads
 * are pending, `editBeforeCommit` after binding; the faults make storage refuse or drop a write.
 */
async function sendDraft(
  tab: Tab,
  draft: ReturnType<typeof composeDraft>,
  options: {
    uploads: boolean;
    stopAfterBind?: boolean;
    edit?: () => void;
    editBeforeCommit?: () => void;
    launchFails?: boolean;
    bindFault?: "throws" | "drops" | "landsUnread";
    commitFault?: "throws" | "drops" | "landsUnread";
    /** Distinguishes a later send's operation on the same thread. */
    label?: string;
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
    commandId: `command-${draft.threadId}${options.label ?? ""}`,
    messageId: `message-${draft.threadId}${options.label ?? ""}`,
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
  assertStorageOwner();
  if (options.bindFault) storageFaults[options.bindFault] = true;
  const bound = tab.store.markPromotedDraftThreadByRef(sentRef, { ...operation, composer });
  resetStorageFaults();
  // The hook's cleanup for a send that did not complete: the same seams, in the same order.
  const cleanUp = (cleared: boolean) => {
    tab.store.restoreFailedDraftThread(
      draft.draftId,
      draftThread,
      draft.threadId,
      tab.send.launchLeftPendingAfterFailure({
        launch: operation,
        priorLaunch: draftThread.pendingLaunch ?? null,
        bound,
      }),
    );
    return tab.send.restoreFailedSendComposer({
      draftTarget: draft.draftId,
      boundDraftId: bound ? draft.draftId : null,
      before,
      cleared,
      snapshot,
    }).type;
  };
  if (!bound) return { bound, committed: false, cleared: false, failed: cleanUp(false), before };
  if (options.stopAfterBind) return null;
  const attachments = await prepared;
  assertStorageOwner();
  options.editBeforeCommit?.();
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
  resetStorageFaults();
  if (!committed) {
    const rolledBack = store.getDraftSession(draft.draftId)?.pendingLaunch;
    const failed = cleanUp(false);
    return {
      bound,
      committed,
      boundLaunch,
      rolledBack,
      turn,
      cleared: false,
      failed,
      before,
      operation,
    };
  }
  const cleared = tab.send.clearSentComposerContent(draft.draftId, before);
  // No launch answer proves the host did not take it.
  const failed = options.launchFails ? cleanUp(cleared) : undefined;
  return { bound, committed, boundLaunch, turn, cleared, failed, before, operation };
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
      expect(sent.turn!.input.message.attachments.map((attachment) => attachment.id)).toEqual([
        "upload-shot-1",
        "upload-file-1",
      ]);

      const { composer, plan } = sendAgain(await reload(), draft.draftId);
      expect(composer?.images.map((image) => image.id)).toEqual(["shot-1"]);
      expect(composer?.files.map((file) => file.uploadedAttachmentId)).toEqual(["upload-file-1"]);
      expect(composer?.threadContexts.map((record) => record.title)).toEqual(["Fix login flow"]);
      // A reload links the file inline; the sent message keeps the text it had.
      expect(composer?.prompt).toContain("(t3-context://v1/file/file_file-1)");
      expect(sent.turn!.input.message.text).toBe(sent.before.prompt);
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
      expect(sent.turn!.input.message.text).toBe("Describe this");
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
      expect(sent.turn!.input.message.attachments.map((attachment) => attachment.id)).toEqual([
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
        commandId: sent.operation!.commandId,
        messageId: sent.operation!.messageId,
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
        commandId: sent.operation!.commandId,
        messageId: sent.operation!.messageId,
        turn: JSON.parse(JSON.stringify(sent.turn)),
      });
    });
  });

  it.each(["throws", "drops", "landsUnread"] as const)(
    "keeps a bound first launch as itself through the failure cleanup (turn write fault: %s)",
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
        // The commit's rollback left the operation as bound: no turn, no upload on its composer.
        expect(sent.rolledBack).toEqual(sent.boundLaunch);
        expect(sent.boundLaunch?.turn).toBeUndefined();
        expect(sent.boundLaunch?.composer?.files?.[0]?.attachmentId).toBeUndefined();
        // Never cleared, never launched: the composer still is the sent copy.
        expect(sent.failed).toBe("kept");
        const sentRef = scopeThreadRef(environmentId, draft.threadId);
        // A reload links the uploaded file inline after the user's own text.
        const expectSameLaunch = (current: Tab, prompt: string) => {
          const session = current.store.useComposerDraftStore
            .getState()
            .getDraftSession(draft.draftId)!;
          const { restoredCopy: _copy, ...committed } = session.pendingLaunch!;
          expect(committed).toEqual(sent.boundLaunch);
          expect(session.sentTo).toEqual(sentRef);
          expect(
            current.store.useComposerDraftStore.getState().getComposerDraft(draft.draftId)?.prompt,
          ).toBe(prompt);
          // Sent again unchanged, it is that launch: same command, message and creation time.
          const { plan } = sendAgain(current, draft.draftId);
          expect(plan.type).toBe("retry");
          expect(plan.type === "retry" ? plan.launch : null).toMatchObject({
            commandId: sent.operation!.commandId,
            messageId: sent.operation!.messageId,
            createdAt: sent.operation!.createdAt,
          });
        };
        expectSameLaunch(tab, "Review the report");
        await vi.advanceTimersByTimeAsync(300);
        expectSameLaunch(
          await reload(),
          "Review the report [report.pdf](t3-context://v1/file/file_file-1) ",
        );
      });
    },
  );

  it.each([
    { fault: "throws", emptied: false },
    { fault: "drops", emptied: false },
    { fault: "drops", emptied: true },
    // Storage takes the binding but its read back fails, so the rollback must replace it.
    { fault: "landsUnread", emptied: false },
  ] as const)(
    "leaves the earlier bound launch untouched when an edited send's binding $fault (emptied: $emptied)",
    async ({ fault, emptied }) => {
      await withReloadableStorage(async () => {
        const tab = await openTab();
        const draft = composeDraft(tab, `unbound-${fault}-${emptied}`, { prompt: "Run the suite" });
        const first = (await sendDraft(tab, draft, { uploads: false, commitFault: "throws" }))!;
        expect(first.failed).toBe("kept");
        const store = tab.store.useComposerDraftStore.getState();
        // A bound launch that never went out, recognised as its own copy.
        const earlier = store.getDraftSession(draft.draftId)!.pendingLaunch!;
        expect(earlier.turn).toBeUndefined();
        expect(earlier.restoredCopy).toBeDefined();
        // Edited, it is a new candidate; storage refuses its binding, so it never binds.
        store.setPrompt(draft.draftId, "Run the suite and the linter");
        const second = (await sendDraft(tab, draft, {
          uploads: false,
          bindFault: fault,
          label: "-2",
          // Emptied while the send reads it, the composer gets the new send back on failure.
          ...(emptied ? { edit: () => store.clearComposerContent(draft.draftId) } : {}),
        }))!;
        expect(second.bound).toBe(false);
        expect(second.failed).toBe(emptied ? "restored" : "kept");
        const candidate = `command-${draft.threadId}-2`;
        const expectEarlier = (current: Tab) => {
          const state = current.store.useComposerDraftStore.getState();
          const session = state.getDraftSession(draft.draftId)!;
          // The earlier operation exactly as it was, signature included: nothing relabelled.
          expect(session.pendingLaunch).toEqual(earlier);
          expect(session.sentTo).toEqual(scopeThreadRef(environmentId, draft.threadId));
          expect(state.getComposerDraft(draft.draftId)?.prompt).toBe(
            "Run the suite and the linter",
          );
          expect(
            localStorage.getItem(current.store.COMPOSER_DRAFT_STORAGE_KEY) ?? "",
          ).not.toContain(candidate);
          // The new text is not the earlier launch's copy: that never went out, so this is new.
          expect(sendAgain(current, draft.draftId).plan.type).toBe("new");
        };
        expectEarlier(tab);
        await vi.advanceTimersByTimeAsync(300);
        expectEarlier(await reload());
      });
    },
  );

  it("keeps an edit made before a failed commit as the user's, not as the bound launch's copy", async () => {
    await withReloadableStorage(async () => {
      const tab = await openTab();
      const draft = composeDraft(tab, "edited-failure", { prompt: "Run the suite" });
      const store = tab.store.useComposerDraftStore.getState();
      const sent = (await sendDraft(tab, draft, {
        uploads: false,
        commitFault: "drops",
        editBeforeCommit: () => store.setPrompt(draft.draftId, "Run only the unit tests"),
      }))!;
      expect(sent.failed).toBe("edited");
      const expectEdited = (current: Tab) => {
        const state = current.store.useComposerDraftStore.getState();
        expect(state.getComposerDraft(draft.draftId)?.prompt).toBe("Run only the unit tests");
        const session = state.getDraftSession(draft.draftId)!;
        expect(session.pendingLaunch?.commandId).toBe(sent.operation!.commandId);
        expect(session.pendingLaunch?.restoredCopy).toBeUndefined();
        // Not the bound launch's copy: it never went out, so it starts afresh on the same thread.
        expect(sendAgain(current, draft.draftId).plan.type).toBe("new");
        expect(session.sentTo).toEqual(scopeThreadRef(environmentId, draft.threadId));
      };
      expectEdited(tab);
      await vi.advanceTimersByTimeAsync(300);
      expectEdited(await reload());
    });
  });
});

describe("a storage run that the timeout did not cancel", () => {
  it("leaves the run that replaced it still owning storage and timers", async () => {
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const older = withReloadableStorage(async () => {
      await openTab();
      reached();
      await held;
      await reload();
    });
    await ready;
    await withReloadableStorage(async () => {
      await openTab();
      release();
      await older;
      expect(vi.isFakeTimers()).toBe(true);
      expect(typeof localStorage.getItem).toBe("function");
      expect(localStorage.getItem("t3code:composer-drafts:v1")).toBeNull();
    });
  });
});
