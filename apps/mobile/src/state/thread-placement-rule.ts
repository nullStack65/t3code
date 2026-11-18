import type { ComposerDraft } from "./use-composer-drafts";

/** Context that only its own machine can resolve keeps a task there. */
const MACHINE_LOCAL_CONTEXT_KINDS = new Set(["thread", "terminal", "environment"]);

/**
 * Whether a new task's draft is placed by its origin rather than run on the draft's machine. Only
 * a stored `auto` intent opts in; real locality (a chosen local checkout or existing worktree, a PR
 * checkout, machine-local context, a scratch folder) keeps it where it is. Attachments never decide.
 */
export function draftRoutesAutomatically(input: {
  readonly draft: Pick<ComposerDraft, "environmentSelection" | "workspaceSelection" | "context">;
  readonly isScratch: boolean;
}): boolean {
  const { draft } = input;
  const selection = draft.workspaceSelection;
  return (
    draft.environmentSelection === "auto" &&
    !input.isScratch &&
    selection?.mode !== "local" &&
    !selection?.worktreePath &&
    selection?.pullRequestReference === undefined &&
    !(draft.context?.records ?? []).some((record) => MACHINE_LOCAL_CONTEXT_KINDS.has(record.kind))
  );
}

/** A genuinely new draft starts as Auto only when more than one machine could take it now. */
export const seedsAutomaticPlacement = (input: {
  readonly isScratch: boolean;
  readonly candidateCount: number;
}): boolean => !input.isScratch && input.candidateCount > 1;
