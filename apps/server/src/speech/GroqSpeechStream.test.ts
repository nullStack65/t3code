import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { createPauseSegmenter, startGroqSpeechStream } from "./GroqSpeechStream.ts";

const RATE = 16_000;
const CHUNK = RATE / 10;
const RELEASE_TO_TEXT_BUDGET_MS = 400;
const GROQ_LATENCY_MODEL = { baseMs: 230, perAudioSecondMs: 12 };

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function utterance(seed: number, seconds: number) {
  const next = random(seed);
  const parts: number[] = [];
  const tone = (duration: number) => {
    for (let index = 0; index < duration * RATE; index++)
      parts.push(0.1 * Math.sin((2 * Math.PI * 220 * index) / RATE));
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

const bytes = (samples: Float32Array) => new Uint8Array(samples.slice().buffer);

it("cuts at pauses after the minimum length and drops silence", () => {
  const segmenter = createPauseSegmenter();
  const audio = utterance(7, 40);
  const segments: Float32Array[] = [];
  for (let offset = 0; offset < audio.length; offset += CHUNK)
    segments.push(...segmenter.push(audio.subarray(offset, offset + CHUNK)));
  const tail = segmenter.flush();
  expect(segments.length).toBeGreaterThanOrEqual(2);
  for (const segment of segments) {
    expect(segment.length).toBeGreaterThanOrEqual(RATE * 7.5);
    expect(segment.length).toBeLessThanOrEqual(RATE * 20);
  }
  const loud = (samples: Float32Array) =>
    samples.filter((sample) => Math.abs(sample) > 0.05).length;
  expect(segments.reduce((sum, segment) => sum + loud(segment), tail ? loud(tail) : 0)).toBe(
    loud(audio),
  );
  const silent = createPauseSegmenter();
  expect(silent.push(new Float32Array(RATE * 30))).toEqual([]);
  expect(silent.flush()).toBeNull();
});

it("forces a cut at the quietest point when nobody pauses", () => {
  const segmenter = createPauseSegmenter();
  const audio = Float32Array.from({ length: RATE * 45 }, (_, index) =>
    index % (RATE * 3) < 200 ? 0.02 : 0.1 * Math.sin(index / 5),
  );
  const segments = segmenter.push(audio);
  expect(segments.length).toBe(2);
  for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(RATE * 20);
});

it.effect(`releases text within ${RELEASE_TO_TEXT_BUDGET_MS} ms over 30 real-time dictations`, () =>
  Effect.gen(function* () {
    const latencies: number[] = [];
    for (let index = 0; index < 30; index++) {
      const audio = utterance(index + 1, 3 + ((index * 7) % 68));
      let uploads = 0;
      const stream = yield* startGroqSpeechStream((pcm) => {
        const seconds = pcm.byteLength / 4 / RATE;
        const id = uploads++;
        return Effect.sleep(
          GROQ_LATENCY_MODEL.baseMs + GROQ_LATENCY_MODEL.perAudioSecondMs * seconds,
        ).pipe(Effect.as(`piece${id}`));
      });
      for (let offset = 0; offset < audio.length; offset += CHUNK) {
        yield* stream.feed(bytes(audio.subarray(offset, offset + CHUNK)));
        yield* TestClock.adjust("100 millis");
      }
      const released = yield* Clock.currentTimeMillis;
      const finished = yield* stream.finish.pipe(
        Effect.flatMap((text) => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ text, at })))),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const { text, at } = yield* Fiber.join(finished);
      expect(text).toBe(Array.from({ length: uploads }, (_, id) => `piece${id}`).join(" "));
      latencies.push(at - released);
    }
    const sorted = latencies.toSorted((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    expect(p95).toBeLessThanOrEqual(RELEASE_TO_TEXT_BUDGET_MS);
    expect(sorted.at(-1)!).toBeLessThanOrEqual(RELEASE_TO_TEXT_BUDGET_MS);
  }).pipe(Effect.scoped),
);
