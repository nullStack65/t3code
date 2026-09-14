import {
  type OmpSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  findOmpModelConfigOption,
  findOmpModelConfigOptionAny,
  flattenSessionConfigSelectOptions,
  resolveOmpAcpConfigUpdates,
} from "../Layers/OmpProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Whether to advertise form elicitation support (default true). Callers
   * that register no elicitation handler (e.g. unattended text generation)
   * must pass false: omp's uiContext.select then resolves immediately with
   * undefined (a fast, clear refusal) instead of waiting on a channel nobody
   * answers.
   */
  readonly enableElicitation?: boolean;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId?: string;
}

/**
 * RuntimeMode is a spawn-time concern for `omp acp`: approval behavior is
 * selected through CLI flags (verified against omp/18.0.6), not through an
 * in-session ACP mechanism. `always-ask` is passed explicitly for
 * approval-required because bare `acp` inherits the user's own
 * `tools.approvalMode` config, which may be `yolo` — Supervised must not
 * silently inherit it.
 */
export function ompAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return ["acp", "--approval-mode=write"];
    case "auto":
      return ["acp", "--auto-approve"];
    case "full-access":
      return ["acp", "--approval-mode=yolo"];
    case "approval-required":
    default:
      return ["acp", "--approval-mode=always-ask"];
  }
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: [...ompAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.ompSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        // omp/18.0.6 advertises exactly one auth method ("Use existing local
        // credentials"); credentials live under ~/.omp.
        authMethodId: "agent",
        // omp routes its second approval layer (extension wrapper, anything
        // short of yolo) through session/elicitation, and only when the
        // client declares form elicitation — undeclared reads as Deny.
        ...(input.enableElicitation === false
          ? {}
          : { clientCapabilities: { elicitation: { form: {} } } }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/**
 * Applies the requested model and provider options through omp's
 * `session/set_config_option` mechanism. There is no static default model
 * id for omp: when no model is requested, nothing is written and the CLI's
 * current config value wins.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<{ readonly model: string | undefined }, E> {
  return Effect.gen(function* () {
    const requestedModel = resolveOmpAcpBaseModelId(input.model);
    let effectiveModel = requestedModel;
    // Model first, then re-read config options: omp re-validates dependent
    // selects per model (e.g. `thinking` accepts off/auto under `auto` but
    // off/low/medium/high/max elsewhere), so validating against the
    // pre-switch options writes values the session then rejects.
    if (requestedModel !== undefined) {
      const configOptions = yield* input.runtime.getConfigOptions;
      // Existence probe without the select guard: ACP permits a boolean
      // option named `model`, and a string slug must never be written to it.
      const anyModelOption = findOmpModelConfigOptionAny(configOptions);
      const modelOption = findOmpModelConfigOption(configOptions);
      const modelConfigId = anyModelOption?.id ?? "model";
      // omp has no static default model id. Three cases:
      // - no model option advertised at all: write through (the CLI's own
      //   default behavior; nothing to validate against);
      // - a select model option that advertises the slug: write it;
      // - anything else (unadvertised slug, or a non-select model option):
      //   preserve the session's configured model instead of failing or
      //   overwriting it with an unrelated cross-provider default.
      const advertised = flattenSessionConfigSelectOptions(modelOption).map(
        (option) => option.value,
      );
      const shouldWrite =
        anyModelOption === undefined ||
        (modelOption !== undefined && advertised.includes(requestedModel));
      if (shouldWrite) {
        yield* input.runtime
          .setConfigOption(modelConfigId, requestedModel)
          .pipe(
            Effect.mapError((cause) =>
              input.mapError({ cause, step: "set-config-option", configId: modelConfigId }),
            ),
          );
      } else {
        // The write was skipped: report the model the session actually kept
        // so callers stamp truthful state (turn events, session record).
        const kept = anyModelOption;
        effectiveModel =
          kept?.type === "select" ? (kept.currentValue?.trim() ?? undefined) : undefined;
      }
    }
    const configOptions = yield* input.runtime.getConfigOptions;
    for (const update of resolveOmpAcpConfigUpdates(configOptions, input.selections)) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
    return { model: effectiveModel };
  });
}

export function resolveOmpAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = trimmed.includes("[") ? trimmed.slice(0, trimmed.indexOf("[")).trim() : trimmed;
  return base.length > 0 ? base : undefined;
}

/**
 * One omp session as reported by ACP `session/list`. omp answers with the
 * spec's `SessionInfo` plus its own transcript stats under `_meta`
 * (`messageCount`, `size`), which the picker shows so a migrating terminal
 * user can tell an empty session from a long one.
 */
export interface OmpNativeSessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly messageCount?: number;
  readonly sizeBytes?: number;
}

export interface OmpNativeSessionListing {
  readonly sessions: ReadonlyArray<OmpNativeSessionInfo>;
  readonly nextCursor?: string;
  /** Entries omp returned without a usable session id or cwd. */
  readonly skippedCount: number;
}

function listRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function listTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parses a `session/list` response leniently. A session picker must not go
 * blank because one persisted session lost its cwd or carries a field shape
 * this build does not know: unusable entries are counted and dropped, every
 * readable one is kept.
 */
export function parseOmpSessionList(raw: unknown): OmpNativeSessionListing {
  const response = listRecord(raw);
  const entries = Array.isArray(response?.sessions) ? response.sessions : [];
  const sessions: Array<OmpNativeSessionInfo> = [];
  let skippedCount = 0;
  for (const entry of entries) {
    const record = listRecord(entry);
    const sessionId = listTrimmedString(record?.sessionId);
    const cwd = listTrimmedString(record?.cwd);
    if (!record || !sessionId || !cwd) {
      skippedCount += 1;
      continue;
    }
    const meta = listRecord(record._meta);
    const title = listTrimmedString(record.title);
    const updatedAt = listTrimmedString(record.updatedAt);
    // omp reports transcript stats under `_meta`; anything non-numeric there
    // is another agent's metadata and must not reach the picker as a count.
    const messageCount = meta?.messageCount;
    const sizeBytes = meta?.size;
    sessions.push({
      sessionId,
      cwd,
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(typeof messageCount === "number" && Number.isInteger(messageCount) && messageCount >= 0
        ? { messageCount }
        : {}),
      ...(typeof sizeBytes === "number" && Number.isInteger(sizeBytes) && sizeBytes >= 0
        ? { sizeBytes }
        : {}),
    });
  }
  const nextCursor = listTrimmedString(response?.nextCursor);
  return {
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
    skippedCount,
  };
}

/**
 * Reads the new session id out of a `session/fork` response. omp answers
 * with a full session setup payload (`configOptions`, `modes`, `models`);
 * only the id is load-bearing for the client, the rest is re-read when the
 * fork is opened as its own session.
 */
export function parseOmpForkedSessionId(raw: unknown): string | undefined {
  return listTrimmedString(listRecord(raw)?.sessionId);
}
