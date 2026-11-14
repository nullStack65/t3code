import type { ThreadInboxType } from "@t3tools/contracts";
import {
  inboxOwnerNames,
  THREAD_INBOX_TYPE_LABELS,
} from "@t3tools/client-runtime/state/thread-inbox";
import { useState } from "react";

import { Button } from "../ui/button";
import { useUiStateStore } from "../../uiStateStore";

const TYPE_OPTIONS: ReadonlyArray<ThreadInboxType> = ["needs-human", "fyi", "bot-work"];

/**
 * Founder inbox for the shared thread pool. The selection is local to this
 * browser; the tags themselves live on the thread.
 */
export function SidebarInboxBar() {
  const inboxIdentity = useUiStateStore((state) => state.inboxIdentity);
  const showBotWork = useUiStateStore((state) => state.showBotWork);
  const inboxOwners = useUiStateStore((state) => state.inboxOwners);
  const createOwner = useUiStateStore((state) => state.createOwner);
  const createThreadType = useUiStateStore((state) => state.createThreadType);
  const setInboxIdentity = useUiStateStore((state) => state.setInboxIdentity);
  const setShowBotWork = useUiStateStore((state) => state.setShowBotWork);
  const setInboxOwners = useUiStateStore((state) => state.setInboxOwners);
  const setCreateOwner = useUiStateStore((state) => state.setCreateOwner);
  const setCreateThreadType = useUiStateStore((state) => state.setCreateThreadType);
  const [draftOwner, setDraftOwner] = useState("");
  const owners = inboxOwnerNames(inboxOwners);

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-1">
        Inbox
        <select
          aria-label="Inbox"
          className="h-6 rounded-md border border-input bg-popover px-1 text-foreground"
          value={inboxIdentity ?? ""}
          onChange={(event) => setInboxIdentity(event.target.value || null)}
        >
          <option value="">All threads</option>
          {owners.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </select>
      </label>
      <Button
        size="xs"
        variant={showBotWork ? "secondary" : "ghost-muted"}
        aria-pressed={showBotWork}
        onClick={() => setShowBotWork(!showBotWork)}
      >
        {showBotWork ? "Hide bot work" : "Show bot work"}
      </Button>
      <label className="flex items-center gap-1">
        New
        <select
          aria-label="Owner for new threads"
          className="h-6 max-w-28 rounded-md border border-input bg-popover px-1 text-foreground"
          value={createOwner ?? ""}
          onChange={(event) => setCreateOwner(event.target.value || null)}
        >
          <option value="">No owner</option>
          {owners.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </select>
        <select
          aria-label="Type for new threads"
          className="h-6 rounded-md border border-input bg-popover px-1 text-foreground"
          value={createThreadType ?? ""}
          onChange={(event) =>
            setCreateThreadType(
              event.target.value === "needs-human" ||
                event.target.value === "fyi" ||
                event.target.value === "bot-work"
                ? event.target.value
                : null,
            )
          }
        >
          <option value="">No type</option>
          {TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {THREAD_INBOX_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draftOwner.trim();
          if (name.length === 0 || owners.includes(name)) {
            setDraftOwner("");
            return;
          }
          setInboxOwners([...inboxOwners, name]);
          setDraftOwner("");
        }}
      >
        <input
          aria-label="Add inbox owner"
          className="h-6 w-24 rounded-md border border-input bg-popover px-1 text-foreground"
          placeholder="Add owner"
          value={draftOwner}
          onChange={(event) => setDraftOwner(event.target.value)}
        />
      </form>
    </div>
  );
}
