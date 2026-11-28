import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";

it.effect.each([false, true])(
  "reconciles shared worktree branches without changing root checkouts or detached HEADs, conflict=%s",
  (conflict) => {
    const reconciled = Deferred.makeUnsafe<void>();
    const commands: OrchestrationV2ServerCommand[] = [];
    const thread = (id: string, branch: string, worktreePath: string | null) =>
      ({ id: ThreadId.make(id), branch, worktreePath }) as OrchestrationV2ThreadShell;
    const snapshot = {
      schemaVersion: 2,
      snapshotSequence: 0,
      threads: [
        thread("generated", "t3/unify-converter-branches", "/worktree"),
        thread("shared", "t3/bfc349ae", "/link/worktree"),
        thread("current", "union", "/worktree"),
        thread("root", "main", null),
        thread("other", "feature", "/other"),
      ],
      archivedThreads: [thread("archived", "t3/bfc349ae", "/worktree")],
    };
    return Effect.gen(function* () {
      yield* Layer.build(WorktreeBranchSync.layer);
      yield* Deferred.await(reconciled);
      assert.deepEqual(
        commands.map((command) => {
          assert.equal(command.type, "thread.metadata.update");
          if (command.type !== "thread.metadata.update") throw new Error("Unexpected command");
          return [
            command.threadId,
            command.branch,
            command.expectedBranch,
            command.expectedWorktreePath,
          ];
        }),
        [
          ["generated", "union", "t3/unify-converter-branches", "/worktree"],
          ["shared", "union", "t3/bfc349ae", "/link/worktree"],
          ["archived", "union", "t3/bfc349ae", "/worktree"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            realPath: (path) => Effect.succeed(path === "/link/worktree" ? "/worktree" : path),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.succeed(
                [...snapshot.threads, ...snapshot.archivedThreads].flatMap((thread) =>
                  thread.worktreePath === null
                    ? []
                    : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
                ),
              ),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            streamBranchChanges: Stream.fromIterable([null, "t3/bfc349ae", "union"]).pipe(
              Stream.map((refName) => ({
                cwd: "/worktree",
                refName,
              })),
              Stream.ensuring(Deferred.succeed(reconciled, undefined)),
            ),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            currentBranch: () => Effect.succeed("union"),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () => Effect.succeed(snapshot),
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                if (
                  command.type === "thread.metadata.update" &&
                  command.threadId === ThreadId.make("generated") &&
                  conflict
                ) {
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Thread moved before branch metadata could be applied.",
                  });
                }
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect(
  "reconciles detached HEAD when the worktree exists and clears stale branch metadata",
  () => {
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> = [
      {
        id: ThreadId.make("detached-thread"),
        branch: "feature/stale",
        worktreePath: "/worktree",
      } as OrchestrationV2ThreadShell,
    ];
    const commands: OrchestrationV2ServerCommand[] = [];
    return Effect.gen(function* () {
      const reconcile = yield* WorktreeBranchSync.makeReconcile;
      yield* reconcile({ cwd: "/worktree", refName: null });
      assert.deepEqual(
        commands.map((command) => {
          assert.equal(command.type, "thread.metadata.update");
          if (command.type !== "thread.metadata.update") throw new Error("Unexpected command");
          return [
            command.threadId,
            command.branch,
            command.expectedBranch,
            command.expectedWorktreePath,
          ];
        }),
        [["detached-thread", null, "feature/stale", "/worktree"]],
      );
      assert.equal(threads[0]?.branch, null);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            realPath: (path) => Effect.succeed(path),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.succeed([
                { threadId: ThreadId.make("detached-thread"), worktreePath: "/worktree" },
              ]),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            repositoryRoot: (cwd) => Effect.succeed(cwd),
            currentBranch: () => Effect.succeed(null),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads,
                archivedThreads: [],
              }),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                if (command.type === "thread.metadata.update" && command.branch !== undefined) {
                  const branch = command.branch;
                  threads = threads.map((thread) =>
                    thread.id === command.threadId && thread.branch === command.expectedBranch
                      ? { ...thread, branch }
                      : thread,
                  );
                }
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect("ignores detached HEAD events when the worktree directory does not exist", () => {
  const commands: OrchestrationV2ServerCommand[] = [];
  const threads: ReadonlyArray<OrchestrationV2ThreadShell> = [
    {
      id: ThreadId.make("missing-worktree"),
      branch: "feature/stale",
      worktreePath: "/worktree",
    } as OrchestrationV2ThreadShell,
  ];
  return Effect.gen(function* () {
    const reconcile = yield* WorktreeBranchSync.makeReconcile;
    yield* reconcile({ cwd: "/worktree", refName: null });
    assert.deepEqual(commands, []);
    assert.equal(threads[0]?.branch, "feature/stale");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(false),
          realPath: (path) => Effect.succeed(path),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed([
              { threadId: ThreadId.make("missing-worktree"), worktreePath: "/worktree" },
            ]),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          currentBranch: () => Effect.succeed(null),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads,
              archivedThreads: [],
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      ),
    ),
  );
});

it.effect(
  "ignores detached HEAD events when the worktree directory is no longer a repository",
  () => {
    const commands: OrchestrationV2ServerCommand[] = [];
    return Effect.gen(function* () {
      const reconcile = yield* WorktreeBranchSync.makeReconcile;
      yield* reconcile({ cwd: "/worktree", refName: null });
      assert.deepEqual(commands, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            realPath: (path) => Effect.succeed(path),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.succeed([
                { threadId: ThreadId.make("pruned-worktree"), worktreePath: "/worktree" },
              ]),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            repositoryRoot: () => Effect.succeed(null),
            currentBranch: () => Effect.succeed(null),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [
                  {
                    id: ThreadId.make("pruned-worktree"),
                    branch: "feature/kept",
                    worktreePath: "/worktree",
                  } as OrchestrationV2ThreadShell,
                ],
                archivedThreads: [],
              }),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
  },
);
