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

const CLAUDE_SESSION = "5a128faa-8253-489e-b935-6c08e8e670c0";
const OTHER_CLAUDE_SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX_SESSION = "019fbbc1-b12c-7360-a685-28c181f0025f";
const GROK_SESSION = "019fec1a-12f7-72f2-9b1f-7778a00aea3c";
const CLAUDE_FINGERPRINT = "host\u0000claude\u0000/home/u/.claude\u00000:1";
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

function record(overrides: Partial<AttributionUsageRecord> = {}): AttributionUsageRecord {
  return {
    provider: "claude",
    sessionId: CLAUDE_SESSION,
    model: "claude-fable-5",
    timestampMs: 1_786_000_000_000,
    totals: totals(),
    costUsd: 0.01,
    dedupeKey: null,
    providerRequestId: null,
    providerMessageId: null,
    promptId: null,
    sourceFingerprint: CLAUDE_FINGERPRINT,
    ...overrides,
  };
}

function codexRecord(overrides: Partial<AttributionUsageRecord> = {}): AttributionUsageRecord {
  return record({
    provider: "codex",
    sessionId: CODEX_SESSION,
    model: "gpt-5.6-sol",
    sourceFingerprint: CODEX_FINGERPRINT,
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

    expect(session.quality).toBe("missing");
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

  it("marks a malformed claude session id invalid", () => {
    const projection = buildUsageAttribution(
      input({ records: [record({ sessionId: "not-a-uuid", dedupeKey: "a" })] }),
    );

    expect(projection.sessions[0]?.quality).toBe("invalid");
    expect(projection.coverage.find((entry) => entry.provider === "claude")?.invalidSessions).toBe(
      1,
    );
  });

  it("de-duplicates identical codex records from two scans of one source", () => {
    const scanned = codexRecord({ dedupeKey: null });
    const projection = buildUsageAttribution(
      input({
        records: [scanned, { ...scanned }],
        bindings: [binding({ provider: "codex", nativeSessionId: CODEX_SESSION })],
      }),
    );

    expect(projection.sessions[0]?.totals?.records).toBe(1);
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
    expect(
      projection.limitations.some((line) => line.includes("duplicate source fingerprint")),
    ).toBe(true);
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
          codexRecord({ dedupeKey: null, totals: totals({ outputTokens: 50 }) }),
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
        records: [record({ dedupeKey: "a" }), codexRecord({ dedupeKey: null })],
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
});

describe("projection contract", () => {
  it("reconciles allocated + shared + unallocated to the distinct measured total", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({
            sessionId: CLAUDE_SESSION,
            dedupeKey: "a",
            totals: totals({ outputTokens: 100 }),
          }),
          codexRecord({ dedupeKey: null }),
          record({
            provider: "grok",
            sessionId: GROK_SESSION,
            model: "grok-4.5",
            promptId: "g1",
            dedupeKey: "g1",
          }),
        ],
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

    const distinct = projection.sessions.reduce(
      (sum, session) => sum + (session.totals?.totalTokens ?? 0),
      0,
    );
    const allocated = projection.pullRequests.reduce(
      (sum, pr) => sum + pr.attributed.totalTokens,
      0,
    );
    expect(allocated + projection.shared.totalTokens + projection.unallocated.totalTokens).toBe(
      distinct,
    );
  });

  it("does not mutate its inputs", () => {
    const records = [record({ dedupeKey: "a" })];
    const bindings = [binding()];
    const links = [link()];
    const before = JSON.stringify({ records, bindings, links });

    buildUsageAttribution(input({ records, bindings, links }));

    expect(JSON.stringify({ records, bindings, links })).toBe(before);
  });

  it("exposes the source capability matrix with live qualification falsy", () => {
    const projection = buildUsageAttribution(input({}));
    expect(USAGE_ATTRIBUTION_VERSION).toBe(1);
    expect(projection.contractVersion).toBe(1);
    for (const entry of projection.coverage) {
      expect(entry.liveQualified).toBe(false);
    }
  });

  it("renders a stable human-readable sample", () => {
    const projection = buildUsageAttribution(
      input({
        records: [record({ dedupeKey: "a", providerRequestId: "r1", providerMessageId: "m1" })],
        bindings: [binding({ threadId: "thread-1" })],
        links: [link({ threadId: "thread-1", number: 12 })],
      }),
    );

    const text = renderUsageAttributionText(projection);
    expect(text).toContain(`claude:${CLAUDE_SESSION}`);
    expect(text).toContain("requests=1");
    expect(text).toContain("github.com/acme/repo#12 attributed=");
  });

  it("returns every level for a machine-readable fixture", () => {
    const projection = buildUsageAttribution(
      input({
        records: [
          record({ dedupeKey: "a", providerRequestId: "r1", providerMessageId: "m1" }),
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

    expect(projection).toMatchObject({ contractVersion: 1, generatedAtMs: 1_786_100_000_000 });
    expect(projection.sessions).toHaveLength(2);
    expect(projection.prompts).toHaveLength(1);
    expect(projection.requests).toHaveLength(1);
    expect(projection.pullRequests).toHaveLength(1);
    expect(projection.coverage.map((entry) => entry.provider)).toEqual(["claude", "grok"]);
    expect(projection.pullRequests[0]?.attributed.records).toBe(2);
  });
});
