import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeCodexSessionObservation } from "./CodexSessionObservation.ts";

const candidate = {
  directory: "/synthetic/candidate-never-read",
  sourceRepository: "nullStack65/closura-agent-config",
  sourceCommit: "a".repeat(40),
  admissionSha256: "b".repeat(64),
};
function ready() {
  const recorder = makeCodexSessionObservation({
    threadId: ThreadId.make("synthetic-thread"),
    providerInstanceId: ProviderInstanceId.make("synthetic-route"),
    pid: 123,
    processGeneration: "synthetic-process-generation",
    model: "fixture-gpt-6",
  });
  recorder.initialized();
  recorder.opened("provider-thread", "reported-session-model", false);
  recorder.acknowledgedTurn(recorder.beginTurn("fixture-gpt-6", "default"), "turn-1");
  return recorder;
}

it.effect(
  "retains immutable known facts without promoting requested/session metadata to served facts",
  () =>
    Effect.gen(function* () {
      const recorder = ready();
      const capture = yield* recorder.reader.capture(candidate);
      expect(capture).not.toBeNull();
      expect(capture?.observation).toMatchObject({
        provenance: "server-owned-child-stdio",
        process: { pid: 123 },
        providerThreadId: "provider-thread",
        acknowledgedTurnId: "turn-1",
        requested: { model: "fixture-gpt-6" },
        reportedSessionModel: {
          value: "reported-session-model",
          provenance: "thread-open-response",
        },
      });
      for (const fact of Object.values(capture!.observation.unknown))
        expect(fact.status).toBe("unknown");
      expect(Object.isFrozen(capture)).toBe(true);
      expect(Object.isFrozen(capture!.candidate)).toBe(true);
      expect(Object.isFrozen(capture!.observation.requested)).toBe(true);
      expect(Object.isFrozen(capture!.observation.process)).toBe(true);
      expect(yield* recorder.reader.resolve(capture, candidate)).toMatchObject({
        admissionAuthorized: false,
        reason: "native-boundary-unqualified",
      });
      expect(yield* recorder.reader.resolve(capture, candidate)).toMatchObject({
        reason: "replayed-capture",
      });
    }),
);

it.effect("rejects forged, copied, cross-process and cross-thread captures", () =>
  Effect.gen(function* () {
    const owner = ready();
    const capture = yield* owner.reader.capture(candidate);
    for (const forged of [
      null,
      true,
      {},
      { ...capture },
      JSON.parse(JSON.stringify(capture)),
      { admissionAuthorized: true, nativeObservation: capture },
    ]) {
      expect(yield* owner.reader.resolve(forged, candidate)).toMatchObject({
        admissionAuthorized: false,
        reason: "untrusted-capture",
      });
    }
    // Even identical labels/PID/generation cannot import another recorder's authority.
    expect(yield* ready().reader.resolve(capture, candidate)).toMatchObject({
      reason: "untrusted-capture",
    });
  }),
);

for (const change of [
  { directory: "/different-candidate" },
  { sourceCommit: "c".repeat(40) },
  { admissionSha256: "d".repeat(64) },
])
  it.effect(`rejects candidate substitution ${Object.keys(change)[0]}`, () =>
    Effect.gen(function* () {
      const recorder = ready();
      const capture = yield* recorder.reader.capture(candidate);
      expect(yield* recorder.reader.resolve(capture, { ...candidate, ...change })).toMatchObject({
        reason: "candidate-mismatch",
      });
    }),
  );

it.effect("rejects missing/unknown selectors and worker-authored authority fields", () =>
  Effect.gen(function* () {
    const recorder = ready();
    for (const value of [
      {},
      { ...candidate, sourceCommit: "latest" },
      { ...candidate, sourceRepository: "attacker/repo" },
      { ...candidate, admissionAuthorized: true },
      { ...candidate, servedModel: "fixture-gpt-6" },
    ]) {
      expect(yield* recorder.reader.capture(value)).toBeNull();
      expect(
        yield* recorder.reader.resolve(yield* recorder.reader.capture(candidate), value),
      ).toMatchObject({ admissionAuthorized: false, reason: "invalid-candidate" });
    }
  }),
);

