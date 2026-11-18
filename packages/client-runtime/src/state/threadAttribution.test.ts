import { EnvironmentId, makeThreadInbox, ThreadId, type ThreadInbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadAttributions, type AttributableThread } from "./threadAttribution.ts";

const asus = EnvironmentId.make("asus");
const air = EnvironmentId.make("air");
const kameron = { kind: "human", id: "kameron" } as const;
const jeff = { kind: "human", id: "jeff" } as const;
const bot = { kind: "agent", id: "lead" } as const;
const thread = (
  id: string,
  inbox: ThreadInbox | null,
  options: { environmentId?: EnvironmentId; parent?: string; createdBy?: string } = {},
): AttributableThread => ({
  environmentId: options.environmentId ?? asus,
  id: ThreadId.make(id),
  lineage: { parentThreadId: options.parent ? ThreadId.make(options.parent) : null },
  source: { inbox, createdBy: options.createdBy },
});
const attributions = (
  threads: ReadonlyArray<AttributableThread>,
  owners: Readonly<Record<string, "kameron" | "jeff">> = {},
) =>
  Object.fromEntries(
    [...resolveThreadAttributions(threads, owners)].map(([key, value]) => [
      key.split(":")[1],
      value,
    ]),
  );

describe("thread attribution", () => {
  it("names the founder, or the founder whose agents did the work", () => {
    expect(
      attributions([
        thread("k", makeThreadInbox({ actor: kameron })),
        thread("j", makeThreadInbox({ actor: jeff })),
        // An agent asked by Jeff, even when the work was filed to Kameron.
        thread(
          "asked",
          makeThreadInbox({ actor: bot, requestedBy: jeff, routing: { owner: "kameron" } }),
        ),
        thread("owned", makeThreadInbox({ actor: bot, routing: { owner: "kameron" } })),
      ]),
    ).toEqual({ k: "kameron", j: "jeff", asked: "jeff-agents", owned: "kameron-agents" });
  });

  it("takes an unowned agent thread's founder from its parent chain", () => {
    const parent = makeThreadInbox({ actor: jeff });
    expect(
      attributions([
        // Listed before its parent, so resolution cannot depend on order.
        thread("grandchild", makeThreadInbox({ actor: bot }), { parent: "child" }),
        thread("child", makeThreadInbox({ actor: bot }), { parent: "root" }),
        thread("root", parent),
      ]),
    ).toEqual({ grandchild: "jeff-agents", child: "jeff-agents", root: "jeff" });
  });

  it("falls back to the machine's owner for history, and never guesses", () => {
    const owners = { [air]: "jeff" } as const;
    expect(
      attributions(
        [
          thread("old-human", null, { environmentId: air }),
          thread("old-agent", null, { environmentId: air, createdBy: "agent" }),
          thread("unmapped", null),
          // A lineage cycle still resolves.
          thread("a", makeThreadInbox({ actor: bot }), { parent: "b" }),
          thread("b", makeThreadInbox({ actor: bot }), { parent: "a" }),
        ],
        owners,
      ),
    ).toEqual({
      "old-human": "jeff",
      "old-agent": "jeff-agents",
      unmapped: "unknown",
      a: "unknown",
      b: "unknown",
    });
  });
});
