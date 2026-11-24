import {
  EventSubscriptionInvalidError,
  EventSubscriptionPhase2Error,
  EventSubscriptionSelectorUnsupportedError,
  type EventDeliveryPolicy,
  type EventFilter,
  type EventSelector,
  type EventSubscription,
  type PullRequestEventFilter,
  type QuietHours,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
} from "@t3tools/contracts";

import type { PullRequestWatchChange } from "./pullRequestWatch.ts";

/** Dropped before a comment or review can wake. Match ignores case and a trailing `[bot]`. */
export const DEFAULT_PULL_REQUEST_IGNORE_AUTHORS = ["coderabbitai"] as const;

const THREAD_EVENT_NAMES = new Set(["lane-ended", "promise-without-wake", "stuck", "needs-person"]);

const HOUR_MS = 3_600_000;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SubscriptionCursor {
  readonly coalesceUntilMs: number | null;
  readonly pendingSummaries: readonly string[];
  readonly wakeTimesMs: readonly number[];
  readonly deliveredSignatures: Readonly<Record<string, string>>;
}

export const emptyCursor = (): SubscriptionCursor => ({
  coalesceUntilMs: null,
  pendingSummaries: [],
  wakeTimesMs: [],
  deliveredSignatures: {},
});

function canonicalAuthor(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/i, "");
}

function authorIgnored(login: string | null | undefined, ignore: readonly string[]): boolean {
  if (login == null || login.trim() === "") return false;
  const key = canonicalAuthor(login);
  return ignore.some((entry) => canonicalAuthor(entry) === key);
}

function normalizePullRequestUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(files|commits|checks)$/i, "");
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
}

export function pullRequestSelectorKey(url: string): string | null {
  try {
    return `pull_request:url:${normalizePullRequestUrl(url)}`;
  } catch {
    return null;
  }
}

export function threadSelectorKey(threadId: string): string {
  return `thread:thread_id:${threadId}`;
}

export function selectorKey(selector: EventSelector): string | null {
  if (selector.entity === "pull_request" && selector.by === "url") {
    return pullRequestSelectorKey(selector.url);
  }
  if (selector.entity === "thread" && selector.by === "thread_id") {
    return threadSelectorKey(selector.threadId);
  }
  return null;
}

export interface DeliveryInput {
  readonly immediate?: boolean | undefined;
  readonly coalesceWindowSeconds?: number | null | undefined;
  readonly autoExpireOnClose?: boolean | undefined;
  readonly onlyWhenIdle?: boolean | undefined;
  readonly quietHours?: QuietHours | null | undefined;
  readonly maxWakesPerHour?: number | null | undefined;
}

function normalizeDelivery(
  input: DeliveryInput | undefined,
):
  | { readonly ok: true; readonly delivery: EventDeliveryPolicy }
  | { readonly ok: false; readonly error: EventSubscriptionInvalidError } {
  const window = input?.coalesceWindowSeconds ?? null;
  if (window !== null && (!Number.isInteger(window) || window < 0)) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({
        detail: "coalesceWindowSeconds must be a non-negative integer.",
      }),
    };
  }
  if (input?.immediate === true && window !== null && window > 0) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({
        detail: "immediate does not combine with a coalesce window.",
      }),
    };
  }
  const maxWakes = input?.maxWakesPerHour ?? null;
  if (maxWakes !== null && (!Number.isInteger(maxWakes) || maxWakes < 1)) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({
        detail: "maxWakesPerHour must be a positive integer.",
      }),
    };
  }
  const quiet = input?.quietHours ?? null;
  if (quiet !== null) {
    const invalid = validateQuietHours(quiet);
    if (invalid !== null) {
      return { ok: false, error: new EventSubscriptionInvalidError({ detail: invalid }) };
    }
  }
  return {
    ok: true,
    delivery: {
      coalesceWindowSeconds:
        input?.immediate === true || window === null || window === 0 ? null : window,
      autoExpireOnClose: input?.autoExpireOnClose === true,
      onlyWhenIdle: input?.onlyWhenIdle === true,
      quietHours: quiet,
      maxWakesPerHour: maxWakes,
    },
  };
}

function validateQuietHours(hours: QuietHours): string | null {
  if (!CLOCK_RE.test(hours.start) || !CLOCK_RE.test(hours.end)) {
    return "quietHours start and end must be HH:MM in 24-hour time.";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone }).format(0);
  } catch {
    return `quietHours timeZone is not a valid IANA zone: ${hours.timeZone}.`;
  }
  return null;
}

