import {
  EnvironmentId,
  makeThreadInbox,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type LinkedSidebarThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sidebarFromServerLinks } from "./linkedSidebar.ts";
import { hasUnseenRunFailure } from "./threadSettled.ts";
import { matchesThreadListFilter, threadListFilterOf } from "./threadListFilter.ts";

const laptop = EnvironmentId.make("primary-mac-laptop");
const omarcy = EnvironmentId.make("omarcy-desktop");
const projectId = ProjectId.make("project-eval");
const threadId = ThreadId.make("thread-eval");

const jeffThread = {
  inbox: makeThreadInbox({ actor: { kind: "human", id: "jeff" } }),
  threadId,
  projectId,
  title: "10-model copy eval",
  createdBy: "user",
  creationSource: "web",
  status: "idle",
  latestRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  runtimeMode: "full-access",
  interactionMode: "default",
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  parentThreadId: null,
  relationshipToParent: null,
  itemCount: 4,
  createdAt: "2026-11-19T12:00:00.000Z",
  updatedAt: "2026-11-20T04:00:00.000Z",
} satisfies LinkedSidebarThread;

describe("sidebarFromServerLinks", () => {
  it("lists a thread owned by another founder on a server-only link", () => {
    const listed = sidebarFromServerLinks({
      catalogEnvironmentIds: [laptop],
      environments: [
        {
          environmentId: laptop,
          label: "primary-mac-laptop",
          projects: [],
          threads: [{ ...jeffThread, threadId: ThreadId.make("thread-local-jeff") }],
        },
        {
          environmentId: omarcy,
          label: "omarcy-desktop",
          projects: [
            {
              id: projectId,
              title: "t3code",
              workspaceRoot: "/src/t3code",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-20T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          threads: [jeffThread],
        },
      ],
    });
    expect(listed.identities).toEqual([{ environmentId: omarcy, label: "omarcy-desktop" }]);
    expect(listed.projects.map((project) => project.environmentId)).toEqual([omarcy]);
    expect(listed.threads.map((thread) => thread.id)).toEqual([threadId]);
    const filter = threadListFilterOf({ founderInboxOwner: "kameron" });
    const linked = listed.threads[0]!;
    expect(matchesThreadListFilter(linked, filter)).toBe(false);
    expect(matchesThreadListFilter(linked, { ...filter, inboxes: ["jeff"] })).toBe(true);
  });

  it("lists one copy when two hosts report the same server-only link", () => {
    const listed = sidebarFromServerLinks({
      catalogEnvironmentIds: [laptop],
      environments: [
        {
          environmentId: omarcy,
          label: "omarcy-desktop",
          projects: [],
          threads: [jeffThread],
        },
        {
          environmentId: omarcy,
          label: "omarcy-desktop",
          projects: [],
          threads: [jeffThread],
        },
      ],
    });
    expect(listed.identities).toEqual([{ environmentId: omarcy, label: "omarcy-desktop" }]);
    expect(listed.threads.map((thread) => thread.id)).toEqual([threadId]);
    expect(listed.projects).toHaveLength(1);
  });

  it("keeps a failed run unseen until the host records a later visit", () => {
    const failed = {
      ...jeffThread,
      status: "failed" as const,
      latestRunId: RunId.make("run-eval"),
      updatedAt: "2026-11-20T05:00:00.000Z",
    } satisfies LinkedSidebarThread;
    const listed = (thread: LinkedSidebarThread) =>
      sidebarFromServerLinks({
        catalogEnvironmentIds: [laptop],
        environments: [
          { environmentId: omarcy, label: "omarcy-desktop", projects: [], threads: [thread] },
        ],
      }).threads[0]!;
    const unseen = listed(failed);
    expect(unseen.latestRun?.status).toBe("failed");
    expect(hasUnseenRunFailure(unseen)).toBe(true);
    const seen = listed({ ...failed, lastVisitedAt: "2026-11-20T05:01:00.000Z" });
    expect(hasUnseenRunFailure(seen)).toBe(false);
    const failedAgain = listed({ ...failed, lastVisitedAt: "2026-11-20T04:59:00.000Z" });
    expect(hasUnseenRunFailure(failedAgain)).toBe(true);
  });

  it("drops the failed pill once the host completes the thread", () => {
    const listed = sidebarFromServerLinks({
      catalogEnvironmentIds: [laptop],
      environments: [
        {
          environmentId: omarcy,
          label: "omarcy-desktop",
          projects: [],
          threads: [
            {
              ...jeffThread,
              status: "idle",
              latestRunId: RunId.make("run-eval"),
              lastVisitedAt: "2026-11-20T04:30:00.000Z",
            },
          ],
        },
      ],
    }).threads[0]!;
    expect(listed.latestRun?.status).toBe("completed");
    expect(hasUnseenRunFailure(listed)).toBe(false);
  });
});
