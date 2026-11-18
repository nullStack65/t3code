import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadPlacementAdmitInput,
  OrchestrationV2ThreadPlacementAdmitResult,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  type DraftId,
  type DraftPlacementOperation,
  type DraftSessionState,
  recordDraftPlacementAdmission,
  releaseDraftPlacement,
  reserveDraftPlacement,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { newCommandId, newMessageId } from "~/lib/utils";

/** What a send asks for, read from the composer at send. */
export interface DraftPlacementRequest {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** A multiple-model send prepares its own worktrees here, so it is not placed elsewhere. */
  readonly multipleModels: boolean;
}

/**
 * The work a placement is for, fixed when its operation is reserved: the exact model with its
 * options, the modes, the logical project and the workspace. A different one is new work.
 */
export const draftPlacementIntent = (
  request: DraftPlacementRequest,
  draft: Pick<
    DraftSessionState,
    "logicalProjectKey" | "branch" | "worktreePath" | "envMode" | "startFromOrigin"
  >,
) =>
  JSON.stringify({
    modelSelection: request.modelSelection,
    runtimeMode: request.runtimeMode,
    interactionMode: request.interactionMode,
    multipleModels: request.multipleModels,
    logicalProjectKey: draft.logicalProjectKey,
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    envMode: draft.envMode,
    startFromOrigin: draft.startFromOrigin,
  });

/**
 * Whether a send goes through placement first: always when its draft holds an operation already
 * (reserved, uncertain or bound), whatever automatic routing says now; otherwise only new work
 * automatic routing may place.
 */
export const placesBeforeSend = (input: {
  readonly draft: Pick<DraftSessionState, "placementOperation" | "promotedTo"> | null;
  readonly automatic: boolean;
  readonly hasAttachments: boolean;
  readonly request: DraftPlacementRequest;
}) =>
  input.draft !== null &&
  !input.draft.promotedTo &&
  (Boolean(input.draft.placementOperation) ||
    (input.automatic && !input.hasAttachments && !input.request.multipleModels));

export type DraftPlacementOutcome =
  | {
      readonly type: "placed";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  | { readonly type: "failed"; readonly title: string; readonly description: string }
  /** The draft changed while it was being placed: its send is dropped, its binding kept. */
  | { readonly type: "abandoned" };

const unsaved = (title: string): DraftPlacementOutcome => ({
  type: "failed",
  title,
  description: "Nothing was started. Free up browser storage, then send again.",
});

const stillOpen = (description: string): DraftPlacementOutcome => ({
  type: "failed",
  title: "Your last send's placement is still open",
  description,
});

const refusalReason = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "OrchestrationV2ThreadPlacementAdmitError" &&
  "reason" in error
    ? String(error.reason)
    : undefined;

/**
 * Where a draft's new thread runs: its operation and intent are stored first; the server asked is
 * asked again under this sign-in every time, even once bound, and its binding is never rescored.
 * Changed work is refused while the operation is open. Nothing is uploaded or launched here.
 */
export async function placeDraftBeforeSend(input: {
  readonly draftId: DraftId;
  readonly request: DraftPlacementRequest;
  /** The machines this client may launch on; they narrow the server's choice. */
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** The composer holds attachments, which are prepared for the machine it is on. */
  readonly hasAttachments: boolean;
  readonly admit: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: OrchestrationV2ThreadPlacementAdmitInput;
  }) => Promise<AtomCommandResult<OrchestrationV2ThreadPlacementAdmitResult, unknown>>;
  /** Whether this client may still launch there, read when it is needed. */
  readonly canLaunchOn: (environmentId: EnvironmentId) => boolean;
  /** Whether the composer is still what this send read. */
  readonly composerUnchanged: () => boolean;
}): Promise<DraftPlacementOutcome> {
  const { draftId } = input;
  const session = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!session) return { type: "abandoned" };
  const intent = draftPlacementIntent(input.request, session);
  const existing = session.placementOperation ?? null;
  if (existing) {
    if (existing.intent !== intent)
      return stillOpen(
        "It may already be running with what you sent then. Send that unchanged to finish it, or start a new draft for different work.",
      );
    if (
      session.environmentId !== existing.admittedOn &&
      session.environmentId !== existing.admission?.environmentId
    )
      return stillOpen(
        "It was placed from another machine than this draft is on now. Switch back to send it, or start a new draft.",
      );
  }
  const reserved: DraftPlacementOperation = existing ?? {
    commandId: newCommandId(),
    messageId: newMessageId(),
    createdAt: new Date().toISOString(),
    admittedOn: session.environmentId,
    admittedProjectId: session.projectId,
    intent,
  };
  if (!existing && !reserveDraftPlacement(draftId, reserved))
    return unsaved("Could not save this draft before sending");
  const result = await input.admit({
    environmentId: reserved.admittedOn,
    input: {
      commandId: CommandId.make(reserved.commandId),
      threadId: session.threadId,
      projectId: reserved.admittedProjectId,
      modelSelection: input.request.modelSelection,
      runtimeMode: input.request.runtimeMode,
      interactionMode: input.request.interactionMode,
      candidateEnvironmentIds: input.candidateEnvironmentIds,
    },
  });
  if (result._tag !== "Success") {
    const error = squashAtomCommandFailure(result);
    // Refused before anything was bound: the next send is new work, under a new identity.
    if (refusalReason(error) === "no-eligible-environment")
      releaseDraftPlacement(draftId, reserved.commandId);
    return {
      type: "failed",
      title: "Could not place this draft",
      description:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Nothing was started. Send it again.",
    };
  }
  const admission = {
    environmentId: result.value.environmentId,
    projectId: result.value.projectId,
  };
  if (reserved.admission) {
    // Its server answers with the binding it holds; anything else is never followed.
    if (
      reserved.admission.environmentId !== admission.environmentId ||
      reserved.admission.projectId !== admission.projectId
    )
      return stillOpen(
        "Its machine answered with another destination than it was bound to, so nothing was sent.",
      );
  } else if (!recordDraftPlacementAdmission(draftId, reserved.commandId, admission)) {
    return unsaved("Could not save where this draft runs");
  }
  const current = useComposerDraftStore.getState().getDraftSession(draftId);
  if (
    !input.composerUnchanged() ||
    current?.placementOperation?.commandId !== reserved.commandId ||
    current.environmentId !== session.environmentId ||
    current.projectId !== session.projectId
  )
    return { type: "abandoned" };
  // Attachments are prepared for the machine the draft is on, so they never move with it.
  if (input.hasAttachments && admission.environmentId !== session.environmentId)
    return stillOpen(
      "It runs on another machine than its attachments were added on. Remove them and attach them there, or start a new draft.",
    );
  // The grant to launch there is this client's own, checked again now that it is needed.
  if (!input.canLaunchOn(admission.environmentId)) {
    return {
      type: "failed",
      title: "This machine no longer accepts your launches",
      description: "Its sign-in changed while the draft was being placed. Nothing was started.",
    };
  }
  return { type: "placed", ...admission };
}