/** Minutes from midnight in the zone. Throws when the zone is invalid. */
function minutesInZone(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nowMs);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function quietHoursCover(hours: QuietHours | null, nowMs: number): boolean {
  if (hours === null || hours.start === hours.end) return false;
  const now = minutesInZone(nowMs, hours.timeZone);
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function clockMinutes(value: string): number {
  const match = CLOCK_RE.exec(value);
  if (match === null) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function eventFamily(name: string): "pull_request" | "thread" {
  return THREAD_EVENT_NAMES.has(name) ? "thread" : "pull_request";
}

export type SubscribeRejection =
  | EventSubscriptionPhase2Error
  | EventSubscriptionSelectorUnsupportedError
  | EventSubscriptionInvalidError;

export function prepareSubscribe(input: {
  readonly id: string;
  readonly subscriberThreadId: ThreadId;
  readonly selector: EventSelector;
  readonly events: readonly EventFilter[];
  readonly ignoreAuthors?: readonly string[] | undefined;
  readonly delivery?: DeliveryInput | undefined;
  readonly createdAt: string;
}):
  | { readonly ok: true; readonly subscription: EventSubscription; readonly selectorKey: string }
  | {
      readonly ok: false;
      readonly error: SubscribeRejection;
    } {
  if (input.selector.entity === "webhook" || input.selector.entity === "external") {
    return {
      ok: false,
      error: new EventSubscriptionPhase2Error({
        entity: input.selector.entity,
        source: input.selector.source,
      }),
    };
  }
  if (input.selector.entity === "pull_request" && input.selector.by !== "url") {
    return {
      ok: false,
      error: new EventSubscriptionSelectorUnsupportedError({
        entity: "pull_request",
        by: input.selector.by,
      }),
    };
  }
  if (input.selector.entity === "thread" && input.selector.by !== "thread_id") {
    return {
      ok: false,
      error: new EventSubscriptionSelectorUnsupportedError({
        entity: "thread",
        by: input.selector.by,
      }),
    };
  }
  if (input.events.length === 0) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({ detail: "Select at least one event." }),
    };
  }
  const family = input.selector.entity;
  const mismatched = input.events.find((event) => eventFamily(event.name) !== family);
  if (mismatched !== undefined) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({
        detail: `${mismatched.name} is not a ${family} event.`,
      }),
    };
  }
  const key = selectorKey(input.selector);
  if (key === null) {
    const detail =
      input.selector.entity === "pull_request"
        ? "The pull request URL is not valid."
        : "The selector could not be stored.";
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({ detail }),
    };
  }
  const delivery = normalizeDelivery(input.delivery);
  if (!delivery.ok) return delivery;
  const ignoreAuthors =
    input.ignoreAuthors !== undefined
      ? [...input.ignoreAuthors]
      : family === "pull_request"
        ? [...DEFAULT_PULL_REQUEST_IGNORE_AUTHORS]
        : [];
  return {
    ok: true,
    selectorKey: key,
    subscription: {
      id: input.id,
      subscriberThreadId: input.subscriberThreadId,
      selector: input.selector,
      events: [...input.events],
      ignoreAuthors,
      delivery: delivery.delivery,
      createdAt: input.createdAt,
      ...emptyCursor(),
    },
  };
}

/** A watch that passes filters. Omitted events keep the legacy wake set. */
export function watchSubscription(input: {
  readonly id: string;
  readonly subscriberThreadId: ThreadId;
  readonly url: string;
  readonly events?: readonly PullRequestEventFilter[] | undefined;
  readonly ignoreAuthors?: readonly string[] | undefined;
  readonly coalesceWindowSeconds?: number | undefined;
  readonly autoExpireOnClose?: boolean | undefined;
  readonly createdAt: string;
}):
  | { readonly ok: true; readonly subscription: EventSubscription; readonly selectorKey: string }
  | {
      readonly ok: false;
      readonly error: EventSubscriptionInvalidError;
    } {
  const delivery = normalizeDelivery({
    ...(input.coalesceWindowSeconds === undefined
      ? {}
      : { coalesceWindowSeconds: input.coalesceWindowSeconds }),
    ...(input.autoExpireOnClose === undefined
      ? {}
      : { autoExpireOnClose: input.autoExpireOnClose }),
  });
  if (!delivery.ok) return delivery;
  const key = pullRequestSelectorKey(input.url);
  if (key === null) {
    return {
      ok: false,
      error: new EventSubscriptionInvalidError({ detail: "The pull request URL is not valid." }),
    };
  }
  return {
    ok: true,
    selectorKey: key,
    subscription: {
      id: input.id,
      subscriberThreadId: input.subscriberThreadId,
      selector: { entity: "pull_request", by: "url", url: input.url },
      events: input.events === undefined ? null : [...input.events],
      ignoreAuthors:
        input.ignoreAuthors === undefined
          ? [...DEFAULT_PULL_REQUEST_IGNORE_AUTHORS]
          : [...input.ignoreAuthors],
      delivery: delivery.delivery,
      createdAt: input.createdAt,
      ...emptyCursor(),
    },
  };
}

