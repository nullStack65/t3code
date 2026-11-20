import {
  type EnvironmentId,
  type LinkedSidebarEnvironment,
  type LinkedSidebarResult,
  type LinkedSidebarThread,
  NonNegativeInt,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  type PeerLinkSummary,
  Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const THREAD_PAGE_LIMIT = 100;
const MAX_THREAD_PAGES = 8;
const PROJECT_PAGE_LIMIT = 100;
const MAX_PROJECT_PAGES = 3;
const PAGE_BUDGET = Duration.seconds(3);

const READ_LIMITS = {
  runtimeMode: "approval-required",
  interactionMode: "default",
} as const;

const ProjectPage = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(NonNegativeInt),
});

const decodeProjectPage = Schema.decodeUnknownEffect(ProjectPage);
const decodeThreadPage = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);

export interface LinkedSidebarSourceLink {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: PeerLinkSummary["status"];
  readonly expiresAt: DateTime.Utc;
}

interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: number | null;
}

type PageError = Schema.SchemaError | OrchestratorMcpFailure;

const pageAll = Effect.fn("linkedSidebar.pageAll")(function* <A>(
  load: (cursor: number) => Effect.Effect<Page<A>, PageError>,
  maxPages: number,
) {
  const items: Array<A> = [];
  let cursor = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = yield* Effect.timeoutOption(load(cursor), PAGE_BUDGET).pipe(
      Effect.orElseSucceed(() => Option.none<Page<A>>()),
    );
    if (Option.isNone(result)) return items;
    items.push(...result.value.items);
    if (result.value.nextCursor === null) return items;
    cursor = result.value.nextCursor;
  }
  return items;
});

const slimThread = (
  thread: (typeof OrchestratorMcpThreadListResult.Type.threads)[number],
): LinkedSidebarThread => ({
  ...(thread.inbox === undefined ? {} : { inbox: thread.inbox }),
  threadId: thread.threadId,
  projectId: thread.projectId,
  title: thread.title,
  createdBy: thread.createdBy,
  creationSource: thread.creationSource,
  status: thread.status,
  latestRunId: thread.latestRunId,
  providerInstanceId: thread.providerInstanceId,
  model: thread.model,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  settled: thread.settled,
  settledAt: thread.settledAt,
  snoozed: thread.snoozed,
  snoozedUntil: thread.snoozedUntil,
  ...(thread.pinned === undefined ? {} : { pinned: thread.pinned }),
  parentThreadId: thread.parentThreadId,
  relationshipToParent: thread.relationshipToParent,
  itemCount: thread.itemCount,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

export const collectLinkedSidebar = Effect.fn("linkedSidebar.collect")(function* (input: {
  readonly links: ReadonlyArray<LinkedSidebarSourceLink>;
  readonly now: DateTime.Utc;
  readonly catalogEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly read: (
    environmentId: EnvironmentId,
    tool: "t3_project_list" | "t3_thread_list",
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, PageError>;
}) {
  const skip = new Set(input.catalogEnvironmentIds);
  const selected = input.links.filter(
    (link) =>
      link.status === "reachable" &&
      !DateTime.isLessThanOrEqualTo(link.expiresAt, input.now) &&
      !skip.has(link.environmentId),
  );
  const environments: Array<LinkedSidebarEnvironment> = yield* Effect.forEach(
    selected,
    (link) =>
      Effect.gen(function* () {
        const projects = yield* pageAll(
          (cursor) =>
            input
              .read(link.environmentId, "t3_project_list", {
                cursor,
                limit: PROJECT_PAGE_LIMIT,
              })
              .pipe(
                Effect.flatMap(decodeProjectPage),
                Effect.map((page) => ({
                  items: page.projects.filter((project) => project.deletedAt === null),
                  nextCursor: page.nextCursor,
                })),
              ),
          MAX_PROJECT_PAGES,
        );
        const threads = yield* pageAll(
          (cursor) =>
            input
              .read(link.environmentId, "t3_thread_list", {
                allProjects: true,
                includeSubagents: false,
                cursor,
                limit: THREAD_PAGE_LIMIT,
              })
              .pipe(
                Effect.flatMap(decodeThreadPage),
                Effect.map((page) => ({
                  items: page.threads.map(slimThread),
                  nextCursor: page.nextCursor,
                })),
              ),
          MAX_THREAD_PAGES,
        );
        return {
          environmentId: link.environmentId,
          label: link.label,
          projects,
          threads,
        } satisfies LinkedSidebarEnvironment;
      }),
    { concurrency: 2 },
  );
  return { environments } satisfies LinkedSidebarResult;
});

export const readLinkedSidebar = Effect.fn("linkedSidebar.read")(function* (input: {
  readonly links: PeerLinks.PeerLinks["Service"];
  readonly peers: PeerMcpClient.PeerMcpClient["Service"];
  readonly catalogEnvironmentIds?: ReadonlyArray<EnvironmentId> | undefined;
}) {
  const listed = yield* input.links.list;
  return yield* collectLinkedSidebar({
    links: listed,
    now: yield* DateTime.now,
    catalogEnvironmentIds: input.catalogEnvironmentIds ?? [],
    read: (environmentId, tool, args) =>
      input.peers.call({
        environmentId,
        tool,
        arguments: args,
        limits: READ_LIMITS,
        success: Schema.Unknown,
      }),
  });
});
