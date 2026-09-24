import { describe, expect, it } from "@effect/vitest";

import type { UsageTokenTotals } from "@t3tools/contracts";

import {
  buildUsageAttribution,
  renderUsageAttributionText,
  USAGE_ATTRIBUTION_VERSION,
  type AttributionPullRequestLink,
  type AttributionSource,
  type AttributionThreadBinding,
  type AttributionUsageRecord,
  type UsageAttributionInput,
} from "./usageAttribution.ts";
import { totalTokens } from "./usageTranscripts.ts";
import {
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";
import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";

const CLAUDE_SESSION = "5a128faa-8253-489e-b935-6c08e8e670c0";
const OTHER_CLAUDE_SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX_SESSION = "019fbbc1-b12c-7360-a685-28c181f0025f";
const GROK_SESSION = "019fec1a-12f7-72f2-9b1f-7778a00aea3c";
const CLAUDE_FINGERPRINT = "host\u0000claude\u0000/home/u/.claude\u00000:1";
const OTHER_FINGERPRINT = "host\u0000claude\u0000/home/u/.claude-copy\u00000:2";
const CODEX_FINGERPRINT = "host\u0000codex\u0000/home/u/.codex\u00000:2";

function totals(overrides: Partial<UsageTokenTotals> = {}): UsageTokenTotals {
  return {
    uncachedInputTokens: 100,
    cachedInputTokens: 10,
    cacheCreationTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    ...overrides,
  };
}

function zeroTotals(): UsageTokenTotals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function tokensOf(record: AttributionUsageRecord): number {
  return totalTokens(record.totals);
}

function record(overrides: Partial<AttributionUsageRecord> = {}): AttributionUsageRecord {
  return {
    provider: "claude",
    sessionId: CLAUDE_SESSION,
    model: "claude-fable-5",
    timestampMs: 1_786_000_000_000,
    totals: totals(),
    costUsd: 0.01,
    dedupeKey: "msg_1:req_1",
    providerRequestId: null,
    providerMessageId: null,
    promptId: null,
    sourceFingerprint: CLAUDE_FINGERPRINT,
    measurement: "observed",
    ...overrides,
  };
}

function codexRecord(overrides: Partial<AttributionUsageRecord> = {}): AttributionUsageRecord {
  return record({
    provider: "codex",
    sessionId: CODEX_SESSION,
    model: "gpt-5.6-sol",
    sourceFingerprint: CODEX_FINGERPRINT,
    dedupeKey: "codex-occurrence:1",
    ...overrides,
  });
}

function binding(overrides: Partial<AttributionThreadBinding> = {}): AttributionThreadBinding {
  return {
    threadId: "thread-1",
    provider: "claude",
    providerInstanceId: "claude-default",
    nativeSessionId: CLAUDE_SESSION,
    origin: "runtimeCursor",
    ...overrides,
  };
}

function link(overrides: Partial<AttributionPullRequestLink> = {}): AttributionPullRequestLink {
  return {
    threadId: "thread-1",
    host: "github.com",
    repository: "acme/repo",
    number: 12,
    source: "manual",
    linkedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<UsageAttributionInput> = {}): UsageAttributionInput {
  return {
    generatedAtMs: 1_786_100_000_000,
    records: [],
    bindings: [],
    links: [],
    sources: [],
    ...overrides,
  };
}

describe("prompt and request granularity", () => {
  it("counts provider requests for one prompt with a retry and a tool continuation", () => {
    const records = [
      record({ dedupeKey: "m1:r1", providerRequestId: "r1", providerMessageId: "m1" }),
      record({ dedupeKey: "m2:r2", providerRequestId: "r2", providerMessageId: "m2" }),
      record({ dedupeKey: "m3:r3", providerRequestId: "r3", providerMessageId: "m3" }),
      // A resumed/forked transcript repeats the first request's record verbatim.
      record({ dedupeKey: "m1:r1", providerRequestId: "r1", providerMessageId: "m1" }),
    ];

    const projection = buildUsageAttribution(input({ records, bindings: [binding()] }));
    const session = projection.sessions[0]!;

    expect(session.requestCount).toBe(3);
    expect(session.promptCount).toBeNull();
    expect(session.requestQuality).toBe("measured");
    expect(session.promptQuality).toBe("unsupported");
    expect(projection.requests).toHaveLength(3);
    expect(projection.prompts).toHaveLength(0);
    expect(session.totals?.records).toBe(3);
    expect(projection.identity.duplicatesDropped).toBe(1);
  });

  it("groups grok usage by prompt across several models", () => {
    const records = [
      record({
        provider: "grok",
        sessionId: GROK_SESSION,
        model: "grok-4.5",
        promptId: "p1",
        dedupeKey: "s:p1:grok-4.5",
        totals: totals({ outputTokens: 10 }),
      }),
      record({
        provider: "grok",
        sessionId: GROK_SESSION,
        model: "grok-fast",
        promptId: "p1",
        dedupeKey: "s:p1:grok-fast",
        totals: totals({ outputTokens: 5 }),
      }),
      record({
        provider: "grok",
        sessionId: GROK_SESSION,
        model: "grok-4.5",
        promptId: "p2",
        dedupeKey: "s:p2:grok-4.5",
        totals: totals({ outputTokens: 7 }),
      }),
    ];

    const projection = buildUsageAttribution(
      input({
        records,
        bindings: [
          binding({ provider: "grok", nativeSessionId: GROK_SESSION, providerInstanceId: null }),
        ],
      }),
    );
    const session = projection.sessions[0]!;

    expect(session.promptCount).toBe(2);
    expect(session.requestCount).toBeNull();
    expect(session.promptQuality).toBe("measured");
    expect(session.requestQuality).toBe("unsupported");
    expect(projection.prompts).toHaveLength(2);
    const prompt1 = projection.prompts.find((prompt) => prompt.promptId === "p1")!;
    expect(prompt1.models).toEqual(["grok-4.5", "grok-fast"]);
    expect(prompt1.totals.records).toBe(2);
    expect(prompt1.modelContributions).toHaveLength(2);
  });

  it("never reports request or prompt counts for turn-only codex usage", () => {
    const projection = buildUsageAttribution(
      input({
        records: [codexRecord()],
        bindings: [binding({ provider: "codex", nativeSessionId: CODEX_SESSION })],
      }),
    );
    const session = projection.sessions[0]!;

    expect(session.requestCount).toBeNull();
    expect(session.promptCount).toBeNull();
    expect(session.requestQuality).toBe("unsupported");
    expect(session.promptQuality).toBe("unsupported");
    expect(projection.requests).toHaveLength(0);
    expect(projection.prompts).toHaveLength(0);
  });
});

describe("session binding and data quality", () => {
  it("collapses runtime and imported bindings for one native session", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a" })],
        bindings: [
          binding({ threadId: "thread-1", origin: "runtimeCursor" }),
          binding({ threadId: "thread-1", origin: "importedTranscript" }),
        ],
      }),
    );

    const session = projection.sessions[0]!;
    expect(session.boundThreadIds).toEqual(["thread-1"]);
    expect(session.bindingOrigins).toEqual(["importedTranscript", "runtimeCursor"]);
    expect(session.totals?.records).toBe(1);
  });

  it("reports a session whose cursor was overwritten as unbound", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ sessionId: CLAUDE_SESSION, dedupeKey: "a" })],
        bindings: [binding({ threadId: "thread-1", nativeSessionId: OTHER_CLAUDE_SESSION })],
      }),
    );

    const old = projection.sessions.find((session) => session.sessionId === CLAUDE_SESSION)!;
    expect(old.boundThreadIds).toEqual([]);
    expect(old.allocation).toBe("unallocated");
    expect(projection.coverage.find((entry) => entry.provider === "claude")?.unboundSessions).toBe(
      1,
    );
  });

  it("reports a bound session with no usage as missing, never zero", () => {
    const projection = buildUsageAttribution(input({ bindings: [binding()] }));
    const session = projection.sessions[0]!;

    expect(session.identityQuality).toBe("valid");
    expect(session.measurementQuality).toBe("missing");
    expect(session.totals).toBeNull();
    expect(session.allocation).toBe("missing");
    // An absent measurement is null, never a zero request count.
    expect(session.requestCount).toBeNull();
    expect(session.promptCount).toBeNull();
    expect(projection.coverage.find((entry) => entry.provider === "claude")?.missingSessions).toBe(
      1,
    );
    expect(projection.unallocated.records).toBe(0);
  });

  it("marks a malformed claude session id invalid on the identity axis", () => {
    const projection = buildUsageAttribution(
      input({ records: [record({ sessionId: "not-a-uuid", dedupeKey: "a" })] }),
    );

    const session = projection.sessions[0]!;
    expect(session.identityQuality).toBe("invalid");
    expect(session.measurementQuality).toBe("measured");
    expect(projection.coverage.find((entry) => entry.provider === "claude")?.invalidSessions).toBe(
      1,
    );
  });

  it("notes duplicate source fingerprints without double counting", () => {
    const source: AttributionSource = {
      fingerprint: CLAUDE_FINGERPRINT,
      provider: "claude",
      status: "ok",
      distinctSessions: 1,
    };
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a" })],
        sources: [source, { ...source }],
      }),
    );

    expect(projection.sessions[0]?.totals?.records).toBe(1);
    expect(projection.coverage.find((entry) => entry.provider === "claude")).toMatchObject({
      declaredSources: 2,
      distinctSourceFingerprints: 1,
      sourceStatus: { ok: 2, missing: 0, partial: 0, failed: 0 },
    });
    expect(
      projection.limitations.some((line) => line.includes("duplicate source fingerprint")),
    ).toBe(true);
  });
});

