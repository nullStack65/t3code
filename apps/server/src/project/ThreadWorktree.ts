import * as NodeServices from "@effect/platform-node/NodeServices";
import * as VcsProcessLayer from "../vcs/VcsProcess.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsProcess } from "../vcs/VcsProcess.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const threadWorktreeServicesLayer = VcsProcessLayer.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);

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

const WorktreeOwnerSchema = Schema.Struct({
  threadId: Schema.String,
  environmentId: Schema.String,
  worktreePath: Schema.String,
  commonDir: Schema.String,
});
const WorktreeOwnerJson = Schema.fromJsonString(WorktreeOwnerSchema);
const encodeWorktreeOwner = Schema.encodeSync(WorktreeOwnerJson);
const decodeWorktreeOwner = Schema.decodeUnknownOption(WorktreeOwnerJson);
const CoordinatorOwnerSchema = Schema.Struct({
  threadId: Schema.String,
  environmentId: Schema.String,
  projectCwd: Schema.String,
  workspacePath: Schema.String,
});
const CoordinatorOwnerJson = Schema.fromJsonString(CoordinatorOwnerSchema);
const encodeCoordinatorOwner = Schema.encodeSync(CoordinatorOwnerJson);
const decodeCoordinatorOwner = Schema.decodeUnknownOption(CoordinatorOwnerJson);

export const coordinationWorkspacePath = (stateDir: string, threadId: string, path: Path.Path) =>
  path.join(stateDir, "coordination-workspaces", `thread-${safeThreadPathSegment(threadId)}`);

export const safeThreadPathSegment = (threadId: string): string =>
  `id-${Array.from(threadId, (character) => character.codePointAt(0)!.toString(16)).join("-")}`;

const qualifyCoordinatorWorkspaceWithServices = Effect.fn("qualifyCoordinatorWorkspace")(function* (
  projectCwd: string,
  workspacePath: string | null,
  threadId: string,
  options?: { readonly claimWorkspace?: boolean; readonly environmentId?: string },
) {
  if (!workspacePath) {
    return yield* new ThreadWorktreeError({
      detail: "Coordinator threads require a dedicated destination-local workspace.",
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentId =
    options?.environmentId ??
    (yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity).pipe(
      Effect.flatMap((identity) =>
        identity._tag === "Some"
          ? identity.value.getEnvironmentId
          : Effect.fail(
              new ThreadWorktreeError({
                detail:
                  "Server environment identity is unavailable; workspace ownership cannot be claimed.",
              }),
            ),
      ),
    ));
  const resolvedWorkspace = yield* fs.realPath(workspacePath);
  const resolvedProject = yield* fs.realPath(projectCwd);
  const relative = path.relative(resolvedProject, resolvedWorkspace);
  const isOutsideProject =
    path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  if (!isOutsideProject) {
    return yield* new ThreadWorktreeError({
      detail: "Coordinator workspace must be separate from the project checkout.",
    });
  }
  const ownerPath = path.join(resolvedWorkspace, ".t3-thread-owner.json");
  const owner = {
    threadId,
    environmentId,
    projectCwd: resolvedProject,
    workspacePath: resolvedWorkspace,
  };
  if (options?.claimWorkspace === true) {
    yield* fs
      .writeFileString(ownerPath, encodeCoordinatorOwner(owner), { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
  }
  const persistedOwner = yield* fs.readFileString(ownerPath).pipe(
    Effect.mapError(
      () =>
        new ThreadWorktreeError({
          detail: "Coordinator workspace has no thread owner; create it through the server.",
        }),
    ),
  );
  const decodedOwner = decodeCoordinatorOwner(persistedOwner);
  if (
    decodedOwner._tag !== "Some" ||
    decodedOwner.value.threadId !== owner.threadId ||
    decodedOwner.value.environmentId !== owner.environmentId ||
    decodedOwner.value.projectCwd !== owner.projectCwd ||
    decodedOwner.value.workspacePath !== owner.workspacePath
  ) {
    return yield* new ThreadWorktreeError({
      detail: "Coordinator workspace belongs to another thread; attach is refused.",
    });
  }
  return resolvedWorkspace;
});

// Read Git's destination-local identity rather than trusting a path sent by another host.
const qualifyWithServices = Effect.fn("qualifyThreadWorktree")(function* (
  input: WorktreeBinding,
  options?: { readonly claimWorktree?: boolean; readonly environmentId?: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess;
  const environmentId =
    options?.environmentId ??
    (yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity).pipe(
      Effect.flatMap((identity) =>
        identity._tag === "Some"
          ? identity.value.getEnvironmentId
          : Effect.fail(
              new ThreadWorktreeError({
                detail:
                  "Server environment identity is unavailable; workspace ownership cannot be claimed.",
              }),
            ),
      ),
    ));
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
  const owner = { threadId: input.threadId, environmentId, worktreePath, commonDir };
  if (options?.claimWorktree === true) {
    // Explicit create/attach paths may claim an unowned checkout. Exclusive
    // creation makes competing attach attempts choose one owner atomically.
    yield* fs
      .writeFileString(ownerPath, encodeWorktreeOwner(owner), { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
  }
  const persistedOwner = yield* fs.readFileString(ownerPath).pipe(
    Effect.mapError(
      () =>
        new ThreadWorktreeError({
          detail: "Worktree has no thread owner; attach it through a thread create operation.",
        }),
    ),
  );
  const decodedOwner = decodeWorktreeOwner(persistedOwner);
  if (
    decodedOwner._tag !== "Some" ||
    decodedOwner.value.threadId !== owner.threadId ||
    decodedOwner.value.environmentId !== owner.environmentId ||
    decodedOwner.value.worktreePath !== owner.worktreePath ||
    decodedOwner.value.commonDir !== owner.commonDir
  ) {
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
  options?: { readonly claimWorktree?: boolean; readonly environmentId?: string },
) =>
  qualifyWithServices(input, options).pipe(
    Effect.provide(threadWorktreeServicesLayer),
    Effect.scoped,
  );

export const qualifyCoordinatorWorkspace = (
  projectCwd: string,
  workspacePath: string | null,
  threadId: string,
  options?: { readonly claimWorkspace?: boolean; readonly environmentId?: string },
) =>
  qualifyCoordinatorWorkspaceWithServices(projectCwd, workspacePath, threadId, options).pipe(
    Effect.provide(NodeServices.layer),
  );

export const rejectConflictingWorktree = (
  ...input: Parameters<typeof rejectConflictingWithServices>
) => rejectConflictingWithServices(...input).pipe(Effect.provide(NodeServices.layer));
