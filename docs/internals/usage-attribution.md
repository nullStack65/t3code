# Usage attribution

[`usageAttribution.ts`](../../apps/server/src/usage/usageAttribution.ts) re-projects
the usage the transcript scan already measured onto four reporting levels — prompt,
provider request, native session, and pull request. It exists so model comparison can
be done at the level a source can actually establish, instead of dividing a turn's
tokens into invented requests. It is a pure function over allowlisted metadata: it
never reads the clock, the filesystem, or the database, and it never sees a prompt,
response, or tool payload.

[`usageAttributionSources.ts`](../../apps/server/src/usage/usageAttributionSources.ts)
is the read-only extraction seam that proves the pure function can be fed from what
the server actually writes. It reads the allowlisted fields of
`provider_session_runtime` (`resume_cursor_json`, `runtime_payload_json.importedTranscripts`)
and `projection_thread_pull_requests`, and returns a binding/link snapshot plus
diagnostics for what it could not read. It never returns a runtime payload.

## Granularity is a source property

Each provider transcript exposes a different unit, and the projection reports a level
as `unsupported` rather than estimating one:

| Provider    | Session | Prompt            | Request | Native unit                                                           |
| ----------- | ------- | ----------------- | ------- | --------------------------------------------------------------------- |
| Claude Code | yes     | no                | yes     | one assistant message = one API response (`message.id` + `requestId`) |
| Codex       | yes     | no                | no      | `token_count` deltas, one per model turn                              |
| Grok Build  | yes     | yes (`prompt_id`) | no      | `turn_completed`, one per prompt per model                            |

This is stated once in `ATTRIBUTION_SOURCE_CAPABILITIES` and mirrored into each
projection's `coverage`. A user prompt can span several Claude requests through tool
continuation, and no prompt id is written, so prompt totals are not derivable for
Claude. A Codex turn has no request id at all, so a request count there is never a
division of the turn: it is `null` with an `unsupported` quality.

`liveQualified` is `false` for every row in the matrix. The capability claims come
from the parsers and adapter cursor shapes in source, not from an installed-live
capture, and code that needs live evidence should say so.

## Four independent axes

A level's honesty is the combination of four things that are deliberately kept apart,
because collapsing them is how a zero-cost success gets invented:

- **identity validity** (`identityQuality`: `valid | missing | invalid`) — is the
  native session id present and well-formed? A malformed Claude id is `invalid`.
- **measurement completeness** (`measurementQuality`: `measured | partial | missing |
invalid | unavailable`) — were tokens actually measured, and were the provider's
  required fields present and valid? An explicit zero is `measured`; a valid known
  subset (Claude `input_tokens` with no `output_tokens`) is `partial`; a field that is
  present but holds `null`, a string, or a negative number makes the record `invalid`;
  Claude's `usage: {}` is `invalid`; an all-zero legacy row whose presence was erased
  is `unavailable`, never `missing` and never a measured zero. A nonzero total never
  implies a complete measurement.
  A **zero subtotal is not a reason to drop a record**: every provider now retains an
  eligible event whose total is zero — a complete measured zero, a known-zero subset,
  or an all-invalid payload — so the classification reaches the projection instead of
  disappearing at a parser gate. Only a usage container with no recognised token field
  (`usage: {}`, `last_token_usage: {}`, or an absent container) is treated as
  no-usage and not emitted. The parser never fabricates tokens to keep such a record,
  and Codex and Grok are held to the same rule as Claude. The scan's diagnostic
  `malformedRecords` count and each session's `measurementQuality` are derived from
  these retained records, so the two agree and nothing is double counted.
- **level support** (`promptQuality` / `requestQuality`) — can the source establish
  this level, and did the records carry its id? `unsupported` is a structural limit,
  not a zero. A legacy row whose native id was erased reports `unavailable`, never
  `missing`, and identity availability is kept apart from token magnitude.
- **allocation certainty** (`allocation`: `attributed | shared | unallocated |
ambiguous | missing | orphan`).

The M1 contract uses `exact | partial | unavailable | ambiguous` for the same ideas.
The mapping is by meaning: `measured` → `exact`, `partial` → `partial`, `missing` /
`unavailable` → `unavailable`, `invalid` stays a malformed observation, `unsupported`
stays a structural limit. No enum is renamed mechanically.

## Identity is not content equality

`dedupeKey` is the **scan/delivery identity**, kept apart from the native observation
ids (`providerRequestId`, `providerMessageId`, `promptId`), which are reporting values.
The projection resolves identity in three ways:

