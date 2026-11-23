import { describe, expect, it } from "vite-plus/test";

import { isFounderName, orderBotTree } from "./botOrgTree";
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
    const { bots, rest } = splitStandingThreads([
      { id: "k", standing: { name: "Kameron" } },
      { id: "c", standing: { name: "CEO" } },
      { id: "w", standing: null },
    ]);
    expect(bots.map((t) => t.id)).toEqual(["c"]);
    expect(rest.map((t) => t.id)).toEqual(["k", "w"]);
  });
});
