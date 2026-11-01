// @effect-diagnostics nodeBuiltinImport:off - real disposable repository/provider-cwd acceptance.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { qualifyThreadWorktree } from "../src/project/ThreadWorktree.ts";

const at = "2026-10-02T00:00:00.000Z";
const projectId = ProjectId.make("isolation-project");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" };
const integrationEnvironmentId = EnvironmentId.make("integration-test-environment");
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

it.live("rejects an unbound coding thread before persistence or any provider launch", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    (harness) =>
      Effect.gen(function* () {
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Fixture",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: selection,
          createdAt: at,
        });
        const threadId = ThreadId.make("unbound-coding");
        const before = yield* harness.engine.latestSequence;
        const outcome = yield* Effect.exit(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-unbound"),
            threadId,
            projectId,
            title: "Coding",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: at,
          }),
        );
        assert.isTrue(Exit.isFailure(outcome));
        assert.equal(yield* harness.engine.latestSequence, before);
        assert.equal(harness.adapterHarness!.getStartCount(), 0);
        const thread = yield* harness.snapshotQuery.getThreadDetailById(threadId);
        assert.isTrue(Option.isNone(thread));
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "two coding threads execute file effects only in their owned worktrees and resume the same cwd",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness(),
      (harness) =>
        Effect.gen(function* () {
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("project"),
            projectId,
            title: "Fixture",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: selection,
            createdAt: at,
          });
          const bindings = ["coding-a", "coding-b"].map((name) => {
            const worktreePath = NodePath.join(harness.rootDir, name);
            git(harness.workspaceDir, "worktree", "add", "-b", name, worktreePath, "main");
            return {
              threadId: ThreadId.make(name),
              projectCwd: harness.workspaceDir,
              branch: name,
              worktreePath,
            };
          });
          for (const binding of bindings) {
            yield* qualifyThreadWorktree(binding, {
              claimWorktree: true,
              environmentId: integrationEnvironmentId,
            });
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create-${binding.threadId}`),
              threadId: binding.threadId,
              projectId,
              title: binding.threadId,
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              executionScope: "coding",
              branch: binding.branch,
              worktreePath: binding.worktreePath,
              createdAt: at,
            });
          }
          const start = (threadId: ThreadId, suffix: string) =>
            harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`turn-${threadId}-${suffix}`),
              threadId,
              message: {
                messageId: MessageId.make(`message-${threadId}-${suffix}`),
                role: "user",
                text: "fixture effect",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: at,
            });
          const response = {
            events: [
              {
                type: "turn.completed",
                eventId: EventId.make("unused"),
                provider: ProviderDriverKind.make("codex"),
                createdAt: at,
                threadId: ThreadId.make("unused"),
                turnId: TurnId.make("unused"),
                payload: { state: "completed" },
              },
            ],
            mutateWorkspace: ({ cwd }: { cwd: string }) =>
              Effect.sync(() =>
                NodeFS.writeFileSync(NodePath.join(cwd, "provider-effect.txt"), cwd),
              ),
          };
          yield* Effect.forEach(
            bindings,
            (binding) =>
              harness.adapterHarness!.queueTurnResponseForThreadStart(
                binding.threadId,
                response as Parameters<
                  NonNullable<typeof harness.adapterHarness>["queueTurnResponseForThreadStart"]
                >[1],
              ),
            { concurrency: "unbounded" },
          );
          yield* Effect.forEach(bindings, (binding) => start(binding.threadId, "first"), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(
            bindings,
            (binding) =>
              harness.waitForReceipt(
                (receipt) =>
                  receipt.type === "turn.processing.quiesced" &&
                  receipt.threadId === binding.threadId,
              ),
            { concurrency: "unbounded" },
          );
          const sessions = yield* harness.providerService.listSessions();
          assert.equal(harness.adapterHarness!.getStartCount(), 2);
          for (const binding of bindings) {
            assert.equal(
              sessions.find((session) => session.threadId === binding.threadId)?.cwd,
              binding.worktreePath,
            );
            assert.equal(
              NodeFS.readFileSync(
                NodePath.join(binding.worktreePath, "provider-effect.txt"),
                "utf8",
              ),
              binding.worktreePath,
            );
          }
          assert.isFalse(
            NodeFS.existsSync(NodePath.join(harness.workspaceDir, "provider-effect.txt")),
          );
          const a = bindings[0]!;
          yield* harness.adapterHarness!.queueTurnResponse(
            a.threadId,
            response as Parameters<
              NonNullable<typeof harness.adapterHarness>["queueTurnResponse"]
            >[1],
          );
          yield* start(a.threadId, "resume");
          yield* harness.waitForReceipt(
            (receipt) =>
              receipt.type === "turn.processing.quiesced" &&
              receipt.threadId === a.threadId &&
              receipt.checkpointTurnCount === 2,
          );
          assert.equal(harness.adapterHarness!.getStartCount(), 2);
          assert.equal(
            NodeFS.readFileSync(NodePath.join(a.worktreePath, "provider-effect.txt"), "utf8"),
            a.worktreePath,
          );
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "refuses turns after the assigned worktree disappears without touching the shared checkout",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness(),
      (harness) =>
        Effect.gen(function* () {
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("project-removed-worktree"),
            projectId,
            title: "Fixture",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: selection,
            createdAt: at,
          });
          const worktreePath = NodePath.join(harness.rootDir, "removed-assignment");
          git(
            harness.workspaceDir,
            "worktree",
            "add",
            "-b",
            "removed-assignment",
            worktreePath,
            "main",
          );
          const threadId = ThreadId.make("removed-assignment");
          yield* qualifyThreadWorktree(
            {
              threadId,
              projectCwd: harness.workspaceDir,
              branch: "removed-assignment",
              worktreePath,
            },
            { claimWorktree: true, environmentId: integrationEnvironmentId },
          );
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-removed-assignment"),
            threadId,
            projectId,
            title: "Assigned coding thread",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            executionScope: "coding",
            branch: "removed-assignment",
            worktreePath,
            createdAt: at,
          });
          NodeFS.writeFileSync(
            NodePath.join(harness.workspaceDir, "user-checkout-data.txt"),
            "keep these bytes\n",
          );
          const before = yield* harness.engine.latestSequence;
          git(harness.workspaceDir, "worktree", "remove", "--force", worktreePath);
          const outcome = yield* Effect.exit(
            harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("turn-missing-assignment"),
              threadId,
              message: {
                messageId: MessageId.make("message-missing-assignment"),
                role: "user",
                text: "must fail before provider launch",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: at,
            }),
          );
          assert.isTrue(Exit.isFailure(outcome));
          assert.equal(yield* harness.engine.latestSequence, before);
          assert.equal(harness.adapterHarness!.getStartCount(), 0);
          assert.isFalse(
            NodeFS.existsSync(NodePath.join(harness.workspaceDir, "must-not-run.txt")),
          );
          assert.equal(
            NodeFS.readFileSync(
              NodePath.join(harness.workspaceDir, "user-checkout-data.txt"),
              "utf8",
            ),
            "keep these bytes\n",
          );
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a second coding thread attaching to an already owned worktree", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    (harness) =>
      Effect.gen(function* () {
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project-attach"),
          projectId,
          title: "Fixture",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: selection,
          createdAt: at,
        });
        const worktreePath = NodePath.join(harness.rootDir, "shared-worktree");
        git(harness.workspaceDir, "worktree", "add", "-b", "shared", worktreePath, "main");
        const binding = {
          threadId: ThreadId.make("owner-thread"),
          projectCwd: harness.workspaceDir,
          branch: "shared",
          worktreePath,
        };
        yield* qualifyThreadWorktree(binding, {
          claimWorktree: true,
          environmentId: integrationEnvironmentId,
        });
        const create = (threadId: ThreadId, commandId: string) =>
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId,
            title: String(threadId),
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            executionScope: "coding",
            branch: binding.branch,
            worktreePath,
            createdAt: at,
          });
        yield* create(binding.threadId, "create-owner");
        const duplicate = yield* Effect.exit(
          create(ThreadId.make("second-owner"), "create-duplicate"),
        );
        assert.isTrue(Exit.isFailure(duplicate));
        assert.equal(harness.adapterHarness!.getStartCount(), 0);
        const thread = yield* harness.snapshotQuery.getThreadDetailById(
          ThreadId.make("second-owner"),
        );
        assert.isTrue(Option.isNone(thread));
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does not claim a second worktree when a live thread id is reused", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    (harness) =>
      Effect.gen(function* () {
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project-duplicate-thread-id"),
          projectId,
          title: "Fixture",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: selection,
          createdAt: at,
        });
        const firstPath = NodePath.join(harness.rootDir, "duplicate-id-first");
        const secondPath = NodePath.join(harness.rootDir, "duplicate-id-second");
        git(harness.workspaceDir, "worktree", "add", "-b", "duplicate-id-first", firstPath, "main");
        git(
          harness.workspaceDir,
          "worktree",
          "add",
          "-b",
          "duplicate-id-second",
          secondPath,
          "main",
        );
        const threadId = ThreadId.make("duplicate-live-thread");
        yield* qualifyThreadWorktree(
          {
            threadId,
            projectCwd: harness.workspaceDir,
            branch: "duplicate-id-first",
            worktreePath: firstPath,
          },
          { claimWorktree: true, environmentId: integrationEnvironmentId },
        );
        const create = (branch: string, worktreePath: string, commandId: string) =>
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId,
            title: "Coding",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            executionScope: "coding",
            branch,
            worktreePath,
            createdAt: at,
          });
        yield* create("duplicate-id-first", firstPath, "create-first-duplicate-id");
        const secondGitDir = git(secondPath, "rev-parse", "--absolute-git-dir");
        const secondOwnerMarker = NodePath.join(secondGitDir, "t3-thread-owner.json");
        assert.isFalse(NodeFS.existsSync(secondOwnerMarker));
        const duplicate = yield* Effect.exit(
          create("duplicate-id-second", secondPath, "create-second-duplicate-id"),
        );
        assert.isTrue(Exit.isFailure(duplicate));
        assert.isFalse(NodeFS.existsSync(secondOwnerMarker));
        assert.equal(harness.adapterHarness!.getStartCount(), 0);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a legacy shared-checkout owner before writing a worktree claim", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    (harness) =>
      Effect.gen(function* () {
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project-legacy-owner"),
          projectId,
          title: "Fixture",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: selection,
          createdAt: at,
        });
        const worktreePath = NodePath.join(harness.rootDir, "legacy-shared-worktree");
        git(harness.workspaceDir, "worktree", "add", "-b", "legacy-shared", worktreePath, "main");
        const gitDir = git(worktreePath, "rev-parse", "--absolute-git-dir");
        const ownerMarker = NodePath.join(gitDir, "t3-thread-owner.json");
        assert.isFalse(NodeFS.existsSync(ownerMarker));
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-legacy-owner"),
          threadId: ThreadId.make("legacy-owner"),
          projectId,
          title: "Legacy",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "legacy-shared",
          worktreePath,
          historyImport: true,
          createdAt: at,
        });
        const attach = yield* Effect.exit(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-coding-conflict"),
            threadId: ThreadId.make("coding-conflict"),
            projectId,
            title: "Coding",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            executionScope: "coding",
            branch: "legacy-shared",
            worktreePath,
            createdAt: at,
          }),
        );
        assert.isTrue(Exit.isFailure(attach));
        assert.isFalse(NodeFS.existsSync(ownerMarker));
        assert.equal(harness.adapterHarness!.getStartCount(), 0);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
