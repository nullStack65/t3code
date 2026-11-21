import {
  ThreadId,
  type EventDeliveryPolicy,
  type EventFilter,
  type EventSelector,
  type PullRequestComment,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { subscribeEvent } from "../mcp/toolkits/events/handlers.ts";

import {
  DEFAULT_PULL_REQUEST_IGNORE_AUTHORS,
  emptyCursor,
  planPullRequestSubscription,
  planThreadSubscription,
  prepareSubscribe,
  quietHoursCover,
  selectWatchChanges,
  virtualLegacySubscription,
  watchSubscription,
  type SubscriptionCursor,
} from "./eventSubscription.ts";
import type { PullRequestWatchChange } from "./pullRequestWatch.ts";

const THREAD = ThreadId.make("thread-1");
const URL = "https://github.com/T3Tools/t3code/pull/12";
const NOW = Date.parse("2026-11-21T15:30:00.000Z");

const off: EventDeliveryPolicy = {
  coalesceWindowSeconds: null,
  autoExpireOnClose: false,
  onlyWhenIdle: false,
  quietHours: null,
  maxWakesPerHour: null,
};

const remark = (login: string, reviewState: string | null): PullRequestComment => ({
  id: `${login}-${reviewState ?? "comment"}`,
  kind: reviewState === null ? "issue-comment" : "review",
  author: { login, name: null, avatarUrl: null },
  body: "note",
  createdAt: "2026-11-21T15:00:00.000Z",
  url: null,
  path: null,
  reviewState,
});

const remarks = (login: string, reviewState: string | null = null): PullRequestWatchChange => ({
  kind: "remarks",
  remarks: [remark(login, reviewState)],
});

const failed = (status: "failure" | "cancelled"): PullRequestWatchChange => ({
  kind: "checks-failed",
  failed: [{ name: "ci", status, description: null, url: null }],
});

const plan = (
  changes: readonly PullRequestWatchChange[],
  events: readonly EventFilter[] | null,
  extras: {
    readonly ignoreAuthors?: readonly string[];
    readonly delivery?: EventDeliveryPolicy;
    readonly state?: SubscriptionCursor;
    readonly nowMs?: number;
    readonly idle?: boolean;
    readonly terminal?: "merged" | "closed" | null;
  } = {},
) =>
  planPullRequestSubscription({
    changes,
    events,
    ignoreAuthors: extras.ignoreAuthors ?? [...DEFAULT_PULL_REQUEST_IGNORE_AUTHORS],
    delivery: extras.delivery ?? off,
    idle: extras.idle ?? true,
    nowMs: extras.nowMs ?? NOW,
    state: extras.state ?? emptyCursor(),
    ...(extras.terminal === undefined ? {} : { terminal: extras.terminal }),
  });

describe("event subscriptions", () => {
  it("does not wake on an ignored coderabbitai comment, including the [bot] suffix", () => {
    const ignored = plan([remarks("coderabbitai[bot]")], [{ name: "comment.human" }]);
    assert.strictEqual(ignored.action, "consume");
    assert.deepEqual(ignored.summaries, []);
    const human = plan([remarks("ada")], [{ name: "comment.human" }]);
    assert.strictEqual(human.action, "wake");
    assert.deepEqual(human.summaries, ["Comment from ada"]);
  });

  it("drops a cancelled check when cancelled is excluded and still wakes on a failure", () => {
    const events = [{ name: "checks.failed" as const, exclude: ["cancelled" as const] }];
    const cancelled = plan([failed("cancelled")], events);
    assert.strictEqual(cancelled.action, "consume");
    const failure = plan([failed("failure")], events);
    assert.strictEqual(failure.action, "wake");
    assert.deepEqual(failure.summaries, ["Failed checks: ci"]);
    const kept = plan([failed("cancelled")], [{ name: "checks.failed" }]);
    assert.strictEqual(kept.action, "wake");
  });

  it("wakes each pull request event only when that event is selected", () => {
    const cases: ReadonlyArray<{
      readonly event: EventFilter;
      readonly change: PullRequestWatchChange;
      readonly summary: string;
    }> = [
      {
        event: { name: "checks.required_passed" },
        change: { kind: "checks-passed", count: 2, required: true },
        summary: "Required checks passed",
      },
      {
        event: { name: "review.changes_requested" },
        change: remarks("ada", "CHANGES_REQUESTED"),
        summary: "Changes requested by ada",
      },
      {
        event: { name: "review.approved" },
        change: remarks("ada", "APPROVED"),
        summary: "Approved by ada",
      },
      {
        event: { name: "conflict.detected" },
        change: { kind: "conflicting" },
        summary: "Merge conflict",
      },
    ];
    for (const entry of cases) {
      const selected = plan([entry.change], [entry.event], { ignoreAuthors: [] });
      assert.strictEqual(selected.action, "wake", entry.event.name);
      assert.deepEqual(selected.summaries, [entry.summary]);
      const other = cases.find((candidate) => candidate.event.name !== entry.event.name)!;
      const skipped = plan([entry.change], [other.event], { ignoreAuthors: [] });
      assert.strictEqual(
        skipped.action,
        "consume",
        `${entry.event.name} selected ${other.event.name}`,
      );
    }
    const merged = plan([], [{ name: "merged" }], { terminal: "merged" });
    assert.strictEqual(merged.action, "wake");
    assert.deepEqual(merged.summaries, ["Pull request merged"]);
    const notMerged = plan([], [{ name: "comment.human" }], { terminal: "merged" });
    assert.strictEqual(notMerged.action, "consume");
    const advisory = plan(
      [{ kind: "checks-passed", count: 1, required: false }],
      [{ name: "checks.required_passed" }],
    );
    assert.strictEqual(advisory.action, "consume");
  });

  it("keeps legacy watches waking on failures and human comments while ignoring coderabbitai", () => {
    const legacy = virtualLegacySubscription(THREAD, URL);
    assert.deepEqual(legacy.ignoreAuthors, ["coderabbitai"]);
    assert.strictEqual(legacy.events, null);
    assert.strictEqual(legacy.delivery.autoExpireOnClose, false);
    const failure = plan([failed("failure"), failed("cancelled")], null);
    assert.strictEqual(failure.action, "wake");
    const human = plan([remarks("ada")], null);
    assert.strictEqual(human.action, "wake");
    const bot = plan([remarks("CodeRabbitAI[bot]")], null);
    assert.strictEqual(bot.action, "consume");
    const optedOut = plan([remarks("coderabbitai")], null, { ignoreAuthors: [] });
    assert.strictEqual(optedOut.action, "wake");
  });

  it("coalesces two events inside the window into one wake", () => {
    const delivery: EventDeliveryPolicy = { ...off, coalesceWindowSeconds: 60 };
    const first = plan([remarks("ada")], [{ name: "comment.human" }], {
      delivery,
      ignoreAuthors: [],
    });
    assert.strictEqual(first.action, "consume");
    assert.deepEqual(first.state.pendingSummaries, ["Comment from ada"]);
    const second = plan([remarks("grace")], [{ name: "comment.human" }], {
      delivery,
      ignoreAuthors: [],
      state: first.state,
      nowMs: NOW + 1_000,
    });
    assert.strictEqual(second.action, "consume");
    assert.deepEqual(second.state.pendingSummaries, ["Comment from ada", "Comment from grace"]);
    const flushed = plan([], [{ name: "comment.human" }], {
      delivery,
      state: second.state,
      nowMs: NOW + 60_000,
    });
    assert.strictEqual(flushed.action, "wake");
    assert.deepEqual(flushed.summaries, ["Comment from ada", "Comment from grace"]);
    assert.deepEqual(flushed.state.pendingSummaries, []);
  });

  it("removes an autoExpireOnClose subscription when the pull request merges or closes", () => {
    const delivery: EventDeliveryPolicy = { ...off, autoExpireOnClose: true };
    assert.strictEqual(
      plan([], [{ name: "merged" }], { delivery, terminal: "merged" }).expire,
      true,
    );
    assert.strictEqual(
      plan([], [{ name: "merged" }], { delivery, terminal: "closed" }).expire,
      true,
    );
    assert.strictEqual(plan([], [{ name: "merged" }], { terminal: "merged" }).expire, false);
    assert.strictEqual(plan([], [{ name: "merged" }], { terminal: "closed" }).expire, false);
  });

  it("enforces idle, quiet hours, and the hourly wake cap by holding the cursor", () => {
    const comment = [remarks("ada")];
    const events = [{ name: "comment.human" as const }];
    const busy = plan(comment, events, {
      ignoreAuthors: [],
      delivery: { ...off, onlyWhenIdle: true },
      idle: false,
    });
    assert.strictEqual(busy.action, "hold");
    const quiet = plan(comment, events, {
      ignoreAuthors: [],
      delivery: {
        ...off,
        quietHours: { start: "15:00", end: "16:00", timeZone: "UTC" },
      },
    });
    assert.strictEqual(quiet.action, "hold");
    assert.strictEqual(
      quietHoursCover({ start: "16:00", end: "17:00", timeZone: "UTC" }, NOW),
      false,
    );
    assert.strictEqual(
      quietHoursCover({ start: "22:00", end: "06:00", timeZone: "UTC" }, NOW),
      false,
    );
    assert.strictEqual(
      quietHoursCover(
        { start: "22:00", end: "06:00", timeZone: "UTC" },
        Date.parse("2026-11-21T23:10:00.000Z"),
      ),
      true,
    );
    const capped = plan(comment, events, {
      ignoreAuthors: [],
      delivery: { ...off, maxWakesPerHour: 1 },
      state: { ...emptyCursor(), wakeTimesMs: [NOW - 1_000] },
    });
    assert.strictEqual(capped.action, "hold");
    const later = plan(comment, events, {
      ignoreAuthors: [],
      delivery: { ...off, maxWakesPerHour: 1 },
      state: { ...emptyCursor(), wakeTimesMs: [NOW - 3_600_001] },
    });
    assert.strictEqual(later.action, "wake");
  });

  it("fails a phase-2 or unimplemented selector before a subscription exists", () => {
    const phase2 = prepareSubscribe({
      id: "evt_1",
      subscriberThreadId: THREAD,
      selector: { entity: "external", source: "linear" },
      events: [{ name: "comment.human" }],
      createdAt: "2026-11-21T15:30:00.000Z",
    });
    assert.strictEqual(phase2.ok, false);
    if (!phase2.ok) assert.strictEqual(phase2.error._tag, "EventSubscriptionPhase2Error");
    const webhook = prepareSubscribe({
      id: "evt_2",
      subscriberThreadId: THREAD,
      selector: { entity: "webhook", source: "gmail" },
      events: [{ name: "comment.human" }],
      createdAt: "2026-11-21T15:30:00.000Z",
    });
    assert.strictEqual(webhook.ok, false);
    if (!webhook.ok) assert.strictEqual(webhook.error._tag, "EventSubscriptionPhase2Error");
    for (const selector of [
      { entity: "pull_request" as const, by: "repository" as const, repository: "t3tools/t3code" },
      { entity: "pull_request" as const, by: "label" as const, label: "bug" },
      { entity: "pull_request" as const, by: "path_glob" as const, pathGlob: "apps/**" },
      { entity: "thread" as const, by: "tag" as const, tag: "ops" },
      { entity: "thread" as const, by: "domain" as const, domain: "inbox" },
    ]) {
      const rejected = prepareSubscribe({
        id: "evt_3",
        subscriberThreadId: THREAD,
        selector,
        events: selector.entity === "thread" ? [{ name: "stuck" }] : [{ name: "merged" }],
        createdAt: "2026-11-21T15:30:00.000Z",
      });
      assert.strictEqual(rejected.ok, false, selector.by);
      if (!rejected.ok) {
        assert.strictEqual(rejected.error._tag, "EventSubscriptionSelectorUnsupportedError");
      }
    }
    const zone = prepareSubscribe({
      id: "evt_4",
      subscriberThreadId: THREAD,
      selector: { entity: "pull_request", by: "url", url: URL },
      events: [{ name: "merged" }],
      delivery: { quietHours: { start: "01:00", end: "02:00", timeZone: "Not/AZone" } },
      createdAt: "2026-11-21T15:30:00.000Z",
    });
    assert.strictEqual(zone.ok, false);
    if (!zone.ok) assert.strictEqual(zone.error._tag, "EventSubscriptionInvalidError");
  });

  it.effect("does not watch or store a phase-2 or unsupported subscribe", () =>
    Effect.gen(function* () {
      const rejected = (selector: EventSelector, events: ReadonlyArray<EventFilter>, tag: string) =>
        Effect.gen(function* () {
          let watched = 0;
          let stored = 0;
          const exit = yield* Effect.exit(
            subscribeEvent({
              callerThreadId: THREAD,
              request: { selector, events: [...events] },
              id: "evt_rejected",
              createdAt: "2026-11-21T15:30:00.000Z",
              store: {
                put: () => {
                  stored += 1;
                  return Effect.die("stored");
                },
              } as never,
              watchPullRequest: () => {
                watched += 1;
                return Effect.die("watched");
              },
            }),
          );
          assert.strictEqual(watched, 0);
          assert.strictEqual(stored, 0);
          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const reason = exit.cause.reasons[0];
            assert.ok(reason !== undefined && Cause.isFailReason(reason));
            if (reason !== undefined && Cause.isFailReason(reason)) {
              assert.strictEqual(reason.error._tag, tag);
            }
          }
        });
      yield* rejected(
        { entity: "external", source: "linear" },
        [{ name: "comment.human" }],
        "EventSubscriptionPhase2Error",
      );
      yield* rejected(
        { entity: "webhook", source: "quo" },
        [{ name: "comment.human" }],
        "EventSubscriptionPhase2Error",
      );
      yield* rejected(
        { entity: "pull_request", by: "label", label: "bug" },
        [{ name: "merged" }],
        "EventSubscriptionSelectorUnsupportedError",
      );
      yield* rejected(
        { entity: "thread", by: "domain", domain: "inbox" },
        [{ name: "stuck" }],
        "EventSubscriptionSelectorUnsupportedError",
      );
    }),
  );

  it("stores omitted delivery fields as off and defaults pull request ignoreAuthors", () => {
    const stored = prepareSubscribe({
      id: "evt_5",
      subscriberThreadId: THREAD,
      selector: { entity: "pull_request", by: "url", url: URL },
      events: [{ name: "comment.human" }],
      createdAt: "2026-11-21T15:30:00.000Z",
    });
    assert.strictEqual(stored.ok, true);
    if (stored.ok) {
      assert.deepEqual(stored.subscription.ignoreAuthors, ["coderabbitai"]);
      assert.strictEqual(stored.subscription.delivery.autoExpireOnClose, false);
      assert.strictEqual(stored.subscription.delivery.onlyWhenIdle, false);
      assert.strictEqual(stored.subscription.delivery.quietHours, null);
      assert.strictEqual(stored.subscription.delivery.maxWakesPerHour, null);
      assert.strictEqual(stored.subscription.delivery.coalesceWindowSeconds, null);
    }
    const watched = watchSubscription({
      id: "evt_6",
      subscriberThreadId: THREAD,
      url: `${URL}/files`,
      createdAt: "2026-11-21T15:30:00.000Z",
    });
    assert.strictEqual(watched.ok, true);
    if (watched.ok) {
      assert.strictEqual(watched.subscription.events, null);
      assert.strictEqual(
        watched.selectorKey,
        "pull_request:url:https://github.com/T3Tools/t3code/pull/12",
      );
    }
    const selected = selectWatchChanges(
      [remarks("ada", "REQUESTED_CHANGES")],
      [{ name: "review.changes_requested" }],
      [],
    );
    assert.strictEqual(selected.summaries[0], "Changes requested by ada");
  });

  it("expires a thread subscription when the watched thread settles", () => {
    const delivery: EventDeliveryPolicy = { ...off, autoExpireOnClose: true };
    const ended = planThreadSubscription({
      findings: [{ kind: "lane-ended", detail: "The lane finished.", signature: "run-1" }],
      events: [{ name: "lane-ended" }],
      delivery,
      idle: true,
      nowMs: NOW,
      state: emptyCursor(),
      settled: true,
    });
    assert.strictEqual(ended.action, "wake");
    assert.strictEqual(ended.expire, true);
    const kept = planThreadSubscription({
      findings: [],
      events: [{ name: "stuck" }],
      delivery: off,
      idle: false,
      nowMs: NOW,
      state: emptyCursor(),
      settled: true,
    });
    assert.strictEqual(kept.expire, false);
  });
});
