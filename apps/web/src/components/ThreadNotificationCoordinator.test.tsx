import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  sessionRunning: false,
  postStartActivity: null as null | {
    lastProviderActivityAt: string | null;
    lastToolCompletedAt: string | null;
    outstandingTools: [];
    observedAt?: string | null;
  },
  environments: ["env-1"] as string[],
  threadsByEnv: {} as Record<string, ReadonlyArray<Record<string, unknown>>>,
  envLive: {} as Record<string, boolean>,
  toastCounter: 0,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      `toast-${++state.toastCounter}`,
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => {
    if (!state.live || state.envLive[environmentId] === false) {
      return { status: "disconnected", snapshot: Option.none() };
    }
    const threads = state.threadsByEnv[environmentId] ?? [
      {
        id: "thread-1",
        title: "Fix the login form",
        archivedAt: state.archivedAt,
        hasPendingUserInput: state.input,
        hasPendingApprovals: state.approval,
        session: state.sessionError
          ? { status: "error" }
          : state.sessionRunning
            ? { status: "running", activeTurnId: "turn-1" }
            : null,
        postStartActivity: state.postStartActivity,
        latestUserMessageAt: null,
        latestTurn: {
          turnId: "turn-1",
          state: state.turnError ? "error" : state.completedAt ? "completed" : "running",
          completedAt: state.completedAt,
        },
      },
    ];
    return { status: "live", snapshot: Option.some({ threads }) };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.environments.map((environmentId) => ({ environmentId })),
  }),
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
import { resetPostStartObservationReceipts } from "@t3tools/client-runtime/state/post-start-observation-receipt";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

const MIN = 60_000;
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
/**
 * A running thread carrying a real server observation basis. `lastActivityAgoMs`
 * of 0 is fresh activity (active); past five minutes is quiet.
 */
