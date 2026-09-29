import type {
  AgentSessionImportSource,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";
import type { RouteEventInput, RouteSelectionMetadata } from "../../usage/routeMetadata.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
  /**
   * True sub-agent parent native session id, when the caller knows it. Kept
   * separate from the resume cursor so child sessions stay distinguishable
   * instead of being flattened into the parent.
   */
  readonly parentNativeSessionId?: string | null;
  /**
   * What this session was asked to run. Persisted as a request record; it is
   * never treated as the observed model.
   */
  readonly requestedRoute?: RouteSelectionMetadata | null;
  /**
   * A declared canary/fallback/review/escalation event. T3 only carries it;
   * the route authority (agent-config policy / OMP Skill) decides it.
   */
  readonly routeEvent?: RouteEventInput | null;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryUpsertOptions {
  readonly onConflict?: "update" | "ignore";
}

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
    options?: ProviderSessionDirectoryUpsertOptions,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  /** Record an imported file without changing the current provider session. */
  readonly recordImportedTranscript: (input: {
    readonly threadId: ThreadId;
    readonly source: AgentSessionImportSource;
  }) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