export function virtualLegacySubscription(
  subscriberThreadId: ThreadId,
  url: string,
): EventSubscription {
  const prepared = watchSubscription({
    id: "virtual",
    subscriberThreadId,
    url,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  return prepared.subscription;
}

export function cursorOf(subscription: EventSubscription): SubscriptionCursor {
  return {
    coalesceUntilMs: subscription.coalesceUntilMs,
    pendingSummaries: subscription.pendingSummaries,
    wakeTimesMs: subscription.wakeTimesMs,
    deliveredSignatures: subscription.deliveredSignatures,
  };
}

export function withCursor(
  subscription: EventSubscription,
  cursor: SubscriptionCursor,
): EventSubscription {
  return { ...subscription, ...cursor };
}

function reviewClass(
  remark: PullRequestComment,
): "review.approved" | "review.changes_requested" | "comment.human" {
  const state = (remark.reviewState ?? "").toUpperCase().replaceAll("-", "_");
  if (state === "APPROVED") return "review.approved";
  if (state === "CHANGES_REQUESTED" || state === "REQUESTED_CHANGES") {
    return "review.changes_requested";
  }
  return "comment.human";
}

function remarkSelected(
  remark: PullRequestComment,
  events: readonly EventFilter[] | null,
  ignoreAuthors: readonly string[],
): boolean {
  if (authorIgnored(remark.author?.login, ignoreAuthors)) return false;
  if (events === null) return true;
  const name = reviewClass(remark);
  return events.some((event) => event.name === name);
}

function failedFilters(events: readonly EventFilter[] | null) {
  if (events === null) return { includeFailure: true, includeCancelled: true };
  const filters = events.filter(
    (event): event is Extract<PullRequestEventFilter, { name: "checks.failed" }> =>
      event.name === "checks.failed",
  );
  return {
    includeFailure: filters.length > 0,
    includeCancelled: filters.some((event) => !event.exclude?.includes("cancelled")),
  };
}

function keepCheck(check: PullRequestCheck, failed: ReturnType<typeof failedFilters>): boolean {
  if (check.status === "cancelled") return failed.includeCancelled;
  if (check.status === "failure") return failed.includeFailure;
  return false;
}

function summaryOf(change: PullRequestWatchChange): string {
  switch (change.kind) {
    case "checks-failed": {
      const names = change.failed.map((check) => check.name).join(", ");
      return change.failed.every((check) => check.status === "cancelled")
        ? `Cancelled checks: ${names}`
        : `Failed checks: ${names}`;
    }
    case "checks-passed":
      return change.required ? "Required checks passed" : "Checks passed";
    case "checks-awaiting-approval":
      return `Checks awaiting approval: ${change.checks.map((check) => check.name).join(", ")}`;
    case "remarks":
      return change.remarks
        .map((remark) => {
          const who = remark.author?.login ?? "someone";
          const kind = reviewClass(remark);
          if (kind === "review.approved") return `Approved by ${who}`;
          if (kind === "review.changes_requested") return `Changes requested by ${who}`;
          return `Comment from ${who}`;
        })
        .join("; ");
    case "no-checks":
      return `No checks reported after ${change.minutes} minutes`;
    case "conflicting":
      return "Merge conflict";
    case "needs-rebase":
      return "Rebase required";
    case "merge-queue-removed":
      return change.reason === null
        ? "Removed from the merge queue"
        : `Removed from the merge queue: ${change.reason}`;
  }
}

export function selectWatchChanges(
  changes: readonly PullRequestWatchChange[],
  events: readonly EventFilter[] | null,
  ignoreAuthors: readonly string[],
): {
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  readonly summaries: readonly string[];
} {
  const selected: PullRequestWatchChange[] = [];
  const failed = failedFilters(events);
  for (const change of changes) {
    switch (change.kind) {
      case "checks-failed": {
        const kept = change.failed.filter((check) => keepCheck(check, failed));
        if (kept.length > 0) selected.push({ kind: "checks-failed", failed: kept });
        break;
      }
      case "checks-passed":
        if (
          events === null ||
          (change.required && events.some((event) => event.name === "checks.required_passed"))
        ) {
          selected.push(change);
        }
        break;
      case "remarks": {
        const remarks = change.remarks.filter((remark) =>
          remarkSelected(remark, events, ignoreAuthors),
        );
        if (remarks.length > 0) selected.push({ kind: "remarks", remarks });
        break;
      }
      case "conflicting":
        if (events === null || events.some((event) => event.name === "conflict.detected")) {
          selected.push(change);
        }
        break;
      case "checks-awaiting-approval":
      case "no-checks":
      case "needs-rebase":
      case "merge-queue-removed":
        if (events === null) selected.push(change);
        break;
    }
  }
  return { changes: selected, summaries: selected.map(summaryOf) };
}

function shouldHold(
  delivery: EventDeliveryPolicy,
  idle: boolean,
  nowMs: number,
  wakeTimesMs: readonly number[],
): boolean {
  if (delivery.onlyWhenIdle && !idle) return true;
  if (delivery.quietHours !== null && quietHoursCover(delivery.quietHours, nowMs)) return true;
  if (delivery.maxWakesPerHour !== null) {
    const recent = wakeTimesMs.filter((time) => nowMs - time < HOUR_MS).length;
    if (recent >= delivery.maxWakesPerHour) return true;
  }
  return false;
}

function afterWake(state: SubscriptionCursor, nowMs: number): SubscriptionCursor {
  return {
    coalesceUntilMs: null,
    pendingSummaries: [],
    wakeTimesMs: [...state.wakeTimesMs.filter((time) => nowMs - time < HOUR_MS), nowMs],
    deliveredSignatures: state.deliveredSignatures,
  };
}

export interface PullRequestPlan {
  readonly action: "wake" | "consume" | "hold";
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  readonly summaries: readonly string[];
  readonly state: SubscriptionCursor;
  readonly expire: boolean;
  readonly includesRemarks: boolean;
}

export function planPullRequestSubscription(input: {
  readonly changes: readonly PullRequestWatchChange[];
  readonly events: readonly EventFilter[] | null;
  readonly ignoreAuthors: readonly string[];
  readonly delivery: EventDeliveryPolicy;
  readonly idle: boolean;
  readonly nowMs: number;
  readonly state: SubscriptionCursor;
  readonly terminal?: "merged" | "closed" | null;
}): PullRequestPlan {
  const terminal = input.terminal ?? null;
  if (terminal === "closed") {
    const summaries = input.state.pendingSummaries;
    return {
      action: summaries.length > 0 ? "wake" : "consume",
      changes: [],
      summaries,
      state: summaries.length > 0 ? afterWake(input.state, input.nowMs) : input.state,
      expire: input.delivery.autoExpireOnClose,
      includesRemarks: false,
    };
  }
  if (terminal === "merged") {
    const wantMerged = input.events?.some((event) => event.name === "merged") === true;
    const summaries = [
      ...input.state.pendingSummaries,
      ...(wantMerged ? ["Pull request merged"] : []),
    ];
    return {
      action: summaries.length > 0 ? "wake" : "consume",
      changes: [],
      summaries,
      state:
        summaries.length > 0 ? afterWake(input.state, input.nowMs) : emptyCursorOf(input.state),
      expire: input.delivery.autoExpireOnClose,
      includesRemarks: false,
    };
  }

  const selected = selectWatchChanges(input.changes, input.events, input.ignoreAuthors);
  const pending = input.state.pendingSummaries;
  const windowSec = input.delivery.coalesceWindowSeconds ?? 0;
  const due = input.state.coalesceUntilMs !== null && input.nowMs >= input.state.coalesceUntilMs;
  const selectedNow = selected.summaries.length > 0;
  const remarksOnly =
    selected.changes.length > 0 && selected.changes.every((change) => change.kind === "remarks");

  if (!selectedNow && pending.length === 0) {
    return {
      action: "consume",
      changes: [],
      summaries: [],
      state: input.state,
      expire: false,
      includesRemarks: false,
    };
  }
  if (!selectedNow && !due) {
    return {
      action: "consume",
      changes: [],
      summaries: [],
      state: input.state,
      expire: false,
      includesRemarks: false,
    };
  }
  if (shouldHold(input.delivery, input.idle, input.nowMs, input.state.wakeTimesMs)) {
    return {
      action: "hold",
      changes: selected.changes,
      summaries: selected.summaries,
      state: input.state,
      expire: false,
      includesRemarks: remarksOnly,
    };
  }
  if (selectedNow && windowSec > 0 && !due) {
    return {
      action: "consume",
      changes: [],
      summaries: [],
      state: {
        ...input.state,
        coalesceUntilMs: input.state.coalesceUntilMs ?? input.nowMs + windowSec * 1000,
        pendingSummaries: [...pending, ...selected.summaries],
      },
      expire: false,
      includesRemarks: false,
    };
  }
  const summaries = [...pending, ...selected.summaries];
  return {
    action: "wake",
    changes: selected.changes,
    summaries,
    state: afterWake(input.state, input.nowMs),
    expire: false,
    includesRemarks:
      remarksOnly || summaries.every((line) => /^(Comment|Approved|Changes requested)/.test(line)),
  };
}

function emptyCursorOf(state: SubscriptionCursor): SubscriptionCursor {
  return { ...emptyCursor(), deliveredSignatures: state.deliveredSignatures };
}

export interface ThreadPlan {
  readonly action: "wake" | "consume" | "hold";
  readonly summaries: readonly string[];
  readonly state: SubscriptionCursor;
  readonly expire: boolean;
}

export function planThreadSubscription(input: {
  readonly findings: readonly {
    readonly kind: string;
    readonly detail: string;
    readonly signature: string;
  }[];
  readonly events: readonly { readonly name: string }[];
  readonly delivery: EventDeliveryPolicy;
  readonly idle: boolean;
  readonly nowMs: number;
  readonly state: SubscriptionCursor;
  readonly settled: boolean;
}): ThreadPlan {
  const names = new Set(input.events.map((event) => event.name));
  const fresh = input.findings.filter(
    (finding) =>
      names.has(finding.kind) &&
      input.state.deliveredSignatures[finding.kind] !== finding.signature,
  );
  const lines = fresh.map((finding) => `${finding.kind}: ${finding.detail}`);
  const signatures = { ...input.state.deliveredSignatures };
  for (const finding of fresh) signatures[finding.kind] = finding.signature;
  const pending = input.state.pendingSummaries;
  const windowSec = input.delivery.coalesceWindowSeconds ?? 0;
  const due = input.state.coalesceUntilMs !== null && input.nowMs >= input.state.coalesceUntilMs;

  if (input.settled) {
    const summaries = [...pending, ...lines];
    return {
      action: summaries.length > 0 ? "wake" : "consume",
      summaries,
      state: {
        ...(summaries.length > 0 ? afterWake(input.state, input.nowMs) : input.state),
        deliveredSignatures: signatures,
        ...(summaries.length === 0 ? {} : { pendingSummaries: [], coalesceUntilMs: null }),
      },
      expire: input.delivery.autoExpireOnClose,
    };
  }

  if (lines.length === 0 && pending.length === 0) {
    return { action: "consume", summaries: [], state: input.state, expire: false };
  }
  if (lines.length === 0 && !due) {
    return { action: "consume", summaries: [], state: input.state, expire: false };
  }
  if (shouldHold(input.delivery, input.idle, input.nowMs, input.state.wakeTimesMs)) {
    if (lines.length === 0) {
      return { action: "hold", summaries: [], state: input.state, expire: false };
    }
    return {
      action: "consume",
      summaries: [],
      state: {
        ...input.state,
        deliveredSignatures: signatures,
        pendingSummaries: [...pending, ...lines],
        coalesceUntilMs:
          input.state.coalesceUntilMs ??
          (windowSec > 0 ? input.nowMs + windowSec * 1000 : input.nowMs),
      },
      expire: false,
    };
  }
  if (lines.length > 0 && windowSec > 0 && !due) {
    return {
      action: "consume",
      summaries: [],
      state: {
        ...input.state,
        deliveredSignatures: signatures,
        coalesceUntilMs: input.state.coalesceUntilMs ?? input.nowMs + windowSec * 1000,
        pendingSummaries: [...pending, ...lines],
      },
      expire: false,
    };
  }
  return {
    action: "wake",
    summaries: [...pending, ...lines],
    state: { ...afterWake(input.state, input.nowMs), deliveredSignatures: signatures },
    expire: false,
  };
}

export function subscriptionWake(input: {
  readonly number: number;
  readonly url: string;
  readonly summaries: readonly string[];
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const summary = input.summaries[0] ?? "update";
  const failed = input.summaries.some((line) => /fail|conflict|cancel|rebase/i.test(line));
  return {
    text: [
      `Update on pull request #${input.number} (${input.url}), which T3 Code is watching for you:`,
      ...input.summaries,
      "",
      "T3 Code is still watching this pull request.",
    ].join("\n"),
    notification: {
      source: { kind: "monitor" },
      outcome: failed ? "failed" : "updated",
      summary: `#${input.number}: ${summary}`,
    },
  };
}
