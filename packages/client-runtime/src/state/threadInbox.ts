import { DEFAULT_THREAD_OWNERS, type ThreadInboxType } from "@t3tools/contracts";

export {
  threadVisibleInInbox,
  type ThreadInboxSubject,
  type ThreadInboxVisibility,
} from "@t3tools/contracts/threadInbox";

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
