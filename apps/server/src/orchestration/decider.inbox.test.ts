import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("thread inbox routing", (it) => {
  it.effect("copies owner, type, and starter onto the created event", () =>
    Effect.gen(function* () {
      const createdAt = "2026-11-14T08:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      const created = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-create"),
          threadId: ThreadId.make("thread-1"),
          projectId,
          title: "Shared pool",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          owner: "Kameron",
          threadType: "needs-human",
          startedBy: "Lead",
          createdAt,
        },
        readModel,
      });
      expect(created).toMatchObject({
        type: "thread.created",
        payload: { owner: "Kameron", threadType: "needs-human", startedBy: "Lead" },
      });
    }),
  );

  it.effect("retags an existing thread without dropping the starter", () =>
    Effect.gen(function* () {
      const createdAt = "2026-11-14T08:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: EventId.make("event-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-create"),
        causationEventId: null,
        correlationId: CommandId.make("command-create"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Shared pool",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          owner: "Kameron",
          threadType: "needs-human",
          startedBy: "Lead",
          createdAt,
          updatedAt: createdAt,
        },
      });
      expect(readModel.threads[0]).toMatchObject({
        owner: "Kameron",
        threadType: "needs-human",
        startedBy: "Lead",
      });

      const updated = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-update"),
          threadId,
          threadType: "bot-work",
          owner: null,
        },
        readModel,
      });
      expect(updated).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadType: "bot-work", owner: null },
      });
    }),
  );
});
