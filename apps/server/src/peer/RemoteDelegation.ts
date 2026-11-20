import {
  CommandId,
  DEFAULT_AUTOMATIC_PLACEMENT_HOSTS,
  EnvironmentId,
  isRuntimeModeAbove,
  type ModelSelection,
  NodeId,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type OrchestrationV2WorkerAlert,
  type PeerLink,
  OrchestrationV2ThreadPlacementAdmitError,
  type ProviderInteractionMode,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type HostResourcesSnapshot,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  chooseThreadPlacement,
  placementHostLimits,
  type ThreadPlacementCandidate,
} from "@t3tools/shared/threadPlacement";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";
import { workerAlert } from "@t3tools/provider-core/server/subagentProjection";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import {
  resolveInteractionMode,
  resolveRuntimeMode,
  taskPrompt,
} from "../mcp/delegatedTaskModes.ts";
import { followUpOwnerRun } from "../orchestration-v2/CommandPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** How long one follow of a remote task waits on its thread there before checking again. */
/** What placement weighs a candidate on, gathered by this server itself. */
export interface PlacementEvidence {
  /** The project here; elsewhere, that machine's project with its repository. */
  readonly projectId: ProjectId;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
  /** The effective mode, sent explicitly wherever the work runs. */
  readonly runtimeMode: RuntimeMode;
  /** This environment's own load, and whether it runs the exact model in that mode. */
  readonly here: {
    readonly resources: HostResourcesSnapshot | null;
    readonly modelAvailable: boolean;
  };
}

const NativePlacement = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  reason: Schema.Literal("capacity"),
});
export interface NativePlacement {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly reason: "capacity";
}
const NativePlacementJson = Schema.fromJsonString(NativePlacement);
const encodeNativePlacementJson = Schema.encodeSync(NativePlacementJson);
const decodeNativePlacementJson = Schema.decodeEffect(NativePlacementJson);
const encodeNativePlacement = (placement: NativePlacement) => encodeNativePlacementJson(placement);
const decodeNativePlacement = (value: string) =>
  decodeNativePlacementJson(value).pipe(
    Effect.map((placement): NativePlacement => ({
      environmentId: EnvironmentId.make(placement.environmentId),
      projectId: placement.projectId as ProjectId,
      reason: placement.reason,
    })),
  );

const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** A follower that hits this many defects in a row fails its task instead of retrying. */
const FOLLOW_MAX_DEFECTS = 3;
/** How a follower retries; tests step it by hand. */
export const FollowRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/RemoteDelegation/FollowRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/** `orchestrator_capabilities` there. Its toolkit imports this module, so it is described here. */
const RemoteCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});

/**
 * `delegate_task` to a linked environment. The task's child is an ordinary
 * thread there, launched through the link; the parent here records the task
 * like a local one, without a child thread, and a follower completes it when
 * the thread there ends, so the parent wakes as it would for a local child.
 */
