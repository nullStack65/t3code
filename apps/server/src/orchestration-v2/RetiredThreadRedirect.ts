import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type RedirectSourceKind,
  type ResolvedThreadTarget,
  type ThreadId,
  type ThreadRedirectError,
  type ThreadRedirectNode,
  resolveActiveThreadTargetWith,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/**
 * Redirect for wakes aimed at a retired thread. Each wake entrypoint (`thread_send`, `schedule`,
 * `pr_watch`, `event`) resolves its target here before it dispatches, so a retired thread never
 * starts a provider turn. Every redirect appends one record to the redirect ledger.
 */

/** Where a wake came from. Ids only: the ledger never carries message text. */
export interface RedirectWakeSource {
  readonly sourceKind: RedirectSourceKind;
  readonly callerThreadId?: ThreadId | undefined;
  readonly taskId?: string | undefined;
  readonly subscriptionId?: string | undefined;
  readonly prUrl?: string | undefined;
}

export interface RedirectLedgerRecord extends RedirectWakeSource {
  readonly timestamp: string;
  readonly retiredThreadId: ThreadId;
  readonly redirectedToThreadId: ThreadId;
  readonly hopCount: number;
}

const LEDGER_FILE = "retired-thread-redirects.jsonl";
/** Override for the ledger location; `scripts/standing_threads.py redirect-report` reads the same variable. */
export const REDIRECT_LEDGER_ENV = "RETIRED_REDIRECT_LEDGER";
/** One append is a single small line, so concurrent writers never interleave it. */
const MAX_FIELD_LENGTH = 512;
/** The ledger keeps one rotated generation, so it stays bounded at about twice this. */
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const APPEND_TIMEOUT = "2 seconds";

const appendLock = Semaphore.makeUnsafe(1);

const clip = (value: string) =>
  value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;

/** The ledger path: the override when set, else the server's state directory. */
const ledgerPath = Effect.gen(function* () {
  const override = process.env[REDIRECT_LEDGER_ENV]?.trim();
  if (override) return override;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  return Option.isSome(config) ? NodePath.join(config.value.stateDir, LEDGER_FILE) : undefined;
});

const appendLine = (path: string, line: string) =>
  Effect.tryPromise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const size = await NodeFSP.stat(path).then(
      (stat) => stat.size,
      () => 0,
    );
    if (size >= MAX_LEDGER_BYTES) await NodeFSP.rename(path, `${path}.1`);
    await NodeFSP.appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  });

/**
 * Appends one redirect-hit record. Never fails and never waits long: a ledger that cannot be
 * written is logged, and the wake is delivered regardless.
 */
export const recordRedirectHit = Effect.fn("RetiredThreadRedirect.recordRedirectHit")(function* (
  record: Omit<RedirectLedgerRecord, "timestamp">,
) {
  const path = yield* ledgerPath;
  if (path === undefined) {
    return yield* Effect.logWarning("retired-thread redirect not recorded: no ledger path");
  }
  const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
  const entry: RedirectLedgerRecord = {
    timestamp,
    retiredThreadId: clip(record.retiredThreadId) as ThreadId,
    redirectedToThreadId: clip(record.redirectedToThreadId) as ThreadId,
    sourceKind: record.sourceKind,
    ...(record.callerThreadId === undefined
      ? {}
      : { callerThreadId: clip(record.callerThreadId) as ThreadId }),
    ...(record.taskId === undefined ? {} : { taskId: clip(record.taskId) }),
    ...(record.subscriptionId === undefined ? {} : { subscriptionId: clip(record.subscriptionId) }),
    ...(record.prUrl === undefined ? {} : { prUrl: clip(record.prUrl) }),
    hopCount: record.hopCount,
  };
  yield* appendLock
    .withPermits(1)(appendLine(path, `${JSON.stringify(entry)}\n`))
    .pipe(
      Effect.timeout(APPEND_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("retired-thread redirect ledger append failed", cause),
      ),
    );
});

export interface ResolvedWakeTarget extends ResolvedThreadTarget {
  /** True when the wake was aimed at a retired thread and moved. */
  readonly redirected: boolean;
}

/**
 * The live thread a wake aimed at `threadId` must go to. A thread that is not retired resolves to
 * itself with no ledger record. A retired one resolves to the end of its chain and appends a
 * ledger record. Fails closed with a `ThreadRedirectError` on a cycle, a chain longer than the hop
 * limit, or a replacement that is gone; the caller must then drop the wake, never deliver it.
 */
export const resolveWakeTarget = Effect.fn("RetiredThreadRedirect.resolveWakeTarget")(function* <
  E,
  R,
>(
  lookup: (threadId: ThreadId) => Effect.Effect<ThreadRedirectNode | null, E, R>,
  threadId: ThreadId,
  source: RedirectWakeSource,
): Effect.fn.Return<ResolvedWakeTarget, E | ThreadRedirectError, R> {
  const resolved = yield* resolveActiveThreadTargetWith(lookup, threadId);
  if (resolved.hopCount === 0) return { ...resolved, redirected: false };
  yield* recordRedirectHit({
    retiredThreadId: threadId,
    redirectedToThreadId: resolved.threadId,
    hopCount: resolved.hopCount,
    ...source,
  });
  return { ...resolved, redirected: true };
});
