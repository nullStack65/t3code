import {
  founderName,
  resolveBotAttention,
  typingLabel,
  type ContextMenuSource,
  type EnvironmentId,
  type ScopedThreadRef,
  type TypingByThread,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent,
} from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import { BotAvatar, BOT_ACCENT_CLASSES } from "../bots/BotAvatar";
import { botDisplayName, orderBotTree, visibleBotRows } from "../bots/botOrgTree";
import { botPresenceInput, resolveBotPresence } from "../bots/botPresence";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { useClientSettings } from "../../hooks/useSettings";

// One shared empty value, so an idle environment never looks like a change.
const NO_TYPING: TypingByThread = {};

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
    /** The group's heading; "Bots" keeps the single group for a search or an older list. */
    readonly label?: string;
    readonly testId?: string;
  },
) {
  const [typingByEnvironment, setTypingByEnvironment] = useState<
    Readonly<Record<string, TypingByThread>>
  >({});
  const onTyping = (environmentId: string, next: TypingByThread) => {
    setTypingByEnvironment((current) =>
      current[environmentId] === next ? current : { ...current, [environmentId]: next },
    );
  };
  const botCollapsedById = useUiStateStore((state) => state.botCollapsedById);
  const setBotCollapsed = useUiStateStore((state) => state.setBotCollapsed);
  const label = props.label ?? "Bots";
  const groupKey = `group:${label}`;
  const groupCollapsed = botCollapsedById[groupKey] === true;
  const rows = visibleBotRows(
    orderBotTree(props.threads),
    (thread) =>
      botCollapsedById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))] === true,
  );
  if (props.threads.length === 0) return null;
  const environmentIds = [...new Set(props.threads.map((thread) => thread.environmentId))];
  return (
    <section
      aria-label={label}
      data-testid={props.testId ?? "sidebar-bots-group"}
      className="mx-0.5 mb-1"
    >
      {environmentIds.map((environmentId) => (
        <TypingFeed key={environmentId} environmentId={environmentId} onTyping={onTyping} />
      ))}
      <button
        type="button"
        aria-expanded={!groupCollapsed}
        data-testid="sidebar-bots-group-toggle"
        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setBotCollapsed(groupKey, !groupCollapsed)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-foreground/60 transition-transform",
            !groupCollapsed && "rotate-90",
          )}
        />
        <span className="shrink-0 text-xs font-medium text-sidebar-foreground/80">{label}</span>
        <span aria-hidden className="ml-1 h-px flex-1 bg-sidebar-foreground/15" />
      </button>
      <ul role="list" className="flex flex-col gap-px" hidden={groupCollapsed}>
        {(groupCollapsed ? [] : rows).map(({ thread, depth, hasReports, collapsed }) => {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarBotRow
              key={key}
              thread={thread}
              depth={depth}
              hasReports={hasReports}
              collapsed={collapsed}
              onToggleCollapsed={() => setBotCollapsed(key, !collapsed)}
              threadKey={key}
              isActive={props.activeThreadKey === key}
              typing={typingByEnvironment[thread.environmentId]}
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

/** One environment's typing stream. A hook cannot loop over a changing set of environments. */
function TypingFeed(props: {
  readonly environmentId: EnvironmentId;
  readonly onTyping: (environmentId: string, next: TypingByThread) => void;
}) {
  const { environmentId, onTyping } = props;
  const { data } = useEnvironmentQuery(
    orchestrationEnvironment.v2.typing({
      environmentId,
      input: {},
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors one environment's typing query result into the group's per-environment map until unmount
  useEffect(() => {
    onTyping(environmentId, data ?? NO_TYPING);
  }, [data, environmentId, onTyping]);
  return null;
}

const SidebarBotRow = memo(function SidebarBotRow(
  props: BotRowHandlers & {
    readonly thread: EnvironmentThreadShell;
    /** Reporting-line depth: 0 is a root; each level indents one step. */
    readonly depth: number;
    /** A bot with reports shows a chevron that folds them away. */
    readonly hasReports: boolean;
    readonly collapsed: boolean;
    readonly onToggleCollapsed: () => void;
    readonly threadKey: string;
    readonly isActive: boolean;
    readonly typing: TypingByThread | undefined;
  },
) {
  const { thread, threadKey } = props;
  const standing = thread.standing!;
  const name = botDisplayName(standing.name);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  const viewingFounder = useClientSettings((state) => state.founderInboxOwner);
  const attention = resolveBotAttention({
    inbox: thread.source.inbox,
    viewingFounder,
    mentioned: thread.source.attentionMentions,
  });
  const typingText = props.isActive
    ? null
    : typingLabel(
        (props.typing?.[thread.id] ?? []).filter((founder) => founder !== viewingFounder),
      );
  const presence = resolveBotPresence(botPresenceInput(pill, thread.runtime), standing.role);
  const accent = BOT_ACCENT_CLASSES[standing.accent];
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onThreadActivate(threadRef);
  };
  return (
    <li
      className="list-none"
      data-bot-depth={props.depth}
      style={props.depth > 0 ? { paddingLeft: `${props.depth * 14}px` } : undefined}
    >
      <div className="relative">
        <div
          role="button"
          tabIndex={0}
          data-sidebar-row={threadKey}
          data-testid="sidebar-bot-row"
          data-bot-state={presence.avatarState}
          aria-current={props.isActive ? "page" : undefined}
          aria-label={`${name}${typingText ? `, ${typingText}` : presence.line ? `, ${presence.line}` : ""}${attentionLabel(
            attention,
          )}${
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
          <span aria-hidden className="size-4 shrink-0" />
          <BotAvatar
            avatarId={standing.avatarId}
            accent={standing.accent}
            state={presence.avatarState}
          />
          <span className="shrink-0 truncate text-sm font-medium" dir="auto">
            {name}
          </span>
          {typingText ? (
            <span
              className="min-w-0 flex-1 truncate text-xs text-sidebar-muted-foreground"
              data-bot-typing=""
              dir="auto"
            >
              {typingText}
            </span>
          ) : presence.line ? (
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
          <BotAttentionMark attention={attention} accentClass={accent.swatch} />
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
        {props.hasReports ? (
          <button
            type="button"
            aria-expanded={!props.collapsed}
            aria-label={`${props.collapsed ? "Expand" : "Collapse"} ${name}'s reports`}
            data-testid="sidebar-bot-toggle"
            className="absolute inset-y-0 left-0 z-10 flex w-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleCollapsed();
            }}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 transition-transform", !props.collapsed && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
    </li>
  );
});

/** What a screen reader adds for the attention mark; the mark itself is hidden. */
function attentionLabel(attention: ReturnType<typeof resolveBotAttention>): string {
  if (attention.kind === "fyi") return ", update";
  if (attention.kind === "badge") return `, ${attention.label}`;
  if (attention.kind === "sign-off") {
    return `, ${attention.founders
      .map((entry) => `${founderName(entry.founder)} ${entry.signed ? "signed" : "waiting"}`)
      .join(", ")}`;
  }
  return "";
}

/**
 * The one attention mark on a bot row. FYI is a faint dot; a decision or a
 * founder mention is a bright pill; a call both founders make lists each one.
 */
function BotAttentionMark(props: {
  readonly attention: ReturnType<typeof resolveBotAttention>;
  readonly accentClass: string;
}) {
  const { attention } = props;
  if (attention.kind === "quiet") return null;
  if (attention.kind === "fyi") {
    return (
      <span
        aria-hidden
        data-bot-attention="fyi"
        className="size-1.5 shrink-0 rounded-full bg-sidebar-foreground/40"
      />
    );
  }
  if (attention.kind === "sign-off") {
    return (
      <span
        aria-hidden
        data-bot-attention="sign-off"
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sidebar-foreground/10 px-1.5 py-0.5 text-2xs font-medium text-sidebar-foreground"
      >
        {attention.founders.map((entry, index) => (
          <span key={entry.founder} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-sidebar-muted-foreground">·</span> : null}
            <span>
              {founderName(entry.founder)} {entry.signed ? "✓" : "○"}
            </span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-bot-attention="badge"
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium text-white",
        props.accentClass,
      )}
    >
      {attention.label}
    </span>
  );
}
