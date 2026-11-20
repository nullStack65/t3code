import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { Project } from "./project.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { OrchestratorMcpThreadStatus } from "./orchestratorMcp.ts";
import { OrchestrationV2Actor, OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ThreadInbox } from "./threadInbox.ts";

export const LinkedSidebarInput = Schema.Struct({
  catalogEnvironmentIds: Schema.optionalKey(Schema.Array(EnvironmentId)),
});
export type LinkedSidebarInput = typeof LinkedSidebarInput.Type;

export const LinkedSidebarThread = Schema.Struct({
  inbox: Schema.optionalKey(ThreadInbox),
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  /** Absent from linked environments that predate it. */
  latestRunCompletedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  pinned: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Absent from linked environments that predate it. */
  lastVisitedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type LinkedSidebarThread = typeof LinkedSidebarThread.Type;

export const LinkedSidebarEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  projects: Schema.Array(Project),
  threads: Schema.Array(LinkedSidebarThread),
});
export type LinkedSidebarEnvironment = typeof LinkedSidebarEnvironment.Type;

export const LinkedSidebarResult = Schema.Struct({
  environments: Schema.Array(LinkedSidebarEnvironment),
});
export type LinkedSidebarResult = typeof LinkedSidebarResult.Type;
