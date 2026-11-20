import { CloudSpeechError, type SpeechStreamText } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { decodeSpeechPcm, MAX_SPEECH_BYTES, SpeechInvalidAudioError } from "./SpeechService.ts";

const SAMPLE_RATE = 16_000;
const FRAME = SAMPLE_RATE / 50;
const isCloudSpeechError = Schema.is(CloudSpeechError);

const GROQ_SEGMENTER = {
  silenceRms: 0.01,
  quietRms: 0.002,
  pauseFrames: 15,
  keepFrames: 5,
  minVoicedFrames: 10,
  minSamples: SAMPLE_RATE * 4,
  maxSamples: SAMPLE_RATE * 12,
};

function frameRms(data: Float32Array, start: number, end: number) {
  let sum = 0;
  for (let index = start; index < end; index++) sum += data[index]! * data[index]!;
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function createPauseSegmenter(config = GROQ_SEGMENTER) {
  let data = new Float32Array(config.maxSamples + SAMPLE_RATE);
  let length = 0;
  let scanned = 0;
  let voicedFrames = 0;
  let silentRun = 0;
  let quietest = { at: 0, rms: Infinity };
  let everVoiced = false;
  let peakRms = 0;
  const keep = config.keepFrames * FRAME;

  const discard = (count: number) => {
    data.copyWithin(0, count, length);
    length -= count;
    scanned -= count;
  };
  const take = (count: number) => {
    const piece = data.slice(0, count);
    discard(count);
    return piece;
  };
  const restart = () => {
    scanned = 0;
    voicedFrames = 0;
    silentRun = 0;
    quietest = { at: 0, rms: Infinity };
  };
  const scan = () => {
    const closed: Float32Array[] = [];
    while (scanned + FRAME <= length) {
      const rms = frameRms(data, scanned, scanned + FRAME);
      scanned += FRAME;
      peakRms = Math.max(peakRms, rms);
      if (rms >= config.silenceRms) {
        if (voicedFrames === 0 && scanned - FRAME > keep) discard(scanned - FRAME - keep);
        voicedFrames++;
        everVoiced = true;
        silentRun = 0;
      } else silentRun++;
      if (voicedFrames === 0) continue;
      if (silentRun >= config.pauseFrames && voicedFrames < config.minVoicedFrames) {
        discard(scanned - keep);
        restart();
        scanned = keep;
        continue;
      }
      if (scanned >= config.minSamples && rms < quietest.rms) quietest = { at: scanned, rms };
      const cut =
        silentRun >= config.pauseFrames && scanned >= config.minSamples
          ? scanned - (silentRun - config.keepFrames) * FRAME
          : scanned >= config.maxSamples
            ? quietest.at
            : 0;
      if (cut > 0) {
        closed.push(take(cut));
        restart();
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
      length += samples.length;
      return scan();
    },
    flush() {
      const partialVoiced =
        length > scanned && frameRms(data, scanned, length) >= config.silenceRms;
      const end = partialVoiced
        ? length
        : voicedFrames > 0
          ? scanned - Math.max(0, silentRun - config.keepFrames) * FRAME
          : !everVoiced && peakRms >= config.quietRms
            ? length
            : 0;
      const tail = data.slice(0, end);
      length = 0;
      restart();
      return tail.length ? tail : null;
    },
  };
}

const retryable = (error: unknown) =>
  isCloudSpeechError(error) && (error.reason === "rate-limit" || error.reason === "unavailable");

export const startGroqSpeechStream = Effect.fn("GroqSpeechStream.start")(function* <E>(
  transcribe: (pcm: Uint8Array) => Effect.Effect<string, E>,
) {
  const scope = yield* Scope.Scope;
  const segmenter = createPauseSegmenter();
  const pieces: Array<Fiber.Fiber<string, E>> = [];
  let receivedBytes = 0;
  let revision = 0;
  const submit = Effect.fnUntraced(function* (piece: Float32Array) {
    pieces.push(
      yield* transcribe(new Uint8Array(piece.buffer)).pipe(
        Effect.retry({
          times: 2,
          while: retryable,
          schedule: Schedule.exponential(Duration.millis(250)),
        }),
        Effect.forkIn(scope),
      ),
    );
  });
  const committed = (): SpeechStreamText | null => {
    const done: string[] = [];
    for (const piece of pieces) {
      const exit = piece.pollUnsafe();
      if (!exit || Exit.isFailure(exit)) break;
      if (exit.value) done.push(exit.value);
    }
    return done.length ? { committed: done.join(" "), tentative: "" } : null;
  };
  return {
    feed: Effect.fnUntraced(function* (bytes: Uint8Array) {
      const failed = pieces.find((piece) => {
        const exit = piece.pollUnsafe();
        return exit !== undefined && Exit.isFailure(exit);
      });
      if (failed) yield* Fiber.join(failed);
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
      for (const piece of segmenter.push(samples)) yield* submit(piece);
      return { revision: ++revision, text: committed() };
    }),
    finish: Effect.gen(function* () {
      const tail = segmenter.flush();
      if (tail) yield* submit(tail);
      const texts = yield* Effect.forEach(pieces, Fiber.join);
      return texts.filter(Boolean).join(" ").trim();
    }),
  };
});
