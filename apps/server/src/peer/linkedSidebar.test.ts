import {
  EnvironmentId,
  makeThreadInbox,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { collectLinkedSidebar } from "./linkedSidebar.ts";

const laptop = EnvironmentId.make("primary-mac-laptop");
const omarcy = EnvironmentId.make("omarcy-desktop");
const air = EnvironmentId.make("js-macbook-air");
const at = (iso: string) => Option.getOrThrow(DateTime.make(iso));

it.effect("reads a reachable server-only link and skips catalog and unreachable links", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const now = at("2026-11-20T05:00:00.000Z");
    const result = yield* collectLinkedSidebar({
      now,
      catalogEnvironmentIds: [laptop],
      links: [
        {
          environmentId: laptop,
          label: "primary-mac-laptop",
          status: "reachable",
          expiresAt: at("2026-12-19T00:00:00.000Z"),
        },
        {
          environmentId: air,
          label: "JS MacBook Air",
          status: "unreachable",
          expiresAt: at("2026-12-19T00:00:00.000Z"),
        },
        {
          environmentId: omarcy,
          label: "omarcy-desktop",
          status: "reachable",
          expiresAt: at("2026-12-19T00:00:00.000Z"),
        },
      ],
      read: (environmentId, tool) => {
        seen.push(`${environmentId}:${tool}`);
        if (tool === "t3_project_list") {
          return Effect.succeed({
            projects: [
              {
                id: ProjectId.make("project-eval"),
                title: "t3code",
                workspaceRoot: "/src/t3code",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-20T00:00:00.000Z",
                deletedAt: null,
              },
            ],
            nextCursor: null,
          });
        }
        return Effect.succeed({
          projectId: null,
          currentThreadId: null,
          nextCursor: null,
          total: 1,
          threads: [
            {
              inbox: makeThreadInbox({ actor: { kind: "human", id: "jeff" } }),
              threadId: ThreadId.make("thread-eval"),
              projectId: ProjectId.make("project-eval"),
              title: "10-model copy eval",
              createdBy: "user",
              creationSource: "web",
              status: "idle",
              latestRunId: null,
              providerInstanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
              runtimeMode: "full-access",
              interactionMode: "default",
              linkedPullRequest: null,
              settled: false,
              settledAt: null,
              snoozed: false,
              snoozedUntil: null,
              parentThreadId: null,
              relationshipToParent: null,
              itemCount: 4,
              createdAt: "2026-11-19T12:00:00.000Z",
              updatedAt: "2026-11-20T04:00:00.000Z",
            },
          ],
        });
      },
    });
    expect(seen).toEqual([`${omarcy}:t3_project_list`, `${omarcy}:t3_thread_list`]);
    expect(result.environments.map((environment) => environment.label)).toEqual(["omarcy-desktop"]);
    expect(result.environments[0]?.threads.map((thread) => thread.title)).toEqual([
      "10-model copy eval",
    ]);
    expect(result.environments[0]?.threads[0]?.inbox?.owner).toBe("jeff");
  }),
);
