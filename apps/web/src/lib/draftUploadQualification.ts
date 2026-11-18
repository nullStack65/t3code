import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { draftPlacementIntent } from "../components/chat/draftPlacement";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  composerDraftCopySignature,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentScope } from "../state/session";

export type DraftUploadQualification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const qualified: DraftUploadQualification = { ok: true };
const refused = (reason: string): DraftUploadQualification => ({ ok: false, reason });

interface StoredRequest {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly multipleModels: boolean;
}

const storedRequest = (intent: string): StoredRequest | null => {
  try {
    const parsed = JSON.parse(intent) as Partial<StoredRequest>;
    return parsed.modelSelection && parsed.runtimeMode && parsed.interactionMode
      ? {
          modelSelection: parsed.modelSelection,
          runtimeMode: parsed.runtimeMode,
          interactionMode: parsed.interactionMode,
          multipleModels: parsed.multipleModels === true,
        }
      : null;
  } catch {
    return null;
  }
};

const generationOf = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentCatalog.sessionGenerationAtom(environmentId));

const connected = (environmentId: EnvironmentId) =>
  Option.exists(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    (state) => state.phase === "connected",
  );

/** The admitted launch this upload's draft holds now, if any: only those wait for its origin. */
export const admittedLaunchOf = (job: {
  readonly draftTarget?: ComposerThreadTarget | undefined;
}): string | undefined =>
  typeof job.draftTarget === "string"
    ? useComposerDraftStore.getState().getDraftSession(DraftId.make(job.draftTarget))
        ?.placementOperation?.commandId
    : undefined;

/** Whether a machine stays connected from now until `stop`, through any phase in between. */
const watchConnected = (environmentId: EnvironmentId) => {
  let held = connected(environmentId);
  const stop = appAtomRegistry.subscribe(environmentCatalog.stateAtom(environmentId), () => {
    if (!connected(environmentId)) held = false;
  });
  return () => {
    stop();
    return held && connected(environmentId);
  };
};

/**
 * Whether an upload owned by admitted launch `admittedCommandId` may go out now: its recorded
 * origin is asked again for the same command each time (a binding is identity, not a grant); then
 * the draft, its operation, composer, attachment object and both operable sessions must not change.
 */
export async function qualifyDraftUpload(job: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget | undefined;
  readonly admittedCommandId: string;
}): Promise<DraftUploadQualification> {
  const ownerLost = refused(
    "This upload belonged to a placed launch this draft no longer holds, so nothing was uploaded.",
  );
  if (typeof job.draftTarget !== "string") return ownerLost;
  const draftId = DraftId.make(job.draftTarget);
  const read = () => {
    const state = useComposerDraftStore.getState();
    const session = state.getDraftSession(draftId);
    const composer = state.getComposerDraft(draftId) ?? undefined;
    const attachment = [...(composer?.images ?? []), ...(composer?.files ?? [])].find(
      (candidate) => candidate.id === job.image.id,
    );
    return { session, attachment, copy: composerDraftCopySignature(composer) };
  };
  const before = read();
  const operation = before.session?.placementOperation;
  if (!before.session || !operation || operation.commandId !== job.admittedCommandId)
    return ownerLost;
  const { admission } = operation;
  const request = storedRequest(operation.intent);
  if (
    !admission ||
    admission.environmentId !== job.environmentId ||
    before.session.environmentId !== job.environmentId ||
    request === null ||
    draftPlacementIntent(request, before.session) !== operation.intent ||
    before.attachment?.file !== job.image.file
  )
    return refused("This draft's launch is not placed on this machine, so nothing was uploaded.");
  const generations = [
    generationOf(operation.admittedOn),
    generationOf(admission.environmentId),
  ] as const;
  const originStayed = watchConnected(operation.admittedOn);
  const destinationStayed = watchConnected(admission.environmentId);
  let sessionsStayed = false;
  // Loaded only for admitted drafts: other uploads never need the orchestration commands.
  const { orchestrationEnvironment } = await import("../state/orchestration");
  const answer = await runAtomCommand(
    appAtomRegistry,
    orchestrationEnvironment.admitThreadPlacement,
    {
      environmentId: operation.admittedOn,
      input: {
        commandId: CommandId.make(operation.commandId),
        threadId: before.session.threadId,
        projectId: operation.admittedProjectId,
        modelSelection: request.modelSelection,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        candidateEnvironmentIds: [admission.environmentId],
      },
    },
    { reportFailure: false },
  ).finally(() => {
    const origin = originStayed();
    const destination = destinationStayed();
    sessionsStayed = origin && destination;
  });
  if (answer._tag !== "Success") {
    const error = squashAtomCommandFailure(answer);
    return refused(
      error instanceof Error && error.message.length > 0
        ? error.message
        : "This draft's placement could not be confirmed, so nothing was uploaded.",
    );
  }
  if (
    answer.value.environmentId !== admission.environmentId ||
    answer.value.projectId !== admission.projectId
  )
    return refused(
      "This draft's placement answered with another machine, so nothing was uploaded.",
    );
  // Asked for this draft, operation, composer and attachment, over these sessions: all the same now.
  const after = read();
  if (
    !after.session ||
    JSON.stringify(after.session.placementOperation ?? null) !== JSON.stringify(operation) ||
    after.session.environmentId !== before.session.environmentId ||
    after.session.projectId !== before.session.projectId ||
    after.session.threadId !== before.session.threadId ||
    draftPlacementIntent(request, after.session) !== operation.intent ||
    after.copy !== before.copy ||
    after.attachment !== before.attachment ||
    !sessionsStayed ||
    generationOf(operation.admittedOn) !== generations[0] ||
    generationOf(admission.environmentId) !== generations[1] ||
    !readEnvironmentScope(operation.admittedOn, AuthOrchestrationOperateScope) ||
    !readEnvironmentScope(admission.environmentId, AuthOrchestrationOperateScope)
  )
    return refused(
      "This draft changed while its placement was confirmed, so nothing was uploaded.",
    );
  return qualified;
}
