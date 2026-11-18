import type {
  ChatAttachment,
  EnvironmentId,
  ThreadContextRecord,
  UploadChatAttachment,
} from "@t3tools/contracts";
import type { PendingDraftLaunch, SentLaunchAttachment } from "../../composerDraftStore";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import type { ComposerThreadDraftState } from "../../composerDraftStore";

/** Compare immutable user content without copying image bytes or upload metadata. */
export function composerDraftContentChanged(
  before: ComposerThreadDraftState | null,
  after: ComposerThreadDraftState | null,
): boolean {
  if (before === after) return false;
  if (!before || !after) return true;
  const sameIds = (left: ReadonlyArray<{ id: string }>, right: ReadonlyArray<{ id: string }>) =>
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
  return (
    before.prompt !== after.prompt ||
    !sameIds(before.images, after.images) ||
    !sameIds(before.files, after.files) ||
    before.terminalContexts !== after.terminalContexts ||
    before.previewAnnotations !== after.previewAnnotations ||
    before.reviewComments !== after.reviewComments ||
    before.threadContexts !== after.threadContexts ||
    before.environmentContexts !== after.environmentContexts ||
    before.replyTo !== after.replyTo
  );
}

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

/**
 * What identifies an attachment's content: the SHA-256 of its bytes, or the upload that holds
 * them when the composer kept only that. Name, type and size do not: two files can share them.
 */
export async function attachmentContentIdentity(attachment: {
  readonly file: File | null;
  readonly uploadedAttachmentId?: string;
}): Promise<string> {
  if (attachment.file !== null) {
    const digest = await crypto.subtle.digest("SHA-256", await attachment.file.arrayBuffer());
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  // Neither bytes nor an upload: nothing can show a retry carries the same content.
  if (attachment.uploadedAttachmentId === undefined)
    throw new Error("An attachment needs to be attached again before sending.");
  return `upload:${attachment.uploadedAttachmentId}`;
}

/** The attachments as the launch sends them, without an inline image's bytes. */
export function sentLaunchAttachments(
  sent: ReadonlyArray<ChatAttachment | UploadChatAttachment>,
): SentLaunchAttachment[] {
  return sent.map((attachment) => {
    if (!("dataUrl" in attachment)) return { attachment, inline: false };
    const { dataUrl: _bytes, ...reference } = attachment;
    return { attachment: reference as ChatAttachment, inline: true };
  });
}

/**
 * Exactly what a launch sent, again: the same references and ids. An inline image's bytes come
 * from the restored file, which the request's content identity already proved unchanged.
 */
export function replayLaunchAttachments(
  sent: ReadonlyArray<SentLaunchAttachment>,
  current: ReadonlyArray<{ readonly file: File | null }>,
  readDataUrl: (file: File) => Promise<string>,
): Promise<Array<ChatAttachment | UploadChatAttachment>> {
  return Promise.all(
    sent.map(async ({ attachment, inline }, index) => {
      if (!inline) return attachment;
      const file = current[index]?.file;
      if (!file) throw new Error(`Attachment '${attachment.name}' is no longer here to resend.`);
      return { ...attachment, dataUrl: await readDataUrl(file) } as UploadChatAttachment;
    }),
  );
}

/**
 * What a new thread's launch asks for. Attachments compare by content identity, not id: a
 * restored draft clones them under new ids and is still the same request.
 */
export function draftLaunchRequest(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    /** From `attachmentContentIdentity`. */
    readonly content: string;
  }>;
  readonly modelSelection: unknown;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly projectId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
}): string {
  return JSON.stringify({
    ...input,
    attachments: input.attachments.map(({ name, mimeType, sizeBytes, content }) => ({
      name,
      mimeType,
      sizeBytes,
      content,
    })),
  });
}

/**
 * A launch whose outcome is unknown is resent as itself; a different request waits until it
 * settles, since the host may already be running the first one.
 */
export function resolveDraftLaunch(
  pending: PendingDraftLaunch | null | undefined,
  request: string,
):
  | { readonly type: "new" }
  | { readonly type: "retry"; readonly launch: PendingDraftLaunch }
  | {
      readonly type: "changed";
    } {
  if (!pending) return { type: "new" };
  return pending.request === request ? { type: "retry", launch: pending } : { type: "changed" };
}
