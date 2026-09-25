import { useEffect, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import type {
  PostStartActivityAnchors,
  PostStartConnectionState,
} from "@t3tools/shared/postStartActivity";
import {
  POST_START_SILENCE_THRESHOLD_MS,
  resolvePostStartActivity,
} from "@t3tools/shared/postStartActivity";

import { formatDuration } from "../../session-logic";
import { useClientSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";

// One notification per silence episode, keyed by the episode's stable
// identity. A resumed turn produces a new key, so silence that recurs later
// can notify again; a tick or a remount cannot replay the same episode.
const notifiedEpisodeToastIds = new Map<string, string>();

function formatThresholdLabel(thresholdMs: number): string {
  const minutes = Math.round(thresholdMs / 60_000);
  if (minutes < 1) return `${Math.round(thresholdMs / 1000)} seconds`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function relativeAge(ageMs: number | null): string {
  return ageMs === null ? "unknown" : `${formatDuration(ageMs)} ago`;
}

/**
 * Inline post-start status for a running turn.
 *
 * Renders nothing while the turn is producing recent progress. Once provider
 * activity goes quiet past the threshold it names what is known: the
 * outstanding tool (with its own age), or unexplained silence, or a
 * disconnected environment we cannot observe. It never says the turn failed.
 *
 * The component self-ticks once a second so the warning appears exactly when
 * the threshold is crossed without re-rendering the surrounding list.
 */
export function PostStartActivityNotice({
  anchors,
  connection,
}: {
  anchors: PostStartActivityAnchors;
  connection: PostStartConnectionState;
}) {
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastNotifiedEpisodeRef = useRef<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const observation = resolvePostStartActivity(anchors, nowMs, { connection });
  const { status, episodeKey } = observation;

  useEffect(() => {
    const previousEpisode = lastNotifiedEpisodeRef.current;
    if (status !== "quiet") {
      if (previousEpisode !== null) {
        const toastId = notifiedEpisodeToastIds.get(previousEpisode);
        if (toastId !== undefined) {
          toastManager.close(toastId);
          notifiedEpisodeToastIds.delete(previousEpisode);
        }
      }
      lastNotifiedEpisodeRef.current = null;
      return;
    }
    lastNotifiedEpisodeRef.current = episodeKey;
    if (!inAppNotificationsEnabled || episodeKey === null) return;
    if (notifiedEpisodeToastIds.has(episodeKey)) return;
    const toastId = toastManager.add({
      type: "warning",
      title: "No recent provider activity",
      description: "This turn may still be working. Open the thread to review its last activity.",
      data: { hideCopyButton: true, leadingIcon: <ClockIcon aria-hidden className="size-4" /> },
    });
    notifiedEpisodeToastIds.set(episodeKey, toastId);
  }, [episodeKey, inAppNotificationsEnabled, status]);

  useEffect(
    () => () => {
      const episode = lastNotifiedEpisodeRef.current;
      if (episode === null) return;
      const toastId = notifiedEpisodeToastIds.get(episode);
      if (toastId !== undefined) {
        toastManager.close(toastId);
        notifiedEpisodeToastIds.delete(episode);
      }
    },
    [],
  );

  if (status !== "quiet" && status !== "unknown") {
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

  const mainLabel =
    status === "unknown"
      ? "Can't observe this turn's provider right now; its state is unknown."
      : observation.outstandingTool !== null
        ? `No activity from ${observation.outstandingTool.title} for over ${formatThresholdLabel(
            POST_START_SILENCE_THRESHOLD_MS,
          )}; this turn may still be working.`
        : `No provider activity observed for over ${formatThresholdLabel(
            POST_START_SILENCE_THRESHOLD_MS,
          )}; this turn may still be working.`;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex min-w-0 items-start gap-1.5 px-1 text-sm leading-relaxed text-muted-foreground">
        <ClockIcon aria-hidden className="mt-1 size-3.5 shrink-0" />
        <div className="min-w-0">
          <span role="status">{mainLabel}</span>
          <div className="text-xs text-muted-foreground/80">
            {lastActivityDetail} · {completionDetail}
          </div>
        </div>
      </div>
    </div>
  );
}