describe("identity: repeated deliveries, occurrences, copies, conflicts", () => {
  it("counts two equal keyless occurrences instead of collapsing them", () => {
    const occurrence = codexRecord({ dedupeKey: null, timestampMs: 1_786_000_000_000 });
    const projection = buildUsageAttribution(
      input({
        records: [occurrence, { ...occurrence }],
        bindings: [binding({ provider: "codex", nativeSessionId: CODEX_SESSION })],
      }),
    );

    const session = projection.sessions[0]!;
    expect(session.totals?.records).toBe(2);
    expect(session.recordIdentity).toBe("uncertain");
    expect(projection.identity.unkeyedRecords).toBe(2);
    expect(projection.coverage.find((entry) => entry.provider === "codex")?.unkeyedRecords).toBe(2);
    expect(projection.limitations.some((line) => line.includes("no scan/delivery identity"))).toBe(
      true,
    );
  });

  it("collapses a repeated scan by its stamped delivery identity", () => {
    const scanned = codexRecord({ dedupeKey: "occurrence-key:1" });
    const projection = buildUsageAttribution(
      input({
        records: [scanned, { ...scanned }],
        bindings: [binding({ provider: "codex", nativeSessionId: CODEX_SESSION })],
      }),
    );

    expect(projection.sessions[0]?.totals?.records).toBe(1);
    expect(projection.identity.duplicatesDropped).toBe(1);
    expect(projection.sessions[0]?.recordIdentity).toBe("exact");
  });

  it("collapses copied history from another physical source without inflating", () => {
    const original = record({ dedupeKey: "m1:r1", sourceFingerprint: CLAUDE_FINGERPRINT });
    const copy = record({ dedupeKey: "m1:r1", sourceFingerprint: OTHER_FINGERPRINT });
    const projection = buildUsageAttribution(
      input({ records: [original, copy], bindings: [binding()] }),
    );

    expect(projection.sessions[0]?.totals?.records).toBe(1);
    expect(projection.identity.duplicatesDropped).toBe(1);
    // Both physical sources are still visible in coverage.
    expect(
      projection.coverage.find((entry) => entry.provider === "claude")?.distinctSourceFingerprints,
    ).toBe(2);
  });

  it("namespaces a declared key by provider so equal local ids do not collide", () => {
    const claudeRecord = record({ provider: "claude", dedupeKey: "1", sessionId: CLAUDE_SESSION });
    const codexRecordValue = codexRecord({ dedupeKey: "1" });
    const projection = buildUsageAttribution(
      input({
        records: [claudeRecord, codexRecordValue],
        bindings: [
          binding({ provider: "claude", nativeSessionId: CLAUDE_SESSION }),
          binding({ provider: "codex", nativeSessionId: CODEX_SESSION }),
        ],
      }),
    );

    expect(projection.sessions).toHaveLength(2);
    expect(projection.identity.duplicatesDropped).toBe(0);
    expect(projection.identity.conflicts).toBe(0);
  });

  it("exposes conflicting versions of one observation instead of dropping one", () => {
    const first = record({ dedupeKey: "m1:r1", totals: totals({ outputTokens: 10 }) });
    const conflicting = record({ dedupeKey: "m1:r1", totals: totals({ outputTokens: 999 }) });
    const projection = buildUsageAttribution(
      input({ records: [first, conflicting], bindings: [binding()] }),
    );

    const session = projection.sessions[0]!;
    expect(session.totals?.records).toBe(1);
    expect(session.totals?.tokens.outputTokens).toBe(10);
    expect(session.conflict).toBe(true);
    expect(projection.identity.conflicts).toBe(1);
    expect(
      projection.coverage.find((entry) => entry.provider === "claude")?.conflictingRecords,
    ).toBe(1);
    expect(projection.limitations.some((line) => line.includes("identity conflict"))).toBe(true);
  });

  it("lets a snapshot observation replace an earlier value for the same identity", () => {
    const delta = record({
      dedupeKey: "snap:1",
      scope: "delta",
      totals: totals({ outputTokens: 10 }),
    });
    const snapshot = record({
      dedupeKey: "snap:1",
      scope: "snapshot",
      totals: totals({ outputTokens: 99 }),
    });
    const projection = buildUsageAttribution(
      input({ records: [delta, snapshot], bindings: [binding()] }),
    );

    const session = projection.sessions[0]!;
    expect(projection.identity.snapshotsReplaced).toBe(1);
    expect(projection.identity.conflicts).toBe(0);
    expect(session.totals?.records).toBe(1);
    expect(session.totals?.tokens.outputTokens).toBe(99);
  });
});

