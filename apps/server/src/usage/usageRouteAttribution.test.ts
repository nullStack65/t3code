import { describe, expect, it } from "@effect/vitest";

import type { UsageTokenTotals } from "@t3tools/contracts";

import type {
  AttributionPullRequestLink,
  AttributionThreadBinding,
  AttributionUsageRecord,
} from "./usageAttribution.ts";
import type { ExtractedSessionHistory } from "./usageAttributionSources.ts";
import type { RouteEventMetadata } from "./routeMetadata.ts";
import { buildUsageRouteAttribution } from "./usageRouteAttribution.ts";
import { totalTokens } from "./usageTranscripts.ts";

const DEEPSEEK_SESSION = "019f0000-0000-7000-8000-000000000001";
const LUNA_SESSION = "019f0000-0000-7000-8000-000000000002";
const OPENCODE_PARENT = "ses_parent_opencode";
const OPENCODE_CHILD = "ses_child_opencode";
const THREAD = "thread-route-1";
const FINGERPRINT = "host\u0000codex\u0000/home/u/.codex\u00000:2";

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
    provider: "codex",
    sessionId: DEEPSEEK_SESSION,
    model: "deepseek-v4.1-flash",
    timestampMs: 1_786_000_000_000,
    totals: totals(),
    costUsd: 0.01,
    dedupeKey: "occ:1",
    sourceFingerprint: FINGERPRINT,
    measurement: "observed",
    ...overrides,
  };
}

function binding(overrides: Partial<AttributionThreadBinding> = {}): AttributionThreadBinding {
  return {
    threadId: THREAD,
    provider: "codex",
    providerInstanceId: "codex-default",
    nativeSessionId: DEEPSEEK_SESSION,
    origin: "sessionHistory",
    ...overrides,
  };
}

function history(overrides: Partial<ExtractedSessionHistory> = {}): ExtractedSessionHistory {
  return {
    threadId: THREAD,
    providerName: "codex",
    adapterKey: "codex",
    providerInstanceId: "codex-default",
    nativeSessionId: DEEPSEEK_SESSION,
    parentNativeSessionId: null,
    source: "runtimeCursor",
    firstSeenAt: "2026-09-23T09:00:00.000Z",
    lastSeenAt: "2026-09-23T09:10:00.000Z",
    usageProvider: "codex",
    ...overrides,
  };
}

function routeEvent(overrides: Partial<RouteEventMetadata> = {}): RouteEventMetadata {
  return {
    eventId: "evt-1",
    threadId: THREAD,
    nativeSessionId: DEEPSEEK_SESSION,
    kind: "canary",
    taskStratum: "implementation",
    experimentId: "canary-2026-09",
    managerId: "ROUTE6-1",
    agentId: "T3",
    requested: { provider: "openai", model: "gpt-6-luna", effort: "high" },
    reason: null,
    recordedAt: "2026-09-23T09:00:00.000Z",
    ...overrides,
  };
}

function link(overrides: Partial<AttributionPullRequestLink> = {}): AttributionPullRequestLink {
  return {
    threadId: THREAD,
    host: "github.com",
    repository: "acme/repo",
    number: 12,
    source: "manual",
    linkedAt: "2026-09-23T09:20:00.000Z",
    ...overrides,
  };
}

function build(overrides: {
  records?: readonly AttributionUsageRecord[];
  bindings?: readonly AttributionThreadBinding[];
  history?: readonly ExtractedSessionHistory[];
  routeEvents?: readonly RouteEventMetadata[];
  links?: readonly AttributionPullRequestLink[];
}) {
  return buildUsageRouteAttribution({
    cutoffMs: 1_786_100_000_000,
    records: overrides.records ?? [],
    bindings: overrides.bindings ?? [],
    links: overrides.links ?? [],
    sources: [],
    history: overrides.history ?? [],
    routeEvents: overrides.routeEvents ?? [],
  });
}

