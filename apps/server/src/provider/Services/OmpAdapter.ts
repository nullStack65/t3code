/**
 * OmpAdapter — shape type for the Oh My Pi (`omp`) provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/OmpDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module OmpAdapter
 */
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { OmpNativeSessionInfo } from "../acp/OmpAcpSupport.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * Cursor persisted on a `ProviderSession` so a later `startSession` reopens
 * the same omp session through `session/load`. Versioned because the
 * adapter refuses cursors it cannot read rather than resuming the wrong
 * conversation.
 */
export interface OmpResumeCursor {
  readonly schemaVersion: number;
  readonly sessionId: string;
}

/** An omp session discovered through `session/list`, ready to resume. */
export interface OmpDiscoveredSession extends OmpNativeSessionInfo {
  readonly resumeCursor: OmpResumeCursor;
}

export interface OmpDiscoveredSessionPage {
  readonly sessions: ReadonlyArray<OmpDiscoveredSession>;
  readonly nextCursor?: string;
  /** Entries omp returned that carried no usable session id or cwd. */
  readonly skippedCount: number;
}

export interface OmpListNativeSessionsInput {
  /**
   * Directory the discovery connection runs in. omp's session store is
   * global, so this only decides where the short-lived `omp acp` child is
   * spawned, not which sessions come back.
   */
  readonly cwd: string;
  /** Restricts results to one workspace. Omitted lists every omp session. */
  readonly filterCwd?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

/** A live omp session copied at its current state by `session/fork`. */
export interface OmpForkedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly resumeCursor: OmpResumeCursor;
}

/**
 * OmpAdapterShape — per-instance Oh My Pi adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 *
 * Extends the shared adapter contract with the two session-store
 * operations omp exposes over ACP and the other providers do not:
 * forking a live session and enumerating the agent's own sessions.
 */
export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /**
   * Copies a live session at its current state through ACP `session/fork`
   * and returns a cursor the caller can start a sibling thread from. The
   * original session keeps running and is not rewound — ACP has no rewind
   * (see `capabilities.supportsConversationRollback`).
   */
  readonly forkSession: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpForkedSession, ProviderAdapterError>;

  /**
   * Enumerates the sessions omp itself persisted — including the ones a
   * user started in the terminal — so they can be resumed here. Served by
   * a live session's connection when one exists, otherwise by a
   * short-lived `omp acp` child that only initializes.
   */
  readonly listNativeSessions: (
    input: OmpListNativeSessionsInput,
  ) => Effect.Effect<OmpDiscoveredSessionPage, ProviderAdapterError>;
}