describe("identity scope and cost provenance", () => {
  it("keeps two source-local keys from different sessions as separate records", () => {
    const first = record({
      sessionId: CLAUDE_SESSION,
      dedupeKey: "1",
      dedupeKeyScope: "source-local",
      totals: totals({ outputTokens: 10 }),
    });
    const second = record({
      sessionId: OTHER_CLAUDE_SESSION,
      dedupeKey: "1",
      dedupeKeyScope: "source-local",
      totals: totals({ outputTokens: 20 }),
    });
    const projection = buildUsageAttribution(
      input({
        records: [first, second],
        bindings: [
          binding({ threadId: "thread-1", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-2", nativeSessionId: OTHER_CLAUDE_SESSION }),
        ],
      }),
    );

    expect(projection.sessions).toHaveLength(2);
    expect(projection.identity.duplicatesDropped).toBe(0);
    expect(projection.identity.conflicts).toBe(0);
    expect(projection.measured.tokens.outputTokens).toBe(30);
  });

  it("surfaces a global key reused under a second session as a conflict", () => {
    const first = record({
      sessionId: CLAUDE_SESSION,
      dedupeKey: "1",
      dedupeKeyScope: "global",
    });
    const reused = record({
      sessionId: OTHER_CLAUDE_SESSION,
      dedupeKey: "1",
      dedupeKeyScope: "global",
    });
    const projection = buildUsageAttribution(
      input({
        records: [first, reused],
        bindings: [
          binding({ threadId: "thread-1", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-2", nativeSessionId: OTHER_CLAUDE_SESSION }),
        ],
      }),
    );

    // Incompatible ownership is not silently dropped as a duplicate.
    expect(projection.identity.conflicts).toBe(1);
    expect(projection.identity.duplicatesDropped).toBe(0);
    expect(projection.measured.records).toBe(1);
    const flagged = projection.sessions.filter((session) => session.conflict);
    expect(flagged).toHaveLength(2);
  });

  it("still collapses a copy of a global key at another physical path", () => {
    const original = record({
      dedupeKey: "m1:r1",
      dedupeKeyScope: "global",
      sourceFingerprint: CLAUDE_FINGERPRINT,
    });
    const copy = record({
      dedupeKey: "m1:r1",
      dedupeKeyScope: "global",
      sourceFingerprint: OTHER_FINGERPRINT,
    });
    const projection = buildUsageAttribution(
      input({ records: [original, copy], bindings: [binding()] }),
    );

    expect(projection.identity.duplicatesDropped).toBe(1);
    expect(projection.identity.conflicts).toBe(0);
    expect(projection.measured.records).toBe(1);
  });

  it("surfaces a cost-only change as a conflict, not a duplicate", () => {
    const first = record({ dedupeKey: "m1:r1", costUsd: 0.1 });
    const repriced = record({ dedupeKey: "m1:r1", costUsd: 99 });
    const projection = buildUsageAttribution(
      input({ records: [first, repriced], bindings: [binding()] }),
    );

    expect(projection.identity.conflicts).toBe(1);
    expect(projection.identity.duplicatesDropped).toBe(0);
    // Kept-first, with the conflict surfaced rather than the change applied.
    expect(projection.sessions[0]?.totals?.costUsd).toBe(0.1);
    expect(projection.sessions[0]?.conflict).toBe(true);
  });

  it("treats a differing cost provenance as a conflict", () => {
    const first = record({ dedupeKey: "m1:r1", costSource: "modelPriced" });
    const reported = record({ dedupeKey: "m1:r1", costSource: "providerReported" });
    const projection = buildUsageAttribution(
      input({ records: [first, reported], bindings: [binding()] }),
    );

    expect(projection.identity.conflicts).toBe(1);
    expect(projection.identity.duplicatesDropped).toBe(0);
  });
});

describe("measurement quality", () => {
  it("treats a Claude usage:{} record as invalid, not a measured zero", () => {
    const empty = record({ dedupeKey: "m1:", measurement: "empty", totals: zeroTotals() });
    const projection = buildUsageAttribution(input({ records: [empty], bindings: [binding()] }));

    const session = projection.sessions[0]!;
    expect(session.measurementQuality).toBe("invalid");
    expect(session.totals?.totalTokens).toBe(0);
    // A request id was present, so the request level is not "unsupported".
    expect(session.requestQuality).not.toBe("unsupported");
  });

  it("keeps an explicit zero as measured", () => {
    const explicitZero = record({
      dedupeKey: "m1:",
      measurement: "observed",
      totals: zeroTotals(),
    });
    const projection = buildUsageAttribution(
      input({ records: [explicitZero], bindings: [binding()] }),
    );

    expect(projection.sessions[0]?.measurementQuality).toBe("measured");
  });

  it("keeps a legacy all-zero row unavailable, not missing and not measured", () => {
    const legacy = record({
      dedupeKey: "legacy:1",
      measurement: "unavailable",
      totals: zeroTotals(),
    });
    const projection = buildUsageAttribution(input({ records: [legacy], bindings: [binding()] }));

    const session = projection.sessions[0]!;
    expect(session.measurementQuality).toBe("unavailable");
    expect(session.totals?.records).toBe(1);
  });

  it("marks a mix of observed and empty records partial", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({ dedupeKey: "a" }),
          record({ dedupeKey: "b", measurement: "empty", totals: zeroTotals() }),
        ],
        bindings: [binding()],
      }),
    );

    expect(projection.sessions[0]?.measurementQuality).toBe("partial");
  });

  it("keeps a partial measurement partial, not measured", () => {
    const partial = record({
      dedupeKey: "m1:",
      measurement: "observed",
      measurementCompleteness: "partial",
      invalidTokenFields: 1,
    });
    const projection = buildUsageAttribution(input({ records: [partial], bindings: [binding()] }));

    expect(projection.sessions[0]?.measurementQuality).toBe("partial");
  });

  it("keeps a present-but-invalid value invalid, not a measured zero", () => {
    const invalid = record({
      dedupeKey: "m1:",
      measurement: "invalid",
      totals: zeroTotals(),
    });
    const projection = buildUsageAttribution(input({ records: [invalid], bindings: [binding()] }));

    expect(projection.sessions[0]?.measurementQuality).toBe("invalid");
    expect(projection.coverage.find((entry) => entry.provider === "claude")?.invalidSessions).toBe(
      1,
    );
  });

  it("reports erased native identity as unavailable, not missing", () => {
    // A legacy nonzero row: the tokens are a known measurement, but the native
    // request id was erased, so the request level is unavailable.
    const legacy = record({
      dedupeKey: "legacy:1",
      measurement: "observed",
      measurementCompleteness: "partial",
      identityAvailable: false,
      totals: totals({ outputTokens: 40 }),
    });
    const projection = buildUsageAttribution(input({ records: [legacy], bindings: [binding()] }));
    const session = projection.sessions[0]!;

    expect(session.measurementQuality).toBe("partial");
    expect(session.requestQuality).toBe("unavailable");
    expect(session.requestCount).toBeNull();
  });

  it("surfaces a failed declared source instead of reading it as measured", () => {
    const source: AttributionSource = {
      fingerprint: CLAUDE_FINGERPRINT,
      provider: "claude",
      status: "failed",
      distinctSessions: 0,
    };
    const projection = buildUsageAttribution(input({ sources: [source] }));

    const coverage = projection.coverage.find((entry) => entry.provider === "claude")!;
    expect(coverage.declaredSources).toBe(1);
    expect(coverage.sourceStatus.failed).toBe(1);
    expect(coverage.measuredSessions).toBe(0);
    expect(projection.limitations.some((line) => line.includes("missing or failed"))).toBe(true);
  });
});

