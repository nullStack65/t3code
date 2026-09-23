import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: "msg_1:",
    measurement: "observed",
    measurementCompleteness: "complete",
    dedupeKeyScope: "global",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    codexState: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      position: position(),
      identity: "declared",
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores records unchanged", () => {
    const original = cacheWith([
      ["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5" })]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", reportedCostUsd: 1.5 })]],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
      ],
      tailRecords: [record({ provider: "grok", model: "grok-4.5-build", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
      identity: "declared",
    });
    original.set("/codex.jsonl", {
      size: 80,
      mtimeMs: 400,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-5.2-codex", dedupeKey: null })],
      tailRecords: [],
      position: position({
        codexState: {
          model: "gpt-5.2-codex",
          sessionId: "session-c",
          lastUsageSignature: '{"input_tokens":1}',
          sawSessionMeta: true,
          suppressingForkCopies: false,
          forkCopyAnchorMs: 0,
        },
      }),
      identity: "declared",
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(4);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
    expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
    expect(restored.get("/codex.jsonl")).toEqual(original.get("/codex.jsonl"));
  });

  it("preserves native request, message, and prompt ids", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [
          record({
            providerRequestId: "r1",
            providerMessageId: "m1",
            promptId: "p1",
          }),
        ],
      ],
    ]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/a.jsonl")?.records[0]).toMatchObject({
      providerRequestId: "r1",
      providerMessageId: "m1",
      promptId: "p1",
    });
  });

  it("round-trips validity, completeness, and key-scope metadata", () => {
    const original = cacheWith([
      [
        "/partial.jsonl",
        100,
        [
          record({
            measurementCompleteness: "partial",
            invalidTokenFields: 1,
            dedupeKeyScope: "source-local",
          }),
        ],
      ],
      ["/invalid.jsonl", 100, [record({ measurement: "invalid" })]],
    ]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/partial.jsonl")?.records[0]).toMatchObject({
      measurement: "observed",
      measurementCompleteness: "partial",
      invalidTokenFields: 1,
      dedupeKeyScope: "source-local",
    });
    expect(restored.get("/invalid.jsonl")?.records[0]?.measurement).toBe("invalid");
  });

  it("preserves the legacy identity-unavailable marker across a round trip", () => {
    // A decoded v3 entry carries identityAvailable: false; re-encoding must not
    // promote it to a declared identity.
    const v3 = {
      version: 3,
      models: ["claude-fable-5"],
      sessions: ["deleted-session"],
      files: {
        "/deleted.jsonl": {
          s: 100,
          m: 500,
          p: "claude",
          r: [[1_786_000_000_000, 0, 0, 2, 1000, 10, 50, 0, "msg_d:", null]],
          t: [],
          o: 90,
          gl: 64,
          gh: 11,
          cs: null,
        },
      },
    };
    const once = decodeScanCache(JSON.parse(JSON.stringify(v3)));
    const again = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(once))));

    expect(again.get("/deleted.jsonl")?.records[0]?.identityAvailable).toBe(false);
    expect(again.get("/deleted.jsonl")?.records[0]?.measurementCompleteness).toBe("partial");
  });

  it("drops an entry whose persisted parse state is corrupt", () => {
    // Resuming with a bad reducer state would attach appended usage to the
    // wrong model or replay fork-copied history; that entry must cold parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, cs: { model: 42 } },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose guard length is outside the supported range", () => {
    // The guard length sizes a Buffer in the reader; a bogus value would make
    // every parse of that file fail and silently drop its usage.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, gl: 1e20 } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("rejects a v1/v2 document that predates the parse position", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: 2 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous))).size).toBe(0);
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    // A bad cache should cost one cold scan, never a broken page.
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(decodeScanCache({ version: 999, models: [], sessions: [], files: {} }).size).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("rejects the whole cache when an intern table holds a non-string", () => {
    // models: [1] would pass the undefined guard, put a number in a record's
    // model, and crash lookupRate at aggregate time.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = { ...encoded, models: [1] };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).size).toBe(0);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    // Keeping the surviving rows under the original (size, mtime) would read
    // as a valid warm hit and the file would never be re-parsed.
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)));
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});

describe("legacy v3 cache history", () => {
  const TS = 1_786_000_000_000;

  /** One deleted transcript (unrecoverable) and one extant transcript. */
  function v3Document(): unknown {
    return {
      version: 3,
      models: ["claude-fable-5"],
      sessions: ["deleted-session", "live-session"],
      files: {
        "/deleted.jsonl": {
          s: 100,
          m: 500,
          p: "claude",
          r: [[TS, 0, 0, 2, 1000, 10, 50, 0, "msg_d:", null]],
          t: [],
          o: 90,
          gl: 64,
          gh: 11,
          cs: null,
        },
        "/live.jsonl": {
          s: 40,
          m: 9000,
          p: "claude",
          r: [[TS, 0, 1, 0, 0, 0, 0, 0, null, null]],
          t: [],
          o: 30,
          gl: 30,
          gh: 22,
          cs: null,
        },
      },
    };
  }

  it("reads a v3 entry instead of discarding the retained history", () => {
    const decoded = decodeScanCache(JSON.parse(JSON.stringify(v3Document())));

    expect([...decoded.keys()].toSorted()).toEqual(["/deleted.jsonl", "/live.jsonl"]);
    const deleted = decoded.get("/deleted.jsonl")!;
    expect(deleted.identity).toBe("unavailable");
    expect(deleted.records[0]?.totals.outputTokens).toBe(50);
    // Native ids are unavailable, not asserted as absent.
    expect(deleted.records[0]?.providerRequestId).toBeUndefined();
    // A nonzero v3 row is still a known measurement.
    expect(deleted.records[0]?.measurement).toBe("observed");
  });

  it("keeps an all-zero v3 row explicitly unavailable, not a measured zero", () => {
    const decoded = decodeScanCache(JSON.parse(JSON.stringify(v3Document())));

    const live = decoded.get("/live.jsonl")!;
    expect(live.identity).toBe("unavailable");
    expect(live.records[0]?.measurement).toBe("unavailable");
  });

  it("persists the legacy marker so deleted history stays unavailable across restarts", () => {
    const once = decodeScanCache(JSON.parse(JSON.stringify(v3Document())));
    const again = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(once))));

    expect(again.get("/deleted.jsonl")?.identity).toBe("unavailable");
    expect(again.get("/deleted.jsonl")?.records[0]?.totals.outputTokens).toBe(50);
  });

  it("marks a freshly re-parsed entry declared so it can resume and enrich", () => {
    const encoded = encodeScanCache(
      cacheWith([["/live.jsonl", 9000, [record({ sessionId: "live-session" })]]]),
    );
    const decoded = decodeScanCache(JSON.parse(JSON.stringify(encoded)));

    expect(decoded.get("/live.jsonl")?.identity).toBe("declared");
  });
});

describe("pruneScanCache", () => {
  const retentionCutoffMs = 1000;

  it("drops entries older than retention", () => {
    const cache = cacheWith([["/old.jsonl", 500, [record()]]]);

    const removed = pruneScanCache(cache, retentionCutoffMs);

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("keeps entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, retentionCutoffMs);

    expect(cache.size).toBe(1);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the first record per dedupe key", () => {
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 1 } }),
      record({ totals: { ...record().totals, outputTokens: 999 } }),
      record({ dedupeKey: "msg_2:" }),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept[0]?.totals.outputTokens).toBe(1);
  });

  it("keeps every record that has no dedupe key", () => {
    expect(
      dedupeWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });
});
