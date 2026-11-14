import { DEFAULT_THREAD_OWNERS, type ThreadInboxType } from "@t3tools/contracts";

/**
 * Fields a shared inbox uses to decide who should see a thread.
 * Missing values are untagged history and stay on the all-threads list.
 */
export interface ThreadInboxSubject {
  readonly owner?: string | null | undefined;
  readonly threadType?: ThreadInboxType | null | undefined;
  readonly startedBy?: string | null | undefined;
}

export interface ThreadInboxVisibility {
  /** Selected founder. Null is the shared list. */
  readonly identity: string | null;
  /** Bot-to-bot threads stay out until this is set, including while searching. */
  readonly showBotWork: boolean;
}

/**
 * Founder inbox: owner is me, a needs-human thread addressed to me, or a
 * thread I started. Untagged threads stay on the all-threads list. Bot work
 * stays hidden until `showBotWork` is set.
 */
export function threadVisibleInInbox(
  thread: ThreadInboxSubject,
  options: ThreadInboxVisibility,
): boolean {
  if (thread.threadType === "bot-work" && !options.showBotWork) {
    return false;
  }
  const identity = options.identity?.trim() ?? "";
  if (identity.length === 0) {
    return true;
  }
  const addressedToMe = thread.threadType === "needs-human" && thread.owner === identity;
  return thread.owner === identity || addressedToMe || thread.startedBy === identity;
}

export function inboxOwnerNames(extraOwners: readonly string[]): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [...DEFAULT_THREAD_OWNERS, ...extraOwners]) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  return names;
}

export const THREAD_INBOX_TYPE_LABELS: Record<ThreadInboxType, string> = {
  "needs-human": "Needs a human",
  fyi: "FYI",
  "bot-work": "Bot work",
};