describe("orphan usage and reconciliation", () => {
  it("preserves usage with no session id in an explicit orphan bucket", () => {
    const orphanRecord = record({
      sessionId: "",
      dedupeKey: "orphan-1",
      totals: totals({ outputTokens: 7 }),
    });
    const projection = buildUsageAttribution(input({ records: [orphanRecord] }));

    expect(projection.orphan.records).toBe(1);
    expect(projection.orphan.totalTokens).toBe(tokensOf(orphanRecord));
    expect(projection.measured.totalTokens).toBe(projection.orphan.totalTokens);
    expect(projection.unallocated.totalTokens).toBe(0);
    expect(projection.sessions).toHaveLength(0);
    expect(
      projection.coverage.find((entry) => entry.provider === "claude")?.recordsWithoutSessionId,
    ).toBe(1);
    expect(projection.identity.orphanRecords).toBe(1);
  });

  it("reconciles attributed + shared + unallocated + orphan to the deduplicated input", () => {
    const attributed = record({
      sessionId: CLAUDE_SESSION,
      dedupeKey: "a",
      totals: totals({ outputTokens: 100 }),
    });
    const sharedRecord = codexRecord({ dedupeKey: "b", totals: totals({ outputTokens: 50 }) });
    const unallocatedRecord = record({
      provider: "grok",
      sessionId: GROK_SESSION,
      model: "grok-4.5",
      promptId: "g1",
      dedupeKey: "g1",
      totals: totals({ outputTokens: 20 }),
    });
    const orphanRecord = record({
      sessionId: "",
      dedupeKey: "e",
      totals: totals({ outputTokens: 5 }),
    });
    // A repeated delivery of `attributed` must not add to the expected total.
    const duplicate = record({
      sessionId: CLAUDE_SESSION,
      dedupeKey: "a",
      totals: totals({ outputTokens: 100 }),
    });

    const projection = buildUsageAttribution(
      input({
        records: [attributed, sharedRecord, unallocatedRecord, orphanRecord, duplicate],
        bindings: [
          binding({ threadId: "thread-1", provider: "claude", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-2", provider: "codex", nativeSessionId: CODEX_SESSION }),
          binding({ threadId: "thread-3", provider: "grok", nativeSessionId: GROK_SESSION }),
        ],
        links: [
          link({ threadId: "thread-1", number: 12 }),
          link({ threadId: "thread-2", number: 13 }),
          link({ threadId: "thread-2", number: 14 }),
        ],
      }),
    );

    // Independent known input truth: every distinct input record, including the
    // orphan, and excluding the exact duplicate.
    const expected =
      tokensOf(attributed) +
      tokensOf(sharedRecord) +
      tokensOf(unallocatedRecord) +
      tokensOf(orphanRecord);
    const allocated = projection.pullRequests.reduce(
      (sum, pr) => sum + pr.attributed.totalTokens,
      0,
    );

    expect(projection.measured.totalTokens).toBe(expected);
    expect(
      allocated +
        projection.shared.totalTokens +
        projection.unallocated.totalTokens +
        projection.orphan.totalTokens,
    ).toBe(expected);
    expect(projection.identity.duplicatesDropped).toBe(1);
  });

  it("does not mutate its inputs", () => {
    const records = [record({ dedupeKey: "a" })];
    const bindings = [binding()];
    const links = [link()];
    const before = JSON.stringify({ records, bindings, links });

    buildUsageAttribution(input({ records, bindings, links }));

    expect(JSON.stringify({ records, bindings, links })).toBe(before);
  });
});

describe("pull request association and attribution", () => {
  it("sums several sessions onto one PR additively", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({
            sessionId: CLAUDE_SESSION,
            dedupeKey: "a",
            totals: totals({ outputTokens: 100 }),
          }),
          codexRecord({ dedupeKey: "b", totals: totals({ outputTokens: 50 }) }),
        ],
        bindings: [
          binding({ threadId: "thread-1", provider: "claude", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-2", provider: "codex", nativeSessionId: CODEX_SESSION }),
        ],
        links: [
          link({ threadId: "thread-1", number: 12 }),
          link({ threadId: "thread-2", number: 12, source: "agent" }),
        ],
      }),
    );

    const pr = projection.pullRequests[0]!;
    const expected = projection.sessions.reduce(
      (sum, session) => sum + (session.totals?.totalTokens ?? 0),
      0,
    );
    expect(pr.key).toBe("github.com/acme/repo#12");
    expect(pr.attributed.records).toBe(2);
    expect(pr.attributed.totalTokens).toBe(expected);
    expect(pr.contributingSessions).toHaveLength(2);
  });

  it("keeps a session linked to two PRs shared, not cloned onto both", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a" })],
        bindings: [binding({ threadId: "thread-1" })],
        links: [
          link({ threadId: "thread-1", number: 12 }),
          link({ threadId: "thread-1", number: 13 }),
        ],
      }),
    );

    const session = projection.sessions[0]!;
    expect(session.allocation).toBe("shared");
    expect(projection.shared.records).toBe(1);
    for (const pr of projection.pullRequests) {
      expect(pr.attributed.records).toBe(0);
      expect(pr.shared.records).toBe(1);
    }
    expect(projection.unallocated.records).toBe(0);
  });

  it("treats a stack sibling as association, not attribution", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a" })],
        bindings: [binding({ threadId: "thread-1" })],
        links: [
          link({ threadId: "thread-1", number: 12, source: "manual" }),
          link({ threadId: "thread-1", number: 13, source: "stack" }),
          link({ threadId: "thread-1", number: 14, source: "stack-dismissed" }),
        ],
      }),
    );

    const session = projection.sessions[0]!;
    expect(session.allocation).toBe("attributed");
    expect(session.pullRequestKeys).toEqual(["github.com/acme/repo#12"]);
    expect(session.stackOnlyPullRequestKeys).toEqual(["github.com/acme/repo#13"]);

    const sibling = projection.pullRequests.find((pr) => pr.number === 13)!;
    expect(sibling.attributed.records).toBe(0);
    expect(sibling.stackAssociationSessions).toHaveLength(1);
    expect(projection.pullRequests.some((pr) => pr.number === 14)).toBe(false);
  });

  it("pools unlinked and ambiguous sessions as unallocated", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a" }), codexRecord({ dedupeKey: "b" })],
        bindings: [
          binding({ threadId: "thread-1", provider: "claude", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-2", provider: "codex", nativeSessionId: CODEX_SESSION }),
          binding({ threadId: "thread-3", provider: "codex", nativeSessionId: CODEX_SESSION }),
        ],
      }),
    );

    expect(projection.sessions.find((session) => session.provider === "claude")?.allocation).toBe(
      "unallocated",
    );
    expect(projection.sessions.find((session) => session.provider === "codex")?.allocation).toBe(
      "ambiguous",
    );
    expect(projection.unallocated.records).toBe(2);
    expect(projection.coverage.find((entry) => entry.provider === "codex")?.ambiguousSessions).toBe(
      1,
    );
  });

  it("preserves per-model contributions at the session and PR level", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({
            model: "claude-opus-5",
            dedupeKey: "a",
            totals: totals({ outputTokens: 10 }),
            costUsd: 0.1,
            costSource: "modelPriced",
          }),
          record({
            model: "claude-fable-5",
            dedupeKey: "b",
            totals: totals({ outputTokens: 20 }),
            costUsd: 0.2,
            costSource: "providerReported",
          }),
        ],
        bindings: [binding({ threadId: "thread-1" })],
        links: [link({ threadId: "thread-1", number: 12 })],
      }),
    );

    const session = projection.sessions[0]!;
    expect(session.models).toEqual(["claude-fable-5", "claude-opus-5"]);
    expect(session.modelContributions.map((entry) => entry.model)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
    ]);
    expect(
      session.modelContributions.find((entry) => entry.model === "claude-opus-5")?.costSource,
    ).toBe("modelPriced");
    const pr = projection.pullRequests[0]!;
    expect(pr.attributedModelContributions).toHaveLength(2);
    // 100 uncached + 10 cached + 20 output; reasoning is a subset of output.
    expect(
      pr.attributedModelContributions.find((entry) => entry.model === "claude-fable-5")
        ?.totalTokens,
    ).toBe(130);
  });

  it("recomputes allocation from the links present at read time", () => {
    const records = [record({ dedupeKey: "a", totals: totals({ outputTokens: 100 }) })];
    const bindings = [binding({ threadId: "thread-1" })];

    const only12 = buildUsageAttribution(
      input({ records, bindings, links: [link({ threadId: "thread-1", number: 12 })] }),
    );
    expect(only12.sessions[0]?.allocation).toBe("attributed");
    expect(only12.association).toMatchObject({
      basis: "links-at-read-time",
      linkedAtGovernsAllocation: false,
    });

    const both = buildUsageAttribution(
      input({
        records,
        bindings,
        links: [
          link({ threadId: "thread-1", number: 12 }),
          link({ threadId: "thread-1", number: 13 }),
        ],
      }),
    );
    expect(both.sessions[0]?.allocation).toBe("shared");
    expect(both.shared.records).toBe(1);
    expect(both.limitations.some((line) => line.includes("does not gate allocation"))).toBe(true);
  });

  it("associates pre-link implementation work with a later link", () => {
    const workRanAtMs = 1_786_000_000_000;
    const projection = buildUsageAttribution(
      input({
        generatedAtMs: workRanAtMs + 30 * 24 * 60 * 60 * 1000,
        records: [record({ dedupeKey: "a", timestampMs: workRanAtMs })],
        bindings: [binding({ threadId: "thread-1" })],
        // Linked long after the work ran; allocation ignores `linkedAt`.
        links: [link({ threadId: "thread-1", number: 12, linkedAt: "2026-09-20T00:00:00.000Z" })],
      }),
    );

    expect(projection.sessions[0]?.allocation).toBe("attributed");
    expect(projection.pullRequests[0]?.attributed.records).toBe(1);
  });
});

