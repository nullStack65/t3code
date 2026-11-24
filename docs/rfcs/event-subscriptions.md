# Event subscriptions

`watch_pull_request` and the thread-alert path wake an agent on every check and comment, including bot skip-reviews such as coderabbitai. An agent needs to choose which events, which entity, and when a wake is delivered.

## Contract

`EventSubscription` lives in `packages/contracts/src/eventSubscription.ts`. One row per subscriber thread and selector is stored in SQLite (`event_subscriptions`, migration 101). The existing pull-request watch reactor and the thread-alert reactor read that row. There is no second poller.

Phase 1 stores and evaluates:

- a pull request selected by URL
- a thread selected by id

Repository, label, and path-glob selectors, and thread tag and domain selectors, are in the schema. A subscribe call that uses one returns `EventSubscriptionSelectorUnsupportedError` and stores nothing. An unimplemented selector is never treated as a match of everything.

`webhook` and `external` selectors (Linear, fleet health sentinel, approvals queue, Quo, Gmail) are schema variants only. Subscribing returns `EventSubscriptionPhase2Error` and stores nothing. This slice does not call those sources.

## Pull-request events

A filtered subscription wakes only for the selected names:

- `checks.required_passed`
- `checks.failed`, with optional `exclude: ["cancelled"]`
- `review.changes_requested`
- `review.approved`
- `comment.human`
- `conflict.detected`
- `merged`

`ignoreAuthors` drops those authors before a comment or review can wake the subscriber. Matching is case-insensitive and ignores a trailing `[bot]`.

`events: null` keeps today's wake set (including cancelled checks, advisory checks passing, awaiting approval, no checks, needs-rebase, and merge-queue removal) minus ignored authors. It does not wake on merge. A filtered subscription does not wake on those advisory changes.

## Delivery

All of these fields are enforced on the subscription. None are stored while the reactor ignores them.

- `immediate` and `coalesceWindowSeconds`: a null window wakes at once. A positive window stashes the burst and wakes once when the window is due. The existing pull-request sweep (about two minutes) and the thread-alert flush (about 30 seconds) flush a due window. There is no new scheduler.
- `autoExpireOnClose`: the row is removed when the pull request merges or closes, and when a watched thread settles.
- `onlyWhenIdle`: a wake waits while the subscriber has an active run. The next sweep or flush retries.
- `quietHours`: a wake waits while the subscriber's local time is inside the window.
- `maxWakesPerHour`: a wake waits after the cap until an older wake falls out of the hour.

`immediate: true` together with a positive window is `EventSubscriptionInvalidError`.

## `ignoreAuthors` default

The upgraded watch and a pull-request subscribe that omits `ignoreAuthors` default to `["coderabbitai"]`. The filter drops comments and reviews only. A real check failure and a human comment still wake, which is what current callers rely on. Pass `ignoreAuthors: []` to hear coderabbitai. A thread subscription defaults to an empty ignore list.

Callers of `watch_pull_request` that omit the new options do not get a stored subscription. When the store is present, the reactor applies that default as a virtual legacy subscription. When the store is absent, the old wake path is unchanged.

Passing `events`, `ignoreAuthors`, `coalesceWindowSeconds`, or `autoExpireOnClose` stores a subscription for that thread and URL and keeps the existing watch. Watching again with none of those options removes the row and restores the virtual legacy watch. `unwatch_pull_request` removes the row.

## Tools

- `t3_event_subscribe`
- `t3_event_unsubscribe` (idempotent; another thread's row is left in place)
- `t3_event_list` (the caller's rows only)

A pull-request URL subscription also starts the existing watch. If that watch fails, nothing is stored.
