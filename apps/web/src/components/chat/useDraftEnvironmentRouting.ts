import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTriagePrompt, replaceTriagePlaybookLink } from "@t3tools/shared/triagePrompt";
import { AuthOrchestrationOperateScope, managedRuntimeModeDenial } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { orchestrationEnvironment } from "../../state/orchestration";
import {
  type DraftPlacementRequest,
  placeDraftBeforeSend,
  placesBeforeSend,
} from "./draftPlacement";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { readAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { currentClientMetadata } from "../../connection/platform";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { DraftSessionState } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { seedDraftModelSelection } from "../../lib/seedDraftModelSelection";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

interface DraftEnvironmentRoutingInput {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

// Multiple-model selections are kept per route, so a draft moving machine takes them along.
function carryFanoutSelections(
  draft: Pick<DraftSessionState, "environmentId" | "threadId">,
  environmentId: EnvironmentId,
) {
  if (draft.environmentId === environmentId) return;
  const selectionsOn = (id: EnvironmentId) =>
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(id, draft.threadId)));
  appAtomRegistry.set(
    selectionsOn(environmentId),
    appAtomRegistry.get(selectionsOn(draft.environmentId)),
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine. A triage draft takes its session along: the
 * target machine prepares one, and the playbook link follows.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prepareTriage = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = automaticEnvironment
    ? logicalProjectEnvironments
        .filter((candidate) => {
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    needsLoadBalancing ? loadBalancingCandidates : [],
    loadBalancingSettings.loadBalancingWeights,
  );
  const readRouting = useStableCallback(() => ({ input, loadBalancingCandidates }));
  const operableEnvironmentIds = useEnvironmentsWithScope(
    logicalProjectEnvironments,
    AuthOrchestrationOperateScope,
  );
  const admitPlacement = useAtomCommand(orchestrationEnvironment.admitThreadPlacement, {
    reportFailure: false,
  });
  /**
   * The machines this client may launch the request on, as it sees them: it can only narrow what
   * the origin server admits, which checks each one itself over its link.
   */
  const launchableCandidates = (request: DraftPlacementRequest) =>
    loadBalancingCandidates.filter(
      (environmentId) =>
        operableEnvironmentIds.has(environmentId) &&
        managedRuntimeModeDenial(
          environmentById.get(environmentId)?.serverConfig?.managedPolicy,
          request.runtimeMode,
        ) === undefined &&
        (providersByEnvironment
          .get(environmentId)
          ?.some(
            (provider) =>
              provider.instanceId === request.modelSelection.instanceId &&
              provider.models.some((model) => model.slug === request.modelSelection.model) &&
              (provider.supportedRuntimeModes === undefined ||
                provider.supportedRuntimeModes.length === 0 ||
                provider.supportedRuntimeModes.includes(request.runtimeMode)),
          ) ??
          false),
    );
  /**
   * Before an automatic draft's send: the server its launch was reserved on admits where it runs
   * (`placeDraftBeforeSend`), and only then does the draft move there.
   */
  const refreshBeforeSend = (
    request: DraftPlacementRequest,
    options: { readonly directAnnotation?: boolean } = {},
  ) => {
    // Pinned here: attachments already uploaded to this machine, or a preview annotation of it.
    const composer = draftId ? useComposerDraftStore.getState().getComposerDraft(draftId) : null;
    const pinnedHere =
      options.directAnnotation === true ||
      (composer?.files.some((file) => file.uploadedAttachmentId !== undefined) ?? false) ||
      [...(composer?.images ?? []), ...(composer?.files ?? [])].some(
        (attachment) => readAttachmentUpload(attachment.id) !== undefined,
      );
    // An operation already reserved is reconciled first, whatever routing says now.
    if (
      !draftId ||
      !placesBeforeSend({
        draft: {
          placementOperation: getDraftSession(draftId)?.placementOperation ?? null,
          promotedTo: draftThread?.promotedTo ?? getDraftSession(draftId)?.promotedTo ?? null,
        },
        // The server chooses; a client pick is not needed, nor proof of anything.
        automatic: automaticEnvironment,
        pinnedHere,
        request,
      })
    )
      return null;
    const composerDraft = useComposerDraftStore.getState().getComposerDraft(draftId);
    return placeDraftBeforeSend({
      draftId,
      request,
      candidateEnvironmentIds: launchableCandidates(request),
      pinnedHere,
      admit: admitPlacement,
      canLaunchOn: (environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      composerUnchanged: () => {
        const current = readRouting().input;
        return (
          current.draftId === draftId &&
          current.composerHasAttachments === composerHasAttachments &&
          current.activeProjectKey === activeProjectKey &&
          useComposerDraftStore.getState().getComposerDraft(draftId) === composerDraft
        );
      },
    }).then((outcome) => {
      if (outcome.type === "failed") {
        toastManager.add({
          type: "warning",
          id: "draft-placement",
          title: outcome.title,
          description: outcome.description,
        });
        return false;
      }
      if (outcome.type === "abandoned") return false;
      const draft = getDraftSession(draftId);
      if (!draft) return false;
      // Already where it was bound: nothing to move, and its routing choice stays as it is.
      if (draft.environmentId === outcome.environmentId && draft.projectId === outcome.projectId)
        return true;
      carryFanoutSelections(draft, outcome.environmentId);
      // The send must read the target project's composer and provider context after retargeting.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          projectRef: scopeProjectRef(outcome.environmentId, outcome.projectId),
          environmentSelection: "auto",
          loadBalancedEnvironmentId: outcome.environmentId,
          branch: draft.branch ?? null,
        }),
      );
      return getDraftSession(draftId)?.environmentId === outcome.environmentId;
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    const draft = getDraftSession(draftId);
    if (draft) carryFanoutSelections(draft, target.environmentId);
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
  ]);
  // A send that may have started there keeps the draft's thread id on that machine.
  const refuseMoveAfterUnconfirmedSend = () => {
    const sentTo = draftId ? getDraftSession(draftId)?.sentTo : null;
    if (!sentTo) return false;
    toastManager.add({
      type: "warning",
      id: "draft-sent-machine",
      title: "This draft stays on the machine it was sent to",
      description:
        "Its earlier send may have started the thread there. Send it again to reach that thread, or start a new draft to run it elsewhere.",
    });
    return true;
  };
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (refuseMoveAfterUnconfirmedSend()) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the current change scope into a ref that async environment switches compare against
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons an in-flight environment change when the draft or project scope changes or unmounts
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target) return;
    if (
      originalDraft.sentTo &&
      target.environmentId !== originalDraft.sentTo.environmentId &&
      refuseMoveAfterUnconfirmedSend()
    )
      return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    // `triagePrompt` is the prompt the target machine prepared for a triage draft.
    const retarget = (project: (typeof allProjects)[number], triagePrompt?: string) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      if (triagePrompt !== undefined) {
        // Read now, so text typed while the machine prepared the session is kept.
        const prompt = getComposerDraft(draftId)?.prompt ?? "";
        const nextPrompt = replaceTriagePlaybookLink(prompt, triagePrompt);
        if (nextPrompt !== prompt) setPrompt(draftId, nextPrompt);
      }
      carryFanoutSelections(currentDraft, target.environmentId);
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
      seedDraftModelSelection(draftId, projectRef);
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    const knownProject = allProjects.find(
      (project) =>
        project.environmentId === target.environmentId && project.id === target.projectId,
    );
    // The playbook and context files exist only on the machine that prepared them.
    const followsTriage = isTriagePrompt(getComposerDraft(draftId)?.prompt ?? "");
    if (target.projectId !== null && !(knownProject && followsTriage)) {
      if (knownProject) retarget(knownProject);
      finish();
      return;
    }
    const prepareTriagePrompt = async () => {
      const prepared = await prepareTriage({
        environmentId: target.environmentId,
        input: { client: currentClientMetadata() },
      });
      if (prepared._tag === "Success") return prepared.value.prompt;
      if (!isAtomCommandInterrupted(prepared)) {
        const error = squashAtomCommandFailure(prepared);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not switch machine",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return null;
    };
    const switchMachine = async () => {
      const triagePrompt = followsTriage ? await prepareTriagePrompt() : undefined;
      if (triagePrompt === null) return;
      const project =
        knownProject ??
        (await openScratchProject(target.environmentId, "Could not switch machine"));
      if (project) retarget(project, triagePrompt);
    };
    setBusyEnvironmentChange(request);
    void switchMachine().finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