describe("parser to projection", () => {
  function claudeUsageLine(usage: Record<string, unknown>, requestId = "req_1"): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-07T04:05:13.944Z",
      sessionId: CLAUDE_SESSION,
      requestId,
      message: { id: "msg_1", model: "claude-fable-5", usage },
    });
  }

  function fromParsed(record: UsageRecord): AttributionUsageRecord {
    return {
      provider: record.provider,
      sessionId: record.sessionId,
      model: record.model,
      timestampMs: record.timestampMs,
      totals: record.totals,
      costUsd: 0,
      dedupeKey: record.dedupeKey,
      sourceFingerprint: CLAUDE_FINGERPRINT,
      ...(record.dedupeKeyScope === undefined ? {} : { dedupeKeyScope: record.dedupeKeyScope }),
      ...(record.providerRequestId === undefined
        ? {}
        : { providerRequestId: record.providerRequestId }),
      ...(record.providerMessageId === undefined
        ? {}
        : { providerMessageId: record.providerMessageId }),
      ...(record.promptId === undefined ? {} : { promptId: record.promptId }),
      ...(record.measurement === undefined ? {} : { measurement: record.measurement }),
      ...(record.measurementCompleteness === undefined
        ? {}
        : { measurementCompleteness: record.measurementCompleteness }),
      ...(record.invalidTokenFields === undefined
        ? {}
        : { invalidTokenFields: record.invalidTokenFields }),
      ...(record.identityAvailable === undefined
        ? {}
        : { identityAvailable: record.identityAvailable }),
    };
  }

  it("carries a partial usage object through to a partial session", () => {
    const parsed = parseClaudeLine(claudeUsageLine({ input_tokens: 10 }))!;
    const projection = buildUsageAttribution(
      input({ records: [fromParsed(parsed)], bindings: [binding()] }),
    );
    const session = projection.sessions[0]!;

    expect(parsed.measurementCompleteness).toBe("partial");
    expect(session.measurementQuality).toBe("partial");
    expect(session.totals?.tokens.uncachedInputTokens).toBe(10);
  });

  it("carries an invalid usage value through to an invalid session", () => {
    const parsed = parseClaudeLine(claudeUsageLine({ input_tokens: null }))!;
    const projection = buildUsageAttribution(
      input({ records: [fromParsed(parsed)], bindings: [binding()] }),
    );

    expect(parsed.measurement).toBe("invalid");
    expect(projection.sessions[0]?.measurementQuality).toBe("invalid");
  });

  it("survives a cache round trip without promoting partial to complete", () => {
    const parsed = parseClaudeLine(claudeUsageLine({ input_tokens: 10 }))!;
    const cache: ScanCache = new Map([
      [
        "/a.jsonl",
        {
          size: 10,
          mtimeMs: 1,
          provider: "claude",
          records: [parsed],
          tailRecords: [],
          position: { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null },
          identity: "declared",
          qualityMetadata: "declared",
        },
      ],
    ]);
    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache))));
    const roundTripped = restored.get("/a.jsonl")!.records[0]!;

    expect(roundTripped.measurementCompleteness).toBe("partial");
    expect(roundTripped.dedupeKeyScope).toBe("global");
    const projection = buildUsageAttribution(
      input({ records: [fromParsed(roundTripped)], bindings: [binding()] }),
    );
    expect(projection.sessions[0]?.measurementQuality).toBe("partial");
  });

  /** A Codex rollout primed with its session meta and model. */
  function primedCodexState(): CodexScanState {
    const state = initialCodexScanState();
    parseCodexLine(JSON.stringify({ type: "session_meta", payload: { id: CODEX_SESSION } }), state);
    parseCodexLine(
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      state,
    );
    return state;
  }

  function codexTokenCount(lastTokenUsage: Record<string, unknown>, timestamp: string): string {
    return JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "token_count", info: { last_token_usage: lastTokenUsage } },
    });
  }

  it("carries a Codex valid and a distinct invalid event to one partial session", () => {
    const state = primedCodexState();
    const valid = parseCodexLine(
      codexTokenCount({ input_tokens: 10, output_tokens: 2 }, "2026-08-01T05:17:49.919Z"),
      state,
    )!;
    const invalid = parseCodexLine(
      codexTokenCount({ input_tokens: null, output_tokens: null }, "2026-08-01T05:18:00.000Z"),
      state,
    )!;
    const projection = buildUsageAttribution(
      input({ records: [fromParsed(valid), fromParsed(invalid)] }),
    );
    const session = projection.sessions[0]!;

    // The invalid event reaches the session as evidence instead of vanishing at
    // the parser's zero-total gate; tokens come only from the valid event.
    expect(session.totals?.records).toBe(2);
    expect(session.totals?.tokens.uncachedInputTokens).toBe(10);
    expect(session.measurementQuality).toBe("partial");
  });

  it("carries a Codex complete explicit zero to a measured session", () => {
    const zero = parseCodexLine(
      codexTokenCount({ input_tokens: 0, output_tokens: 0 }, "2026-08-01T05:17:49.919Z"),
      primedCodexState(),
    )!;
    const projection = buildUsageAttribution(input({ records: [fromParsed(zero)] }));

    expect(projection.sessions[0]?.measurementQuality).toBe("measured");
    expect(projection.sessions[0]?.totals?.tokens.outputTokens).toBe(0);
  });

  it("carries Grok per-model invalid and zero rows into the session", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: GROK_SESSION,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-1",
          usage: {
            inputTokens: null,
            outputTokens: null,
            modelUsage: {
              "model-invalid": { inputTokens: null, outputTokens: null },
              "model-zero": { inputTokens: 0, outputTokens: 0 },
              "model-valid": { inputTokens: 5, outputTokens: 5 },
            },
          },
        },
        _meta: { agentTimestampMs: 1_786_372_566_485 },
      },
    });
    const records = parseGrokLine(line).map(fromParsed);
    const projection = buildUsageAttribution(input({ records }));
    const session = projection.sessions[0]!;

    expect(session.totals?.records).toBe(3);
    expect(session.totals?.tokens.uncachedInputTokens).toBe(5);
    expect(session.measurementQuality).toBe("partial");
    expect(session.models).toEqual(["model-invalid", "model-valid", "model-zero"]);
  });
});

