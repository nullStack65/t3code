import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { MessageId } from "./baseSchemas.ts";
import {
  applyOrchestrationV2ThreadVisit,
  nextFounderSeenMessage,
  nextFounderVisits,
  OrchestrationV2ThreadVisitJson,
  rewindFounderVisit,
} from "./orchestrationV2.ts";

const earlier = DateTime.makeUnsafe("2026-11-20T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-11-20T13:00:00.000Z");
const newest = DateTime.makeUnsafe("2026-11-20T14:00:00.000Z");

describe("per-founder read cursors", () => {
  it("seeds the other founder from the shared cursor, then advances only the reader", () => {
    const seeded = nextFounderVisits(
      { lastVisitedAt: earlier, visitsByFounder: undefined },
      "jeff",
      later,
    );
    expect(seeded.kameron).toBe(earlier);
    expect(seeded.jeff).toBe(later);

    const sameVisit = nextFounderVisits(
      { lastVisitedAt: earlier, visitsByFounder: seeded },
      "jeff",
      later,
    );
    expect(sameVisit).toBe(seeded);

    const kameronReads = nextFounderVisits(
      { lastVisitedAt: earlier, visitsByFounder: seeded },
      "kameron",
      newest,
    );
    expect(kameronReads.jeff).toBe(later);
    expect(kameronReads.kameron).toBe(newest);
  });

  it("persists the split when the first named visit is not newer than the shared cursor", () => {
    const seeded = nextFounderVisits(
      { lastVisitedAt: later, visitsByFounder: undefined },
      "jeff",
      earlier,
    );
    expect(seeded.kameron).toBe(later);
    expect(seeded.jeff).toBe(later);
  });

  it("marks both founders read as of the first visit, so a later reply is unread for the other", () => {
    const seeded = nextFounderVisits(
      { lastVisitedAt: null, visitsByFounder: undefined },
      "kameron",
      later,
    );
    expect(seeded.kameron).toBe(later);
    expect(seeded.jeff).toBe(later);

    const jeffReadsLater = nextFounderVisits(
      { lastVisitedAt: null, visitsByFounder: seeded },
      "jeff",
      newest,
    );
    expect(jeffReadsLater.kameron).toBe(later);
    expect(jeffReadsLater.jeff).toBe(newest);
  });

  it("rewinds one founder and leaves the other where they were", () => {
    const current = { kameron: later, jeff: later };
    const rewound = rewindFounderVisit(
      { lastVisitedAt: later, visitsByFounder: current },
      "jeff",
      earlier,
    );
    expect(rewound.jeff).toBe(earlier);
    expect(rewound.kameron).toBe(later);
    expect(current.jeff).toBe(later);
  });

  it("copies a founder map onto the thread and leaves the shared watermark as the payload says", () => {
    const thread = { id: "thread", lastVisitedAt: earlier } as Parameters<
      typeof applyOrchestrationV2ThreadVisit
    >[0];
    const next = applyOrchestrationV2ThreadVisit(thread, {
      lastVisitedAt: earlier,
      visitsByFounder: { kameron: earlier, jeff: later },
    });
    expect(next.lastVisitedAt).toBe(earlier);
    expect(next.visitsByFounder?.jeff).toBe(later);
    expect(next.visitsByFounder?.kameron).toBe(earlier);

    const globalOnly = applyOrchestrationV2ThreadVisit(next, { lastVisitedAt: newest });
    expect(globalOnly.lastVisitedAt).toBe(newest);
    expect(globalOnly.visitsByFounder).toBe(next.visitsByFounder);
  });

  it("records one founder's message and leaves the other founder's message", () => {
    const jeffMessage = MessageId.make("message-jeff");
    const kameronMessage = MessageId.make("message-kameron");
    const jeffSeen = nextFounderSeenMessage(
      { seenMessageByFounder: undefined },
      "jeff",
      jeffMessage,
    );
    expect(jeffSeen.jeff).toBe(jeffMessage);
    expect(jeffSeen.kameron).toBeUndefined();

    const same = nextFounderSeenMessage({ seenMessageByFounder: jeffSeen }, "jeff", jeffMessage);
    expect(same).toBe(jeffSeen);

    const both = nextFounderSeenMessage(
      { seenMessageByFounder: jeffSeen },
      "kameron",
      kameronMessage,
    );
    expect(both.jeff).toBe(jeffMessage);
    expect(both.kameron).toBe(kameronMessage);
    expect(jeffSeen.kameron).toBeUndefined();
  });

  it("keeps a stored message map when a later visit does not include one", () => {
    const thread = { id: "thread", lastVisitedAt: earlier } as Parameters<
      typeof applyOrchestrationV2ThreadVisit
    >[0];
    const jeffMessage = MessageId.make("message-jeff");
    const withSeen = applyOrchestrationV2ThreadVisit(thread, {
      lastVisitedAt: earlier,
      seenMessageByFounder: { jeff: jeffMessage },
    });
    const laterVisit = applyOrchestrationV2ThreadVisit(withSeen, { lastVisitedAt: newest });
    expect(laterVisit.seenMessageByFounder).toBe(withSeen.seenMessageByFounder);
    expect(laterVisit.lastVisitedAt).toBe(newest);
  });

  it("decodes founder visit timestamps stored as strings", () => {
    const visit = Schema.decodeSync(OrchestrationV2ThreadVisitJson)({
      lastVisitedAt: "2026-11-20T12:00:00.000Z",
      visitsByFounder: {
        kameron: "2026-11-20T12:00:00.000Z",
        jeff: "2026-11-20T13:00:00.000Z",
      },
    });
    expect(DateTime.formatIso(visit.lastVisitedAt!)).toBe("2026-11-20T12:00:00.000Z");
    expect(DateTime.formatIso(visit.visitsByFounder!.jeff!)).toBe("2026-11-20T13:00:00.000Z");
  });
});
