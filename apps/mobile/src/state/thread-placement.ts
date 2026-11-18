import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  managedRuntimeModeDenial,
  OrchestrationV2ThreadPlacementAdmitError,
  type EnvironmentId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { scopedThreadKey } from "../lib/scopedEntities";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { environmentProjects } from "./projects";
import { readEnvironmentScope } from "./session";
import { serverEnvironment } from "./server";
import {
  confirmThreadOutboxMessageQueued,
  flattenQueuedThreadMessages,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { composerDraftsAtom } from "./use-composer-drafts";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";

type Catalog = (typeof import("../connection/catalog"))["environmentCatalog"];

// Loaded only for placed tasks: other sends never need the connection runtime or admission.
async function loadSessions() {
  const { environmentCatalog } = await import("../connection/catalog");
  return sessionsOf(environmentCatalog);
}

function sessionsOf(catalog: Catalog) {
  const connectedPhase = (environmentId: EnvironmentId): boolean =>
    Option.exists(
      AsyncResult.value(appAtomRegistry.get(catalog.stateAtom(environmentId))),
      (state) => state.phase === "connected",
    );
  const sessionGeneration = (environmentId: EnvironmentId): number =>
    appAtomRegistry.get(catalog.sessionGenerationAtom(environmentId));
  const operable = (environmentId: EnvironmentId): boolean =>
    connectedPhase(environmentId) &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return {
    operable,
    /** Whether these machines stay connected, on the same established sessions, until `settle`. */
    watch: (environmentIds: ReadonlyArray<EnvironmentId>) =>
      watchSessions(catalog, environmentIds, connectedPhase, sessionGeneration, operable),
  };
}

function watchSessions(
  catalog: Catalog,
  environmentIds: ReadonlyArray<EnvironmentId>,
  connectedPhase: (environmentId: EnvironmentId) => boolean,
  sessionGeneration: (environmentId: EnvironmentId) => number,
  operable: (environmentId: EnvironmentId) => boolean,
) {
  const generations = environmentIds.map(sessionGeneration);
  let held = environmentIds.every(connectedPhase);
  const stops = environmentIds.map((environmentId) =>
    appAtomRegistry.subscribe(catalog.stateAtom(environmentId), () => {
      if (!connectedPhase(environmentId)) held = false;
    }),
  );
  return () => {
    for (const stop of stops) stop();
    return (
      held &&
      environmentIds.every(
        (environmentId, index) =>
          operable(environmentId) && sessionGeneration(environmentId) === generations[index],
      )
    );
  };
}

const currentMessage = (messageId: QueuedThreadMessage["messageId"]) =>
  flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);

const editing = (messageId: QueuedThreadMessage["messageId"]): boolean =>
  appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId] === true;

/** Candidates the origin may choose from now: operable here, and able to run this request. */
function currentPlacementCandidates(
  message: QueuedThreadMessage,
  operable: (environmentId: EnvironmentId) => boolean,
): Array<EnvironmentId> {
  const placement = message.placement;
  if (placement === undefined || message.modelSelection === undefined) return [];
  return placement.candidateEnvironmentIds.filter((environmentId) => {
    if (!operable(environmentId)) return false;
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    return (
      config !== null &&
      !isModelSelectionUnavailable(config, message.modelSelection, null) &&
      managedRuntimeModeDenial(
        config.managedPolicy,
        message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      ) === undefined
    );
  });
}

type AdmissionAnswer =
  | { readonly kind: "bound"; readonly environmentId: EnvironmentId; readonly projectId: string }
  | { readonly kind: "refused"; readonly reason: string; readonly nothingBound: boolean }
  | { readonly kind: "uncertain" };

const isAdmitRefusal = Schema.is(OrchestrationV2ThreadPlacementAdmitError);

async function askOrigin(
  message: QueuedThreadMessage,
  candidateEnvironmentIds: ReadonlyArray<EnvironmentId>,
): Promise<AdmissionAnswer> {
  const placement = message.placement!;
  const { orchestrationEnvironment } = await import("./orchestration");
  const answer = await runAtomCommand(
    appAtomRegistry,
    orchestrationEnvironment.admitThreadPlacement,
    {
      environmentId: placement.originEnvironmentId,
      input: {
        commandId: message.commandId,
        threadId: message.threadId,
        projectId: placement.originProjectId,
        modelSelection: message.modelSelection!,
        runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        candidateEnvironmentIds,
      },
    },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(answer)) {
    return {
      kind: "bound",
      environmentId: answer.value.environmentId,
      projectId: answer.value.projectId,
    };
  }
  if (!AsyncResult.isFailure(answer)) return { kind: "uncertain" };
  const error = squashAtomCommandFailure(answer);
  if (isAdmitRefusal(error)) {
    return {
      kind: "refused",
      reason: error.detail,
      nothingBound: error.reason === "no-eligible-environment",
    };
  }
  return { kind: "uncertain" };
}

