import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { cn } from "~/lib/utils";
import {
  formatThreadFindCount,
  nextThreadFindAnnouncement,
  type ThreadFindAnnouncement,
} from "./threadFind";
import { THREAD_DETAILS_CARD_GAP } from "./threadDetailsCardLayout";
import type { OrchestrationMessageSenderFilter } from "@t3tools/contracts";
import { MESSAGE_SENDER_FILTER_LABELS } from "@t3tools/client-runtime/message-sender";

const SENDER_FILTERS = Object.keys(MESSAGE_SENDER_FILTER_LABELS) as OrchestrationMessageSenderFilter[];

interface ThreadFindBarProps {
  readonly open: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly counting?: boolean;
  readonly status: "loading" | "error" | null;
  readonly onRetry: () => void;
  readonly activeIndex: number;
  /** Bumped by each user search or step; background refreshes keep it. */
  readonly navigationId: number;
  /** Whether the label shows the outcome of `navigationId`: a count or a failure. */
  readonly settled: boolean;
  readonly focusRequestId: number;
  readonly onQueryChange: (query: string) => void;
  /** Only messages from this sender stay in the timeline while find is open. */
  readonly sender?: OrchestrationMessageSenderFilter | null;
  readonly onSenderChange?: (sender: OrchestrationMessageSenderFilter | null) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

export const THREAD_FIND_BAR_RESERVED_HEIGHT = 36 + THREAD_DETAILS_CARD_GAP;

export function ThreadFindBar(props: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the input DOM node when the bar opens or a find shortcut fires
  useEffect(() => {
    if (!props.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each find shortcut bumps the request id, so an already-open bar refocuses and reselects its query.
    props.focusRequestId,
    props.open,
  ]);

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && !props.status && props.matchCount === 0;
  let label = "";
  if (hasQuery) {
    label = props.counting ? "1/…" : formatThreadFindCount(props.activeIndex, props.matchCount);
  }
  if (props.status === "loading") label = "Searching…";
  if (props.status === "error") label = "Search failed";
  const [storedAnnouncement, setAnnouncement] = useState<ThreadFindAnnouncement | null>(null);
  const announcement = nextThreadFindAnnouncement(storedAnnouncement, {
    navigationId: props.navigationId,
    text: label,
    settled: props.settled || props.status === "loading",
    provisional: props.status !== null,
  });
  if (announcement !== storedAnnouncement) setAnnouncement(announcement);

  if (!props.open) return null;

  const navigationDisabled =
    props.matchCount === 0 || props.status === "loading" || props.counting === true;
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) props.onPrevious();
      else props.onNext();
    }
  };

  return (
    <div
      data-thread-find-bar
      className="absolute top-3 right-3 z-40 w-[min(var(--thread-details-panel-width),calc(100%-1.5rem))] transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
    >
      <InputGroup
        variant="popover"
        size="lg"
        onContextMenu={(event) => event.stopPropagation()}
        role="search"
        aria-label="Find in thread"
        aria-busy={props.status === "loading" || props.counting === true}
        className="w-full"
      >
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={props.query}
          aria-label="Find in thread"
          placeholder="Find in thread"
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="inline-end" inset="pill">
          {props.onSenderChange ? (
            <select
              aria-label="From"
              title="Show only messages from"
              data-thread-find-sender
              className="h-6 max-w-28 rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none"
              value={props.sender ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                props.onSenderChange?.(
                  value === "" ? null : (value as OrchestrationMessageSenderFilter),
                );
              }}
            >
              <option value="">From anyone</option>
              {SENDER_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {MESSAGE_SENDER_FILTER_LABELS[filter]}
                </option>
              ))}
            </select>
          ) : null}
          <span aria-live="polite" className="sr-only">
            {announcement.text}
          </span>
          <span
            aria-hidden
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              noResults ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {props.status === "error" ? (
            <Button size="xs" variant="ghost" onClick={props.onRetry}>
              Retry
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={navigationDisabled}
            onClick={props.onPrevious}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={navigationDisabled}
            onClick={props.onNext}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={props.onClose}>
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
