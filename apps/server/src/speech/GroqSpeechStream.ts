import type { SpeechStreamText } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { decodeSpeechPcm, MAX_SPEECH_BYTES, SpeechInvalidAudioError } from "./SpeechService.ts";

const SAMPLE_RATE = 16_000;
const FRAME = SAMPLE_RATE / 50;

const GROQ_SEGMENTER = {
  silenceRms: 0.01,
  pauseFrames: 15,
  keepFrames: 5,
  minSamples: SAMPLE_RATE * 8,
  maxSamples: SAMPLE_RATE * 20,
};

type SegmenterConfig = typeof GROQ_SEGMENTER;

function frameRms(data: Float32Array, start: number, end: number) {
  let sum = 0;
  for (let index = start; index < end; index++) sum += data[index]! * data[index]!;
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function createPauseSegmenter(config: SegmenterConfig = GROQ_SEGMENTER) {
  let data = new Float32Array(config.maxSamples + SAMPLE_RATE);
  let length = 0;
  let scanned = 0;
  let voiced = false;
  let silentRun = 0;
  let quietest = { at: 0, rms: Infinity };
  const keep = config.keepFrames * FRAME;

  const take = (count: number) => {
    const out = data.slice(0, count);
    data.copyWithin(0, count, length);
    length -= count;
    return out;
  };
  const rescan = () => {
    const pending = length;
    length = 0;
    scanned = 0;
    voiced = false;
    silentRun = 0;
    quietest = { at: 0, rms: Infinity };
    return scan(pending);
  };
  const scan = (available: number): Float32Array[] => {
    const closed: Float32Array[] = [];
    length = available;
    while (scanned + FRAME <= length) {
      const rms = frameRms(data, scanned, scanned + FRAME);
      scanned += FRAME;
      if (rms >= config.silenceRms) {
        voiced = true;
        silentRun = 0;
      } else silentRun++;
      if (!voiced) {
        if (scanned > keep) {
          take(scanned - keep);
          scanned = keep;
        }
        continue;
      }
      if (scanned >= config.minSamples && rms < quietest.rms) quietest = { at: scanned, rms };
      const cut =
        silentRun >= config.pauseFrames && scanned >= config.minSamples
          ? scanned - Math.floor(silentRun / 2) * FRAME
          : scanned >= config.maxSamples
            ? quietest.at
            : 0;
      if (cut > 0) {
        closed.push(take(cut));
        closed.push(...rescan());
        return closed;
      }
    }
    return closed;
  };

  return {
    push(samples: Float32Array) {
      if (length + samples.length > data.length) {
        const grown = new Float32Array(Math.max(data.length * 2, length + samples.length));
        grown.set(data.subarray(0, length));
        data = grown;
      }
      data.set(samples, length);
      return scan(length + samples.length);
    },
    flush() {
      const partialVoiced =
        length > scanned && frameRms(data, scanned, length) >= config.silenceRms;
      const end = partialVoiced
        ? length
        : voiced
          ? scanned - Math.max(0, silentRun - config.keepFrames) * FRAME
          : 0;
      const tail = data.slice(0, end);
      length = 0;
      rescan();
      return tail.length ? tail : null;
    },
  };
}

export const startGroqSpeechStream = Effect.fn("GroqSpeechStream.start")(function* <E>(
  transcribe: (pcm: Uint8Array) => Effect.Effect<string, E>,
) {
  const segmenter = createPauseSegmenter();
  const results: Array<string | undefined> = [];
  const pending: Array<Fiber.Fiber<string, E>> = [];
  let receivedBytes = 0;
  let revision = 0;
  const submit = Effect.fnUntraced(function* (segment: Float32Array) {
    const index = results.length;
    results.push(undefined);
    const fiber = yield* transcribe(new Uint8Array(segment.buffer)).pipe(
      Effect.tap((text) =>
        Effect.sync(() => {
          results[index] = text;
        }),
      ),
      Effect.forkScoped,
    );
    pending.push(fiber);
  });
  const committed = (): SpeechStreamText | null => {
    const done: string[] = [];
    for (const text of results) {
      if (text === undefined) break;
      if (text) done.push(text);
    }
    return done.length ? { committed: done.join(" "), tentative: "" } : null;
  };
  return {
    feed: Effect.fnUntraced(function* (bytes: Uint8Array) {
      receivedBytes += bytes.byteLength;
      if (receivedBytes > MAX_SPEECH_BYTES)
        return yield* new SpeechInvalidAudioError({
          byteLength: receivedBytes,
          message: "audio must contain at most five minutes of 16 kHz mono Float32 PCM",
        });
      const samples = yield* Effect.try({
        try: () => decodeSpeechPcm(bytes),
        catch: () =>
          new SpeechInvalidAudioError({
            byteLength: bytes.byteLength,
            message: "Invalid PCM audio.",
          }),
      });
      for (const segment of segmenter.push(samples)) yield* submit(segment);
      return { revision: ++revision, text: committed() };
    }),
    finish: Effect.gen(function* () {
      const tail = segmenter.flush();
      if (tail) yield* submit(tail);
      const texts = yield* Effect.forEach(pending, Fiber.join);
      return texts.filter(Boolean).join(" ").trim();
    }),
  };
});
