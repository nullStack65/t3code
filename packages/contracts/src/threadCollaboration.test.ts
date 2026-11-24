import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import {
  applyCollaborationUpdate,
  collaborationUpdateError,
  openPromises,
  promiseState,
  roomCloseRecord,
  roomFacilitatorNote,
  StoredThreadCollaboration,
  THREAD_MAX_PROMISES,
  ThreadCollaborationUpdate,
  type ThreadCollaboration,
} from "./threadCollaboration.ts";
import { ThreadDecisionAsk } from "./threadInbox.ts";

const cos = ThreadId.make("thread-cos");
const growth = ThreadId.make("thread-growth");
const T0 = "2026-11-24T15:00:00.000Z";
const T1 = "2026-11-24T16:00:00.000Z";
const decodeUpdate = Schema.decodeUnknownSync(ThreadCollaborationUpdate);
const isDecisionAsk = Schema.is(ThreadDecisionAsk);
const decodeStored = Schema.decodeUnknownSync(StoredThreadCollaboration);

const openRoom = applyCollaborationUpdate(
  undefined,
  {
    type: "open_room",
    room: { topic: "How we set up Growth", members: [cos, growth], linearIssue: "CLO-1200" },
  },
  T0,
);

describe("rooms", () => {
  it("rejects a room with fewer than two members or a repeated member", () => {
    expect(() =>
      decodeUpdate({ type: "open_room", room: { topic: "x", members: [cos] } }),
    ).toThrow();
    expect(() =>
      decodeUpdate({ type: "open_room", room: { topic: "x", members: [cos, cos] } }),
    ).toThrow();
    expect(() =>
      decodeUpdate({
        type: "open_room",
        room: { topic: "x", members: [cos, growth], linearIssue: "not an issue" },
      }),
    ).toThrow();
  });

  it("keeps the opening time when members change and refuses to close twice", () => {
    const changed = applyCollaborationUpdate(
      openRoom,
      {
        type: "open_room",
        room: { topic: "How we set up Growth", members: [cos, growth, ThreadId.make("cfo")] },
      },
      T1,
    );
    expect(changed.room?.openedAt).toBe(T0);
    expect(changed.room?.members).toHaveLength(3);

    const close = {
      type: "close_room" as const,
      close: {
        summary: "Growth owns outbound.",
        decisions: [{ text: "Growth runs the weekly list", owner: "Growth" }],
      },
    };
    const closed = applyCollaborationUpdate(openRoom, close, T1);
    expect(closed.room?.closedAt).toBe(T1);
    expect(collaborationUpdateError(closed, close)).toMatch(/no open room/);
    // A replayed close leaves the first close in place.
    expect(
      applyCollaborationUpdate(
        closed,
        { ...close, close: { summary: "other", decisions: [] } },
        T1,
      ),
    ).toEqual(closed);
    expect(roomFacilitatorNote(closed.room!)).toBe("");
  });

  it("writes the close record for Linear and memory", () => {
    const closed = applyCollaborationUpdate(
      openRoom,
      {
        type: "close_room",
        close: {
          summary: "Growth owns outbound.",
          decisions: [
            { text: "Growth runs the weekly list", owner: "Growth", dueAt: "2026-11-28T17:00:00Z" },
            { text: "CoS reviews it Fridays" },
          ],
        },
      },
      T1,
    );
    const record = roomCloseRecord(closed.room!);
    expect(record?.linearIssue).toBe("CLO-1200");
    expect(record?.linearComment).toContain("## Room closed: How we set up Growth");
    expect(record?.linearComment).toContain(
      "- Growth runs the weekly list (owner: Growth, due 2026-11-28T17:00:00Z)",
    );
    expect(record?.memoryEntry).toContain("- CoS reviews it Fridays");
    expect(roomCloseRecord(openRoom.room!)).toBeNull();
  });

  it("tells an open room's facilitator who to fan out to", () => {
    const note = roomFacilitatorNote(openRoom.room!);
    expect(note).toContain(`${cos}, ${growth}`);
    expect(note).toContain("on CLO-1200");
  });
});

