import * as NodeServices from "@effect/platform-node/NodeServices";
import * as VcsProcessLayer from "../vcs/VcsProcess.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsProcess } from "../vcs/VcsProcess.ts";

export class ThreadWorktreeError extends Schema.TaggedError<ThreadWorktreeError>()(
  "ThreadWorktreeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

interface WorktreeBinding {
  readonly threadId: string;
  readonly projectCwd: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

// Read Git's destination-local identity rather than trusting a path sent by another host.
const qualifyWithServices = Effect.fn("qualifyThreadWorktree")(function* (
  input: WorktreeBinding,
  options?: { readonly claimCreatedWorktree?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess;
  if (!input.worktreePath || !input.branch) {
    return yield* new ThreadWorktreeError({
      detail: "Coding requires a dedicated Git worktree and branch before provider execution.",
    });
  }
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcs
      .run({ operation: "ThreadWorktree.qualify", command: "git", args, cwd })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const worktreePath = yield* fs.realPath(input.worktreePath);
  const projectPath = yield* fs.realPath(input.projectCwd);
  const root = yield* fs.realPath(yield* git(worktreePath, ["rev-parse", "--show-toplevel"]));
  const commonDir = yield* fs.realPath(
    yield* git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const projectCommonDir = yield* fs.realPath(
    yield* git(projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const gitDir = yield* fs.realPath(yield* git(worktreePath, ["rev-parse", "--absolute-git-dir"]));
  const branch = yield* git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (
    root !== worktreePath ||
    commonDir !== projectCommonDir ||
    gitDir === commonDir ||
    branch !== input.branch
  ) {
    return yield* new ThreadWorktreeError({
      detail:
        "Worktree root, repository or branch does not match the coding thread; shared checkout fallback is refused.",
    });
  }
  const entries = (yield* git(projectPath, ["worktree", "list", "--porcelain", "-z"])).split(
    "\0\0",
  );
  let entry: string[] | undefined;
  for (const fields of entries.map((item) => item.split("\0"))) {
    const listedPath = fields[0]?.startsWith("worktree ") ? fields[0].slice(9) : null;
    if (
      listedPath !== null &&
      (yield* fs.realPath(listedPath).pipe(Effect.orElseSucceed(() => null))) === worktreePath
    ) {
      entry = fields;
      break;
    }
  }
  if (!entry || entry.some((field) => field.startsWith("locked") || field.startsWith("prunable"))) {
    return yield* new ThreadWorktreeError({ detail: "Worktree is missing, locked or stale." });
  }
  const ownerPath = path.join(gitDir, "t3-thread-owner.json");
  const owner = { threadId: input.threadId, worktreePath, commonDir };
  if (options?.claimCreatedWorktree === true) {
    // Only the allocator calls this, immediately after Git created a new checkout.
    // Exclusive creation rejects concurrent or foreign claims without overwriting them.
    yield* fs.writeFileString(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  }
  const persistedOwner = yield* fs.readFileString(ownerPath);
  if (persistedOwner !== JSON.stringify(owner)) {
    return yield* new ThreadWorktreeError({
      detail: "Worktree belongs to another thread; attach is refused.",
    });
  }
  return { worktreePath, branch, commonDir };
});

// Serialization belongs to the existing engine queue. Never allocate on a turn/callback.
const rejectConflictingWithServices = Effect.fn("rejectConflictingWorktree")(function* (
  threadId: string,
  worktreePath: string,
  threads: ReadonlyArray<{
    readonly id: string;
    readonly worktreePath: string | null;
    readonly deletedAt: string | null;
  }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const claimedPath = yield* fs.realPath(worktreePath);
  for (const thread of threads) {
    if (thread.id === threadId || thread.deletedAt !== null || thread.worktreePath === null)
      continue;
    const peerPath = yield* fs
      .realPath(thread.worktreePath)
      .pipe(Effect.orElseSucceed(() => thread.worktreePath));
    if (peerPath === claimedPath) {
      return yield* new ThreadWorktreeError({
        detail: `Worktree is already bound to thread '${thread.id}'.`,
      });
    }
  }
});

// This is a destination-local filesystem/process boundary. Provision the existing
// platform/VCS implementation here so unrelated engine clients need no new service.
export const qualifyThreadWorktree = (
  input: WorktreeBinding,
  options?: { readonly claimCreatedWorktree?: boolean },
) =>
  qualifyWithServices(input, options).pipe(
    Effect.provide(VcsProcessLayer.layer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

export const rejectConflictingWorktree = (
  ...input: Parameters<typeof rejectConflictingWithServices>
) => rejectConflictingWithServices(...input).pipe(Effect.provide(NodeServices.layer));