export class RemoteDelegation extends Context.Service<
  RemoteDelegation,
  {
    readonly delegate: (
      scope: ThreadScope,
      input: OrchestratorMcpDelegateTaskInput & {
        readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
          readonly environmentId: EnvironmentId;
        };
      },
    ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
    /**
     * Where a `placement: "auto"` task runs: the environment its key is bound to,
     * or the one chosen now from this environment's and authenticated links' own
     * answers, bound before anything starts. A retry never chooses again.
     */
    readonly place: (
      scope: McpInvocationContext.McpInvocationScope,
      input: {
        /** What is placed: one caller's key binds one environment per operation. */
        readonly operation: "delegate-task" | "thread-launch";
        readonly key: string;
        /** The thread the binding is recorded against. */
        readonly threadId: ThreadId;
      } & PlacementEvidence,
    ) => Effect.Effect<EnvironmentId, OrchestratorMcpFailure>;
    /**
     * Where a native client's new-thread launch runs: the environment its operation was first
     * bound to, or one chosen now from this environment and authenticated links the client may
     * launch on, bound with the session that admitted it before anything is sent. Another
     * session's operation is refused, never adopted or admitted afresh.
     */
    readonly admit: (
      caller: {
        readonly sessionId: string;
        /** Whether that session is still signed in with operate access; asked before each write. */
        readonly stillAuthorized: Effect.Effect<boolean>;
      },
      input: Omit<PlacementEvidence, "here"> & {
        /** This environment's evidence, read only when nothing is bound yet. */
        readonly here: Effect.Effect<
          PlacementEvidence["here"],
          OrchestrationV2ThreadPlacementAdmitError
        >;
        readonly commandId: CommandId;
        readonly threadId: ThreadId;
        readonly interactionMode: ProviderInteractionMode;
        /** Narrows the choice to machines the client may launch on; never widens it. */
        readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
      },
    ) => Effect.Effect<
      NativePlacement & { readonly resumed: boolean },
      OrchestrationV2ThreadPlacementAdmitError
    >;
    /** The environment a caller's key was placed in, if it was. */
    readonly placed: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly operation: "delegate-task" | "thread-launch"; readonly key: string },
    ) => Effect.Effect<Option.Option<EnvironmentId>, OrchestratorMcpFailure>;
    /**
     * A top-level `t3_thread_launch` there, sent only under the link session its
     * key was first bound to: a retry after linking again never starts a second
     * thread there, and refuses instead of guessing which one is its.
     */
    readonly launch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: {
        readonly environmentId: EnvironmentId;
        readonly key: string;
        /** The thread the bindings are recorded against. */
        readonly threadId: ThreadId;
        /** The project here; it runs in the project there with the same repository. */
        readonly projectId: ProjectId;
        readonly params: Omit<
          Tool.Parameters<typeof ProjectToolkit.tools.t3_thread_launch>,
          "projectId"
        >;
      },
    ) => Effect.Effect<
      Tool.Success<typeof ProjectToolkit.tools.t3_thread_launch>,
      OrchestratorMcpFailure
    >;
    /**
     * A `t3_thread_send` there that started or queued a run on the thread of
     * one of this thread's tasks that has its result: like a follow-up to a
     * finished child here, that run is a new task, whose id the send returns.
     * Any other send is returned as it came.
     */
    readonly followUp: (
      scope: McpInvocationContext.McpInvocationScope,
      environmentId: EnvironmentId,
      request: Pick<OrchestratorMcpThreadSendInput, "message" | "clientRequestId">,
      sent: OrchestratorMcpThreadSendResult,
    ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
    /**
     * Stops the task's thread there, then completes it here as cancelled. A
     * task that already has its result keeps it; its thread there is still
     * stopped, as cancelling a local task stops follow-up work on its child.
     */
    readonly cancel: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
      input: {
        readonly reason?: string | undefined;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    /**
     * The status of the task's run there, or null when it cannot be read: an
     * unreachable machine reads as no news rather than failing the read here.
     */
    readonly runStatus: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
    ) => Effect.Effect<OrchestratorMcpThreadRun["status"] | null>;
    /**
     * Follows every open remote task until it ends, including after a
     * restart, and a finished one again when a Stop here owes it a stop there.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteDelegation") {}

/** The exact instance and model there can run a child task, in the mode asked for. */
export const runsModel = (
  capabilities: OrchestratorMcpCapabilitiesResult,
  requested: {
    readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
    readonly runtimeMode: RuntimeMode;
  },
) =>
  capabilities.providers.some(
    (provider) =>
      provider.providerInstanceId === requested.modelSelection.instanceId &&
      provider.canRunChildTask &&
      provider.models.some((model) => model.id === requested.modelSelection.model) &&
      (provider.runtimeModes === undefined ||
        provider.runtimeModes.includes(requested.runtimeMode)),
  );

/** The other side refused because the thread there runs above this caller's modes. */
const isModeRefusal = (error: OrchestratorMcpFailure) =>
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

/**
 * Refusals that following again cannot change: the link was revoked, expired
 * or forgotten, or the thread or run there is gone. Anything else (the other
 * machine asleep, a dropped route) is worth retrying.
 */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

const make = Effect.gen(function* () {
  const followRetry = yield* FollowRetrySchedule;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const random = yield* SecureRandom.SecureRandom;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  // One follower runs per open task and holds what it read across a wait of
  // up to FOLLOW_WAIT_MS, so it reads its own task, never the parent's whole
  // task list: a parent with thousands of tasks made every restart decode
  // that list once per open task at the same time and ran out of heap.
  const readTask = (parentThreadId: ThreadId, taskId: NodeId) =>
    threads
      .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] })
      .pipe(Effect.map(({ thread, subagents }) => ({ thread, task: subagents[0] })));

  /** The peer's project with this thread's repository, or the one the caller named. */
  const resolveRemoteProject = Effect.fn("RemoteDelegation.resolveRemoteProject")(function* (
    ask: Ask,
    environmentId: EnvironmentId,
    parentProjectId: ProjectId,
    requested: ProjectId | undefined,
  ) {
    if (requested !== undefined) return requested;
    const here = yield* projects.getById(parentProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    // The project's own identity is a one-minute cache that reads blank when
    // cold, so resolve it here, as the other side's t3_project_list does.
    const key =
      here === undefined
        ? undefined
        : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass target.projectId: this thread's project has no repository to match there.",
      });
    }
    const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> = yield* ask(
        ProjectToolkit.tools.t3_project_list,
        environmentId,
        {
          cursor,
          limit: 100,
        },
      );
      matches.push(
        ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
      );
      cursor = listed.nextCursor;
    }
    if (matches.length === 1) return matches[0]!.id;
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        matches.length === 0
          ? `No project there has this repository (${key}). Pass target.projectId; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`
          : `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass target.projectId.`,
    });
  });

  /** The instance there of the driver the caller named, preferring the one this thread runs on, as a task here does. */
  const resolveRemoteInstance = Effect.fn("RemoteDelegation.resolveRemoteInstance")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    requested: {
      readonly driverKind: ProviderDriverKind;
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly inheritedInstanceId: ProviderInstanceId;
    },
  ) {
    const { providers } = yield* forwarding.call(scope, RemoteCapabilitiesTool, environmentId, {});
    if (requested.providerInstanceId !== undefined) {
      const named = providers.find(
        (provider) => provider.providerInstanceId === requested.providerInstanceId,
      );
      if (named !== undefined && named.driverKind !== requested.driverKind) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Provider instance ${named.providerInstanceId} there uses driver ${named.driverKind}, not ${requested.driverKind}.`,
        });
      }
      return requested.providerInstanceId;
    }
    const candidates = providers.filter(
      (provider) => provider.driverKind === requested.driverKind && provider.canRunChildTask,
    );
    const chosen =
      candidates.find(
        (provider) => provider.providerInstanceId === requested.inheritedInstanceId,
      ) ?? candidates[0];
    if (chosen === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `No instance of driver ${requested.driverKind} there can run a child task. orchestrator_capabilities with this environmentId lists its providers.`,
      });
    }
    return chosen.providerInstanceId;
  });

  /** One linked environment's answer for placement, asked over whichever caller's forwarding. */
  type Ask = <T extends Tool.Any>(
    tool: T,
    environmentId: EnvironmentId,
    params: Tool.Parameters<T>,
  ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
  const askFor =
    (scope: McpInvocationContext.McpInvocationScope): Ask =>
    (tool, environmentId, params) =>
      forwarding.call(scope, tool, environmentId, params);
  const askNative =
    (caller: PeerForwarding.NativeCaller): Ask =>
    (tool, environmentId, params) =>
      forwarding.callNative(caller, tool, environmentId, params);

  /** A linked environment as a placement candidate, from what it answered just now. */
  const peerCandidate = Effect.fn("RemoteDelegation.peerCandidate")(
    function* (ask: Ask, link: PeerLink, input: PlacementEvidence) {
      const capabilities = yield* ask(RemoteCapabilitiesTool, link.environmentId, {
        search: input.modelSelection.model,
      });
      const receivedAt = yield* Clock.currentTimeMillis;
      const projectId = yield* resolveRemoteProject(
        ask,
        link.environmentId,
        input.projectId,
        undefined,
      ).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<ProjectId>()),
      );
      return {
        projectId,
        candidate: {
          environmentId: link.environmentId,
          resources: capabilities.hostResources ?? null,
          receivedAt,
          weight: 1,
          operable: true,
          projectAvailable: Option.isSome(projectId),
          modelAvailable: runsModel(capabilities, input),
        } satisfies ThreadPlacementCandidate,
      };
    },
    // One that does not answer, or refuses this caller, is not a candidate.
    (effect, _ask, link) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("remote-delegation.placement-candidate-unavailable", {
            environmentId: link.environmentId,
            cause,
          }),
        ),
        Effect.option,
      ),
  );

  const exclusions = links.placementExclusions.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "Unable to read which machines automatic placement may use, so nothing was started. Retry with the same clientRequestId.",
        }),
    ),
  );

  /**
   * Linked environments placement may ask, from what is stored here only: an excluded one, or
   * one this work could not use, is dropped before any peer is contacted. `restrictTo` narrows
   * them to the ones a caller can launch on.
   */
  const askableLinks = Effect.fn("RemoteDelegation.askableLinks")(function* (input: {
    readonly runtimeMode: RuntimeMode;
    readonly excluded: ReadonlySet<EnvironmentId>;
    readonly restrictTo?: ReadonlyArray<EnvironmentId> | undefined;
  }) {
    if (!(yield* links.enabled)) return [];
    const usable = (environmentId: EnvironmentId) =>
      environmentId !== hereId && !input.excluded.has(environmentId);
    const stored =
      input.restrictTo === undefined
        ? yield* links.stored.pipe(Effect.orElseSucceed((): ReadonlyArray<PeerLink> => []))
        : (yield* Effect.forEach(input.restrictTo.filter(usable), (environmentId) =>
            links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none<PeerLink>())),
          )).flatMap((link) => (Option.isSome(link) ? [link.value] : []));
    const now = yield* DateTime.now;
    return stored.filter(
      (link) =>
        usable(link.environmentId) &&
        link.access !== "read-only" &&
        !isRuntimeModeAbove(input.runtimeMode, link.access) &&
        DateTime.isGreaterThan(link.expiresAt, now),
    );
  });

  const recentPlacements = new Map<string, ReadonlyArray<number>>();
  const recentAt = (environmentId: string, now: number) =>
    (recentPlacements.get(environmentId) ?? []).filter((at) => now - at < 60_000);
  const withRecentPlacements = <
    C extends { readonly environmentId: string; readonly resources: HostResourcesSnapshot | null },
  >(
    candidate: C,
    now: number,
  ): C => {
    const recent = recentAt(candidate.environmentId, now).length;
    const lanes = candidate.resources?.runningAgents;
    return recent === 0 || candidate.resources === null || lanes === undefined
      ? candidate
      : { ...candidate, resources: { ...candidate.resources, runningAgents: lanes + recent } };
  };

  /** The shared choice: this environment and the askable links, from their own answers. */
  const choosePlacement = Effect.fn("RemoteDelegation.choosePlacement")(function* (
    ask: Ask,
    input: PlacementEvidence & {
      readonly excluded: ReadonlySet<EnvironmentId>;
      readonly restrictTo?: ReadonlyArray<EnvironmentId> | undefined;
    },
  ) {
    const askable = yield* askableLinks(input);
    const hosts = yield* links.placementHosts.pipe(
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_PLACEMENT_HOSTS),
    );
    const peers = (yield* Effect.forEach(askable, (link) => peerCandidate(ask, link, input), {
      concurrency: "unbounded",
    })).flatMap((peer) => (Option.isSome(peer) ? [peer.value] : []));
    const now = yield* Clock.currentTimeMillis;
    const hereCandidate =
      !input.excluded.has(hereId) &&
      (input.restrictTo === undefined || input.restrictTo.includes(hereId));
    const candidates = [
      ...(hereCandidate
        ? [
            {
              environmentId: hereId,
              resources: input.here.resources,
              receivedAt: now,
              weight: 1,
              operable: true,
              projectAvailable: true,
              modelAvailable: input.here.modelAvailable,
              ...placementHostLimits(hosts, hereId),
            },
          ]
        : []),
      ...peers.map((peer) => ({
        ...peer.candidate,
        ...placementHostLimits(hosts, peer.candidate.environmentId),
      })),
    ];
    const decision = yield* Effect.sync(() => {
      const chosen = chooseThreadPlacement(
        { originEnvironmentId: hereId },
        candidates.map((candidate) => withRecentPlacements(candidate, now)),
        now,
      );
      if (chosen.accepted)
        recentPlacements.set(chosen.environmentId, [...recentAt(chosen.environmentId, now), now]);
      return chosen;
    });
    yield* Effect.annotateCurrentSpan({
      "placement.reason": decision.reason,
      "placement.candidates": askable.length + (hereCandidate ? 1 : 0),
    });
    const projectId = !decision.accepted
      ? undefined
      : decision.environmentId === hereId
        ? input.projectId
        : peers
            .find((peer) => peer.candidate.environmentId === decision.environmentId)
            ?.projectId.pipe(Option.getOrUndefined);
    return { decision, projectId };
  });

  const placementBinding = (
    scope: McpInvocationContext.McpInvocationScope,
    input: { readonly operation: string; readonly key: string },
  ) =>
    CommandId.make(
      `command:mcp:${encodeURIComponent(scope.requestNamespace)}:placement:${input.operation}:${encodeURIComponent(input.key)}`,
    );
  const bindingFailure = () =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message:
        "Unable to record where this task runs, so nothing was started. Retry with the same clientRequestId.",
    });

  /** A bound environment automatic placement may no longer use: nothing is sent there or anywhere. */
  const boundExcluded = (environmentId: EnvironmentId) =>
    new OrchestratorMcpFailure({
      code: "target_required",
      message: `This request is bound to environment ${environmentId}, which automatic placement may no longer use, so nothing was sent. Reconcile it there, or start new work with a new clientRequestId.`,
    });

  const placed: RemoteDelegation["Service"]["placed"] = (scope, input) =>
    threads.intentOf(placementBinding(scope, input)).pipe(
      Effect.map(Option.map(EnvironmentId.make)),
      Effect.mapError(bindingFailure),
      // Current exclusions hold for every bound destination, this one too. A launch already
      // made here replays before placement is consulted (`t3_thread_launch`).
      Effect.tap((bound) =>
        Option.isSome(bound)
          ? Effect.flatMap(exclusions, (excluded) =>
              excluded.has(bound.value) ? Effect.fail(boundExcluded(bound.value)) : Effect.void,
            )
          : Effect.void,
      ),
    );

  const place: RemoteDelegation["Service"]["place"] = Effect.fn("RemoteDelegation.place")(
    function* (scope, input) {
      const bindingId = placementBinding(scope, input);
      // A bound intent keeps its environment, even one that has since filled up or
      // stopped answering: its first attempt may have started the task there.
      const bound = yield* placed(scope, input);
      if (Option.isSome(bound)) return bound.value;
      const { decision } = yield* choosePlacement(askFor(scope), {
        ...input,
        excluded: yield* exclusions,
      });
      if (!decision.accepted) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: `No environment can take this task now (${decision.reason}): every machine automatic placement may use is at its lane or memory limit, or lacks this repository's project or ${input.modelSelection.instanceId}/${input.modelSelection.model}. Nothing was started. Retry later; name an environment only for work bound to that machine.`,
        });
      }
      return yield* threads
        .bindIntent({
          commandId: bindingId,
          threadId: input.threadId,
          value: decision.environmentId,
        })
        .pipe(Effect.map(EnvironmentId.make), Effect.mapError(bindingFailure));
    },
  );

  /**
   * Native admission keys hang off this server's own id and the launch's command id. Its
   * owner, the session that first admitted it, is bound before anything is chosen.
   */
  const nativeBinding = (kind: "placement" | "placement-owner", commandId: CommandId) =>
    CommandId.make(
      `command:native:${encodeURIComponent(hereId)}:${kind}:thread-launch:${encodeURIComponent(commandId)}`,
    );

  const admit: RemoteDelegation["Service"]["admit"] = Effect.fn("RemoteDelegation.admit")(
    function* (caller, input) {
      const refuse = (reason: OrchestrationV2ThreadPlacementAdmitError["reason"], detail: string) =>
        new OrchestrationV2ThreadPlacementAdmitError({
          commandId: input.commandId,
          reason,
          detail,
        });
      const unavailableHere = () =>
        refuse(
          "unavailable",
          "Unable to read or record where this launch runs, so nothing was bound or started. Send it again.",
        );
      const signedOut = () =>
        refuse(
          "unavailable",
          "This sign-in can no longer launch threads here, so nothing was bound or started.",
        );
      if (!(yield* caller.stillAuthorized)) return yield* signedOut();
      const owner = yield* threads
        .bindIntent({
          commandId: nativeBinding("placement-owner", input.commandId),
          threadId: input.threadId,
          value: caller.sessionId,
        })
        .pipe(Effect.mapError(unavailableHere));
      if (owner !== caller.sessionId) {
        return yield* refuse(
          "other-session",
          "This launch was started from another sign-in, so it is not continued or started again from this one. Open it where it was sent from, or start a new draft.",
        );
      }
      const excluded = yield* links.placementExclusions.pipe(Effect.mapError(unavailableHere));
      const placementId = nativeBinding("placement", input.commandId);
      const decode = (value: string) =>
        decodeNativePlacement(value).pipe(Effect.mapError(unavailableHere));
      // The first admission's answer holds, whatever this one asks: it may already have launched.
      const bound = yield* threads.intentOf(placementId).pipe(Effect.mapError(unavailableHere));
      if (Option.isSome(bound)) {
        const placement = yield* decode(bound.value);
        // Only this operation's own launch, accepted here for its own thread, is reconciled past a
        // current exclusion: its `thread.create` receipt. Elsewhere that cannot be known without
        // contact, and a thread that merely exists proves nothing.
        const acceptedHere =
          placement.environmentId === hereId &&
          (yield* threads.acceptedLaunchOf(input.commandId).pipe(
            Effect.map((launched) => Option.isSome(launched) && launched.value === input.threadId),
            Effect.mapError(unavailableHere),
          ));
        if (excluded.has(placement.environmentId) && !acceptedHere) {
          return yield* refuse(
            "excluded",
            `This launch is bound to environment ${placement.environmentId}, which automatic placement may no longer use, so nothing was sent. Reconcile it there, or start a new draft.`,
          );
        }
        return { ...placement, resumed: true };
      }
      const { decision, projectId } = yield* choosePlacement(
        askNative({
          limits: { runtimeMode: input.runtimeMode, interactionMode: input.interactionMode },
        }),
        { ...input, here: yield* input.here, excluded, restrictTo: input.candidateEnvironmentIds },
      );
      if (!decision.accepted || projectId === undefined) {
        return yield* refuse(
          "no-eligible-environment",
          `No machine you can launch on answered with spare capacity, this repository's project and ${input.modelSelection.instanceId}/${input.modelSelection.model} in ${input.runtimeMode}. Nothing was started.`,
        );
      }
      if (!(yield* caller.stillAuthorized)) return yield* signedOut();
      const value = encodeNativePlacement({
        environmentId: EnvironmentId.make(decision.environmentId),
        projectId,
        reason: "capacity",
      });
      const held = yield* threads
        .bindIntent({ commandId: placementId, threadId: input.threadId, value })
        .pipe(Effect.mapError(unavailableHere));
      return { ...(yield* decode(held)), resumed: held !== value };
    },
  );

  /**
   * The other side names the thread from its link session and the key. The first launch's
   * session and answered thread are bound here, and it is sent only under that session; a
   * key bound under another one is never sent again, so a re-link never starts a second.
   */
  const launchThere = Effect.fn("RemoteDelegation.launchThere")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly launchId: CommandId;
      readonly childId: CommandId;
      readonly threadId: ThreadId;
      readonly params: Tool.Parameters<typeof ProjectToolkit.tools.t3_thread_launch>;
    },
  ) {
    const { label } = input;
    const linkSession = yield* links.session(input.environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Unable to read the link to ${label}, so nothing was started. Retry with the same clientRequestId.`,
          }),
      ),
    );
    // A launch is only sent bound to the link session it goes out under; with no link
    // there is none, and one appearing before the send must not carry it unbound.
    if (linkSession === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `This environment is not linked to ${label}, so nothing was started. t3_environment_links lists the linked ones.`,
      });
    }
    const session = `${input.environmentId}@${linkSession}`;
    const launchedUnder = yield* threads
      .bindIntent({ commandId: input.launchId, threadId: input.threadId, value: session })
      .pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "Unable to record the launch there, so nothing was started. Retry with the same clientRequestId.",
            }),
        ),
      );
    if (launchedUnder !== session) {
      const childThreadId = yield* threads.intentOf(input.childId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      return { _tag: "bound-elsewhere" as const, childThreadId };
    }
    const launched = yield* forwarding.call(
      scope,
      ProjectToolkit.tools.t3_thread_launch,
      input.environmentId,
      input.params,
      // Sent only under the session bound above, never one linked since.
      { expectedIncarnation: linkSession },
    );
    // Losing this only makes a retry after linking again refuse instead of finding the thread.
    yield* threads
      .bindIntent({ commandId: input.childId, threadId: input.threadId, value: launched.threadId })
      .pipe(Effect.ignoreCause({ log: true }));
    return { _tag: "launched" as const, launched };
  });

  const launch: RemoteDelegation["Service"]["launch"] = Effect.fn("RemoteDelegation.launch")(
    function* (scope, input) {
      const keyed = (operation: string) =>
        CommandId.make(
          `command:mcp:${encodeURIComponent(scope.requestNamespace)}:${operation}:${encodeURIComponent(input.key)}`,
        );
      const label = yield* links.get(input.environmentId).pipe(
        Effect.map((link) => (Option.isSome(link) ? link.value.label : input.environmentId)),
        Effect.orElseSucceed(() => input.environmentId),
      );
      const projectId = yield* resolveRemoteProject(
        askFor(scope),
        input.environmentId,
        input.projectId,
        undefined,
      );
      const sent = yield* launchThere(scope, {
        environmentId: input.environmentId,
        label,
        launchId: keyed("thread-launch-there"),
        childId: keyed("thread-launch-child"),
        threadId: input.threadId,
        params: { ...input.params, projectId },
      });
      if (sent._tag === "launched") return sent.launched;
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `${label} was linked again after an earlier attempt with this clientRequestId launched the thread there, and the new link cannot find it. Nothing new was started. ${
          sent.childThreadId === undefined
            ? "t3_thread_list with this environmentId finds it."
            : `Its thread there is ${sent.childThreadId}.`
        } This clientRequestId stays bound to the earlier link. Check that thread there before deciding the work still needs doing.`,
      });
    },
  );

  const delegate: RemoteDelegation["Service"]["delegate"] = Effect.fn("RemoteDelegation.delegate")(
    function* (scope, input) {
      const parent = yield* threads.getThreadRecords(scope.thread.threadId, ["runs"]).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The calling thread was not found.",
            }),
        ),
      );
      const parentRun = parent.runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Delegated tasks require an active run owned by this MCP provider session.",
        });
      }
      const parentNodeId = parentRun.rootNodeId;
      const { target } = input;
      // A worktree there would branch from a commit this checkout has and the
      // other may not, so a remote task runs in that project's checkout.
      if (input.isolation === "worktree") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            'A task in a linked environment runs in that project\'s checkout; isolation "worktree" is not supported there. Omit isolation, or use t3_thread_launch with environmentId and a worktree workspaceStrategy.',
        });
      }
      // The provider and model inherit as they do for a task here. Another
      // provider there has no model to inherit, so the caller names one.
      const inherited = parent.thread.modelSelection;
      const instanceId =
        target.driverKind === undefined
          ? (target.providerInstanceId ?? inherited.instanceId)
          : yield* resolveRemoteInstance(scope, target.environmentId, {
              driverKind: target.driverKind,
              providerInstanceId: target.providerInstanceId,
              inheritedInstanceId: inherited.instanceId,
            });
      const model =
        target.model ?? (instanceId === inherited.instanceId ? inherited.model : undefined);
      if (model === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass target.model from orchestrator_capabilities with this environmentId.",
        });
      }
      const options =
        target.options ??
        (instanceId === inherited.instanceId && model === inherited.model
          ? inherited.options
          : undefined);
      // Modes asked for are checked against this thread. Omitted ones are left
      // to the other side, which inherits this thread's modes capped by the
      // link's access, so a narrower link still takes the task.
      const runtimeMode =
        input.runtimeMode === undefined || input.runtimeMode === "inherit"
          ? undefined
          : yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
      const interactionMode =
        input.interactionMode === undefined || input.interactionMode === "inherit"
          ? undefined
          : yield* resolveInteractionMode(parent.thread.interactionMode, input.interactionMode);
      const projectId = yield* resolveRemoteProject(
        askFor(scope),
        target.environmentId,
        parent.thread.projectId,
        target.projectId,
      );
      // One key for the launch there and the record here, so a retry finds both.
      // Both are scoped to the provider session, as every key a caller passes is:
      // the forwarder scopes the launch's, and the record's names it.
      const key = input.clientRequestId ?? (yield* random.uuidV4());
      const keyed = (operation: string) =>
        CommandId.make(
          `command:mcp:${encodeURIComponent(scope.requestNamespace)}:${operation}:${encodeURIComponent(key)}`,
        );
      const commandId = keyed("remote-delegate");
      const link = yield* links.get(target.environmentId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const label = link?.label ?? target.environmentId;
      const task = taskPrompt(input);
      const title = input.title ?? parent.thread.title;
      const sent = yield* launchThere(scope, {
        environmentId: target.environmentId,
        label,
        launchId: keyed("remote-launch"),
        childId: keyed("remote-child"),
        threadId: parent.thread.id,
        params: {
          projectId,
          title,
          modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(interactionMode === undefined ? {} : { interactionMode }),
          message: task,
          clientRequestId: `delegate:${scope.thread.threadId}:${key}`,
          // The thread there shows it is this thread's subagent, with a way back.
          delegatedFrom: {
            environmentId: hereId,
            threadId: parent.thread.id,
            title: parent.thread.title,
          },
        },
      });
      if (sent._tag === "bound-elsewhere") {
        const childThere = sent.childThreadId;
        const recordedTask =
          childThere === undefined
            ? undefined
            : yield* threads.getThreadRecords(scope.thread.threadId, ["subagents"]).pipe(
                Effect.map(({ subagents }) =>
                  subagents.find(
                    (task) =>
                      task.remoteChild?.environmentId === target.environmentId &&
                      task.remoteChild.threadId === childThere,
                  ),
                ),
                Effect.orElseSucceed(() => undefined),
              );
        if (recordedTask !== undefined) return { taskId: recordedTask.id };
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${label} was linked again after an earlier attempt with this clientRequestId launched the task there, and the new link cannot find that thread. Nothing new was started. ${
            childThere === undefined
              ? "t3_thread_list with this environmentId finds it: it names this thread as its parent."
              : `Its thread there is ${childThere}.`
          } This clientRequestId stays bound to the earlier link. Check that thread there before deciding the work still needs doing.`,
        });
      }
      const launched = sent.launched;
      const remoteChild: OrchestrationV2RemoteTaskChild = {
        environmentId: target.environmentId,
        threadId: launched.threadId,
        label,
        title,
        ...(launched.runId === null ? {} : { runId: launched.runId }),
      };
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId,
          task,
          ...(input.title === undefined ? {} : { title: input.title }),
          // The driver runs there; this side only labels the task with it.
          driver: ProviderDriverKind.make("remote"),
          modelSelection: launched.modelSelection,
          remoteChild,
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          // The cause goes to the log; the caller learns only that recording failed.
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.record-failed", {
              parentThreadId: scope.thread.threadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Unable to record the delegated task.",
              }),
          ),
          // Nothing here follows a thread the task was never recorded for, so stop it there.
          // A crash between the launch and this record still leaves it running there
          // until a retry with the same clientRequestId records it.
          Effect.tapError(() =>
            stopThere(followScope(scope.thread, remoteChild), remoteChild, "stop").pipe(
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated"
          ? taskEvent.event.payload.id
          : // A replayed request recorded the task the first time.
            yield* threads.getThreadRecords(scope.thread.threadId, ["subagents"]).pipe(
              Effect.map(
                ({ subagents }) =>
                  subagents.find((task) => task.remoteChild?.threadId === launched.threadId)?.id,
              ),
              Effect.orElseSucceed(() => undefined),
            );
      if (taskId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The delegated task was not recorded.",
        });
      }
      yield* followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers));
      return { taskId };
    },
  );

  const followUp: RemoteDelegation["Service"]["followUp"] = Effect.fn("RemoteDelegation.followUp")(
    function* (scope, environmentId, request, sent) {
      // A steer joins a run that is already some task's, or no one's.
      if (scope.thread === undefined || (sent.delivery !== "started" && sent.delivery !== "queued"))
        return sent;
      const parentThreadId = scope.thread.threadId;
      const parent = yield* threads
        .getThreadRecords(parentThreadId, ["runs", "subagents"])
        .pipe(Effect.orElseSucceed(() => undefined));
      const isThere = (task: OrchestrationV2Subagent) =>
        task.remoteChild?.environmentId === environmentId &&
        task.remoteChild.threadId === sent.threadId;
      const finished = parent?.subagents.find((task) => isThere(task) && task.result !== null);
      // Bound as a follow-up here is: a background caller's foreground run may have ended.
      const parentRun = parent === undefined ? null : followUpOwnerRun(parent.runs);
      if (
        finished?.remoteChild === undefined ||
        finished.model === null ||
        parentRun === null ||
        parentRun.rootNodeId === null
      )
        return sent;
      // The message id there is the send's, so a retry that reached the same send records once.
      const commandId = CommandId.make(
        `command:remote-followup:${encodeURIComponent(parentThreadId)}:${encodeURIComponent(environmentId)}:${encodeURIComponent(sent.messageId)}`,
      );
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: request.message,
          ...(finished.title === null ? {} : { title: finished.title }),
          driver: finished.driver,
          modelSelection: { instanceId: finished.providerInstanceId, model: finished.model },
          remoteChild: {
            environmentId,
            threadId: sent.threadId,
            label: finished.remoteChild.label,
            runId: sent.runId,
          },
          completionWake: "always",
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.followup-record-failed", {
              parentThreadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  request.clientRequestId === undefined
                    ? "The message was sent, but its task was not recorded; read the thread for its answer instead of sending it again."
                    : "The message was sent, but its task was not recorded; send it again with the same clientRequestId to record it.",
              }),
          ),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated"
          ? taskEvent.event.payload.id
          : // A replayed request recorded the task the first time.
            yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
              Effect.map(
                ({ subagents }) =>
                  subagents.find((task) => isThere(task) && task.remoteChild?.runId === sent.runId)
                    ?.id,
              ),
              Effect.orElseSucceed(() => undefined),
            );
      if (taskId === undefined) return sent;
      yield* followOne(parentThreadId, taskId).pipe(Effect.forkIn(followers));
      return { ...sent, taskId };
    },
  );

  /**
   * Completes `task` here with its thread there's final state. Each attempt is its own
   * command, so a failed one never blocks the next; a report refused because the task already
   * has its result (a cancel, a Stop or an earlier report) is done. `stoppedThere` records that
   * nothing is left to stop there, even on a task that already has its result.
   */
  const complete = Effect.fn("RemoteDelegation.complete")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string,
    stoppedThere: "ran-out" | "stopped" | undefined,
    stopCount?: number,
    executedModel?: string,
    alert?: OrchestrationV2WorkerAlert,
  ) {
    const attempt = yield* random.uuidV4();
    yield* threads
      .dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make(`command:remote-task-complete:${taskId}:${attempt}`),
        parentThreadId,
        taskId,
        status,
        result,
        ...(stoppedThere === undefined ? {} : { stoppedThere }),
        ...(stopCount === undefined ? {} : { stopCount }),
        ...(executedModel === undefined ? {} : { executedModel }),
        ...(alert === undefined ? {} : { workerAlert: alert }),
      })
      .pipe(
        Effect.catch((error) =>
          readTask(parentThreadId, taskId).pipe(
            Effect.flatMap(({ task }) => (task?.result != null ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
  });

  /**
   * How this environment reaches a task's thread there: as the parent
   * thread, under one namespace per parent, so a stop sent again after a
   * restart or a dropped route is recorded there once.
   */
  const followScope = (
    parent: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
    remote: OrchestrationV2RemoteTaskChild,
  ): ThreadScope => ({
    environmentId: hereId,
    requestNamespace: `remote-task:${parent.threadId}`,
    thread: {
      threadId: parent.threadId,
      providerSessionId: `remote-task:${remote.threadId}`,
      providerInstanceId: parent.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /**
   * Stops the task's own thread there as its Stop button does: its running turn, queued
   * messages, pull request watches and delegated tasks. `key` names the stop (the follower
   * sends one, each cancel its own), and each is recorded there once however often it is sent.
   */
  const stopThere = (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    key: string,
    reason?: string,
  ) =>
    forwarding
      .interruptThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        stop: true,
        ...(reason === undefined ? {} : { reason }),
        clientRequestId: `${key}:${remote.threadId}`,
      })
      .pipe(Effect.asVoid);

  /**
   * The last reply `runId` gave on the task's thread there, which is its
   * result, read whole however long it is. A failed run prefers its error
   * from the activity view over an earlier reply, without taking another run's.
   * Led by a worker alert when the run ran another model or withheld the task.
   */
  const lastReply = Effect.fn("RemoteDelegation.lastReply")(function* (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    runId: RunId | null,
    failed = false,
  ) {
    let reply: OrchestratorMcpThreadTimelineItem | undefined;
    let error: OrchestratorMcpThreadTimelineItem | undefined;
    let afterPosition: number | undefined;
    let run: OrchestratorMcpThreadRun | undefined;
    while (true) {
      const read = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        view: failed ? "activity" : "messages",
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 20_000,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      run ??= read.recentRuns.find((candidate) => candidate.runId === runId);
      reply =
        read.items.findLast(
          (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
        ) ?? reply;
      if (failed) {
        error =
          read.items.findLast(
            (item) => item.type === "error" && (runId === null || item.runId === runId),
          ) ?? error;
      }
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    reply = error ?? reply;
    const executedModel = run?.executedModel ?? undefined;
    // Peers that predate `workerAlert` report only the model, so judge the run here.
    const alertFor = (finalText: string | undefined) =>
      run === undefined
        ? undefined
        : (run.workerAlert ??
          workerAlert({ requestedModel: run.model, executedModel: run.executedModel, finalText }));
    if (reply === undefined)
      return { text: undefined, executedModel, workerAlert: alertFor(undefined) };
    let text = reply.text ?? "";
    let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
    while (textOffset !== null) {
      const rest = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        itemId: reply.itemId,
        textOffset,
        maxCharsPerItem: 20_000,
      });
      const part = rest.items[0];
      if (part === undefined) break;
      text += part.text ?? "";
      textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    const alert = alertFor(error === undefined ? text : undefined);
    return {
      text: alert === undefined ? text : `${alert.notice}\n\n${text}`,
      executedModel,
      workerAlert: alert,
    };
  });

  /**
   * Why following a task can never succeed, if that is what `error` means.
   * The far side's message already says what was refused and what to do; a
   * link forgotten here only reads as a bad request, so it is named.
   */
  const finalReason = Effect.fn("RemoteDelegation.finalReason")(
    function* (parentThreadId: ThreadId, taskId: NodeId, error: OrchestratorMcpFailure) {
      if (isFinal(error)) return error.message;
      if (error.code !== "invalid_request") return undefined;
      const { task } = yield* readTask(parentThreadId, taskId);
      const environmentId = task?.remoteChild?.environmentId;
      if (environmentId === undefined) return error.message;
      const link = yield* links.get(environmentId);
      return Option.isSome(link) ? undefined : error.message;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** A task's thread there that ended without a reply. */
  const noReply = "(The thread in the linked environment ended without a reply.)";

  /**
   * Waits for the task's run there to end, completes the task here, and stops it there if it
   * ended here first. A revoked, expired or forgotten link, or a thread or run gone there,
   * fails the task with nothing left to stop; repeated defects here fail it too. Anything else
   * (the other machine asleep, a dropped route) is retried with back-off, and so is completing.
   */
  const follow = (parentThreadId: ThreadId, taskId: NodeId): Effect.Effect<void> =>
    Effect.suspend(() => {
      let defects = 0;
      const noDefect = Effect.sync(() => {
        defects = 0;
      });
      return followOnce(parentThreadId, taskId).pipe(
        Effect.tap(noDefect),
        // `false` means it is still running there: follow again straight away.
        Effect.repeat({ while: (done) => !done }),
        Effect.catchTags({
          OrchestratorMcpFailure: Effect.fn("RemoteDelegation.followFailed")(function* (error) {
            const reason = yield* finalReason(parentThreadId, taskId, error);
            if (reason === undefined) return yield* error;
            // Gone there, or no link to reach it by: nothing left to stop there.
            const { task } = yield* readTask(parentThreadId, taskId);
            const stopCount = task?.remoteChild?.stopCount;
            yield* complete(parentThreadId, taskId, "failed", reason, "stopped", stopCount);
          }),
        }),
        Effect.tapError(() => noDefect),
        Effect.tapDefect(() =>
          Effect.sync(() => {
            defects += 1;
          }),
        ),
        failOnDefect,
        Effect.retry({ schedule: followRetry, while: () => defects < FOLLOW_MAX_DEFECTS }),
        Effect.catch(
          Effect.fn("RemoteDelegation.followGaveUp")(
            function* () {
              const { task } = yield* readTask(parentThreadId, taskId);
              const remote = task?.remoteChild;
              // A task with its result keeps it; completing it again would owe another stop there.
              if (remote === undefined || task?.result !== null) return;
              const result = `Following the thread ${remote.threadId} in ${remote.label} failed repeatedly, so it may still run there (task_cancel stops it).`;
              yield* complete(parentThreadId, taskId, "failed", result, undefined);
            },
            failOnDefect,
            Effect.retry(followRetry),
          ),
        ),
        Effect.ignoreCause({ log: true }),
      );
    });

  /**
   * One wait on the task's thread there; true once the task here is done.
   * A task completed here first (cancelled, or its parent stopped) is
   * stopped there, and done once that stop is recorded here.
   */
  const followOnce = Effect.fn("RemoteDelegation.followOnce")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    const sequence = yield* threads.getThreadEventSequence(parentThreadId);
    const { thread, task } = yield* readTask(parentThreadId, taskId);
    if (task?.remoteChild === undefined) return true;
    const remote = task.remoteChild;
    const scope = followScope(
      { threadId: parentThreadId, providerInstanceId: thread.providerInstanceId },
      remote,
    );
    // Ended here, maybe while this follower backed off from an unreachable
    // machine or before a restart: it still has to be stopped there. So
    // does one its parent here was stopped after, for what followed there.
    if (task.result !== null) {
      if (
        remote.stoppedThere === false ||
        ((task.status === "cancelled" || task.status === "interrupted") &&
          remote.stoppedThere !== true)
      ) {
        const count = remote.stopCount === undefined ? "stop" : `stop-${remote.stopCount}`;
        // Named for its run too: a follow-up task shares the thread there and counts its own stops.
        const key = remote.runId === undefined ? count : `${count}:${remote.runId}`;
        yield* stopThere(scope, remote, key).pipe(
          // Its thread there now runs above what this side may touch, say
          // because the parent here was lowered since; no retry changes that.
          Effect.catchIf(isModeRefusal, (error) =>
            Effect.logWarning("A linked environment refused to stop a delegated task", {
              taskId,
              reason: error.message,
            }),
          ),
        );
        yield* complete(
          parentThreadId,
          taskId,
          terminalStatus(task.status),
          task.result,
          "stopped",
          remote.stopCount,
        );
        return yield* settled(parentThreadId, taskId);
      }
      return true;
    }
    const endedHere = threads
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: sequence,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.result !== null,
        ),
        Stream.runHead,
        Effect.flatMap((ended) =>
          Option.isSome(ended) ? Effect.succeed({ endedHere: true } as const) : Effect.never,
        ),
      );
    const waited = yield* forwarding
      .waitForThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        ...(remote.runId === undefined ? {} : { runId: remote.runId }),
        timeoutMs: FOLLOW_WAIT_MS,
        // A thread there whose run ended may still be waiting on its own
        // tasks to wake it for the answer, which a task here waits for too.
        // An older peer ignores this and reports the run alone.
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.raceFirst(endedHere));
    // The next look reads the result and stops it there.
    if ("endedHere" in waited) return false;
    if (waited.timedOut) return false;
    // A task recorded without its run waits on the thread's latest; a
    // thread there with none has nothing left to wait for.
    if (waited.runId === null) {
      const reply = yield* lastReply(scope, remote, null);
      yield* complete(
        parentThreadId,
        taskId,
        reply.text === undefined ? "failed" : "completed",
        reply.text ?? "The thread in the linked environment has no run to follow.",
        "ran-out",
      );
      return yield* settled(parentThreadId, taskId);
    }
    if (!isTerminal(waited.status)) return false;
    // A later run's answer there may be another open follow-up's, or its restart, which no run id
    // here names; concurrent sends may record here out of their order there. Then this task's
    // answer is its own run's latest restart, the one waited on.
    const sharedThread =
      waited.resultRun !== undefined &&
      waited.resultRun.runId !== waited.runId &&
      (yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
        Effect.map(({ subagents }) => {
          const recordedAt = subagents.find((task) => task.id === taskId)?.startedAt ?? null;
          return subagents.some(
            (other) =>
              other.id !== taskId &&
              other.remoteChild?.environmentId === remote.environmentId &&
              other.remoteChild.threadId === remote.threadId &&
              // One that settled before this was recorded ran before it there.
              (recordedAt === null ||
                other.completedAt === null ||
                DateTime.isGreaterThan(other.completedAt, recordedAt)),
          );
        }),
      ));
    const resultRun =
      waited.resultRun !== undefined && !sharedThread
        ? waited.resultRun
        : { runId: waited.runId, status: waited.status };
    const result = yield* lastReply(scope, remote, resultRun.runId, resultRun.status === "failed");
    yield* complete(
      parentThreadId,
      taskId,
      terminalStatus(resultRun.status),
      result.text ?? noReply,
      "ran-out",
      undefined,
      result.executedModel,
      result.workerAlert,
    );
    return yield* settled(parentThreadId, taskId);
  });

  /**
   * Whether the task is done here after the follower reported its run ran
   * out there. A cancel or Stop that landed while the reply was read keeps
   * its result, and still owes a stop there for what may follow the run;
   * the next look sends it.
   */
  const settled = (parentThreadId: ThreadId, taskId: NodeId) =>
    readTask(parentThreadId, taskId).pipe(
      Effect.map(({ task }) => task?.remoteChild?.stoppedThere === true),
    );

  const following = new Map<NodeId, { again: boolean }>();

  /**
   * `follow`, at most once per task. Asked again while it runs, say by a
   * Stop here on a task that already has its result, it looks once more
   * before it ends, so that stop is not missed.
   */
  const followOne = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.suspend(() => {
      const running = following.get(taskId);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const state = { again: false };
      following.set(taskId, state);
      return follow(parentThreadId, taskId).pipe(
        // Checked and released in one step, so a request between them is never lost.
        Effect.repeat({
          while: () => {
            if (state.again) {
              state.again = false;
              return true;
            }
            following.delete(taskId);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (following.get(taskId) === state) following.delete(taskId);
          }),
        ),
      );
    });

  const cancel: RemoteDelegation["Service"]["cancel"] = Effect.fn("RemoteDelegation.cancel")(
    function* (scope, task, input) {
      const remote = task.remoteChild;
      if (remote === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: `Delegated task ${task.id} is not remote.`,
        });
      }
      const { reason } = input;
      const there = followScope(scope.thread, remote);
      // A later cancel stops what started there since; a retry of this one, nothing new.
      const key = `cancel:${encodeURIComponent(scope.requestNamespace)}:${
        input.clientRequestId ?? (yield* random.uuidV4())
      }`;
      if (task.result !== null) {
        // Best effort: the result stands whether or not the stop gets there.
        yield* stopThere(there, remote, key, reason).pipe(
          Effect.andThen(
            complete(
              task.threadId,
              task.id,
              terminalStatus(task.status),
              task.result,
              "stopped",
              remote.stopCount,
            ),
          ),
          Effect.ignoreCause({ log: true }),
        );
        return {
          taskId: task.id,
          status:
            task.status === "completed" || task.status === "failed" || task.status === "interrupted"
              ? task.status
              : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      // A link that is gone or a machine that is down still cancels the task
      // here; its follower keeps trying to stop it there, across restarts.
      const unstopped = yield* stopThere(there, remote, key, reason).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      const cancelled = reason === undefined ? "Cancelled." : `Cancelled: ${reason}`;
      yield* complete(
        task.threadId,
        task.id,
        "cancelled",
        unstopped === undefined
          ? cancelled
          : `${cancelled} It could not be stopped in ${remote.label} and may still run there: ${unstopped}`,
        unstopped === undefined ? "stopped" : undefined,
        remote.stopCount,
      ).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.cancel-record-failed", { taskId: task.id, cause }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the cancellation.",
            }),
        ),
      );
      return {
        taskId: task.id,
        status: "cancel_requested",
      } satisfies OrchestratorMcpTaskCancelResult;
    },
  );

  const runStatus = Effect.fn("RemoteDelegation.runStatus")(
    function* (scope: ThreadScope, task: OrchestrationV2Subagent) {
      const remote = task.remoteChild;
      if (remote?.runId === undefined) return null;
      const read = yield* forwarding.readThread(
        followScope(scope.thread, remote),
        remote.environmentId,
        { threadId: remote.threadId, limit: 1, runLimit: 50 },
      );
      return read.recentRuns.find((run) => run.runId === remote.runId)?.status ?? null;
    },
    Effect.orElseSucceed(() => null),
  );

  const start: RemoteDelegation["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // A finished task's follower has ended, so a Stop here that owes its
        // thread there a stop starts it again. Started before the scan below;
        // a Stop that slips between the two stays owed for the next start.
        yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "subagent.updated" && event.payload.remoteChild?.stoppedThere === false
            ? followOne(event.threadId, event.payload.id).pipe(Effect.forkIn(followers))
            : Effect.void,
        ).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(followers, { startImmediately: true }),
        );
        const open = yield* projections.getOpenRemoteDelegatedTasks;
        yield* Effect.forEach(
          open,
          ({ parentThreadId, taskId }) => followOne(parentThreadId, taskId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return RemoteDelegation.of({
    delegate,
    place,
    admit,
    placed,
    launch,
    followUp,
    cancel,
    runStatus,
    start,
  });
});

/** A defect, logged, as a failure, so a retry covers it. */
const failOnDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchDefect(effect, (defect) =>
    Effect.logWarning("A remote task's follower hit a defect", Cause.die(defect)).pipe(
      Effect.andThen(Effect.fail(new Cause.UnknownError(defect, "A follower hit a defect."))),
    ),
  );

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const terminalStatus = (status: string): "completed" | "failed" | "cancelled" | "interrupted" =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";

export const layer = Layer.effect(RemoteDelegation, make);
