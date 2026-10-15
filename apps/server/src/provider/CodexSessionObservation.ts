import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const CodexTypedSkillCandidate = Schema.Struct({
  directory: Schema.NonEmptyString,
  sourceRepository: Schema.Literal("nullStack65/closura-agent-config"),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  admissionSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeCandidate = Schema.decodeUnknownOption(CodexTypedSkillCandidate, {
  onExcessProperty: "error",
});
type Candidate = typeof CodexTypedSkillCandidate.Type;

const unknown = (reason: string) => Object.freeze({ status: "unknown" as const, reason });
const unqualified = Object.freeze({
  servedModel: unknown("session model metadata does not attest the model serving a turn"),
  modelGeneration: unknown("no independently attested model generation"),
  harnessVersion: unknown("initialize does not attest the executable build"),
  principal: unknown("no session-bound authenticated principal observation"),
  billing: unknown("no authoritative session billing observation"),
  effort: unknown("requested/session effort does not attest served effort"),
  fallback: unknown("no complete fallback/pin observation"),
  availability: unknown("no authoritative availability or remaining-budget observation"),
  skillContainment: unknown("implicit discovery, body reads and invocation are not intercepted"),
  contextContainment: unknown(
    "fresh thread or compaction does not establish absence of unqualified instructions",
  ),
  sourceAdmission: unknown("candidate pins are requests, not authenticated source or admission"),
  assignment: unknown("no authenticated task, owner, effect and budget binding"),
});

export interface CodexObservationCapture {
  readonly candidate: Candidate;
  readonly observation: CodexNativeObservation;
  readonly capturedAt: number;
}

export interface CodexNativeObservation {
  readonly provenance: "server-owned-child-stdio";
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly process: Readonly<{ pid: number; generation: string }>;
  readonly revision: number;
  readonly contextGeneration: number;
  readonly initialized: boolean;
  readonly providerThreadId: string | null;
  readonly acknowledgedTurnId: string | null;
  readonly requested: Readonly<{ model: string | null; serviceTier: string | null }>;
  readonly reportedSessionModel: Readonly<{
    value: string;
    provenance:
      | "thread-open-response"
      | "thread-settings-notification"
      | "model-rerouted-notification";
  }> | null;
  readonly retainedContext: boolean;
  readonly invalidated: string | null;
  readonly closed: boolean;
  readonly unknown: typeof unqualified;
}

export interface CodexSkillAdmissionResult {
  readonly admissionAuthorized: false;
  readonly reason:
    | "invalid-candidate"
    | "untrusted-capture"
    | "replayed-capture"
    | "candidate-mismatch"
    | "future-capture"
    | "expired-capture"
    | "stale-generation"
    | "observation-unavailable"
    | "native-boundary-unqualified";
  readonly observation?: CodexNativeObservation;
}

/** Server-memory capability, not a signed or portable route attestation. Only
 * the runtime holding the child transport gets the recorder. Readers cannot
 * import worker JSON as evidence; even a serialized copy of a capture refuses.
 * Candidate pins bind a request, never authenticate its source or read its files.
 */
export function makeCodexSessionObservation(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly pid: number;
  readonly processGeneration: string;
  readonly model?: string;
  readonly serviceTier?: string;
}) {
  const threadId = input.threadId;
  const providerInstanceId = input.providerInstanceId ?? null;
  const process = Object.freeze({ pid: input.pid, generation: input.processGeneration });
  let revision = 0;
  let contextGeneration = 0;
  let initialized = false;
  let providerThreadId: string | null = null;
  let acknowledgedTurnId: string | null = null;
  let requested = Object.freeze({
    model: input.model ?? null,
    serviceTier: input.serviceTier ?? null,
  });
  let reportedSessionModel: CodexNativeObservation["reportedSessionModel"] = null;
  let retainedContext = false;
  let invalidated: string | null = null;
  let closed = false;
  let pendingTurn: number | null = null;
  const seenTurns = new Set<string>();
  const captures = new WeakSet<object>();
  const consumed = new WeakSet<object>();
  const now = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const read = (): CodexNativeObservation =>
    Object.freeze({
      provenance: "server-owned-child-stdio",
      threadId,
      providerInstanceId,
      process,
      revision,
      contextGeneration,
      initialized,
      providerThreadId,
      acknowledgedTurnId,
      requested,
      reportedSessionModel,
      retainedContext,
      invalidated,
      closed,
      unknown: unqualified,
    });
  const invalidate = (reason: string) => {
    revision++;
    contextGeneration++;
    invalidated = reason;
    retainedContext = true;
  };
  const sameCandidate = (a: Candidate, b: Candidate) =>
    a.directory === b.directory &&
    a.sourceRepository === b.sourceRepository &&
    a.sourceCommit === b.sourceCommit &&
    a.admissionSha256 === b.admissionSha256;

  return {
    reader: {
      read: Effect.sync(read),
      capture: (candidate: unknown): Effect.Effect<CodexObservationCapture | null> =>
        Effect.gen(function* () {
          const decoded = decodeCandidate(candidate);
          if (Option.isNone(decoded)) return null;
          const capture = Object.freeze({
            candidate: Object.freeze({ ...decoded.value }),
            observation: read(),
            capturedAt: yield* now,
          });
          captures.add(capture);
          return capture;
        }),
      resolve: (capture: unknown, candidate: unknown): Effect.Effect<CodexSkillAdmissionResult> =>
        Effect.gen(function* () {
          const refuse = (
            reason: CodexSkillAdmissionResult["reason"],
            observation?: CodexNativeObservation,
          ): CodexSkillAdmissionResult =>
            Object.freeze({
              admissionAuthorized: false,
              reason,
              ...(observation ? { observation } : {}),
            });
          if (!Predicate.isObject(capture) || !captures.has(capture))
            return refuse("untrusted-capture");
          if (consumed.has(capture)) return refuse("replayed-capture");
          consumed.add(capture);
          // Membership is checked before this cast; no deserialized structure is trusted.
          const trusted = capture as CodexObservationCapture;
          const decoded = decodeCandidate(candidate);
          if (Option.isNone(decoded)) return refuse("invalid-candidate");
          if (!sameCandidate(trusted.candidate, decoded.value)) return refuse("candidate-mismatch");
          const currentTime = yield* now;
          if (currentTime < trusted.capturedAt) return refuse("future-capture");
          if (currentTime - trusted.capturedAt > 5_000) return refuse("expired-capture");
          if (trusted.observation.revision !== revision) return refuse("stale-generation");
          const current = read();
          if (closed || invalidated || !initialized || !providerThreadId || !acknowledgedTurnId) {
            return refuse("observation-unavailable", current);
          }
          // Current process/thread/turn evidence is useful, but neither this
          // observer nor the legacy process contains Skill bodies or old context.
          return refuse("native-boundary-unqualified", current);
        }),
    },
    initialized: () => {
      if (!closed) {
        initialized = true;
        revision++;
      }
    },
    opened: (id: string, model: string, resumed: boolean) => {
      if (closed) return;
      retainedContext ||= resumed || providerThreadId !== null;
      providerThreadId = id;
      reportedSessionModel = Object.freeze({ value: model, provenance: "thread-open-response" });
      acknowledgedTurnId = null;
      pendingTurn = null;
      invalidated = null;
      revision++;
      contextGeneration++;
    },
    beginTurn: (model: string | undefined, serviceTier: string | undefined) => {
      if (closed) return -1;
      retainedContext ||= seenTurns.size > 0;
      if (pendingTurn !== null) invalidate("overlapping-turn-requests");
      requested = Object.freeze({ model: model ?? null, serviceTier: serviceTier ?? null });
      acknowledgedTurnId = null;
      revision++;
      pendingTurn = ++contextGeneration;
      return pendingTurn;
    },
    acknowledgedTurn: (generation: number, id: string) => {
      if (closed) return;
      if (pendingTurn !== generation || seenTurns.has(id)) {
        invalidate("reordered-or-replayed-turn-response");
        return;
      }
      pendingTurn = null;
      seenTurns.add(id);
      acknowledgedTurnId = id;
      revision++;
    },
    turnFailed: () => invalidate("turn-request-failed"),
    lifecycle: (id: string, turnId: string) => {
      if (closed || id !== providerThreadId) return;
      // Events cannot substitute for the correlated turn/start response. A
      // notification racing that response only invalidates outstanding reads.
      revision++;
      if (pendingTurn === null && turnId !== acknowledgedTurnId)
        invalidate("out-of-order-turn-event");
    },
    modelChanged: (
      id: string,
      model: string,
      source: "thread-settings-notification" | "model-rerouted-notification",
      turnId?: string,
    ) => {
      if (closed || id !== providerThreadId) return;
      invalidate(
        turnId !== undefined && turnId !== acknowledgedTurnId
          ? "out-of-order-model-event"
          : "model-or-route-changed",
      );
      reportedSessionModel = Object.freeze({ value: model, provenance: source });
    },
    invalidate,
    close: () => {
      if (!closed) {
        closed = true;
        invalidate("process-or-session-closed");
      }
    },
  };
}

export type CodexSessionObservationReader = ReturnType<
  typeof makeCodexSessionObservation
>["reader"];
