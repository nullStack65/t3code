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

  it("blinks only while running, and only when motion is allowed", () => {
    expect(
      renderToStaticMarkup(<BotAvatar avatarId="halo" accent="sky" state="running" />),
    ).toContain("motion-safe:animate-bot-blink");
    expect(renderToStaticMarkup(<BotAvatar avatarId="halo" accent="sky" />)).not.toContain(
      "animate-bot-blink",
    );
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
