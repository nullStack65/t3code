import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PostStartActivityAnchors } from "@t3tools/shared/postStartActivity";

const state = vi.hoisted(() => ({
  inApp: true,
  add: vi.fn(() => "toast-1"),
  close: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { inAppNotificationsEnabled: boolean }) => unknown) =>
    select({ inAppNotificationsEnabled: state.inApp }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { PostStartActivityNotice } from "./PostStartActivityNotice";

const T0 = "2026-01-01T00:00:00.000Z";
const T0_MS = Date.parse(T0);
const THRESHOLD_MS = 5 * 60_000;

function anchors(overrides: Partial<PostStartActivityAnchors> = {}): PostStartActivityAnchors {
  return {
    turnId: "turn-1",
    active: true,
    turnStartedAt: T0,
    lastProviderActivityAt: T0,
    lastToolCompletedAt: null,
    outstandingTools: [],
    outstandingTool: null,
    knownWait: null,
    ...overrides,
  };
}

function renderedText(renderer: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return parts.join(" ");
}

describe("PostStartActivityNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    state.inApp = true;
    state.add.mockClear();
    state.close.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays silent while activity is recent, then warns exactly at the threshold", () => {
    vi.setSystemTime(T0_MS + THRESHOLD_MS - 1_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<PostStartActivityNotice anchors={anchors()} connection="live" />);
    });
    expect(renderedText(renderer)).not.toContain("No provider activity observed");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(renderedText(renderer)).toContain(
      "No provider activity observed for over 5 minutes; this turn may still be working.",
    );
    expect(state.add).toHaveBeenCalledTimes(1);

    // Ticking further in the same episode does not re-notify.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("names an outstanding tool and clears when activity resumes", () => {
    vi.setSystemTime(T0_MS + THRESHOLD_MS);
    const quietAnchors = anchors({
      outstandingTool: {
        toolCallId: "call-1",
        title: "npm test",
        itemType: "command_execution",
        startedAt: T0,
        lastObservedAt: T0,
      },
      outstandingTools: [
        {
          toolCallId: "call-1",
          title: "npm test",
          itemType: "command_execution",
          startedAt: T0,
          lastObservedAt: T0,
        },
      ],
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<PostStartActivityNotice anchors={quietAnchors} connection="live" />);
    });
    expect(renderedText(renderer)).toContain("No activity from npm test");

    // A resumed provider event moves the anchor and clears the warning.
    const resumedAt = "2026-01-01T00:05:00.000Z";
    act(() => {
      renderer.update(
        <PostStartActivityNotice
          anchors={anchors({ lastProviderActivityAt: resumedAt })}
          connection="live"
        />,
      );
    });
    expect(renderedText(renderer)).not.toContain("No activity from npm test");
    expect(state.close).toHaveBeenCalledWith("toast-1");
  });

  it("shows uncertainty instead of a stop when disconnected", () => {
    vi.setSystemTime(T0_MS + 30 * 60_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<PostStartActivityNotice anchors={anchors()} connection="disconnected" />);
    });
    expect(renderedText(renderer)).toContain("its state is unknown");
    expect(state.add).not.toHaveBeenCalled();
  });
});
