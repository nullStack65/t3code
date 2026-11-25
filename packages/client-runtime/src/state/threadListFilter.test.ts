import { EnvironmentId, type Founder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchesOlderSettledGroup,
  matchesThreadListFilter,
  threadListFilterOf,
} from "./threadListFilter.ts";

const environmentId = EnvironmentId.make("crown");

const inboxOf = (owner: Founder | null, audience: string | undefined) =>
  ({ owner, audience }) as never;

const thread = (
  inbox: ReturnType<typeof inboxOf> | undefined,
  options: { readonly standing?: boolean; readonly archived?: boolean } = {},
) => ({
  environmentId,
  standing: options.standing === true ? { name: "Bot" } : null,
  archivedAt: options.archived === true ? "2026-11-25T00:00:00.000Z" : null,
  source: { inbox },
});

/** Every inbox is checked, so only the founder rule can hide a thread. */
const filterFor = (viewingFounder: Founder | undefined) =>
  threadListFilterOf({
    ...(viewingFounder === undefined ? {} : { founderInboxOwner: viewingFounder }),
    founderInboxFilter: ["kameron", "jeff", "shared", "agents"],
  });

const cos = inboxOf("kameron", "kameron");
const cosJeff = inboxOf("jeff", "jeff");
const shared = inboxOf(null, "shared");

describe("matchesThreadListFilter asymmetric founder visibility", () => {
  it("takes the viewing founder from the settings", () => {
    expect(threadListFilterOf({ founderInboxOwner: "jeff" }).viewingFounder).toBe("jeff");
    expect(threadListFilterOf({}).viewingFounder).toBeUndefined();
  });

  describe("viewing as jeff", () => {
    const filter = filterFor("jeff");

    it("hides Kameron's threads and standing bots, even with every inbox checked", () => {
      expect(matchesThreadListFilter(thread(cos), filter)).toBe(false);
      expect(matchesThreadListFilter(thread(cos, { standing: true }), filter)).toBe(false);
      expect(matchesThreadListFilter(thread(inboxOf(null, "kameron")), filter)).toBe(false);
      expect(
        matchesThreadListFilter(thread(inboxOf(null, "kameron"), { standing: true }), filter),
      ).toBe(false);
    });

    it("hides a Kameron-owned thread or bot filed Agents-only or with no audience", () => {
      for (const audience of ["agent-only", undefined]) {
        const inbox = inboxOf("kameron", audience);
        expect(matchesThreadListFilter(thread(inbox), filter)).toBe(false);
        expect(matchesThreadListFilter(thread(inbox, { standing: true }), filter)).toBe(false);
      }
    });

    it("keeps Jeff's, shared and Kameron-owned shared or Jeff-audience threads and bots", () => {
      for (const inbox of [
        cosJeff,
        shared,
        inboxOf("kameron", "shared"),
        inboxOf("kameron", "jeff"),
      ]) {
        expect(matchesThreadListFilter(thread(inbox), filter)).toBe(true);
        expect(matchesThreadListFilter(thread(inbox, { standing: true }), filter)).toBe(true);
      }
    });

    it("keeps a thread with no inbox", () => {
      expect(matchesThreadListFilter(thread(undefined), filter)).toBe(true);
      expect(matchesThreadListFilter(thread(null as never), filter)).toBe(true);
    });

    it("still lists Jeff's own standing bot when his inbox checkboxes would drop it", () => {
      const onlyShared = { ...filter, inboxes: ["shared"] as const };
      expect(matchesThreadListFilter(thread(cosJeff), onlyShared)).toBe(false);
      expect(matchesThreadListFilter(thread(cosJeff, { standing: true }), onlyShared)).toBe(true);
    });

    it("hides Kameron's older settled groups", () => {
      const group = (inbox: "kameron" | "jeff" | "shared" | "agents" | null) => ({
        inbox,
        agentCreated: false,
        founder: "machine" as const,
        byAgent: false,
        count: 3,
      });
      expect(matchesOlderSettledGroup(environmentId, group("kameron"), filter, {})).toBe(false);
      expect(matchesOlderSettledGroup(environmentId, group("jeff"), filter, {})).toBe(true);
      expect(matchesOlderSettledGroup(environmentId, group("shared"), filter, {})).toBe(true);
    });
  });

  describe("viewing as kameron", () => {
    const filter = filterFor("kameron");

    it("keeps Jeff's personal threads and bots next to his own and shared ones", () => {
      for (const inbox of [cosJeff, cos, shared, inboxOf("jeff", "jeff")]) {
        expect(matchesThreadListFilter(thread(inbox), filter)).toBe(true);
        expect(matchesThreadListFilter(thread(inbox, { standing: true }), filter)).toBe(true);
      }
    });

    it("keeps Kameron-owned Agents-only threads and a thread with no inbox", () => {
      expect(matchesThreadListFilter(thread(inboxOf("kameron", "agent-only")), filter)).toBe(true);
      expect(matchesThreadListFilter(thread(undefined), filter)).toBe(true);
    });

    it("still hides an archived standing bot, as before", () => {
      expect(
        matchesThreadListFilter(thread(cosJeff, { standing: true, archived: true }), {
          ...filter,
          inboxes: ["kameron"],
        }),
      ).toBe(false);
    });

    it("keeps Jeff's older settled groups", () => {
      expect(
        matchesOlderSettledGroup(
          environmentId,
          { inbox: "jeff", agentCreated: false, founder: "machine", byAgent: false, count: 1 },
          filter,
          {},
        ),
      ).toBe(true);
    });
  });

  it("hides nothing for a client that chose no founder", () => {
    const filter = filterFor(undefined);
    expect(matchesThreadListFilter(thread(cos, { standing: true }), filter)).toBe(true);
    expect(matchesThreadListFilter(thread(cosJeff, { standing: true }), filter)).toBe(true);
  });
});
