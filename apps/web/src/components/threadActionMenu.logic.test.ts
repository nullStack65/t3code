import { describe, expect, it } from "vite-plus/test";

import {
  threadRoutingUpdateFromMenuAction,
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});

it("offers inbox routing only on capable environments and retains ordinary operate grants", () => {
  expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "inbox")).toBe(false);
  const items = buildThreadActionMenuItems({
    ...baseState,
    canOperate: false,
    supports: { ...baseState.supports, inboxRouting: true },
  });
  expect(
    items.find((item) => item.id === "inbox")?.children?.every((child) => child.disabled),
  ).toBe(true);
  expect(threadRoutingUpdateFromMenuAction("inbox:jeff")).toEqual({
    owner: "jeff",
    assignee: { kind: "human", id: "jeff" },
    audience: "jeff",
    attentionKind: "action",
  });
  expect(threadRoutingUpdateFromMenuAction("inbox:agents")).toEqual({
    owner: null,
    assignee: null,
    audience: "agent-only",
    attentionKind: "background",
  });
  expect(threadRoutingUpdateFromMenuAction("attention:FYI")).toEqual({ attentionKind: "FYI" });
  expect(threadRoutingUpdateFromMenuAction("rename")).toBeNull();
});

describe("standing bot menu items", () => {
  const ids = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).map((item) => item.id);

  it("offers Make standing bot only when the environment supports it", () => {
    expect(ids(baseState)).not.toContain("make-bot");
    const supported = { ...baseState, supports: { ...baseState.supports, standing: true } };
    expect(ids(supported)).toContain("make-bot");
    expect(ids(supported)).not.toContain("make-ordinary");
  });

  it("offers editing and reverting on a bot, independent of pinning", () => {
    const bot = {
      ...baseState,
      isPinned: true,
      isStanding: true,
      supports: { ...baseState.supports, standing: true },
    };
    const items = ids(bot);
    expect(items).toEqual(expect.arrayContaining(["unpin", "edit-bot", "make-ordinary"]));
    expect(items).not.toContain("make-bot");
  });
});