describe("projection contract", () => {
  it("exposes the source capability matrix with live qualification falsy", () => {
    const projection = buildUsageAttribution(input({}));
    expect(USAGE_ATTRIBUTION_VERSION).toBe(2);
    expect(projection.contractVersion).toBe(2);
    for (const entry of projection.coverage) {
      expect(entry.liveQualified).toBe(false);
    }
  });

  it("renders a stable human-readable sample", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "m1:r1", providerRequestId: "r1", providerMessageId: "m1" })],
        bindings: [binding({ threadId: "thread-1" })],
        links: [link({ threadId: "thread-1", number: 12 })],
      }),
    );

    const text = renderUsageAttributionText(projection);
    expect(text).toContain(`claude:${CLAUDE_SESSION}`);
    expect(text).toContain("requests=1");
    expect(text).toContain("github.com/acme/repo#12 attributed=");
    expect(text).toContain("Orphan:");
  });

  it("returns every level for a machine-readable fixture", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({ dedupeKey: "m1:r1", providerRequestId: "r1", providerMessageId: "m1" }),
          record({
            provider: "grok",
            sessionId: GROK_SESSION,
            model: "grok-4.5",
            promptId: "p1",
            dedupeKey: "s:p1",
          }),
        ],
        bindings: [
          binding({ threadId: "thread-1", provider: "claude", nativeSessionId: CLAUDE_SESSION }),
          binding({ threadId: "thread-1", provider: "grok", nativeSessionId: GROK_SESSION }),
        ],
        links: [link({ threadId: "thread-1", number: 12 })],
      }),
    );

    expect(projection).toMatchObject({ contractVersion: 2, generatedAtMs: 1_786_100_000_000 });
    expect(projection.sessions).toHaveLength(2);
    expect(projection.prompts).toHaveLength(1);
    expect(projection.requests).toHaveLength(1);
    expect(projection.pullRequests).toHaveLength(1);
    expect(projection.coverage.map((entry) => entry.provider)).toEqual(["claude", "grok"]);
    expect(projection.pullRequests[0]?.attributed.records).toBe(2);
  });
});
