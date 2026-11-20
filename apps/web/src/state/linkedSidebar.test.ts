import {
  EnvironmentId,
  makeThreadInbox,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type LinkedSidebarResult,
  type LinkedSidebarThread,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  linkedSidebarByHostAtom,
  linkedSidebarEnvironmentIds,
  readLinkedSidebarThreadShell,
} from "./linkedSidebar";

const laptop = EnvironmentId.make("primary-mac-laptop");
const omarcy = EnvironmentId.make("omarcy-desktop");
const threadId = ThreadId.make("mcp:7757a75b-0495-468c-a4ae-318012336419");

const linkedThread = {
  inbox: makeThreadInbox({ actor: { kind: "human", id: "jeff" } }),
  threadId,
  projectId: ProjectId.make("project-dns"),
  title: "Fleet naming + local DNS",
  createdBy: "user",
  creationSource: "mcp",
  status: "idle",
  latestRunId: RunId.make("run-1"),
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

const hostResult = {
  environments: [
    { environmentId: omarcy, label: "omarcy-desktop", projects: [], threads: [linkedThread] },
  ],
} satisfies LinkedSidebarResult;

afterEach(() => {
  appAtomRegistry.set(linkedSidebarByHostAtom, new Map());
});

describe("readLinkedSidebarThreadShell", () => {
  it("finds a thread that only a server link lists, with a completion time to rewind", () => {
    appAtomRegistry.set(linkedSidebarByHostAtom, new Map([[laptop, hostResult]]));
    const shell = readLinkedSidebarThreadShell({ environmentId: omarcy, threadId });
    expect(shell?.title).toBe("Fleet naming + local DNS");
    expect(shell?.latestRun?.completedAt).toBe("2026-11-20T04:00:00.000Z");
  });

  it("returns null for a thread no link lists", () => {
    appAtomRegistry.set(linkedSidebarByHostAtom, new Map([[laptop, hostResult]]));
    expect(
      readLinkedSidebarThreadShell({ environmentId: omarcy, threadId: ThreadId.make("other") }),
    ).toBeNull();
    expect(readLinkedSidebarThreadShell({ environmentId: laptop, threadId })).toBeNull();
  });
});

describe("linkedSidebarEnvironmentIds", () => {
  it("reports a server-only link, which the filter paints connected", () => {
    appAtomRegistry.set(linkedSidebarByHostAtom, new Map([[laptop, hostResult]]));
    expect(linkedSidebarEnvironmentIds()).toEqual([omarcy]);
  });
});
