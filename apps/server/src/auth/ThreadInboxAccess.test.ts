import {
  WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  inboxIdentitySubject,
  type InboxIdentity,
  type ThreadInbox,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { threadInboxAccess, inboxRpcAllowed, inboxHttpAllowed } from "./ThreadInboxAccess.ts";
const environmentId = EnvironmentId.make("destination");
const actor = { kind: "human", id: "kameron" } as const;
const identity: InboxIdentity = { actor, delegatesTo: [], operational: false };
const inbox: ThreadInbox = {
  actor,
  requestedBy: actor,
  assignee: actor,
  audience: "kameron",
  attentionKind: "action",
  executorEnvironmentId: environmentId,
};
const threadId = ThreadId.make("thread");
const createdAt = "2026-11-15T00:00:00.000Z";
const create = {
  type: "thread.create",
  commandId: CommandId.make("create"),
  threadId,
  projectId: ProjectId.make("synthetic"),
  title: "Synthetic",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt,
} as const;
const shell = (routing: ThreadInbox | null): OrchestrationThreadShell => ({
  ...create,
  id: threadId,
  inbox: routing,
  updatedAt: createdAt,
  latestTurn: null,
  pullRequests: [],
  session: null,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
describe("destination inbox authorization", () => {
  it.effect("denies guessed IDs, legacy unknowns, foreign writes and revoked access", () =>
    Effect.gen(function* () {
      let current = Option.some(shell(inbox));
      const query = {
        getThreadShellById: (id: ThreadId) =>
          Effect.succeed(id === threadId ? current : Option.none()),
      };
      const access = threadInboxAccess(inboxIdentitySubject(identity), query);
      yield* access.requireThread(threadId);
      expect((yield* Effect.result(access.requireThread(ThreadId.make("guessed"))))._tag).toBe(
        "Failure",
      );
      current = Option.some(shell({ ...inbox, audience: "jeff" }));
      expect((yield* Effect.result(access.requireThread(threadId)))._tag).toBe("Failure");
      expect(
        (yield* Effect.result(
          access.prepareCommand(
            { type: "thread.delete", commandId: CommandId.make("delete"), threadId },
            environmentId,
          ),
        ))._tag,
      ).toBe("Failure");
      current = Option.some(shell(null));
      expect((yield* Effect.result(access.requireThread(threadId)))._tag).toBe("Failure");
    }),
  );
  it.effect(
    "stamps authenticated immutable provenance and actual executor, ignoring forged input",
    () =>
      Effect.gen(function* () {
        const access = threadInboxAccess(inboxIdentitySubject(identity), {
          getThreadShellById: () => Effect.succeed(Option.none()),
        });
        const prepared = yield* access.prepareCommand(
          {
            ...create,
            inbox: {
              ...inbox,
              requestedBy: { kind: "human", id: "jeff" },
              executorEnvironmentId: EnvironmentId.make("forged"),
            },
          },
          environmentId,
        );
        expect(prepared.type).toBe("thread.create");
        expect("inbox" in prepared && prepared.inbox).toEqual(inbox);
        expect("executionScope" in prepared && prepared.executionScope).toBe("coordinator");
        const foreign = yield* Effect.result(
          access.prepareCommand(
            {
              ...create,
              inboxRouting: {
                assignee: { kind: "human", id: "jeff" },
                audience: "jeff",
                attentionKind: "action",
              },
            },
            environmentId,
          ),
        );
        expect(foreign._tag).toBe("Failure");
      }),
  );
  it.effect("rejects provenance injection by an unbound host session", () =>
    Effect.gen(function* () {
      const access = threadInboxAccess("one-time-token", {
        getThreadShellById: () => Effect.succeed(Option.none()),
      });
      expect(
        (yield* Effect.result(access.prepareCommand({ ...create, inbox }, environmentId)))._tag,
      ).toBe("Failure");
      expect(yield* access.prepareCommand(create, environmentId)).toEqual(create);
    }),
  );
  it("denies host file, terminal, attachment and alternate transport bypasses", () => {
    const subject = inboxIdentitySubject(identity);
    for (const method of [
      WS_METHODS.projectsReadFile,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.filesystemBrowse,
      WS_METHODS.terminalOpen,
      WS_METHODS.assetsCreateUrl,
      WS_METHODS.attachmentsDelete,
    ]) {
      expect(inboxRpcAllowed(subject, method)).toBe(false);
    }
    expect(inboxRpcAllowed(subject, ORCHESTRATION_WS_METHODS.subscribeThread)).toBe(true);
    expect(inboxHttpAllowed(subject, "/api/projects/read-file")).toBe(false);
    expect(inboxHttpAllowed(subject, "/api/auth/pairing-credential")).toBe(false);
    expect(inboxHttpAllowed(subject, "/api/orchestration/threads/guessed")).toBe(true);
    expect(inboxRpcAllowed(subject, "future-unknown-host-method")).toBe(false);
  });
  it.effect(
    "rechecks visibility after reassignment and reconnect instead of trusting a prior grant",
    () =>
      Effect.gen(function* () {
        let current = shell(inbox);
        const query = { getThreadShellById: () => Effect.succeed(Option.some(current)) };
        const subject = inboxIdentitySubject(identity);
        yield* threadInboxAccess(subject, query).requireThread(threadId);
        current = shell({ ...inbox, audience: "jeff" });
        expect(
          (yield* Effect.result(threadInboxAccess(subject, query).requireThread(threadId)))._tag,
        ).toBe("Failure");
        expect(
          threadInboxAccess(subject, query).filterSnapshot({
            threads: [current],
            projects: [{ id: current.projectId }],
          }).threads,
        ).toEqual([]);
      }),
  );
  it.effect("keeps an authenticated original requester separate from the acting agent", () =>
    Effect.gen(function* () {
      const delegated: InboxIdentity = {
        actor: { kind: "agent", id: "lead" },
        requestedBy: actor,
        delegatesTo: ["jeff"],
        operational: false,
      };
      const access = threadInboxAccess(inboxIdentitySubject(delegated), {
        getThreadShellById: () => Effect.succeed(Option.none()),
      });
      const prepared = yield* access.prepareCommand(
        {
          ...create,
          inboxRouting: {
            assignee: { kind: "human", id: "jeff" },
            audience: "jeff",
            attentionKind: "FYI",
          },
        },
        environmentId,
      );
      expect("inbox" in prepared && prepared.inbox).toMatchObject({
        requestedBy: actor,
        actor: { kind: "agent", id: "lead" },
        assignee: { kind: "human", id: "jeff" },
        executorEnvironmentId: environmentId,
      });
    }),
  );
});
