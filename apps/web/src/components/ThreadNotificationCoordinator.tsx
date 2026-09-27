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
import {
  monotonicNowMs,
  postStartObservationReceiptKey,
  rememberPostStartObservationReceipt,
} from "../state/postStartObservationReceipt";
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
  // Silence-episode memory lives on the always-mounted parent. The child list
  // unmounts when both notification preferences are off; keeping this here
  // means re-enabling in-app alerts cannot replay an episode the user already
  // saw. Keyed by `${environmentId}:${threadId}:${episodeKey}`.
  const notifiedSilenceEpisodes = useRef(new Set<string>());
  const openSilenceToasts = useRef(new Map<string, string>());
  // Desktop silence notifications by episode key, so resumption/terminal state
  // can close exactly the one episode's system notification without touching
  // unrelated pending notifications.
  const openSilenceDesktopNotifications = useRef(new Map<string, string>());
  // Threads already seen in a live snapshot. Kept on the always-mounted parent
  // so a child remount caused by both preferences being off does not re-baseline
  // and suppress a genuinely new episode.
  const hydratedThreads = useRef(new Set<string>());
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);
  const dismissNotification = useCallback((tag: string) => {
    const entry = pending.current.get(tag);
    if (entry === undefined) return;
    entry.notification.close();
    pending.current.delete(tag);
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

  useEffect(
    () => () => {
      for (const toastId of openSilenceToasts.current.values()) toastManager.close(toastId);
      openSilenceToasts.current.clear();
    },
    [],
  );

  // When both preferences are off the child list unmounts, so its effect cannot
  // close the warnings it opened. Close them here; the episode memory above
  // still prevents a replay when notifications are re-enabled.
  useEffect(() => {
    if (mode !== "off" || inAppNotificationsEnabled) return;
    for (const toastId of openSilenceToasts.current.values()) toastManager.close(toastId);
    openSilenceToasts.current.clear();
  }, [inAppNotificationsEnabled, mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onNotification={onNotification}
      dismissNotification={dismissNotification}
      notifiedSilenceEpisodes={notifiedSilenceEpisodes}
      openSilenceToasts={openSilenceToasts}
      openSilenceDesktopNotifications={openSilenceDesktopNotifications}
      hydratedThreads={hydratedThreads}
    />
  ));
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
  dismissNotification,
  notifiedSilenceEpisodes,
  openSilenceToasts,
  openSilenceDesktopNotifications,
  hydratedThreads,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
  dismissNotification: (tag: string) => void;
  notifiedSilenceEpisodes: React.RefObject<Set<string>>;
  openSilenceToasts: React.RefObject<Map<string, string>>;
  openSilenceDesktopNotifications: React.RefObject<Map<string, string>>;
  hydratedThreads: React.RefObject<Set<string>>;
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
  // Threads already seen in a live snapshot. The first sighting establishes the
  // hydration baseline for the silence signal: an already-quiet thread the user
  // did not just watch must not toast the moment notifications connect.
  // Owned by the parent so a child remount does not re-baseline.
  // Server-clock basis: the observation stamps the server instant; the receipt
  // registry pairs each distinct observation with the client instant it
  // actually landed, including its monotonic baseline, so unrelated shell
  // updates and renders cannot re-date it.
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
  // quiet past the conservative threshold raises one alert per episode. The
  // environment shell already carries the server-observed activity, so this
  // covers threads the user is not viewing and follows the same in-app,
  // desktop and sound modes as the attention/completion signal above.
  useEffect(() => {
    const prefix = `${environmentId}:`;
    const closeEnvironmentToasts = () => {
      for (const [key, toastId] of [...openSilenceToasts.current]) {
        if (!key.startsWith(prefix)) continue;
        toastManager.close(toastId);
        openSilenceToasts.current.delete(key);
      }
    };
    const closeEnvironmentDesktopNotifications = () => {
      for (const [key, tag] of [...openSilenceDesktopNotifications.current]) {
        if (!key.startsWith(prefix)) continue;
        dismissNotification(tag);
        openSilenceDesktopNotifications.current.delete(key);
      }
    };
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      // A disconnected environment cannot be observed: end its episodes without
      // touching another environment's open warnings or dedup memory.
      closeEnvironmentToasts();
      closeEnvironmentDesktopNotifications();
      return;
    }
    // Turning in-app alerts off closes any open silence toast; the episode stays
    // remembered so re-enabling cannot replay it.
    if (!inAppNotificationsEnabled) {
      closeEnvironmentToasts();
    }
    const seen = new Set<string>();
    for (const thread of shell.snapshot.value.threads) {
      if (thread.archivedAt !== null) continue;
      const live = thread.postStartActivity ?? null;
      const observedAt = live?.observedAt ?? null;
      // Pair each distinct server observation with the client instant it
      // actually arrived. An unrelated shell update or render reuses the same
      // receipt instead of re-dating the observation; the monotonic baseline
      // keeps elapsed time honest across browser wall-clock changes.
      const receipt =
        observedAt === null
          ? undefined
          : rememberPostStartObservationReceipt(
              postStartObservationReceiptKey(environmentId, thread.id, observedAt),
            );
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
        live,
        receivedAtMs: receipt?.wallMs ?? null,
        receivedMonotonicMs: receipt?.monotonicMs ?? null,
      });
      const observation = resolvePostStartActivity(anchors, nowMs, {
        nowMonotonicMs: monotonicNowMs(),
      });
      const baselineKey = `${environmentId}:${thread.id}`;
      // Baseline on the first live observation in any state (active, waiting or
      // ready), not only once it is already quiet, so the first genuine
      // active→quiet transition still notifies. A thread that is already quiet
      // when first seen is recorded as known so hydration cannot storm.
      if (!hydratedThreads.current.has(baselineKey)) {
        hydratedThreads.current.add(baselineKey);
        if (observation.status === "quiet" && observation.episodeKey !== null) {
          notifiedSilenceEpisodes.current.add(`${baselineKey}:${observation.episodeKey}`);
        }
        continue;
      }
      if (observation.status !== "quiet" || observation.episodeKey === null) continue;
      const key = `${baselineKey}:${observation.episodeKey}`;
      seen.add(key);
      if (notifiedSilenceEpisodes.current.has(key)) continue;

      const isForeground = document.visibilityState === "visible" && document.hasFocus();
      // A selected thread is only actively viewed while T3 is foregrounded. In a
      // hidden/unfocused window the existing away-from-T3 preferences apply.
      const isViewing =
        activeEnvironmentId === environmentId && activeThreadId === thread.id && isForeground;
      if (isViewing) {
        notifiedSilenceEpisodes.current.add(key);
        continue;
      }
      const soundEnabled = hasNotificationSound(mode);
      if (soundEnabled) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      // Sound alone is a delivery channel too: mark the episode delivered so
      // sound-only mode does not replay on every timer tick.
      let alerted = soundEnabled;
      if (inAppNotificationsEnabled && isForeground) {
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
        openSilenceToasts.current.set(key, toastId);
        alerted = true;
      } else if (
        hasDesktopNotifications(mode) &&
        !isForeground &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification("No recent provider activity", {
            body: thread.title,
            tag: `${environmentId}:${thread.id}:silence`,
            silent: true,
          });
          onNotification(environmentId, notification);
          openSilenceDesktopNotifications.current.set(key, notification.tag);
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          });
          alerted = true;
        } catch {
          // Browser exposes Notification but rejects desktop presentation.
        }
      }
      if (alerted) notifiedSilenceEpisodes.current.add(key);
    }
    // End this environment's episodes that are no longer quiet (resumption,
    // terminal state); another environment's warnings and dedup memory are
    // untouched.
    for (const key of [...notifiedSilenceEpisodes.current]) {
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      const toastId = openSilenceToasts.current.get(key);
      if (toastId !== undefined) {
        toastManager.close(toastId);
        openSilenceToasts.current.delete(key);
      }
      const tag = openSilenceDesktopNotifications.current.get(key);
      if (tag !== undefined) {
        dismissNotification(tag);
        openSilenceDesktopNotifications.current.delete(key);
      }
      notifiedSilenceEpisodes.current.delete(key);
    }
  }, [
    activeEnvironmentId,
    activeThreadId,
    dismissNotification,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    nowMs,
    onNotification,
    shell,
  ]);

  return null;
}
