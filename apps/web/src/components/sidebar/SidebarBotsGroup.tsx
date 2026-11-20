import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { memo, type MouseEvent as ReactMouseEvent, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import { BotAvatar, BOT_ACCENT_CLASSES } from "../bots/BotAvatar";
import { resolveBotPresence } from "../bots/botPresence";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";

interface BotRowHandlers {
  readonly onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  readonly onThreadActivate: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}

/**
 * Standing bots sit above Pinned as one-line rows: who the bot is and what it
 * is doing. Branch, worktree, PR, model and time belong to work threads and
 * stay off these rows; they live in the thread's details instead.
 */
export function SidebarBotsGroup(
  props: BotRowHandlers & {
    readonly threads: readonly EnvironmentThreadShell[];
    readonly activeThreadKey: string | null;
  },
) {
  if (props.threads.length === 0) return null;
  return (
    <section aria-label="Bots" data-testid="sidebar-bots-group" className="mx-0.5 mb-1">
      <div className="flex h-6 items-center gap-2 px-2">
        <span className="shrink-0 text-xs font-medium text-sidebar-foreground/80">Bots</span>
        <span aria-hidden className="h-px flex-1 bg-sidebar-foreground/15" />
      </div>
      <ul role="list" className="flex flex-col gap-px">
        {props.threads.map((thread) => {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarBotRow
              key={key}
              thread={thread}
              threadKey={key}
              isActive={props.activeThreadKey === key}
              onThreadClick={props.onThreadClick}
              onThreadActivate={props.onThreadActivate}
              onContextMenu={props.onContextMenu}
            />
          );
        })}
      </ul>
    </section>
  );
}

const SidebarBotRow = memo(function SidebarBotRow(
  props: BotRowHandlers & {
    readonly thread: EnvironmentThreadShell;
    readonly threadKey: string;
    readonly isActive: boolean;
  },
) {
  const { thread, threadKey } = props;
  const standing = thread.standing!;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  const presence = resolveBotPresence(
    pill === null ? null : { ...pill, errorClass: thread.runtime?.lastErrorClass },
    standing.role,
  );
  const accent = BOT_ACCENT_CLASSES[standing.accent];
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onThreadActivate(threadRef);
  };
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={threadKey}
        data-testid="sidebar-bot-row"
        data-bot-state={presence.avatarState}
        aria-current={props.isActive ? "page" : undefined}
        aria-label={`${standing.name}${presence.line ? `, ${presence.line}` : ""}${
          presence.badge === "needs-you"
            ? ", needs you"
            : presence.badge === "unread"
              ? ", unread"
              : ""
        }`}
        className={cn(
          "group/sidebar-row relative flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          presence.avatarState === "running" &&
            cn(
              "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:content-[''] motion-safe:before:animate-status-pulse",
              accent.text,
              "before:bg-current",
            ),
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={(event) => props.onThreadClick(event, threadRef)}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            threadRef,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
      >
        <BotAvatar
          avatarId={standing.avatarId}
          accent={standing.accent}
          state={presence.avatarState}
        />
        <span className="shrink-0 truncate text-sm font-medium" dir="auto">
          {standing.name}
        </span>
        {presence.line ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              presence.avatarState === "failed"
                ? "text-destructive-foreground"
                : presence.badge === "needs-you" || presence.avatarState === "running"
                  ? accent.text
                  : "text-sidebar-muted-foreground",
            )}
            dir="auto"
          >
            {presence.line}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {presence.badge ? (
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              presence.badge === "needs-you" ? accent.swatch : "bg-sidebar-foreground/60",
            )}
          />
        ) : null}
      </div>
    </li>
  );
});
