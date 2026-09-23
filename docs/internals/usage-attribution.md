# Usage attribution

[`usageAttribution.ts`](../../apps/server/src/usage/usageAttribution.ts) re-projects
the usage the transcript scan already measured onto four reporting levels — prompt,
provider request, native session, and pull request. It exists so model comparison can
be done at the level a source can actually establish, instead of dividing a turn's
tokens into invented requests. It is a pure function over allowlisted metadata: it
never reads the clock, the filesystem, or the database, and it never sees a prompt,
response, or tool payload. Ingestion is the caller's job; the projection takes records,
explicit bindings, and existing PR links.

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
division of the turn: it is `null` with a `unsupported` quality. The request/message
ids were added to `UsageRecord` (and the v4 scan cache) precisely so they stay
separate from `dedupeKey`, which is a de-duplication composite and not a provider
request id.

`liveQualified` is `false` for every row in the matrix. The capability claims come
from the parsers and adapter cursor shapes in source, not from an installed-live
capture, and code that needs live evidence should say so.

## The identity join

A native session reaches a T3 thread through exactly one of two durable places, both
already persisted:

- the current `resume_cursor_json` on `provider_session_runtime` — `{threadId}` for
  Codex, `{resume}` for Claude, `{sessionId}` for ACP and OpenCode;
- `runtime_payload_json.importedTranscripts`, which accumulates imported Claude/Codex
  file identities (including `providerSessionId`) and is the only historical binding
  that survives an upsert.

`provider_session_runtime` is one row per thread and the upsert overwrites
`resume_cursor_json`, so after a session switch, fork, or model-change restart only the
newest native id is durable. Usage from an earlier native id therefore becomes
unbound, and the projection reports it as `unallocated` rather than guessing an owner.
A thread → PR link comes from `projection_thread_pull_requests`, canonicalized with
`@t3tools/shared/threadPullRequests`; the projection does not resolve PRs itself.

## Association is not attribution

A session linked to two pull requests is reported once in the `shared` pool, which is
explicitly not additive, and is never cloned onto both PRs. Only sessions bound to
exactly one strong link contribute to a PR's `attributed` total. A `stack` link is a
display association, not evidence of billed work, so it feeds
`stackAssociationSessions` and never `attributed`; `stack-dismissed` tombstones are
ignored, matching `visibleThreadPullRequests`. Link changes therefore do not rewrite
past allocations — the projection is recomputed from the links that exist at read time.

## Data quality and duplicate scans

The output distinguishes a measured zero from an absent measurement: a known session
with no usage has `totals: null` and quality `missing`, and contributes nothing to any
pool, so a failed turn can never read as a zero-cost success. Malformed Claude session
ids are `invalid`; a session with some records lacking the level's id is `partial`.
Records are de-duplicated by `dedupeKey`, falling back to a content signature for
sourceless records such as Codex turns, so two environments scanning one transcript
directory cannot count it twice. The projection never rescans history; it consumes the
records the append-only scan cache already produced.

## What still needs architecture approval

The projection proves the join and the levels with fixtures. It does not choose a
storage or transport for the result and registers no endpoint. Durable per-thread
session history (an additive cursor/identity record rather than the single current
cursor) is the one schema change that would widen coverage, and it is deliberately not
adopted here. Provider-instance identity is likewise not recoverable from a transcript
scan; correlate that when the scan starts tagging files with the instance that produced
them.
