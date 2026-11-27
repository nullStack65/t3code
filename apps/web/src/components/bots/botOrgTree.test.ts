import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isFounderName, orderBotTree, visibleBotRows } from "./botOrgTree";
import { splitStandingThreads } from "./botPresence";

const bot = (name: string) => ({ id: name, standing: { name } });
const shape = (names: string[]) =>
  orderBotTree(names.map(bot)).map(({ thread, depth }) => `${depth}:${thread.id}`);

describe("orderBotTree", () => {
  it("nests the exec team under CEO and engineering under CTO", () => {
    expect(
      shape([
        "PR Reviewer",
        "Growth",
        "Release Engineer",
        "CFO",
        "CEO",
        "Infra / ARC Ops",
        "Platform",
        "CTO",
        "Product",
        "CoS",
      ]),
    ).toEqual([
      "0:CoS",
      "0:CEO",
      "1:CTO",
      "2:Platform",
      "2:Infra / ARC Ops",
      "2:Release Engineer",
      "2:PR Reviewer",
      "1:CFO",
      "1:Product",
      "1:Growth",
    ]);
  });

  it("shows a bot as a root when its manager is not in the list", () => {
    expect(shape(["CTO", "Platform"])).toEqual(["0:CTO", "1:Platform"]);
    expect(shape(["Platform", "CFO"])).toEqual(["0:CFO", "0:Platform"]);
  });

  it("maps existing persona names to their seat and sorts unknown bots last", () => {
    expect(shape(["Zed", "Platform / CTO", "CTO", "Product / Site", "CEO", "Alpha"])).toEqual([
      "0:CEO",
      "1:CTO",
      "2:Platform / CTO",
      "1:Product / Site",
      "0:Alpha",
      "0:Zed",
    ]);
  });

  it("never drops a bot, even with duplicate seats", () => {
    expect(shape(["CEO", "CTO", "CTO"]).length).toBe(3);
  });
});

describe("founders are not bots", () => {
  it("recognizes founder names", () => {
    expect(isFounderName(" Kameron ")).toBe(true);
    expect(isFounderName("Jeff")).toBe(true);
    expect(isFounderName("CEO")).toBe(false);
  });

  it("keeps a founder thread out of the Bots shelf", () => {
    const lineage = {
      parentThreadId: null,
      rootThreadId: ThreadId.make("root"),
      relationshipToParent: null,
    };
    const persona = (name: string) => ({ name, avatarId: "bolt", accent: "sky" }) as const;
    const { bots, rest } = splitStandingThreads([
      { id: "k", lineage, standing: persona("Kameron") },
      { id: "c", lineage, standing: persona("CEO") },
      { id: "w", lineage, standing: null },
    ]);
    expect(bots.map((t) => t.id)).toEqual(["c"]);
    expect(rest.map((t) => t.id)).toEqual(["k", "w"]);
  });
});

describe("visibleBotRows", () => {
  const rows = orderBotTree(["CEO", "CTO", "Platform", "CFO", "CoS"].map(bot));
  const shown = (collapsed: string[]) =>
    visibleBotRows(rows, (thread) => collapsed.includes(thread.id)).map(
      (row) => `${row.depth}:${row.thread.id}${row.hasReports ? (row.collapsed ? "+" : "-") : ""}`,
    );

  it("marks bots with reports and lists everything when nothing is collapsed", () => {
    expect(shown([])).toEqual(["0:CoS", "0:CEO-", "1:CTO-", "2:Platform", "1:CFO"]);
  });

  it("hides a collapsed bot's whole subtree but not its siblings", () => {
    expect(shown(["CTO"])).toEqual(["0:CoS", "0:CEO-", "1:CTO+", "1:CFO"]);
    expect(shown(["CEO"])).toEqual(["0:CoS", "0:CEO+"]);
  });

  it("ignores a collapse flag on a bot with no reports", () => {
    expect(shown(["Platform"])).toEqual(shown([]));
  });
});