describe("promises", () => {
  const promise = (id: string, dueAt: string) => ({
    type: "set_promise" as const,
    promise: { id, text: `Ship ${id}`, dueAt },
  });

  it("turns overdue at its due time and stops counting once kept", () => {
    const state = applyCollaborationUpdate(undefined, promise("a", T1), T0);
    const [stored] = state.promises!;
    expect(promiseState(stored!, Date.parse(T0))).toBe("open");
    expect(promiseState(stored!, Date.parse(T1))).toBe("overdue");
    const kept = applyCollaborationUpdate(state, { type: "keep_promise", promiseId: "a" }, T1);
    expect(promiseState(kept.promises![0]!, Date.parse(T1) + 1)).toBe("kept");
    expect(openPromises(kept)).toEqual([]);
  });

  it("updates a promise by id and lists open ones soonest first", () => {
    let state: ThreadCollaboration = applyCollaborationUpdate(undefined, promise("late", T1), T0);
    state = applyCollaborationUpdate(state, promise("soon", T0), T0);
    state = applyCollaborationUpdate(state, promise("late", "2026-11-30T00:00:00Z"), T0);
    expect(openPromises(state).map((entry) => entry.id)).toEqual(["soon", "late"]);
  });

  it("caps open promises and lets kept ones make room", () => {
    let state: ThreadCollaboration = {};
    for (let index = 0; index < THREAD_MAX_PROMISES; index += 1) {
      state = applyCollaborationUpdate(state, promise(`p${index}`, T1), T0);
    }
    expect(collaborationUpdateError(state, promise("extra", T1))).toMatch(/at most/);
    state = applyCollaborationUpdate(state, { type: "keep_promise", promiseId: "p0" }, T0);
    state = applyCollaborationUpdate(state, promise("extra", T1), T0);
    expect(state.promises).toHaveLength(THREAD_MAX_PROMISES);
    expect(state.promises!.some((entry) => entry.id === "p0")).toBe(false);
    expect(collaborationUpdateError(state, { type: "keep_promise", promiseId: "gone" })).toMatch(
      /No promise/,
    );
  });
});

describe("handoff", () => {
  it("sets and clears the handoff", () => {
    const set = applyCollaborationUpdate(
      undefined,
      {
        type: "set_handoff",
        handoff: { from: "CoS", to: "Growth", what: "Draft the outbound list" },
      },
      T0,
    );
    expect(set.handoff?.to).toBe("Growth");
    expect(applyCollaborationUpdate(set, { type: "set_handoff", handoff: null }, T0)).toEqual({});
  });
});

describe("stored collaboration", () => {
  it("reads a value a later rule rejects as no collaboration", () => {
    expect(decodeStored({ room: { topic: 3 } })).toEqual({});
  });
});

describe("decision cards", () => {
  const ask = {
    founder: "kameron",
    kind: "decision",
    question: "Who owns outbound?",
    options: [
      { label: "Growth", effect: "Growth runs the list weekly." },
      { label: "CD bot", effect: "Customer Discovery keeps it." },
    ],
  };

  it("accepts options with a recommendation that names one of them", () => {
    expect(isDecisionAsk({ ...ask, recommendation: "Growth" })).toBe(true);
    expect(isDecisionAsk({ ...ask, recommendation: "Lead" })).toBe(false);
    expect(isDecisionAsk({ ...ask, options: undefined, recommendation: "Growth" })).toBe(false);
    expect(isDecisionAsk({ ...ask, options: [ask.options[0]] })).toBe(false);
  });

  it("still accepts a plain question", () => {
    expect(isDecisionAsk({ founder: "kameron", kind: "decision", question: "Ship it?" })).toBe(
      true,
    );
  });
});