function sessionOf(report: ReturnType<typeof build>, sessionId: string) {
  const session = report.sessions.find((entry) => entry.sessionId === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} not found`);
  return session;
}

describe("durable session history across model switches", () => {
  it("retains both a DeepSeek and a Luna session for one thread", () => {
    const report = build({
      records: [
        record({ sessionId: DEEPSEEK_SESSION, model: "deepseek-v4.1-flash", dedupeKey: "ds:1" }),
        record({ sessionId: LUNA_SESSION, model: "gpt-6-luna", dedupeKey: "luna:1" }),
      ],
      bindings: [binding(), binding({ nativeSessionId: LUNA_SESSION })],
      history: [
        history(),
        history({
          nativeSessionId: LUNA_SESSION,
          firstSeenAt: "2026-09-23T09:30:00.000Z",
          lastSeenAt: "2026-09-23T09:40:00.000Z",
        }),
      ],
      links: [link()],
    });

    expect(report.sessions).toHaveLength(2);
    const deepseek = sessionOf(report, DEEPSEEK_SESSION);
    const luna = sessionOf(report, LUNA_SESSION);
    expect(deepseek.actualModel).toBe("deepseek-v4.1-flash");
    expect(luna.actualModel).toBe("gpt-6-luna");
    const thread = report.threads.find((entry) => entry.threadId === THREAD)!;
    expect(thread.models).toEqual(["deepseek-v4.1-flash", "gpt-6-luna"]);
    expect(thread.sessionLabels).toHaveLength(2);
    // Both sessions are bound to the single thread, so both attribute to its PR.
    const pr = report.base.pullRequests.find((entry) => entry.number === 12)!;
    expect(pr.attributed.totalTokens).toBe(deepseek.usage!.totalTokens + luna.usage!.totalTokens);
  });

  it("keeps the earlier session after the resume cursor moves to a new session", () => {
    const report = build({
      // Only the *current* cursor is available as a runtime binding.
      bindings: [binding({ nativeSessionId: LUNA_SESSION, origin: "runtimeCursor" })],
      records: [
        record({ sessionId: DEEPSEEK_SESSION, dedupeKey: "ds:1" }),
        record({ sessionId: LUNA_SESSION, model: "gpt-6-luna", dedupeKey: "luna:1" }),
      ],
      history: [history(), history({ nativeSessionId: LUNA_SESSION })],
    });

    const deepseek = sessionOf(report, DEEPSEEK_SESSION);
    expect(deepseek.usage).not.toBeNull();
    expect(deepseek.threadId).toBe(THREAD);
    // Without history this session would be unbound and its usage lost.
    expect(report.threads[0]!.sessionLabels).toEqual([
      `codex:${DEEPSEEK_SESSION}`,
      `codex:${LUNA_SESSION}`,
    ]);
  });

  it("does not flatten a child OpenCode session into its parent", () => {
    const report = build({
      bindings: [],
      history: [
        history({
          providerName: "opencode",
          adapterKey: "opencode",
          providerInstanceId: "opencode-default",
          nativeSessionId: OPENCODE_PARENT,
          usageProvider: null,
        }),
        history({
          providerName: "opencode",
          adapterKey: "opencode",
          providerInstanceId: "opencode-default",
          nativeSessionId: OPENCODE_CHILD,
          parentNativeSessionId: OPENCODE_PARENT,
          usageProvider: null,
        }),
      ],
    });

    const child = sessionOf(report, OPENCODE_CHILD);
    const parent = sessionOf(report, OPENCODE_PARENT);
    expect(child.parentSessionId).toBe(OPENCODE_PARENT);
    expect(parent.parentSessionId).toBeNull();
    expect(child.provider).toBeNull();
    // Unknown, never zero.
    expect(child.usage).toBeNull();
    expect(report.identity.sessionsWithParent).toBe(1);
  });
});

describe("route and experiment metadata", () => {
  it("keeps a readable manager/agent id distinct from the native session id", () => {
    const report = build({
      records: [record()],
      bindings: [binding()],
      history: [history()],
      routeEvents: [routeEvent()],
    });

    const session = sessionOf(report, DEEPSEEK_SESSION);
    expect(session.managerId).toBe("ROUTE6-1");
    expect(session.agentId).toBe("T3");
    expect(session.managerId).not.toBe(session.sessionId);
    expect(session.agentId).not.toBe(session.sessionId);
    expect(report.identity.managerIds).toEqual(["ROUTE6-1"]);
    expect(report.identity.agentIds).toEqual(["T3"]);
  });

  it("keeps requested and observed models separate and never copies one into the other", () => {
    const report = build({
      records: [record({ sessionId: LUNA_SESSION, model: "gpt-6-luna-2026-09", dedupeKey: "l:1" })],
      bindings: [binding({ nativeSessionId: LUNA_SESSION })],
      history: [history({ nativeSessionId: LUNA_SESSION })],
      routeEvents: [routeEvent({ nativeSessionId: LUNA_SESSION })],
    });

    const session = sessionOf(report, LUNA_SESSION);
    expect(session.requested).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(session.requestedQuality).toBe("declared");
    expect(session.actualModel).toBe("gpt-6-luna-2026-09");
    expect(session.actualModel).not.toBe(session.requested!.model);
  });

  it("leaves unsupported actual effort unknown rather than copying the request", () => {
    const report = build({
      records: [record()],
      bindings: [binding()],
      history: [history()],
      routeEvents: [routeEvent()],
    });

    const session = sessionOf(report, DEEPSEEK_SESSION);
    expect(session.requested!.effort).toBe("high");
    expect(session.actualEffort).toBeNull();
    expect(session.actualEffortQuality).toBe("unsupported");
  });

  it("distinguishes an availability fallback from an independent review", () => {
    const report = build({
      records: [
        record({ sessionId: DEEPSEEK_SESSION, dedupeKey: "ds:1" }),
        record({ sessionId: LUNA_SESSION, model: "gpt-6-luna", dedupeKey: "luna:1" }),
      ],
      bindings: [binding(), binding({ nativeSessionId: LUNA_SESSION })],
      history: [history(), history({ nativeSessionId: LUNA_SESSION })],
      routeEvents: [
        routeEvent({
          eventId: "fallback-1",
          kind: "availability_fallback",
          reason: "provider 503 during send",
        }),
        routeEvent({
          eventId: "review-1",
          nativeSessionId: LUNA_SESSION,
          kind: "independent_review",
          reason: "independent review gate",
          recordedAt: "2026-09-23T09:35:00.000Z",
        }),
      ],
    });

    expect(sessionOf(report, DEEPSEEK_SESSION).routeEventKind).toBe("availability_fallback");
    expect(sessionOf(report, DEEPSEEK_SESSION).escalationReason).toBe("provider 503 during send");
    expect(sessionOf(report, LUNA_SESSION).routeEventKind).toBe("independent_review");
    expect(sessionOf(report, LUNA_SESSION).escalationReason).toBe("independent review gate");
    const thread = report.threads.find((entry) => entry.threadId === THREAD)!;
    expect(thread.routeEventKinds).toEqual(["availability_fallback", "independent_review"]);
  });

  it("preserves a quality escalation reason", () => {
    const report = build({
      records: [record()],
      bindings: [binding()],
      history: [history()],
      routeEvents: [
        routeEvent({
          kind: "quality_escalation",
          reason: "two materially similar failed repair attempts",
        }),
      ],
    });

    const session = sessionOf(report, DEEPSEEK_SESSION);
    expect(session.routeEventKind).toBe("quality_escalation");
    expect(session.escalationReason).toBe("two materially similar failed repair attempts");
    expect(session.taskStratum).toBe("implementation");
    expect(session.experimentId).toBe("canary-2026-09");
  });

  it("reports an unknown stratum and unclassified kind when nothing was declared", () => {
    const report = build({
      records: [record()],
      bindings: [binding()],
      history: [history()],
    });

    const session = sessionOf(report, DEEPSEEK_SESSION);
    expect(session.routeEventKind).toBeNull();
    expect(session.taskStratum).toBe("unknown");
    expect(session.requested).toBeNull();
    expect(session.requestedQuality).toBe("unknown");
  });
});

describe("pull-request association without duplicated usage", () => {
  it("links one thread to multiple PRs without duplicating its usage", () => {
    const only = record({ dedupeKey: "ds:1" });
    const report = build({
      records: [only],
      bindings: [binding()],
      history: [history()],
      links: [link({ number: 12 }), link({ number: 13 })],
    });

    const thread = report.threads.find((entry) => entry.threadId === THREAD)!;
    expect(thread.pullRequestKeys).toEqual(["github.com/acme/repo#12", "github.com/acme/repo#13"]);
    expect(thread.usage.totalTokens).toBe(totalTokens(only.totals));
    // Association is not attribution: a session on two PRs sits in `shared`,
    // and its total is not cloned onto each PR.
    expect(report.base.shared.totalTokens).toBe(totalTokens(only.totals));
    for (const pr of report.base.pullRequests) {
      expect(pr.attributed.totalTokens).toBe(0);
      expect(pr.shared.totalTokens).toBe(totalTokens(only.totals));
    }
  });

  it("does not attribute usage through a dismissed PR link", () => {
    const report = build({
      records: [record()],
      bindings: [binding()],
      history: [history()],
      links: [link({ number: 14, source: "stack-dismissed" })],
    });

    expect(report.base.pullRequests).toHaveLength(0);
    const thread = report.threads.find((entry) => entry.threadId === THREAD)!;
    expect(thread.pullRequestKeys).toEqual([]);
    // The usage is still measured; it is unallocated, not zero.
    expect(report.base.measured.totalTokens).toBe(totalTokens(record().totals));
    expect(report.base.unallocated.totalTokens).toBe(totalTokens(record().totals));
  });

  it("treats missing usage as unknown, never zero", () => {
    const missingSession = "019f0000-0000-7000-8000-0000000000aa";
    const report = build({
      bindings: [binding({ nativeSessionId: missingSession })],
      history: [history({ nativeSessionId: missingSession })],
    });

    const session = sessionOf(report, missingSession);
    expect(session.usage).toBeNull();
    // The provider is known from the durable binding; the model is unknown
    // because no usage was measured. Neither is a zero.
    expect(session.actualProvider).toBe("codex");
    expect(session.actualModel).toBeNull();
    const baseSession = report.base.sessions.find((entry) => entry.sessionId === missingSession)!;
    expect(baseSession.measurementQuality).toBe("missing");
    const thread = report.threads.find((entry) => entry.threadId === THREAD)!;
    expect(thread.usage.totalTokens).toBe(0);
    expect(thread.usage.records).toBe(0);
  });
});

describe("durable history keeps #4 measurement and identity quality", () => {
  // Claude has a supported request level, so an erased native identity is
  // observable as `unavailable` rather than collapsing to `missing`.
  const CLAUDE_SESSION = "5a128faa-8253-489e-b935-6c08e8e670c0";

  function claudeBinding() {
    return binding({ provider: "claude", nativeSessionId: CLAUDE_SESSION });
  }

  function claudeHistory() {
    return history({
      providerName: "claudeAgent",
      adapterKey: "claudeAgent",
      nativeSessionId: CLAUDE_SESSION,
      usageProvider: "claude",
    });
  }

  it("carries partial measurement completeness into the route view", () => {
    const report = build({
      records: [
        record({
          provider: "claude",
          sessionId: CLAUDE_SESSION,
          model: "claude-fable-5",
          dedupeKey: "m1:",
          measurement: "observed",
          measurementCompleteness: "partial",
          invalidTokenFields: 1,
        }),
      ],
      bindings: [claudeBinding()],
      history: [claudeHistory()],
    });

    const session = sessionOf(report, CLAUDE_SESSION);
    expect(session.quality?.measurement).toBe("partial");
    expect(session.quality?.identity).toBe("valid");
    // The base projection still carries the same axis, so the route view is a
    // faithful mirror rather than a second, divergent computation.
    const baseSession = report.base.sessions.find((entry) => entry.sessionId === CLAUDE_SESSION)!;
    expect(baseSession.measurementQuality).toBe(session.quality?.measurement);
  });

  it("keeps a legacy identity-erased durable row unavailable, not missing", () => {
    const report = build({
      records: [
        record({
          provider: "claude",
          sessionId: CLAUDE_SESSION,
          model: "claude-fable-5",
          dedupeKey: "legacy:1",
          measurement: "observed",
          measurementCompleteness: "partial",
          identityAvailable: false,
          totals: totals({ outputTokens: 40 }),
        }),
      ],
      bindings: [claudeBinding()],
      history: [claudeHistory()],
    });

    const session = sessionOf(report, CLAUDE_SESSION);
    // The erased native id leaves request identity `unavailable`, never
    // `missing`, and the nonzero total never implies a complete measurement.
    expect(session.quality?.request).toBe("unavailable");
    expect(session.quality?.measurement).toBe("partial");
  });

  it("keeps an invalid measurement invalid rather than measured", () => {
    const report = build({
      records: [
        record({
          provider: "claude",
          sessionId: CLAUDE_SESSION,
          model: "claude-fable-5",
          dedupeKey: "m1:",
          measurement: "invalid",
        }),
      ],
      bindings: [claudeBinding()],
      history: [claudeHistory()],
    });

    expect(sessionOf(report, CLAUDE_SESSION).quality?.measurement).toBe("invalid");
  });

  it("surfaces a cost-only conflict instead of silently deduping", () => {
    const report = build({
      records: [
        record({ dedupeKey: "same:1", costUsd: 0.01 }),
        record({ dedupeKey: "same:1", costUsd: 0.02 }),
      ],
      bindings: [binding()],
      history: [history()],
    });

    const session = sessionOf(report, DEEPSEEK_SESSION);
    expect(session.quality?.conflict).toBe(true);
    expect(session.quality?.recordIdentity).toBe("exact");
  });

  it("reports no measurement quality for a history-only unmeasured identity", () => {
    const report = build({
      bindings: [],
      history: [
        history({
          providerName: "opencode",
          adapterKey: "opencode",
          nativeSessionId: OPENCODE_CHILD,
          usageProvider: null,
        }),
      ],
    });

    const child = sessionOf(report, OPENCODE_CHILD);
    // Unknown usage has no measurement to qualify: null, never a fabricated zero
    // or a fabricated `measured`.
    expect(child.usage).toBeNull();
    expect(child.quality).toBeNull();
  });
});