/** The bound message: delivery and presentation follow B; the origin stays admission metadata. */
function boundMessage(
  message: QueuedThreadMessage,
  bound: { readonly environmentId: EnvironmentId; readonly projectId: string },
): QueuedThreadMessage {
  const creation = message.creation!;
  const project = appAtomRegistry
    .get(environmentProjects.projectsAtom)
    .find(
      (candidate) =>
        candidate.environmentId === bound.environmentId && candidate.id === bound.projectId,
    );
  const { projectCwd: _originCwd, ...ordinary } = creation;
  return {
    ...message,
    environmentId: bound.environmentId,
    creation: {
      ...ordinary,
      projectId: project?.id ?? (bound.projectId as typeof creation.projectId),
      ...(project?.title !== undefined ? { projectTitle: project.title } : {}),
      // Only B's own root: the origin's path means nothing there.
      ...(project?.workspaceRoot ? { projectCwd: project.workspaceRoot } : {}),
    },
    // An upload stamped for another machine is not one B can use.
    attachments: message.attachments.map((attachment) =>
      attachment.uploadEnvironmentId !== undefined &&
      attachment.uploadEnvironmentId !== bound.environmentId
        ? (({ uploadedAttachmentId: _id, uploadEnvironmentId: _env, ...rest }) => rest)(attachment)
        : attachment,
    ),
    placement: {
      ...message.placement!,
      bound: {
        environmentId: bound.environmentId,
        projectId: project?.id ?? (bound.projectId as typeof creation.projectId),
      },
    },
  };
}

/** A creation outcome recorded under the origin key moves only if it is this message's. */
function rekeyOutcome(before: QueuedThreadMessage, after: QueuedThreadMessage): void {
  const from = scopedThreadKey(before.environmentId, before.threadId);
  const to = scopedThreadKey(after.environmentId, after.threadId);
  if (from === to) return;
  const outcomes = appAtomRegistry.get(pendingThreadCreationOutcomesAtom);
  const outcome = outcomes[from];
  if (outcome === undefined || outcome.message.messageId !== before.messageId) return;
  const next = { ...outcomes, [to]: { ...outcome, message: after } };
  delete next[from];
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, next);
}

export type PlacementStep =
  /** Bound and persisted, abandoned to a newer owner, or not ready: the next pass decides. */
  | { readonly step: "done" }
  /** Held with the same origin and IDs; try again after backoff. */
  | { readonly step: "hold" }
  /** The origin bound nothing and offers no machine: hand the task back to its draft. */
  | { readonly step: "restore"; readonly reason: string };

/**
 * Admits a queued Auto creation at its recorded origin, then rebinds the same message to the
 * machine it answered with. Nothing is uploaded or prepared before that binding is durable.
 */
export async function admitPlacedCreation(message: QueuedThreadMessage): Promise<PlacementStep> {
  const placement = message.placement;
  if (placement === undefined || placement.bound !== undefined) return { step: "done" };
  // A record whose write failed never reaches its origin.
  if (!(await confirmThreadOutboxMessageQueued(message)) || editing(message.messageId)) {
    return { step: "done" };
  }
  const revision = threadOutboxRevision(message.messageId);
  const origin = placement.originEnvironmentId;
  const sessions = await loadSessions();
  if (!sessions.operable(origin)) return { step: "hold" };
  const candidates = currentPlacementCandidates(message, sessions.operable);
  if (candidates.length === 0) return { step: "hold" };
  const sessionsHeld = sessions.watch([origin]);
  let originStayed = false;
  let answer: AdmissionAnswer;
  try {
    answer = await askOrigin(message, candidates);
  } finally {
    originStayed = sessionsHeld();
  }
  const stillOwned = () =>
    !editing(message.messageId) &&
    threadOutboxRevision(message.messageId) === revision &&
    currentMessage(message.messageId) === message;
  if (answer.kind === "uncertain") return { step: "hold" };
  if (answer.kind === "refused") {
    if (!answer.nothingBound) return { step: "hold" };
    return stillOwned() ? { step: "restore", reason: answer.reason } : { step: "done" };
  }
  // An answer over a session that changed, or for a message edited meanwhile, is not acted on.
  if (!originStayed || !stillOwned()) return { step: "done" };
  const bound = boundMessage(message, answer);
  if (!(await updateThreadOutboxMessage(bound, revision))) return { step: "done" };
  rekeyOutcome(message, bound);
  return { step: "done" };
}

