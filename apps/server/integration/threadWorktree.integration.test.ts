// @effect-diagnostics nodeBuiltinImport:off - real disposable repository/provider-cwd acceptance.
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { CommandId, ProjectId, ThreadId, MessageId, ProviderInstanceId } from "@t3tools/contracts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { qualifyThreadWorktree } from "../src/project/ThreadWorktree.ts";

const at = "2026-10-02T00:00:00.000Z";
const projectId = ProjectId.make("isolation-project");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

it.live(
  "rejects an unbound coding turn before ingesting its message or starting any provider",
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
          const threadId = ThreadId.make("unbound-coding");
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            title: "Coding",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            executionScope: "coding",
            branch: null,
            worktreePath: null,
            createdAt: at,
          });
          const before = yield* harness.engine.latestSequence;
          const outcome = yield* Effect.exit(
            harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("unsafe-turn"),
              threadId,
              message: {
                messageId: MessageId.make("unsafe-message"),
                role: "user",
                text: "edit",
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
          const thread = yield* harness.snapshotQuery.getThreadDetailById(threadId);
          assert.equal(Option.getOrThrow(thread).messages.length, 0);
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
            const worktreePath = join(harness.rootDir, name);
            git(harness.workspaceDir, "worktree", "add", "-b", name, worktreePath, "main");
            return {
              threadId: ThreadId.make(name),
              projectCwd: harness.workspaceDir,
              branch: name,
              worktreePath,
            };
          });
          for (const binding of bindings) {
            yield* qualifyThreadWorktree(binding, { claimCreatedWorktree: true });
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
                threadId: "unused",
                turnId: "unused",
                payload: { state: "completed" },
              },
            ],
            mutateWorkspace: ({ cwd }: { cwd: string }) =>
              Effect.sync(() => writeFileSync(join(cwd, "provider-effect.txt"), cwd)),
          };
          for (const binding of bindings) {
            yield* harness.adapterHarness!.queueTurnResponseForNextSession(
              response as Parameters<
                NonNullable<typeof harness.adapterHarness>["queueTurnResponseForNextSession"]
              >[0],
            );
            yield* start(binding.threadId, "first");
            yield* harness.waitForReceipt(
              (receipt) =>
                receipt.type === "turn.processing.quiesced" &&
                receipt.threadId === binding.threadId,
            );
          }
          const sessions = yield* harness.providerService.listSessions();
          assert.equal(harness.adapterHarness!.getStartCount(), 2);
          for (const binding of bindings) {
            assert.equal(
              sessions.find((session) => session.threadId === binding.threadId)?.cwd,
              binding.worktreePath,
            );
            assert.equal(
              readFileSync(join(binding.worktreePath, "provider-effect.txt"), "utf8"),
              binding.worktreePath,
            );
          }
          assert.isFalse(existsSync(join(harness.workspaceDir, "provider-effect.txt")));
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
            readFileSync(join(a.worktreePath, "provider-effect.txt"), "utf8"),
            a.worktreePath,
          );
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