function observedThread(
  overrides: Partial<{ id: string; title: string; lastActivityAgoMs: number }> = {},
) {
  const lastActivityAgoMs = overrides.lastActivityAgoMs ?? 0;
  return {
    id: overrides.id ?? "thread-1",
    title: overrides.title ?? "Fix the login form",
    archivedAt: null,
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    session: { status: "running", activeTurnId: "turn-1" },
    latestUserMessageAt: null,
    latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
    postStartActivity: {
      lastProviderActivityAt: agoIso(lastActivityAgoMs),
      lastToolCompletedAt: null,
      outstandingTools: [],
      observedAt: agoIso(0),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPostStartObservationReceipts();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    sessionRunning: false,
    postStartActivity: null,
    environments: ["env-1"],
    threadsByEnv: {},
    envLive: {},
    toastCounter: 0,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stubWindow = new EventTarget() as EventTarget & {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  stubWindow.setInterval = globalThis.setInterval.bind(globalThis);
  stubWindow.clearInterval = globalThis.clearInterval.bind(globalThis);
  vi.stubGlobal("window", stubWindow);
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("does not storm on the first live snapshot and warns once per later episode", async () => {
    state.sessionRunning = true;
    state.postStartActivity = {
      lastProviderActivityAt: "2020-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    // First live snapshot: an already-quiet thread is baselined, not alerted.
    await render();
    expect(state.add).not.toHaveBeenCalled();

    // A later episode (a new quiet origin) alerts once.
    state.postStartActivity = {
      lastProviderActivityAt: "2021-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "No recent provider activity" }),
    );

    // Another shell update within the same episode does not re-notify.
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);

    // Real resumption: the episode ends and the toast closes.
    state.postStartActivity = {
      lastProviderActivityAt: new Date().toISOString(),
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("keeps first-load quiet suppression across repeated unchanged evaluations (C1)", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = true;
    const stale = (id: string) => observedThread({ id, title: id, lastActivityAgoMs: 6 * MIN });
    // Several already-stale threads with current-shaped observations arrive in
    // the first live snapshot: hydration must not alert and must keep the
    // suppression, so an unchanged repeated evaluation does not alert either.
    // Hold the same observation objects across evaluations: an unchanged
    // server snapshot keeps the same quiet origin and episode identity.
    const quietB = stale("thread-b");
    const quietC = stale("thread-c");
    state.threadsByEnv["env-1"] = [stale("thread-a"), quietB, quietC];
    await render();
    await render();
    await render();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();

    // Real progress on thread-a ends its episode; thread-b/thread-c stay quiet
    // and already suppressed.
    state.threadsByEnv["env-1"] = [
      observedThread({ id: "thread-a", title: "thread-a", lastActivityAgoMs: 0 }),
      quietB,
      quietC,
    ];
    await render();
    expect(state.add).not.toHaveBeenCalled();

    // A genuinely new silence episode on thread-a alerts exactly once.
    state.threadsByEnv["env-1"] = [
      observedThread({ id: "thread-a", title: "thread-a", lastActivityAgoMs: 7 * MIN }),
      quietB,
      quietC,
    ];
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "No recent provider activity", description: "thread-a" }),
    );
  });

  it("does not replay an episode across a preference remount", async () => {
    state.sessionRunning = true;
    state.postStartActivity = {
      lastProviderActivityAt: "2020-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    state.postStartActivity = {
      lastProviderActivityAt: "2021-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);

    // Both preferences off unmounts the environment list and closes the toast.
    state.inApp = false;
    await render();
    expect(state.close).toHaveBeenCalledWith("toast-1");

    // Re-enabling does not replay the same episode.
    state.inApp = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not warn about a silent thread the user is viewing", async () => {
    state.sessionRunning = true;
    state.active.threadId = "thread-1";
    state.postStartActivity = {
      lastProviderActivityAt: "2020-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    state.postStartActivity = {
      lastProviderActivityAt: "2021-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("raises a desktop alert for silence when away from T3", async () => {
    state.sessionRunning = true;
    state.mode = "notifications";
    state.focused = false;
    state.postStartActivity = {
      lastProviderActivityAt: "2020-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    state.postStartActivity = {
      lastProviderActivityAt: "2021-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("No recent provider activity", {
      body: "Fix the login form",
      tag: "env-1:thread-1:silence",
      silent: true,
    });
  });

  it("plays the input sound for a silence alert when sound is enabled", async () => {
    state.sessionRunning = true;
    state.mode = "notifications-and-sound";
    state.postStartActivity = {
      lastProviderActivityAt: "2020-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    state.postStartActivity = {
      lastProviderActivityAt: "2021-01-01T00:00:00.000Z",
      lastToolCompletedAt: null,
      outstandingTools: [],
    };
    await render();
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("baselines on the first live observation then notifies on the real quiet transition", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = true;
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 0 })];

    // First live sighting while active: establish the baseline without alerting.
    await render();
    expect(state.add).not.toHaveBeenCalled();

    // The first genuine active→quiet transition notifies once.
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 6 * MIN })];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "No recent provider activity" }),
    );

    // Staying quiet does not repeat.
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("keeps each environment's warnings and episode memory isolated", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = true;
    state.environments = ["env-1", "env-2"];
    const a = (lastActivityAgoMs: number) =>
      observedThread({ id: "thread-a", title: "Thread A", lastActivityAgoMs });
    const b = (lastActivityAgoMs: number) =>
      observedThread({ id: "thread-b", title: "Thread B", lastActivityAgoMs });
    state.threadsByEnv["env-1"] = [a(0)];
    state.threadsByEnv["env-2"] = [b(0)];
    await render(); // baseline both envs, no alerts

    state.threadsByEnv["env-1"] = [a(6 * MIN)];
    state.threadsByEnv["env-2"] = [b(6 * MIN)];
    await render(); // both quiet → one alert each
    expect(state.add).toHaveBeenCalledTimes(2);
    const idFor = (description: string) => {
      const index = state.add.mock.calls.findIndex((call) => call[0]?.description === description);
      return state.add.mock.results[index]?.value;
    };
    const toastA = idFor("Thread A");
    const toastB = idFor("Thread B");
    expect(toastA).toBeDefined();
    expect(toastB).toBeDefined();

    // env-2 resumes: only its own warning closes.
    state.threadsByEnv["env-2"] = [b(0)];
    await render();
    expect(state.close).toHaveBeenCalledWith(toastB);
    expect(state.close).not.toHaveBeenCalledWith(toastA);

    // env-2 quiet again on a new origin notifies again; env-1's memory is intact
    // and does not replay.
    state.threadsByEnv["env-2"] = [b(7 * MIN)];
    await render();
    expect(state.add).toHaveBeenCalledTimes(3);
    expect(state.add.mock.calls[2]?.[0]?.description).toBe("Thread B");
  });

  it("delivers sound-only once per episode rather than on every tick", async () => {
    state.mode = "sound";
    state.inApp = false;
    state.focused = true;
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 0 })];
    await render();
    expect(state.sound).not.toHaveBeenCalled();

    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 6 * MIN })];
    await render();
    expect(state.sound).toHaveBeenCalledTimes(1);

    // Repeated shell/clock ticks within the same episode stay silent.
    await render();
    await render();
    expect(state.sound).toHaveBeenCalledTimes(1);

    // A new episode (new quiet origin) delivers again.
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 7 * MIN })];
    await render();
    expect(state.sound).toHaveBeenCalledTimes(2);
  });

  it("closes the matching desktop silence notification on resumption, leaving others open", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = false;
    state.environments = ["env-1", "env-2"];
    const a = (lastActivityAgoMs: number) =>
      observedThread({ id: "thread-a", title: "Thread A", lastActivityAgoMs });
    const b = (lastActivityAgoMs: number) =>
      observedThread({ id: "thread-b", title: "Thread B", lastActivityAgoMs });
    state.threadsByEnv["env-1"] = [a(0)];
    state.threadsByEnv["env-2"] = [b(0)];
    await render();

    state.threadsByEnv["env-1"] = [a(6 * MIN)];
    state.threadsByEnv["env-2"] = [b(6 * MIN)];
    await render();
    const sent = state.notification.mock.results.map(
      (result) => result.value as { tag: string; close: ReturnType<typeof vi.fn> },
    );
    const silenceA = sent.find((notification) => notification.tag === "env-1:thread-a:silence");
    const silenceB = sent.find((notification) => notification.tag === "env-2:thread-b:silence");
    expect(silenceA).toBeDefined();
    expect(silenceB).toBeDefined();

    // env-1 resumes: its desktop warning closes; env-2's stays.
    state.threadsByEnv["env-1"] = [a(0)];
    await render();
    expect(silenceA!.close).toHaveBeenCalled();
    expect(silenceB!.close).not.toHaveBeenCalled();
  });

  it("treats a selected thread in a hidden window as away from T3", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = false;
    state.visible = "hidden";
    state.active = { environmentId: "env-1", threadId: "thread-1" };
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 0 })];
    await render();

    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 6 * MIN })];
    await render();
    // Not actively viewed, so the away-from-T3 desktop preference applies
    // instead of suppressing the warning.
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(
      "No recent provider activity",
      expect.objectContaining({ tag: "env-1:thread-1:silence" }),
    );
  });

  it("closes the desktop silence notification when the turn reaches terminal state", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = false;
    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 0 })];
    await render();

    state.threadsByEnv["env-1"] = [observedThread({ lastActivityAgoMs: 6 * MIN })];
    await render();
    const sent = state.notification.mock.results.map(
      (result) => result.value as { tag: string; close: ReturnType<typeof vi.fn> },
    );
    const silence = sent.find((notification) => notification.tag === "env-1:thread-1:silence");
    expect(silence).toBeDefined();

    // The turn finishes rather than resuming: the warning is closed.
    state.threadsByEnv["env-1"] = [
      {
        ...observedThread({ lastActivityAgoMs: 6 * MIN }),
        session: { status: "ready", activeTurnId: null },
        latestTurn: { turnId: "turn-1", state: "completed", completedAt: agoIso(0) },
      },
    ];
    await render();
    expect(silence!.close).toHaveBeenCalled();
  });

  it("closes only the disconnected environment's live warnings", async () => {
    state.mode = "notifications";
    state.inApp = true;
    state.focused = true;
    state.environments = ["env-1", "env-2"];
    const a = observedThread({ id: "thread-a", title: "Thread A", lastActivityAgoMs: 0 });
    const b = observedThread({ id: "thread-b", title: "Thread B", lastActivityAgoMs: 0 });
    state.threadsByEnv["env-1"] = [a];
    state.threadsByEnv["env-2"] = [b];
    await render();

    const quiet = (thread: typeof a) => ({
      ...thread,
      postStartActivity: {
        ...thread.postStartActivity,
        lastProviderActivityAt: agoIso(6 * MIN),
      },
    });
    state.threadsByEnv["env-1"] = [quiet(a)];
    state.threadsByEnv["env-2"] = [quiet(b)];
    await render();
    expect(state.add).toHaveBeenCalledTimes(2);
    const toastA = state.add.mock.calls[0]?.[0];
    const toastB = state.add.mock.calls[1]?.[0];
    const idFor = (description: string) => {
      const index = state.add.mock.calls.findIndex((call) => call[0]?.description === description);
      return state.add.mock.results[index]?.value;
    };
    expect(toastA?.description).toBe("Thread A");
    expect(toastB?.description).toBe("Thread B");
    const idA = idFor("Thread A");
    const idB = idFor("Thread B");

    // env-2 disconnects: its warning closes; env-1's live warning stays.
    state.envLive["env-2"] = false;
    await render();
    expect(state.close).toHaveBeenCalledWith(idB);
    expect(state.close).not.toHaveBeenCalledWith(idA);
  });
});