- **declared** — a `dedupeKey` present on the record, namespaced by provider so equal
  local ids from two providers cannot collide. Its **scope** is explicit:
  `dedupeKeyScope: "global"` is a globally qualified native observation id (Claude's
  `message.id:requestId`, Grok's `sessionId:promptId:model`), so the same key at
  another path is the same event; `"source-local"` is qualified by the canonical
  native session (the scan's Codex occurrence key), so equal local keys in two
  sessions are two observations, never one. A physical path is never used as scope.
  A global key that appears under a second native session is incompatible ownership,
  not a copy: it is surfaced as a conflict rather than silently dropped. Cost and its
  provenance are part of the observation, so a repriced record is a conflict, not a
  silent duplicate.
- **occurrence** — for a keyless source such as Codex `token_count`, the scan stamps an
  occurrence-aware key from `usageEventOccurrenceBaseKey` plus a per-delivery occurrence
  index. A copied rollout restarts its counter, so the copy lands on the same key and is
  de-duplicated, while two genuine equal events in one file land on different keys and
  are both kept.
- **unkeyed** — no identity at all. The record is **kept and counted**, never merged by
  content equality, and the owning session is marked `recordIdentity: "uncertain"`.
  A repeated delivery cannot be told from a second equal occurrence, so the projection
  says so instead of guessing.

Two versions of one identity with different content are a **conflict**: the first is
kept and the conflict is surfaced (`identity.conflicts`, `session.conflict`, a
limitation). A record whose source defines snapshot semantics (`scope: "snapshot"`)
instead **replaces** the earlier value for that identity, matching a
`cumulative_snapshot`/`aggregate` observation that is non-additive.

## Nothing measured is dropped

A record with no native session id is preserved in an explicit `orphan` bucket rather
than being discarded, and coverage seeds from declared sources and records before any
session is built, so a provider with only a failed or missing source still produces a
coverage row. The reconciliation identity holds against the deduplicated input, not a
pre-filtered session list:

```
sum(PR.attributed) + shared + unallocated + orphan === measured
```

where `measured` is the total of every distinct input record. Ambiguous sessions (a
native session bound to more than one thread) are pooled with unallocated usage; neither
can be placed on a PR without inventing an owner. Per-model contributions are preserved
at the session and PR levels, with each model's `costUsd` and `costSource` kept separate
so an unpriced model is never hidden by a priced one.

## Association is not attribution

A session linked to two pull requests is reported once in the `shared` pool, which is
explicitly not additive, and is never cloned onto both PRs. Only sessions bound to
exactly one strong link contribute to a PR's `attributed` total. A `stack` link is a
display association, not evidence of billed work, so it feeds
`stackAssociationSessions` and never `attributed`; `stack-dismissed` tombstones are
ignored, matching `visibleThreadPullRequests`.

Associations are read from the links that exist at the read cutoff
(`association.basis: "links-at-read-time"`, `cutoffMs === generatedAtMs`). `linkedAt`
does **not** gate allocation, so pre-link implementation work is included, and a link
that is later added, removed, or changed rewrites the recomputed view. The projection
therefore does not claim that changed links leave past allocations untouched:
historical allocation as of a past instant is unavailable without temporal evidence.

## Cache upgrades retain existing history

The scan cache version is still `4`. Supported-format policy:

- A `v3` document is **read** rather than discarded. The scan retains measured records
  from transcripts that have since been deleted for 90 days, and those cannot be
  re-parsed, so discarding a v3 cache would destroy that history. A v3 row decodes with
  its native ids and measurement presence explicitly `unavailable` (an all-zero row
  stays unknown, not a measured zero; a nonzero row is a known but only-partial
  measurement).
- A `v4` row written by the predecessor (15 fields, before the
  validity/completeness/key-scope fields were appended) is **read conservatively**:
  its completeness is `partial`, never `complete`, because the writer never asserted
  coverage. Missing quality metadata is never silently promoted. The entry is marked
  `qualityMetadata: "predecessor"`, so an extant file is cold re-parsed once and then
  accepted warm. No row is discarded for the format change.
- Only `v1`/`v2` (no parse position, different fork semantics) are rejected.

Warm-cache acceptance therefore requires both `identity: "declared"` (native ids and
measurement presence) and `qualityMetadata: "declared"` (the current numeric quality
fields). Either being stale forces one cold re-parse that replaces the entry, so
enrichment never double counts. A read failure during that re-parse keeps the retained
fallback rows, and a deleted file is never re-parsed at all, so its history survives
with conservative `partial` quality. Native-id availability alone does **not**
establish numeric metadata freshness; the two are separate axes.

## What still needs architecture approval

The projection proves the join and the levels with fixtures. It does not choose a
storage or transport for the result and registers no endpoint. Durable per-thread
session history (an additive cursor/identity record rather than the single current
cursor) is the one schema change that would widen coverage, and it is deliberately not
adopted here. Provider-instance identity is likewise not recoverable from a transcript
scan; correlate that when the scan starts tagging files with the instance that produced
them.

`UsageProviderKind` is `claude | codex | grok`. OpenCode, Antigravity, and Cursor have a
native cursor id but no transcript T3 scans, so they have no usage source here.
`usageAttributionSources` still exposes their native session → thread identity as a
narrow `ExtractedNativeSession` with `usageProvider: null` for M1R to consume; that is
the whole integration. Turn-only data remains turn-only: nothing in this module reads
`projection_turns`, and no OpenCode parser is added.
