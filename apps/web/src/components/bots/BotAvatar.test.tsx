import { THREAD_STANDING_AVATAR_IDS } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";

describe("BotAvatar", () => {
  it("rings needs-you in the accent and failed in destructive", () => {
    const needsYou = renderToStaticMarkup(
      <BotAvatar avatarId="bolt" accent="rose" state="needs-you" />,
    );
    expect(needsYou).toContain("ring-2");
    expect(needsYou).toContain("ring-rose-500/70");
    const failed = renderToStaticMarkup(<BotAvatar avatarId="bolt" accent="rose" state="failed" />);
    expect(failed).toContain("ring-destructive/80");
    expect(renderToStaticMarkup(<BotAvatar avatarId="bolt" accent="rose" />)).not.toContain(
      "ring-2",
    );
  });

  it("blinks only while idle or running, and only when motion is allowed", () => {
    for (const state of ["idle", "running"] as const) {
      expect(
        renderToStaticMarkup(<BotAvatar avatarId="halo" accent="sky" state={state} />),
      ).toContain("motion-safe:animate-bot-blink");
    }
    for (const state of ["waiting", "needs-you", "failed"] as const) {
      expect(
        renderToStaticMarkup(<BotAvatar avatarId="halo" accent="sky" state={state} />),
      ).not.toContain("animate-bot-blink");
    }
  });

  it("gives each state its own motion, and never animates under reduced motion", () => {
    const markup = (state: "idle" | "running" | "waiting" | "needs-you" | "failed") =>
      renderToStaticMarkup(<BotAvatar avatarId="visor" accent="amber" state={state} />);
    expect(markup("idle")).toContain("motion-safe:animate-bot-breathe");
    const running = markup("running");
    expect(running).toContain("motion-safe:animate-bot-scan");
    expect(running).toContain("motion-safe:animate-bot-antenna");
    expect(running).toContain("motion-safe:animate-status-pulse");
    expect(markup("waiting")).toContain("motion-safe:animate-bot-wait");
    for (const state of ["idle", "running", "waiting"] as const) {
      expect(markup(state)).not.toMatch(/(^|\s)animate-/);
    }
  });

  it("marks an antenna on every avatar so the working pulse has something to move", () => {
    for (const avatarId of THREAD_STANDING_AVATAR_IDS) {
      expect(
        renderToStaticMarkup(<BotAvatar avatarId={avatarId} accent="teal" state="running" />),
      ).toContain("data-bot-antenna");
    }
  });

  it("draws every avatar and falls back for unknown ids", () => {
    for (const avatarId of THREAD_STANDING_AVATAR_IDS) {
      expect(renderToStaticMarkup(<BotAvatar avatarId={avatarId} accent="teal" />)).toContain(
        "<svg",
      );
    }
    expect(renderToStaticMarkup(<BotAvatar avatarId="nope" accent="nope" />)).toBe(
      renderToStaticMarkup(<BotAvatar avatarId={THREAD_STANDING_AVATAR_IDS[0]} accent="sky" />),
    );
  });
});
