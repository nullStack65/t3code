import { useEffect, useState } from "react";
import { ClockIcon, LoaderCircleIcon } from "lucide-react";
import type {
  PostStartActivityAnchors,
  PostStartConnectionState,
} from "@t3tools/shared/postStartActivity";
import {
  POST_START_SILENCE_THRESHOLD_MS,
  resolvePostStartActivity,
} from "@t3tools/shared/postStartActivity";

import { formatDuration } from "../../session-logic";

function formatThresholdLabel(thresholdMs: number): string {
  const minutes = Math.round(thresholdMs / 60_000);
  if (minutes < 1) return `${Math.round(thresholdMs / 1000)} seconds`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function relativeAge(ageMs: number | null): string {
  return ageMs === null ? "unknown" : `${formatDuration(ageMs)} ago`;
}

/**
 * Compact inline post-start status for a running turn.
 *
 * Unlike the warning-only first slice, this is always informative while the
 * turn is active: it names the outstanding tool (with its own age), the last
 * provider activity, the last real tool completion, or the pending decision
 * being waited on. Once the provider passes the threshold without progress it
 * switches to the qualified silence warning. It never says the turn failed and
 * never changes turn state.
 *
 * The component self-ticks once a second so the text stays current and the
 * warning appears exactly when the threshold is crossed without re-rendering
 * the surrounding list. Notifications are owned by the environment-scoped
 * ThreadNotificationCoordinator, not here.
 */
export function PostStartActivityNotice({
  anchors,
  connection,
}: {
  anchors: PostStartActivityAnchors;
  connection: PostStartConnectionState;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const observation = resolvePostStartActivity(anchors, nowMs, { connection });
  const { status } = observation;

  if (status === "inactive") {
    return null;
  }

  const lastActivityDetail =
    observation.lastProviderActivityAgeMs === null
      ? "no provider activity observed yet"
      : `last provider activity ${relativeAge(observation.lastProviderActivityAgeMs)}`;
  const completionDetail =
    observation.lastToolCompletedAt === null
      ? "no tool completion observed"
      : `last tool completed ${relativeAge(observation.lastToolCompletedAgeMs)}`;
  const toolDetail =
    observation.outstandingTool === null
      ? null
      : `${observation.outstandingTool.title} observed ${relativeAge(observation.outstandingToolAgeMs)}`;

  const mainLabel = (() => {
    switch (status) {
      case "unknown":
        return "Can't observe this turn's provider right now; its state is unknown.";
      case "waiting":
        return anchors.knownWait === "approval"
          ? "Waiting for your approval. This turn is paused, not silent."
          : "Waiting for your input. This turn is paused, not silent.";
      case "quiet":
        return observation.outstandingTool !== null
          ? `No activity from ${observation.outstandingTool.title} for over ${formatThresholdLabel(
              POST_START_SILENCE_THRESHOLD_MS,
            )}; this turn may still be working.`
          : `No provider activity observed for over ${formatThresholdLabel(
              POST_START_SILENCE_THRESHOLD_MS,
            )}; this turn may still be working.`;
      case "active":
      default:
        return observation.outstandingTool !== null
          ? `Working: ${observation.outstandingTool.title}${
              toolDetail === null ? "" : ` · ${toolDetail}`
            }`
          : "Provider active.";
    }
  })();

  const isWarning = status === "quiet" || status === "unknown";

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex min-w-0 items-start gap-1.5 px-1 text-sm leading-relaxed text-muted-foreground">
        {isWarning ? (
          <ClockIcon aria-hidden className="mt-1 size-3.5 shrink-0" />
        ) : (
          <LoaderCircleIcon aria-hidden className="mt-1 size-3.5 shrink-0" />
        )}
        <div className="min-w-0">
          <span role="status">{mainLabel}</span>
          <div className="text-xs text-muted-foreground/80">
            {lastActivityDetail} · {completionDetail}
            {status !== "active" && toolDetail !== null ? ` · ${toolDetail}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
