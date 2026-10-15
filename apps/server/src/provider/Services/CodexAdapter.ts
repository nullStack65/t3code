/**
 * CodexAdapter — shape type for the Codex provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CodexDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module CodexAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { CodexSessionObservationReader } from "../CodexSessionObservation.ts";
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * CodexAdapterShape — per-instance Codex adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /** In-process readback for a future admission consumer, not a client/model RPC. */
  readonly nativeObservation: (
    threadId: ThreadId,
  ) => Effect.Effect<CodexSessionObservationReader | undefined, ProviderAdapterError>;
  readonly uploadFeedback: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["uploadFeedback"]
  >;
}
