import { describe, expect, it } from "@effect/vitest";
import {
  type AppConnectionReport,
  EnvironmentId,
  type KnownEnvironmentAction,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { knownEnvironments } from "./knownEnvironments.ts";

const self = EnvironmentId.make("laptop");

const link = (
  id: string,
  label: string,
  overrides: Partial<PeerLinkSummary> = {},
): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(id),
  label,
  urls: [`https://${id}.example.ts.net`],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  appPairing: true,
  serverVersion: "0.1.10",
  ...overrides,
});

const app = (
  id: string,
  label: string,
  overrides: Partial<AppConnectionReport> = {},
): AppConnectionReport => ({
  environmentId: EnvironmentId.make(id),
  label,
  urls: [`https://${id}.example.ts.net`],
  serverVersion: "0.1.10",
  keepsLinkLimits: true,
  ...overrides,
});

describe("knownEnvironments", () => {
  it.each<{
    readonly name: string;
    readonly links: ReadonlyArray<PeerLinkSummary>;
    readonly reports: ReadonlyArray<AppConnectionReport>;
    readonly action: KnownEnvironmentAction | null | "none";
    readonly message?: string;
  }>([
    {
      name: "an app connection too old to link asks for an update",
      links: [],
      reports: [
        app("crown", "Crown", {
          serverVersion: "0.1.2",
          keepsLinkLimits: false,
          urls: ["http://192.168.0.27:3773"],
        }),
      ],
      action: "update",
      message: "Crown 0.1.2 is too old to link, so agents here cannot work there. Update it.",
    },
    {
      name: "an app connection reached only over LAN http asks for a safe address",
      links: [],
      reports: [app("box", "Box", { urls: ["http://192.168.0.9:3773"] })],
      action: "add-address",
    },
    {
      name: "an app connection with a Tailscale address offers to link",
      links: [],
      reports: [app("box", "Box", { urls: ["http://box.tail1234.ts.net:3773"] })],
      action: "link",
    },
    {
      name: "a link the app lacks offers to add it",
      links: [link("asus", "ASUS")],
      reports: [],
      action: "add-to-app",
    },
    {
      name: "a link to a peer too old to add itself asks for an update",
      links: [link("r720", "R720", { appPairing: false, serverVersion: "0.1.8" })],
      reports: [],
      action: "update",
      message: "R720 0.1.8 is linked for agents but too old to add to the app. Update it.",
    },
    {
      name: "a silent link says why it cannot be added now",
      links: [link("r720", "R720", { status: "unreachable" })],
      reports: [],
      action: null,
    },
    {
      name: "an expired link asks to link again even when the app has it",
      links: [link("asus", "ASUS", { status: "expired" })],
      reports: [app("asus", "ASUS")],
      action: "relink",
    },
    {
      name: "a machine on both sides has no issue",
      links: [link("asus", "ASUS")],
      reports: [app("asus", "ASUS")],
      action: "none",
    },
  ])("$name", ({ links, reports, action, message }) => {
    const [entry, ...rest] = knownEnvironments({ self, links, reports });
    expect(rest).toEqual([]);
    expect(entry?.issue === null ? "none" : entry?.issue.action).toBe(action);
    if (message !== undefined) expect(entry?.issue?.message).toBe(message);
  });

  it("lists each machine once, named as the app names it, and never itself", () => {
    const listed = knownEnvironments({
      self,
      links: [link("asus", "asus-box", { urls: ["https://asus.example.ts.net"] })],
      reports: [
        app("laptop", "This laptop"),
        app("asus", "ASUS", { urls: ["http://asus.tail1.ts.net:3773"] }),
        app("crown", "Crown", { keepsLinkLimits: false }),
        app("crown", "Crown", { urls: ["http://crown.tail1.ts.net:3773"] }),
      ],
    });
    expect(listed.map((entry) => [entry.environmentId, entry.label, entry.inApp])).toEqual([
      ["asus", "ASUS", true],
      ["crown", "Crown", true],
    ]);
    expect(listed[0]?.urls).toEqual([
      "https://asus.example.ts.net",
      "http://asus.tail1.ts.net:3773",
    ]);
    expect(listed[1]?.urls).toEqual([
      "https://crown.example.ts.net",
      "http://crown.tail1.ts.net:3773",
    ]);
    expect(listed[0]?.link?.access).toBe("full-access");
    expect(listed[1]?.link).toBeNull();
  });
});
