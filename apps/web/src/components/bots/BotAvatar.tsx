import {
  resolveThreadStandingAccent,
  resolveThreadStandingAvatarId,
  type ThreadStandingAccent,
  type ThreadStandingAvatarId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Original robot heads drawn for T3 Code (no third-party art). Each is a
 * 24×24 line drawing in currentColor so the accent and theme set its color;
 * the eyes sit in one group so the running state can blink them.
 */
const FACE = (
  <rect x="4" y="8" width="16" height="12" rx="4" fill="currentColor" fillOpacity="0.14" />
);

const AVATARS: Record<
  ThreadStandingAvatarId,
  { readonly head: ReactNode; readonly eyes: ReactNode }
> = {
  bolt: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M12.8 2.5 11 5.5h2l-1.8 2.5" />
        <path d="M9 17h6" />
      </>
    ),
    eyes: (
      <>
        <circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  dish: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M8.5 5.5a3.5 3.5 0 0 0 7 0Z" />
        <path data-bot-antenna d="M12 5.5V8" />
        <path d="M10 17.2q2 1 4 0" />
      </>
    ),
    eyes: (
      <>
        <rect x="7.6" y="12" width="2.8" height="2" rx="1" fill="currentColor" stroke="none" />
        <rect x="13.6" y="12" width="2.8" height="2" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  visor: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M12 8V5.5" />
        <circle data-bot-antenna cx="12" cy="4.5" r="1" />
        <path d="M10.5 17.5h3" />
      </>
    ),
    eyes: (
      <rect x="6.5" y="11.5" width="11" height="3" rx="1.5" fill="currentColor" stroke="none" />
    ),
  },
  cyclops: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M8 8 6.5 5M16 8l1.5-3" />
        <path d="M9.5 17.5h5" />
      </>
    ),
    eyes: (
      <>
        <circle cx="12" cy="13" r="2.6" />
        <circle cx="12" cy="13" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  periscope: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M12 8V4h3" />
        <rect data-bot-antenna x="15" y="2.8" width="2.4" height="2.4" rx="0.6" />
        <path d="M9 17h6" />
      </>
    ),
    eyes: (
      <>
        <circle cx="9" cy="13" r="1.6" />
        <circle cx="15" cy="13" r="1.6" />
      </>
    ),
  },
  twin: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M9 8V5M15 8V5" />
        <circle data-bot-antenna cx="9" cy="4" r="1" fill="currentColor" stroke="none" />
        <circle data-bot-antenna cx="15" cy="4" r="1" fill="currentColor" stroke="none" />
        <path d="M9.5 17q2.5 1.5 5 0" />
      </>
    ),
    eyes: (
      <>
        <path d="M7.6 13.4q1.4-1.6 2.8 0" />
        <path d="M13.6 13.4q1.4-1.6 2.8 0" />
      </>
    ),
  },
  sprout: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M12 8V5.5" />
        <path data-bot-antenna d="M12 5.5q-3-.2-3.5-3 3 .2 3.5 3Z" />
        <path data-bot-antenna d="M12 5.5q2.5-.4 3.2-2.6-2.6.2-3.2 2.6Z" />
        <path d="M10 17.2h4" />
      </>
    ),
    eyes: (
      <>
        <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  halo: {
    head: (
      <>
        {FACE}
        <ellipse data-bot-antenna cx="12" cy="4.5" rx="4.5" ry="1.4" />
        <path d="M10 17.5q2 .8 4 0" />
      </>
    ),
    eyes: (
      <>
        <path d="M7.8 13h2.4M13.8 13h2.4" />
      </>
    ),
  },
  grill: {
    head: (
      <>
        {FACE}
        <path d="M4 12H2.5M20 12h1.5" />
        <path data-bot-antenna d="M12 8V6" />
        <path d="M8.5 16.5h7M8.5 18h7" />
      </>
    ),
    eyes: (
      <>
        <rect x="7.6" y="11" width="2.8" height="2.8" rx="0.6" fill="currentColor" stroke="none" />
        <rect x="13.6" y="11" width="2.8" height="2.8" rx="0.6" fill="currentColor" stroke="none" />
      </>
    ),
  },
  monocle: {
    head: (
      <>
        {FACE}
        <path data-bot-antenna d="M7 8 9 5.5h6L17 8" />
        <path d="M17.6 14.8 19 19" />
        <path d="M9.5 17.5h4" />
      </>
    ),
    eyes: (
      <>
        <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="2.4" />
        <circle cx="15" cy="13" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  },
};

/** Literal classes so Tailwind keeps them; tuned per theme for contrast on the sidebar. */
export const BOT_ACCENT_CLASSES: Record<
  ThreadStandingAccent,
  { readonly text: string; readonly ring: string; readonly swatch: string }
> = {
  sky: {
    text: "text-sky-700 dark:text-sky-300",
    ring: "ring-sky-500/70 dark:ring-sky-300/70",
    swatch: "bg-sky-500 dark:bg-sky-300",
  },
  violet: {
    text: "text-violet-700 dark:text-violet-300",
    ring: "ring-violet-500/70 dark:ring-violet-300/70",
    swatch: "bg-violet-500 dark:bg-violet-300",
  },
  emerald: {
    text: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-500/70 dark:ring-emerald-300/70",
    swatch: "bg-emerald-500 dark:bg-emerald-300",
  },
  amber: {
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-500/70 dark:ring-amber-300/70",
    swatch: "bg-amber-500 dark:bg-amber-300",
  },
  rose: {
    text: "text-rose-700 dark:text-rose-300",
    ring: "ring-rose-500/70 dark:ring-rose-300/70",
    swatch: "bg-rose-500 dark:bg-rose-300",
  },
  teal: {
    text: "text-teal-700 dark:text-teal-300",
    ring: "ring-teal-500/70 dark:ring-teal-300/70",
    swatch: "bg-teal-500 dark:bg-teal-300",
  },
  indigo: {
    text: "text-indigo-700 dark:text-indigo-300",
    ring: "ring-indigo-500/70 dark:ring-indigo-300/70",
    swatch: "bg-indigo-500 dark:bg-indigo-300",
  },
  orange: {
    text: "text-orange-700 dark:text-orange-300",
    ring: "ring-orange-500/70 dark:ring-orange-300/70",
    swatch: "bg-orange-500 dark:bg-orange-300",
  },
};

export type BotAvatarState = "idle" | "running" | "waiting" | "needs-you" | "failed";

export function BotAvatar(props: {
  readonly avatarId: string;
  readonly accent: string;
  readonly state?: BotAvatarState;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}) {
  const avatar = AVATARS[resolveThreadStandingAvatarId(props.avatarId)];
  const accent = BOT_ACCENT_CLASSES[resolveThreadStandingAccent(props.accent)];
  const state = props.state ?? "idle";
  return (
    <span
      aria-hidden="true"
      data-bot-state={state}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-current/8",
        props.size === "lg" ? "size-9" : props.size === "md" ? "size-7" : "size-5",
        accent.text,
        state === "idle" && "motion-safe:animate-bot-breathe",
        state === "running" && "motion-safe:animate-status-pulse",
        state === "waiting" && "motion-safe:animate-bot-wait",
        state === "needs-you" && cn("ring-2", accent.ring),
        state === "failed" && "ring-2 ring-destructive/80",
        props.className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={props.size === "lg" ? "size-7" : props.size === "md" ? "size-5.5" : "size-4"}
      >
        <g className={cn(state === "running" && "**:data-bot-antenna:motion-safe:animate-bot-antenna")}>
          {avatar.head}
        </g>
        {state === "running" ? (
          <rect
            x="9"
            y="11"
            width="3"
            height="4"
            fill="currentColor"
            stroke="none"
            opacity="0.28"
            className="motion-safe:animate-bot-scan"
          />
        ) : null}
        <g
          className={cn(
            "origin-[12px_13px]",
            (state === "idle" || state === "running") && "motion-safe:animate-bot-blink",
          )}
        >
          {avatar.eyes}
        </g>
      </svg>
    </span>
  );
}
