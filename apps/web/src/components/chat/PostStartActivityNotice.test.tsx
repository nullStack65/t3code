import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PostStartActivityAnchors } from "@t3tools/shared/postStartActivity";

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
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays informative while active, then warns exactly at the threshold", () => {
    vi.setSystemTime(T0_MS + THRESHOLD_MS - 1_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<PostStartActivityNotice anchors={anchors()} connection="live" />);
    });
    expect(renderedText(renderer)).toContain("Provider active");
    expect(renderedText(renderer)).not.toContain("No provider activity observed");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(renderedText(renderer)).toContain(
      "No provider activity observed for over 5 minutes; this turn may still be working.",
    );
  });

  it("names an outstanding tool while active and when quiet", () => {
    const tool = {
      toolCallId: "call-1",
      title: "npm test",
      itemType: "command_execution",
      startedAt: T0,
      lastObservedAt: T0,
    };
    vi.setSystemTime(T0_MS + 2 * 60_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <PostStartActivityNotice
          anchors={anchors({ outstandingTool: tool, outstandingTools: [tool] })}
          connection="live"
        />,
      );
    });
    expect(renderedText(renderer)).toContain("Working: npm test");

    act(() => {
      vi.setSystemTime(T0_MS + 8 * 60_000);
      vi.advanceTimersByTime(1_000);
    });
    expect(renderedText(renderer)).toContain("No activity from npm test");
  });

  it("shows a pending decision as an explained wait, not silence", () => {
    vi.setSystemTime(T0_MS + 30 * 60_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <PostStartActivityNotice anchors={anchors({ knownWait: "approval" })} connection="live" />,
      );
    });
    expect(renderedText(renderer)).toContain("Waiting for your approval");
  });

  it("shows uncertainty instead of a stop when disconnected", () => {
    vi.setSystemTime(T0_MS + 30 * 60_000);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<PostStartActivityNotice anchors={anchors()} connection="disconnected" />);
    });
    expect(renderedText(renderer)).toContain("its state is unknown");
  });
});
