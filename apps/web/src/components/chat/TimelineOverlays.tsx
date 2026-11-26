import { T } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PaperclipIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";

export function WorkspaceFileDropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      data-chat-workspace-drop-overlay="true"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
        <T>Drop files to attach</T>
      </div>
    </div>
  );
}

/**
 * Sits `bottom` pixels up, clear of the composer and its attached banners. The summary names
 * what waits at the end of the timeline, which is out of view while it shows.
 */
export function ScrollToEndButton(props: {
  readonly bottom: number;
  readonly summary: string | null;
  readonly onScrollToEnd: () => void;
}) {
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute right-4 z-30 flex justify-end py-1.5"
      style={{ bottom: props.bottom }}
    >
      <Button
        data-scroll-to-end="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onScrollToEnd}
        className="pointer-events-auto"
        size="xs"
        variant="glass"
      >
        <ChevronDownIcon className="size-3.5" />
        <T>Scroll to end</T>
        {props.summary === null ? null : (
          <span className="text-muted-foreground">
            <span aria-hidden>· </span>
            {props.summary}
          </span>
        )}
      </Button>
    </div>
  );
}

/** Discord's "new messages" bar: sits at the top edge while the divider is off screen. */
export function NewSinceLastSeenPill(props: {
  readonly count: number;
  readonly direction: "up" | "down";
  readonly onJump: () => void;
  readonly onDismiss: () => void;
}) {
  const Arrow = props.direction === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <div
      data-new-since-last-seen="true"
      className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3"
    >
      <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-1">
        <Button
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onJump}
          className="min-w-0"
          size="xs"
          variant="glass"
        >
          <Arrow aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{props.count} new since you last looked</span>
          <span aria-hidden className="shrink-0 text-muted-foreground">
            ·
          </span>
          <span className="shrink-0 font-medium">Jump</span>
        </Button>
        <Button
          aria-label="Dismiss new messages"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onDismiss}
          size="icon-xs"
          variant="glass"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