export type PlacedTargetQualification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a bound placed task may act on its machine now: upload, verify a stored upload, prepare
 * or launch there. Asked of its origin again each time, for the same command and binding; a stored
 * binding is identity to reconcile, not a standing grant. `stillOwned` checks the caller's owner.
 */
export async function qualifyPlacedTarget(input: {
  readonly messageId: QueuedThreadMessage["messageId"];
  readonly commandId: QueuedThreadMessage["commandId"];
  readonly environmentId: EnvironmentId;
  readonly stillOwned: () => boolean;
}): Promise<PlacedTargetQualification> {
  const message = currentMessage(input.messageId);
  const bound = message?.placement?.bound;
  if (
    message === undefined ||
    bound === undefined ||
    message.commandId !== input.commandId ||
    bound.environmentId !== input.environmentId
  ) {
    return {
      ok: false,
      reason: "This upload belonged to a placed task that no longer holds it.",
    };
  }
  const origin = message.placement!.originEnvironmentId;
  const sessions = await loadSessions();
  if (
    !sessions.operable(origin) ||
    !sessions.operable(bound.environmentId) ||
    !input.stillOwned()
  ) {
    return { ok: false, reason: "Waiting for this task's machines to connect." };
  }
  const sessionsHeld = sessions.watch([origin, bound.environmentId]);
  let sessionsStayed = false;
  let answer: AdmissionAnswer;
  try {
    answer = await askOrigin(message, [bound.environmentId]);
  } finally {
    sessionsStayed = sessionsHeld();
  }
  if (answer.kind !== "bound") {
    return {
      ok: false,
      reason:
        answer.kind === "refused" ? answer.reason : "This task's placement could not be confirmed.",
    };
  }
  if (answer.environmentId !== bound.environmentId || answer.projectId !== bound.projectId) {
    return { ok: false, reason: "This task's origin answered with another machine." };
  }
  const now = currentMessage(input.messageId);
  if (
    !sessionsStayed ||
    now?.commandId !== input.commandId ||
    JSON.stringify(now.placement) !== JSON.stringify(message.placement) ||
    !input.stillOwned()
  ) {
    return { ok: false, reason: "This task changed while its placement was confirmed." };
  }
  return { ok: true };
}

/** The upload owner a queued placed task's attachment carries through the queue and retries. */
export interface PlacedUploadOwner {
  readonly messageId: QueuedThreadMessage["messageId"];
  readonly commandId: QueuedThreadMessage["commandId"];
}

/** The current owner record of this attachment: the queued message, or its pending-task editor. */
function ownedAttachment(
  owner: PlacedUploadOwner,
  attachmentId: string,
): {
  readonly attachment: DraftComposerAttachment;
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
} | null {
  const message = currentMessage(owner.messageId);
  if (message === undefined || message.commandId !== owner.commandId) return null;
  if (editing(owner.messageId)) {
    const editor = appAtomRegistry.get(composerDraftsAtom)[`pending-task:${owner.messageId}`];
    const attachment = editor?.attachments.find((candidate) => candidate.id === attachmentId);
    return attachment && editor ? { attachment, text: editor.text, context: editor.context } : null;
  }
  const attachment = message.attachments.find((candidate) => candidate.id === attachmentId);
  return attachment ? { attachment, text: message.text, context: message.context } : null;
}

/**
 * Qualifies one queued upload for a placed task at its actual callback: the same attachment object
 * and content must still belong to the same operation before and after its origin answers.
 */
export async function qualifyPlacedUpload(input: {
  readonly owner: PlacedUploadOwner;
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
}): Promise<PlacedTargetQualification> {
  const before = ownedAttachment(input.owner, input.attachment.id);
  if (before === null || before.attachment !== input.attachment) {
    return { ok: false, reason: "This upload belonged to a placed task that no longer holds it." };
  }
  return qualifyPlacedTarget({
    messageId: input.owner.messageId,
    commandId: input.owner.commandId,
    environmentId: input.environmentId,
    stillOwned: () => {
      const now = ownedAttachment(input.owner, input.attachment.id);
      return (
        now !== null &&
        now.attachment === before.attachment &&
        now.text === before.text &&
        now.context === before.context
      );
    },
  });
}
