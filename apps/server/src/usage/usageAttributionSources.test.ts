import { describe, expect, it } from "@effect/vitest";

import {
  extractAttributionBindings,
  extractAttributionLinks,
  extractAttributionSnapshot,
  type PersistedProviderSessionRuntimeRow,
  type PersistedThreadPullRequestRow,
} from "./usageAttributionSources.ts";

function runtimeRow(
  overrides: Partial<PersistedProviderSessionRuntimeRow> = {},
): PersistedProviderSessionRuntimeRow {
  return {
    threadId: "thread-1",
    providerName: "claudeAgent",
    providerInstanceId: "claude-default",
    adapterKey: "claudeAgent",
    resumeCursor: { resume: "5a128faa-8253-489e-b935-6c08e8e670c0" },
    runtimePayload: null,
    ...overrides,
  };
}

function importedSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claudeAgent",
    providerInstanceId: "claude-original",
    providerSessionId: "original-session",
    filePath: "/home/u/.claude/projects/-home-u-project/original.jsonl",
    size: 10,
    mtimeMs: 1,
    device: 1,
    inode: 2,
    birthtimeMs: 3,
    ...overrides,
  };
}

function linkRow(
  overrides: Partial<PersistedThreadPullRequestRow> = {},
): PersistedThreadPullRequestRow {
  return {
    threadId: "thread-1",
    host: "github.com",
    repository: "acme/repo",
    number: 12,
    url: "https://github.com/acme/repo/pull/12",
    source: "manual",
    linkedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("extractAttributionBindings", () => {
  it("reads the Claude {resume} cursor shape into a usage binding", () => {
    const { bindings, nativeSessions, diagnostics } = extractAttributionBindings([runtimeRow()]);

    expect(bindings).toEqual([
      {
        threadId: "thread-1",
        provider: "claude",
        providerInstanceId: "claude-default",
        nativeSessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
        origin: "runtimeCursor",
      },
    ]);
    expect(nativeSessions[0]).toMatchObject({
      providerName: "claudeAgent",
      adapterKey: "claudeAgent",
      usageProvider: "claude",
    });
    expect(diagnostics.runtimeCursorBindings).toBe(1);
    expect(diagnostics.absentIdentityRows).toBe(0);
  });

  it("reads the Codex {threadId} cursor shape", () => {
    const { bindings } = extractAttributionBindings([
      runtimeRow({
        providerName: "codex",
        adapterKey: "codex",
        providerInstanceId: "codex-default",
        resumeCursor: { threadId: "019fbbc1-b12c-7360-a685-28c181f0025f" },
      }),
    ]);

    expect(bindings[0]).toMatchObject({
      provider: "codex",
      nativeSessionId: "019fbbc1-b12c-7360-a685-28c181f0025f",
    });
  });

  it("binds an imported transcript only for the thread it names", () => {
    const { bindings, diagnostics } = extractAttributionBindings([
      runtimeRow({
        threadId: "import:claude-original:original-session",
        resumeCursor: null,
        runtimePayload: { importedTranscripts: [importedSource()] },
      }),
    ]);

    expect(bindings).toEqual([
      {
        threadId: "import:claude-original:original-session",
        provider: "claude",
        providerInstanceId: "claude-original",
        nativeSessionId: "original-session",
        origin: "importedTranscript",
      },
    ]);
    expect(diagnostics.importedTranscriptBindings).toBe(1);
  });

  it("exposes an OpenCode session without inventing a usage provider", () => {
    const { bindings, nativeSessions, diagnostics } = extractAttributionBindings([
      runtimeRow({
        providerName: "opencode",
        adapterKey: "opencode",
        providerInstanceId: "opencode-default",
        resumeCursor: { sessionId: "ses_opencode_1" },
      }),
    ]);

    expect(bindings).toEqual([]);
    expect(nativeSessions).toEqual([
      {
        threadId: "thread-1",
        providerName: "opencode",
        adapterKey: "opencode",
        providerInstanceId: "opencode-default",
        nativeSessionId: "ses_opencode_1",
        origin: "runtimeCursor",
        usageProvider: null,
      },
    ]);
    expect(diagnostics.unsupportedProviderBindings).toBe(1);
  });

  it("leaves absent, malformed, and overwritten history visible", () => {
    const { bindings, diagnostics } = extractAttributionBindings([
      // Absent: no cursor, no imported transcripts.
      runtimeRow({ threadId: "thread-absent", resumeCursor: null }),
      // Malformed cursor: an object with no recognised id field.
      runtimeRow({ threadId: "thread-malformed", resumeCursor: { nope: true } }),
      // Malformed payload: importedTranscripts is not an array.
      runtimeRow({
        threadId: "thread-payload",
        resumeCursor: null,
        runtimePayload: { importedTranscripts: {} },
      }),
      // Overwritten: the current cursor is a later session than the retained import.
      runtimeRow({
        threadId: "import:claude-original:original-session",
        providerName: "codex",
        adapterKey: "codex",
        providerInstanceId: "codex-new",
        resumeCursor: { threadId: "new-session" },
        runtimePayload: { importedTranscripts: [importedSource()] },
      }),
    ]);

    expect(diagnostics.absentIdentityRows).toBe(1);
    expect(diagnostics.malformedResumeCursors).toBe(1);
    expect(diagnostics.malformedRuntimePayloads).toBe(1);
    expect(diagnostics.overwrittenThreads).toBe(1);
    // The overwritten row still yields both identities.
    expect(bindings.map((entry) => entry.nativeSessionId).toSorted()).toEqual([
      "new-session",
      "original-session",
    ]);
  });

  it("counts one native session bound to two threads as ambiguous", () => {
    const { diagnostics } = extractAttributionBindings([
      runtimeRow({ threadId: "thread-1" }),
      runtimeRow({ threadId: "thread-2" }),
    ]);

    expect(diagnostics.ambiguousSessionIds).toBe(1);
  });

  it("skips imported entries that name a different thread or provider", () => {
    const { diagnostics } = extractAttributionBindings([
      runtimeRow({
        threadId: "import:claude-original:original-session",
        resumeCursor: null,
        runtimePayload: {
          importedTranscripts: [
            null,
            {},
            importedSource({ provider: "cursor" }),
            importedSource({ providerSessionId: "wrong-session" }),
            importedSource(),
          ],
        },
      }),
    ]);

    expect(diagnostics.skippedImportedTranscripts).toBe(4);
    expect(diagnostics.importedTranscriptBindings).toBe(1);
  });
});

describe("extractAttributionLinks", () => {
  it("reads allowlisted fields from a persisted projection row", () => {
    const { links, diagnostics } = extractAttributionLinks([linkRow()]);

    expect(links).toEqual([
      {
        threadId: "thread-1",
        host: "github.com",
        repository: "acme/repo",
        number: 12,
        source: "manual",
        linkedAt: "2026-09-01T00:00:00.000Z",
        url: "https://github.com/acme/repo/pull/12",
      },
    ]);
    expect(diagnostics).toMatchObject({ rows: 1, links: 1, dismissed: 0, malformed: 0 });
  });

  it("keeps stack-dismissed tombstones for the projection to filter", () => {
    const { links, diagnostics } = extractAttributionLinks([
      linkRow({ number: 12 }),
      linkRow({ number: 13, source: "stack" }),
      linkRow({ number: 14, source: "stack-dismissed" }),
    ]);

    expect(links.map((entry) => entry.number)).toEqual([12, 13, 14]);
    expect(diagnostics.dismissed).toBe(1);
  });

  it("drops malformed rows and counts them", () => {
    const { links, diagnostics } = extractAttributionLinks([
      linkRow(),
      linkRow({ number: 0 }),
      linkRow({ host: "" }),
      linkRow({ source: "not-a-source" as PersistedThreadPullRequestRow["source"] }),
    ]);

    expect(links).toHaveLength(1);
    expect(diagnostics.malformed).toBe(3);
  });
});

describe("extractAttributionSnapshot", () => {
  it("reads a Claude imported cursor that carries both threadId and resume", () => {
    // Claude writes `{ threadId, resume }` together for an imported session; the
    // native session id is `resume`, not the T3 thread id in `threadId`.
    const { bindings, nativeSessions } = extractAttributionBindings([
      runtimeRow({
        threadId: "import:claude-original:original-session",
        providerName: "claudeAgent",
        adapterKey: "claudeAgent",
        resumeCursor: {
          threadId: "import:claude-original:original-session",
          resume: "5a128faa-8253-489e-b935-6c08e8e670c0",
        },
      }),
    ]);

    expect(nativeSessions[0]).toMatchObject({
      nativeSessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
      origin: "runtimeCursor",
      usageProvider: "claude",
    });
    expect(bindings[0]).toMatchObject({
      nativeSessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    });
  });

  it("labels the cutoff and never leaks the runtime payload", () => {
    const snapshot = extractAttributionSnapshot({
      cutoffMs: 1_786_100_000_000,
      runtimeRows: [
        runtimeRow({
          threadId: "import:claude-original:original-session",
          resumeCursor: null,
          runtimePayload: {
            cwd: "/secret/path",
            importedTranscripts: [importedSource()],
            marker: "do-not-leak",
          },
        }),
      ],
      linkRows: [linkRow({ threadId: "import:claude-original:original-session" })],
    });

    expect(snapshot.cutoffMs).toBe(1_786_100_000_000);
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.links).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-leak");
    expect(JSON.stringify(snapshot)).not.toContain("/secret/path");
  });

  /**
   * The deterministic interchange fixture M1C consumes. It is produced by the
   * real extractor from persisted-row shapes only, so it can be regenerated
   * exactly. Field semantics:
   *
   * - `cutoffMs` — associations are read as of this instant.
   * - `bindings[]` — usage-provider native session -> T3 thread, with the
   *   canonical `provider` (never the adapter key) and `origin`.
   * - `nativeSessions[]` — every native identity, including OpenCode with
   *   `usageProvider: null`; a label, never a join key.
   * - `links[]` — canonical thread -> PR links; `stack-dismissed` tombstones are
   *   preserved for the projection to filter.
   * - `diagnostics` — what could not be read, never dropped silently.
   */
  it("produces a stable fixture for the M1C interchange", () => {
    const snapshot = extractAttributionSnapshot({
      cutoffMs: 1_786_100_000_000,
      runtimeRows: [
        runtimeRow({
          threadId: "thread-opencode",
          providerName: "opencode",
          adapterKey: "opencode",
          providerInstanceId: "opencode-default",
          resumeCursor: { sessionId: "ses_opencode_1" },
        }),
        runtimeRow({
          threadId: "import:claude-original:original-session",
          providerName: "claudeAgent",
          adapterKey: "claudeAgent",
          providerInstanceId: "claude-default",
          resumeCursor: {
            threadId: "import:claude-original:original-session",
            resume: "5a128faa-8253-489e-b935-6c08e8e670c0",
          },
          runtimePayload: { importedTranscripts: [importedSource()] },
        }),
        runtimeRow({
          threadId: "thread-codex",
          providerName: "codex",
          adapterKey: "codex",
          providerInstanceId: "codex-default",
          resumeCursor: { threadId: "019fbbc1-b12c-7360-a685-28c181f0025f" },
        }),
      ],
      linkRows: [
        linkRow({ threadId: "thread-opencode", number: 12 }),
        linkRow({ threadId: "thread-codex", number: 12, source: "agent" }),
        linkRow({ threadId: "thread-codex", number: 13, source: "stack" }),
      ],
    });

    expect(snapshot).toEqual({
      cutoffMs: 1_786_100_000_000,
      bindings: [
        {
          threadId: "import:claude-original:original-session",
          provider: "claude",
          providerInstanceId: "claude-default",
          nativeSessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
          origin: "runtimeCursor",
        },
        {
          threadId: "import:claude-original:original-session",
          provider: "claude",
          providerInstanceId: "claude-original",
          nativeSessionId: "original-session",
          origin: "importedTranscript",
        },
        {
          threadId: "thread-codex",
          provider: "codex",
          providerInstanceId: "codex-default",
          nativeSessionId: "019fbbc1-b12c-7360-a685-28c181f0025f",
          origin: "runtimeCursor",
        },
      ],
      nativeSessions: [
        {
          threadId: "thread-opencode",
          providerName: "opencode",
          adapterKey: "opencode",
          providerInstanceId: "opencode-default",
          nativeSessionId: "ses_opencode_1",
          origin: "runtimeCursor",
          usageProvider: null,
        },
        {
          threadId: "import:claude-original:original-session",
          providerName: "claudeAgent",
          adapterKey: "claudeAgent",
          providerInstanceId: "claude-default",
          nativeSessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
          origin: "runtimeCursor",
          usageProvider: "claude",
        },
        {
          threadId: "import:claude-original:original-session",
          providerName: "claudeAgent",
          adapterKey: "claudeAgent",
          providerInstanceId: "claude-original",
          nativeSessionId: "original-session",
          origin: "importedTranscript",
          usageProvider: "claude",
        },
        {
          threadId: "thread-codex",
          providerName: "codex",
          adapterKey: "codex",
          providerInstanceId: "codex-default",
          nativeSessionId: "019fbbc1-b12c-7360-a685-28c181f0025f",
          origin: "runtimeCursor",
          usageProvider: "codex",
        },
      ],
      links: [
        {
          threadId: "thread-opencode",
          host: "github.com",
          repository: "acme/repo",
          number: 12,
          source: "manual",
          linkedAt: "2026-09-01T00:00:00.000Z",
          url: "https://github.com/acme/repo/pull/12",
        },
        {
          threadId: "thread-codex",
          host: "github.com",
          repository: "acme/repo",
          number: 12,
          source: "agent",
          linkedAt: "2026-09-01T00:00:00.000Z",
          url: "https://github.com/acme/repo/pull/12",
        },
        {
          threadId: "thread-codex",
          host: "github.com",
          repository: "acme/repo",
          number: 13,
          source: "stack",
          linkedAt: "2026-09-01T00:00:00.000Z",
          url: "https://github.com/acme/repo/pull/12",
        },
      ],
      diagnostics: {
        bindings: {
          runtimeRows: 3,
          runtimeCursorBindings: 3,
          importedTranscriptBindings: 1,
          absentIdentityRows: 0,
          malformedResumeCursors: 0,
          malformedRuntimePayloads: 0,
          skippedImportedTranscripts: 0,
          unsupportedProviderBindings: 1,
          overwrittenThreads: 1,
          ambiguousSessionIds: 0,
        },
        links: { rows: 3, links: 3, dismissed: 0, malformed: 0 },
      },
    });
  });
});
