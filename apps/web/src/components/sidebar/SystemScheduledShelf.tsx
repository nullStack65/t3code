import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CircleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

/**
 * System and scheduled runs sit under the founder shelves. The header is the
 * toggle; the rows stay absent until it is opened.
 */
export function SystemScheduledShelf(props: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly revealed: boolean;
  readonly activeThreadKey: string | null;
  readonly onToggle: () => void;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  if (props.threads.length === 0 && !props.revealed) return null;
  const rows = props.revealed
    ? [...props.threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    : [];
  return (
    <section
      aria-label={gt("System / Scheduled")}
      data-testid="sidebar-system-scheduled"
      className="mx-0.5 mt-1"
    >
      <CollapsibleSectionHeader
        data-testid="sidebar-system-scheduled-toggle"
        aria-label={gt("System / Scheduled")}
        expanded={props.revealed}
        onClick={props.onToggle}
        accessory={<span className="font-normal tabular-nums">{props.threads.length}</span>}
      >
        <T>System / Scheduled</T>
      </CollapsibleSectionHeader>
      {props.revealed ? (
        <ul
          data-testid="sidebar-system-scheduled-section"
          role="list"
          className="flex flex-col gap-px"
        >
          {rows.map((thread) => {
            const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            const failed = thread.runtime?.status === "failed";
            const error = failed ? thread.runtime?.lastError : null;
            return (
              <li key={key} className="list-none">
                <button
                  type="button"
                  data-testid="sidebar-system-scheduled-row"
                  data-thread-key={key}
                  data-failed={failed ? "true" : "false"}
                  aria-current={props.activeThreadKey === key ? "page" : undefined}
                  aria-label={
                    failed
                      ? error
                        ? gt("{title}, failed: {error}", { title: thread.title, error })
                        : gt("{title}, failed", { title: thread.title })
                      : thread.title
                  }
                  onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    props.activeThreadKey === key
                      ? "bg-sidebar-row-active text-sidebar-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  {failed ? (
                    <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 text-xs text-destructive-foreground">
                      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="truncate">{error || gt("Failed")}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
