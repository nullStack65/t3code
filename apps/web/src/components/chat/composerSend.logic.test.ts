import { ChatAttachmentId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  composerDraftContentChanged,
  attachmentContentIdentity,
  draftLaunchRequest,
  replayLaunchAttachments,
  resolveDraftLaunch,
  sentLaunchAttachments,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

it("detects draft edits during upload preparation without treating upload metadata as an edit", () => {
  const draft: ComposerThreadDraftState = {
    prompt: "before",
    images: [],
    files: [
      {
        type: "file",
        id: "file",
        name: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        file: null,
      },
    ],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    replyTo: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
  expect(
    composerDraftContentChanged(draft, {
      ...draft,
      files: [{ ...draft.files[0]!, uploadedAttachmentId: "upload", uploadEnvironmentId: local }],
    }),
  ).toBe(false);
  expect(composerDraftContentChanged(draft, { ...draft, prompt: "after" })).toBe(true);
  expect(composerDraftContentChanged(draft, { ...draft, files: [] })).toBe(true);
  expect(composerDraftContentChanged(draft, { ...draft, threadContexts: [localThread] })).toBe(
    true,
  );
});

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

describe("draft launch identity", () => {
  const request = async (file: File) =>
    draftLaunchRequest({
      text: "Review this screenshot",
      attachments: [
        {
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          content: await attachmentContentIdentity({ file }),
        },
      ],
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      projectId: "project-1",
      branch: null,
      worktreePath: null,
      baseBranch: null,
      startFromOrigin: false,
    });

  it("treats a same-named, same-sized attachment with other bytes as a different request", async () => {
    const sent = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const swapped = new File([new Uint8Array([9, 9, 9, 9])], "shot.png", { type: "image/png" });
    const pending = {
      commandId: "command-1",
      messageId: "message-1",
      createdAt: "2026-11-18T00:00:00.000Z",
      request: await request(sent),
    };
    expect(resolveDraftLaunch(pending, await request(swapped))).toEqual({ type: "changed" });
    // The same bytes restored under a new attachment id are the same request.
    const restored = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    expect(resolveDraftLaunch(pending, await request(restored))).toEqual({
      type: "retry",
      launch: pending,
    });
  });

  it("replays exactly the references and ids a launch sent", async () => {
    const shot = { type: "image" as const, name: "shot.png", mimeType: "image/png", sizeBytes: 4 };
    const upload = { ...shot, id: ChatAttachmentId.make("pending-upload-1") };
    const inline = { ...shot, id: ChatAttachmentId.make("inline-original") };
    const bytes = "data:image/png;base64,AQIDBA==";
    const sent = sentLaunchAttachments([upload, { ...inline, dataUrl: bytes }]);
    // What is kept carries no image bytes.
    expect(sent).toEqual([
      { attachment: upload, inline: false },
      { attachment: inline, inline: true },
    ]);
    // The restored composer holds copies under new ids; the replay keeps the sent ones.
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const replayed = await replayLaunchAttachments(sent, [{ file }, { file }], async () => bytes);
    expect(replayed).toEqual([upload, { ...inline, dataUrl: bytes }]);
  });
});
