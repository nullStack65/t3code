// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures verify filesystem identity.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, afterEach } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  qualifyThreadWorktree,
  qualifyCoordinatorWorkspace,
  rejectConflictingWorktree,
  safeThreadPathSegment,
} from "./ThreadWorktree.ts";

const roots: string[] = [];
const testServices = (environmentId = "worktree-test-environment") =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
    }),
  );
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fixture = () => {
  const container = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-policy-")),
  );
  roots.push(container);
  const root = NodePath.join(container, "repo");
  NodeFS.mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "accepted bytes\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "fixture");
  return root;
};
const add = (root: string, name: string) => {
  const worktreePath = NodePath.join(root, "..", name);
  git(root, "worktree", "add", "-b", name, worktreePath, "main");
  return { threadId: name, projectCwd: root, branch: name, worktreePath };
};
const isFailureContaining = (exit: Exit.Exit<unknown, unknown>, text: string) =>
  Exit.isFailure(exit) && String(exit.cause).includes(text);

afterEach(() => {
  for (const root of roots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.effect("refuses ownership claims when the server environment identity is unavailable", () =>
  Effect.gen(function* () {
    const root = fixture();
    const binding = add(root, "missing-environment-identity");
    const failure = yield* Effect.exit(qualifyThreadWorktree(binding, { claimWorktree: true }));
    expect(isFailureContaining(failure, "environment identity is unavailable")).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("destination-local coding worktrees", () => {
  it("encodes arbitrary thread ids as safe single path and branch segments", () => {
    const segment = safeThreadPathSegment("../../repo/name\\with space");
    expect(segment).toMatch(/^id-[0-9a-f-]+$/);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("..");
  });

  it.effect("qualifies concurrent distinct claims and reuses the same assignment", () =>
    Effect.gen(function* () {
      const root = fixture();
      const a = add(root, "thread-a");
      const b = add(root, "thread-b");
      const [qa, qb] = yield* Effect.all(
        [a, b].map((input) => qualifyThreadWorktree(input, { claimWorktree: true })),
        { concurrency: "unbounded" },
      );
      expect(qa!.commonDir).toBe(qb!.commonDir);
      expect(qa!.worktreePath).not.toBe(qb!.worktreePath);
      NodeFS.writeFileSync(NodePath.join(a.worktreePath, "own-effect.txt"), "thread-a\n");
      expect(yield* qualifyThreadWorktree(a)).toEqual(qa);
      expect(git(root, "status", "--porcelain")).not.toContain("own-effect");
      expect(git(b.worktreePath, "status", "--porcelain")).not.toContain("own-effect");
    }).pipe(Effect.provide(testServices())),
  );

  it.effect("rejects shared checkout, wrong repo, wrong branch, stale and foreign attach", () =>
    Effect.gen(function* () {
      const root = fixture();
      const other = fixture();
      const a = add(root, "thread-a");
      yield* qualifyThreadWorktree(a, { claimWorktree: true });
      for (const input of [
        { ...a, worktreePath: root, branch: "main" },
        { ...a, projectCwd: other },
        { ...a, branch: "other" },
        { ...a, worktreePath: NodePath.join(root, "missing") },
        { ...a, threadId: "foreign" },
      ]) {
        const failure = yield* Effect.exit(qualifyThreadWorktree(input));
        expect(Exit.isFailure(failure)).toBe(true);
      }
      const unclaimed = add(root, "unclaimed");
      const unclaimedFailure = yield* Effect.exit(qualifyThreadWorktree(unclaimed));
      expect(Exit.isFailure(unclaimedFailure)).toBe(true);
      git(root, "worktree", "lock", a.worktreePath);
      const locked = yield* Effect.exit(qualifyThreadWorktree(a));
      expect(isFailureContaining(locked, "locked")).toBe(true);
    }).pipe(Effect.provide(testServices())),
  );

  it.effect("rejects concurrent ownership through symlink aliases without overwriting", () =>
    Effect.gen(function* () {
      const root = fixture();
      const a = add(root, "thread-a");
      yield* qualifyThreadWorktree(a, { claimWorktree: true });
      const alias = NodePath.join(root, "alias");
      NodeFS.symlinkSync(a.worktreePath, alias, "junction");
      const conflict = yield* Effect.exit(
        rejectConflictingWorktree("foreign", alias, [
          { id: a.threadId, worktreePath: a.worktreePath, deletedAt: null },
        ]),
      );
      expect(isFailureContaining(conflict, "already bound")).toBe(true);
      const foreign = yield* Effect.exit(
        qualifyThreadWorktree({ ...a, threadId: "foreign" }, { claimWorktree: true }),
      );
      expect(Exit.isFailure(foreign)).toBe(true);
      expect(yield* qualifyThreadWorktree(a)).toBeDefined();
    }).pipe(Effect.provide(testServices())),
  );

  it.effect("binds an owner marker to the stable server environment identity", () =>
    Effect.gen(function* () {
      const root = fixture();
      const binding = add(root, "environment-bound");
      yield* qualifyThreadWorktree(binding, { claimWorktree: true });
      const otherEnvironment = yield* Effect.exit(
        qualifyThreadWorktree(binding, { claimWorktree: true }).pipe(
          Effect.provide(testServices("different-worktree-environment")),
        ),
      );
      expect(isFailureContaining(otherEnvironment, "belongs to another thread")).toBe(true);
      expect(yield* qualifyThreadWorktree(binding)).toBeDefined();
    }).pipe(Effect.provide(testServices())),
  );

  it.effect("preserves a dirty canonical checkout's tracked and untracked bytes", () =>
    Effect.gen(function* () {
      const root = fixture();
      NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "active unsaved work\n");
      NodeFS.writeFileSync(NodePath.join(root, "untracked.txt"), "user work\n");
      const before = git(root, "status", "--porcelain");
      const head = git(root, "rev-parse", "HEAD");
      const a = add(root, "thread-a");
      yield* qualifyThreadWorktree(a, { claimWorktree: true });
      expect(NodeFS.readFileSync(NodePath.join(root, "tracked.txt"), "utf8")).toBe(
        "active unsaved work\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(root, "untracked.txt"), "utf8")).toBe("user work\n");
      expect(git(root, "status", "--porcelain")).toBe(before);
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
    }).pipe(Effect.provide(testServices())),
  );
});

describe("coordinator workspace boundary", () => {
  it.effect("requires an existing workspace outside the project checkout", () =>
    Effect.gen(function* () {
      const root = fixture();
      const workspace = NodePath.join(root, "..", "coordinator-workspace");
      NodeFS.mkdirSync(workspace);
      expect(
        yield* qualifyCoordinatorWorkspace(root, workspace, "coordinator-a", {
          claimWorkspace: true,
        }),
      ).toBe(NodeFS.realpathSync(workspace));
      const otherEnvironment = yield* Effect.exit(
        qualifyCoordinatorWorkspace(root, workspace, "coordinator-a").pipe(
          Effect.provide(testServices("different-coordinator-environment")),
        ),
      );
      expect(isFailureContaining(otherEnvironment, "belongs to another thread")).toBe(true);
      const foreign = yield* Effect.exit(
        qualifyCoordinatorWorkspace(root, workspace, "coordinator-b"),
      );
      expect(isFailureContaining(foreign, "belongs to another thread")).toBe(true);
      const nested = NodePath.join(root, "nested-coordinator");
      NodeFS.mkdirSync(nested);
      const dotPrefix = NodePath.join(root, "..foo-coordinator");
      NodeFS.mkdirSync(dotPrefix);
      for (const path of [root, nested, dotPrefix]) {
        const rejected = yield* Effect.exit(qualifyCoordinatorWorkspace(root, path, "nested"));
        expect(isFailureContaining(rejected, "separate from the project checkout")).toBe(true);
      }
      const missing = yield* Effect.exit(qualifyCoordinatorWorkspace(root, null, "missing"));
      expect(isFailureContaining(missing, "dedicated destination-local workspace")).toBe(true);
    }).pipe(Effect.provide(testServices())),
  );
});
