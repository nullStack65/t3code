import { it } from "@effect/vitest";
import { CloudSpeechError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { createPauseSegmenter, startGroqSpeechStream } from "./GroqSpeechStream.ts";

const RATE = 16_000;
const CHUNK = RATE / 10;
const RELEASE_TO_TEXT_BUDGET_MS = 400;
const MODELLED_GROQ_LATENCY = { baseMs: 230, perAudioSecondMs: 12 };

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function utterance(seed: number, seconds: number, amplitude = 0.1) {
  const next = random(seed);
  const parts: number[] = [];
  const tone = (duration: number) => {
    for (let index = 0; index < duration * RATE; index++)
      parts.push(amplitude * Math.sin((2 * Math.PI * 220 * index) / RATE));
  };
  const quiet = (duration: number) => {
    for (let index = 0; index < duration * RATE; index++) parts.push(0);
  };
  quiet(0.3);
  while (parts.length < seconds * RATE) {
    const phraseEnd = parts.length + (2 + next() * 4) * RATE;
    while (parts.length < phraseEnd) {
      tone(0.15 + next() * 0.35);
      quiet(0.05 + next() * 0.2);
    }
    quiet(0.35 + next() * 0.45);
  }
  quiet(0.2);
  return Float32Array.from(parts);
}

function segment(audio: Float32Array) {
  const segmenter = createPauseSegmenter();
  const pieces: Float32Array[] = [];
  for (let offset = 0; offset < audio.length; offset += CHUNK)
    pieces.push(...segmenter.push(audio.subarray(offset, offset + CHUNK)));
  return { pieces, tail: segmenter.flush() };
}

const bytes = (samples: Float32Array) => new Uint8Array(samples.slice().buffer);
const loud = (samples: Float32Array) => samples.filter((sample) => Math.abs(sample) > 0.05).length;

it("cuts paused speech into 4 to 12 second pieces without losing speech", () => {
  const audio = utterance(7, 40);
  const { pieces, tail } = segment(audio);
  expect(pieces.length).toBeGreaterThanOrEqual(4);
  for (const piece of pieces) {
    expect(piece.length).toBeGreaterThanOrEqual(RATE * 3.5);
    expect(piece.length).toBeLessThanOrEqual(RATE * 12);
  }
  expect(pieces.reduce((sum, piece) => sum + loud(piece), tail ? loud(tail) : 0)).toBe(loud(audio));
});

it("drops silence and stray clicks but keeps a quiet microphone's speech", () => {
  expect(segment(new Float32Array(RATE * 30))).toEqual({ pieces: [], tail: null });
  const click = new Float32Array(RATE * 30);
  click.fill(0.5, RATE, RATE + 320);
  expect(segment(click)).toEqual({ pieces: [], tail: null });
  const quiet = utterance(3, 6, 0.005);
  const { pieces, tail } = segment(quiet);
  expect(pieces).toEqual([]);
  expect(tail?.length).toBe(quiet.length);
});

it("forces a cut at the quietest point when nobody pauses", () => {
  const audio = Float32Array.from({ length: RATE * 45 }, (_, index) =>
    index % (RATE * 3) < 200 ? 0.02 : 0.1 * Math.sin(index / 5),
  );
  const { pieces, tail } = segment(audio);
  expect(pieces.length).toBeGreaterThanOrEqual(3);
  for (const piece of [...pieces, tail!]) expect(piece.length).toBeLessThanOrEqual(RATE * 12);
});

it.effect(
  `release waits only for a short tail, within ${RELEASE_TO_TEXT_BUDGET_MS} ms against a modelled Groq latency`,
  () =>
    Effect.gen(function* () {
      const latencies: number[] = [];
      for (let index = 0; index < 30; index++) {
        const audio = utterance(index + 1, 3 + ((index * 7) % 68));
        let uploads = 0;
        let tailSamples = 0;
        const stream = yield* startGroqSpeechStream((pcm) => {
          const samples = pcm.byteLength / 4;
          tailSamples = samples;
          const id = uploads++;
          return Effect.sleep(
            MODELLED_GROQ_LATENCY.baseMs +
              (MODELLED_GROQ_LATENCY.perAudioSecondMs * samples) / RATE,
          ).pipe(Effect.as(`piece${id}`));
        });
        for (let offset = 0; offset < audio.length; offset += CHUNK) {
          yield* stream.feed(bytes(audio.subarray(offset, offset + CHUNK)));
          yield* TestClock.adjust("100 millis");
        }
        const released = yield* Clock.currentTimeMillis;
        const uploadsBeforeRelease = uploads;
        const finished = yield* stream.finish.pipe(
          Effect.flatMap((text) =>
            Clock.currentTimeMillis.pipe(Effect.map((at) => ({ text, at }))),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        const { text, at } = yield* Fiber.join(finished);
        expect(text).toBe(Array.from({ length: uploads }, (_, id) => `piece${id}`).join(" "));
        if (uploads > uploadsBeforeRelease) expect(tailSamples).toBeLessThanOrEqual(RATE * 10);
        latencies.push(at - released);
      }
      expect(Math.max(...latencies)).toBeLessThanOrEqual(RELEASE_TO_TEXT_BUDGET_MS);
    }).pipe(Effect.scoped),
);

it.effect("retries a rate-limited piece, and fails the stream early on a rejected one", () =>
  Effect.gen(function* () {
    const audio = utterance(11, 9);
    const run = (fail: (call: number) => CloudSpeechError | null) =>
      Effect.gen(function* () {
        let calls = 0;
        const stream = yield* startGroqSpeechStream(() =>
          Effect.suspend(() => {
            const error = fail(calls++);
            return error ? Effect.fail(error) : Effect.succeed("ok");
          }),
        );
        let fed = 0;
        let failure: unknown;
        for (let offset = 0; offset < audio.length; offset += CHUNK) {
          const result = yield* Effect.result(
            stream.feed(bytes(audio.subarray(offset, offset + CHUNK))),
          );
          fed++;
          if (result._tag === "Failure") {
            failure = result.failure;
            break;
          }
          yield* TestClock.adjust("100 millis");
        }
        return { stream, calls: () => calls, fed, failure };
      });
    const limited = yield* run((call) =>
      call === 0 ? new CloudSpeechError({ provider: "groq", reason: "rate-limit" }) : null,
    );
    expect(limited.failure).toBeUndefined();
    const finished = yield* Effect.forkChild(limited.stream.finish);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(finished)).toMatch(/^ok( ok)*$/);
    expect(limited.calls()).toBeGreaterThan(1);
    const rejected = yield* run(
      () => new CloudSpeechError({ provider: "groq", reason: "rejected-key" }),
    );
    expect(rejected.failure).toMatchObject({ reason: "rejected-key" });
    expect(rejected.fed * CHUNK).toBeLessThan(audio.length);
    expect(rejected.calls()).toBe(1);
  }).pipe(Effect.scoped),
);
