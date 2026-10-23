// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures verify filesystem identity.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { qualifyThreadWorktree, rejectConflictingWorktree } from "./ThreadWorktree.ts";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fixture = () => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "t3-worktree-policy-")));
  roots.push(container);
  const root = join(container, "repo");
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "accepted bytes\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "fixture");
  return root;
};
const add = (root: string, name: string) => {
  const worktreePath = join(root, "..", name);
  git(root, "worktree", "add", "-b", name, worktreePath, "main");
  return { threadId: name, projectCwd: root, branch: name, worktreePath };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("destination-local coding worktrees", () => {
  it("qualifies two concurrent distinct claims and reuses the same assignment without rebinding", async () => {
    const root = fixture();
    const a = add(root, "thread-a");
    const b = add(root, "thread-b");
    const [qa, qb] = await Promise.all(
      [a, b].map((input) =>
        Effect.runPromise(qualifyThreadWorktree(input, { claimCreatedWorktree: true })),
      ),
    );
    expect(qa!.commonDir).toBe(qb!.commonDir);
    expect(qa!.worktreePath).not.toBe(qb!.worktreePath);
    writeFileSync(join(a.worktreePath, "own-effect.txt"), "thread-a\n");
    expect(await Effect.runPromise(qualifyThreadWorktree(a))).toEqual(qa);
    expect(git(root, "status", "--porcelain")).not.toContain("own-effect");
    expect(git(b.worktreePath, "status", "--porcelain")).not.toContain("own-effect");
  });
  it("rejects shared checkout, wrong repo, wrong branch, stale and foreign attach", async () => {
    const root = fixture();
    const other = fixture();
    const a = add(root, "thread-a");
    await Effect.runPromise(qualifyThreadWorktree(a, { claimCreatedWorktree: true }));
    for (const input of [
      { ...a, worktreePath: root, branch: "main" },
      { ...a, projectCwd: other },
      { ...a, branch: "other" },
      { ...a, worktreePath: join(root, "missing") },
      { ...a, threadId: "foreign" },
    ])
      await expect(Effect.runPromise(qualifyThreadWorktree(input))).rejects.toThrow();
    const unclaimed = add(root, "unclaimed");
    await expect(Effect.runPromise(qualifyThreadWorktree(unclaimed))).rejects.toThrow();
    git(root, "worktree", "lock", a.worktreePath);
    await expect(Effect.runPromise(qualifyThreadWorktree(a))).rejects.toThrow("locked");
  });
  it("rejects concurrent ownership through a symlink alias and never overwrites a claim", async () => {
    const root = fixture();
    const a = add(root, "thread-a");
    await Effect.runPromise(qualifyThreadWorktree(a, { claimCreatedWorktree: true }));
    const alias = join(root, "alias");
    symlinkSync(a.worktreePath, alias, "junction");
    await expect(
      Effect.runPromise(
        rejectConflictingWorktree("foreign", alias, [
          { id: a.threadId, worktreePath: a.worktreePath, deletedAt: null },
        ]),
      ),
    ).rejects.toThrow("already bound");
    await expect(
      Effect.runPromise(
        qualifyThreadWorktree({ ...a, threadId: "foreign" }, { claimCreatedWorktree: true }),
      ),
    ).rejects.toThrow();
    await Effect.runPromise(qualifyThreadWorktree(a));
  });
  it("allocation and qualification preserve a dirty canonical checkout's tracked and untracked bytes", async () => {
    const root = fixture();
    writeFileSync(join(root, "tracked.txt"), "active unsaved work\n");
    writeFileSync(join(root, "untracked.txt"), "user work\n");
    const before = git(root, "status", "--porcelain");
    const head = git(root, "rev-parse", "HEAD");
    const a = add(root, "thread-a");
    await Effect.runPromise(qualifyThreadWorktree(a, { claimCreatedWorktree: true }));
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("active unsaved work\n");
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("user work\n");
    expect(git(root, "status", "--porcelain")).toBe(before);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
});
