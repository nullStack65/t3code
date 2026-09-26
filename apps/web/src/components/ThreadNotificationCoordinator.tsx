import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  derivePostStartActivityAnchors,
  resolvePostStartActivity,
} from "@t3tools/shared/postStartActivity";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environments.map(({ environmentId }) => environmentId));
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environments]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onNotification={onNotification}
    />
  ));
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );
  // Post-start silence episodes already surfaced as an in-app toast. Keyed by
  // environment+thread+episode so a resumed turn notifies again while a tick,
  // remount or reconnect cannot replay the same episode.
  const quietToastIds = useRef(new Map<string, string>());
  // Episodes already surfaced. Kept separately from the open toast map so a
  // disconnect, reconnect or preference change can close the toast without
  // losing the "already notified" memory and replaying it.
  const notifiedEpisodes = useRef(new Set<string>());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    for (const thread of shell.snapshot.value.threads) {
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestTurn?.state === "error") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed"
          ? `${thread.latestTurn?.turnId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "failed"
              ? "Thread failed"
              : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
      ) {
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon
                  aria-hidden
                  className="size-4 text-emerald-700 dark:text-emerald-300"
                />
              ) : status === "approval" ? (
                <ShieldQuestionIcon
                  aria-hidden
                  className="size-4 text-amber-700 dark:text-amber-300"
                />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-red-700 dark:text-red-300" />
              ) : (
                <MessageCircleQuestionIcon
                  aria-hidden
                  className="size-4 text-indigo-600 dark:text-indigo-300"
                />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: `${environmentId}:${thread.id}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    shell,
  ]);

  // Post-start silence: an unattended running thread whose provider has gone
  // quiet past the conservative threshold raises one in-app toast per episode.
  // The environment shell already carries the server-observed activity, so
  // this warns about threads the user is not viewing, follows the existing
  // in-app preference and navigation convention, and closes as the episode
  // ends or notifications are turned off.
  useEffect(() => {
    // A quiet provider produces no shell updates, so the wall-clock state
    // drives re-evaluation of the threshold.
    const closeToasts = () => {
      for (const toastId of quietToastIds.current.values()) toastManager.close(toastId);
      quietToastIds.current.clear();
    };
    if (!inAppNotificationsEnabled || shell.status !== "live" || Option.isNone(shell.snapshot)) {
      closeToasts();
      return;
    }
    const seen = new Set<string>();
    for (const thread of shell.snapshot.value.threads) {
      if (thread.archivedAt !== null) continue;
      const anchors = derivePostStartActivityAnchors({
        activities: [],
        latestTurn: thread.latestTurn,
        session: thread.session,
        knownWait: thread.hasPendingApprovals
          ? "approval"
          : thread.hasPendingUserInput
            ? "input"
            : null,
        pendingStartedAt: thread.latestUserMessageAt,
        live: thread.postStartActivity ?? null,
      });
      const observation = resolvePostStartActivity(anchors, nowMs);
      if (observation.status !== "quiet" || observation.episodeKey === null) continue;
      const key = `${environmentId}:${thread.id}:${observation.episodeKey}`;
      seen.add(key);
      if (notifiedEpisodes.current.has(key)) continue;
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        (activeEnvironmentId === environmentId && activeThreadId === thread.id)
      ) {
        continue;
      }
      const toastId = toastManager.add({
        type: "warning",
        title: "No recent provider activity",
        description: thread.title,
        data: { hideCopyButton: true, leadingIcon: <ClockIcon aria-hidden className="size-4" /> },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      notifiedEpisodes.current.add(key);
      quietToastIds.current.set(key, toastId);
    }
    for (const key of notifiedEpisodes.current) {
      if (seen.has(key)) continue;
      const toastId = quietToastIds.current.get(key);
      if (toastId !== undefined) {
        toastManager.close(toastId);
        quietToastIds.current.delete(key);
      }
      notifiedEpisodes.current.delete(key);
    }
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    navigate,
    nowMs,
    shell,
  ]);

  useEffect(
    () => () => {
      for (const toastId of quietToastIds.current.values()) toastManager.close(toastId);
      quietToastIds.current.clear();
    },
    [],
  );

  return null;
}