it.effect(
  "expires evidence and refuses server clock regression without caller-controlled freshness",
  () =>
    Effect.gen(function* () {
      const recorder = ready();
      const expired = yield* recorder.reader.capture(candidate);
      yield* TestClock.adjust("5001 millis");
      expect(yield* recorder.reader.resolve(expired, candidate)).toMatchObject({
        reason: "expired-capture",
      });
      const future = yield* recorder.reader.capture(candidate);
      yield* TestClock.setTime(0);
      expect(yield* recorder.reader.resolve(future, candidate)).toMatchObject({
        reason: "future-capture",
      });
    }),
);

it.effect(
  "new requests and next-generation models revoke old captures while retaining old context risk",
  () =>
    Effect.gen(function* () {
      const recorder = ready();
      const old = yield* recorder.reader.capture(candidate);
      const next = recorder.beginTurn("fixture-gpt-7", "default");
      recorder.acknowledgedTurn(next, "turn-2");
      expect(yield* recorder.reader.resolve(old, candidate)).toMatchObject({
        reason: "stale-generation",
      });
      const current = yield* recorder.reader.read;
      expect(current.requested.model).toBe("fixture-gpt-7");
      expect(current.reportedSessionModel?.value).toBe("reported-session-model");
      expect(current.unknown.servedModel.status).toBe("unknown");
      expect(current.retainedContext).toBe(true);
      expect(current.contextGeneration).toBeGreaterThan(old!.observation.contextGeneration);
      expect(
        yield* recorder.reader.resolve(yield* recorder.reader.capture(candidate), candidate),
      ).toMatchObject({ admissionAuthorized: false });
    }),
);

for (const mutate of [
  (r: ReturnType<typeof ready>) =>
    r.modelChanged("provider-thread", "other", "thread-settings-notification"),
  (r: ReturnType<typeof ready>) =>
    r.modelChanged("provider-thread", "fallback", "model-rerouted-notification", "wrong-turn"),
  (r: ReturnType<typeof ready>) => r.lifecycle("provider-thread", "old-turn"),
  (r: ReturnType<typeof ready>) => r.acknowledgedTurn(0, "turn-1"),
  (r: ReturnType<typeof ready>) => r.turnFailed(),
  (r: ReturnType<typeof ready>) => r.invalidate("compaction-does-not-attest-context-removal"),
  (r: ReturnType<typeof ready>) => r.close(),
])
  it.effect(`invalidates old evidence on lifecycle mutation ${mutate.toString()}`, () =>
    Effect.gen(function* () {
      const recorder = ready();
      const before = yield* recorder.reader.capture(candidate);
      mutate(recorder);
      expect(yield* recorder.reader.resolve(before, candidate)).toMatchObject({
        reason: "stale-generation",
      });
      expect(
        yield* recorder.reader.resolve(yield* recorder.reader.capture(candidate), candidate),
      ).toMatchObject({ reason: "observation-unavailable" });
    }),
  );

it.effect("foreign child lifecycle cannot replace the root observation", () =>
  Effect.gen(function* () {
    const recorder = ready();
    const before = yield* recorder.reader.capture(candidate);
    recorder.lifecycle("foreign-child", "foreign-turn");
    recorder.modelChanged("foreign-child", "fake-model", "thread-settings-notification");
    expect(yield* recorder.reader.resolve(before, candidate)).toMatchObject({
      reason: "native-boundary-unqualified",
      observation: { acknowledgedTurnId: "turn-1" },
    });
  }),
);

it.effect(
  "overlapping/reordered requests and resumed sessions never attest fresh retained context",
  () =>
    Effect.gen(function* () {
      const recorder = ready();
      const first = recorder.beginTurn("fixture-gpt-6", undefined);
      const second = recorder.beginTurn("fixture-gpt-7", undefined);
      recorder.acknowledgedTurn(first, "late-turn");
      recorder.acknowledgedTurn(second, "new-turn");
      expect(
        yield* recorder.reader.resolve(yield* recorder.reader.capture(candidate), candidate),
      ).toMatchObject({ reason: "observation-unavailable" });
      recorder.opened("replacement-session", "reported-new", true);
      expect((yield* recorder.reader.read).retainedContext).toBe(true);
      expect(
        yield* recorder.reader.resolve(yield* recorder.reader.capture(candidate), candidate),
      ).toMatchObject({ admissionAuthorized: false, reason: "observation-unavailable" });
    }),
);
