// @effect-diagnostics processEnvInEffect:off - checks that the host key leaves the live environment.
import { it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SecretProviderId,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

it.effect.each(["openai", "xai"] as const)("sends only to %s using its own saved key", (provider) =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    let resolved: string | undefined;
    let cached: string | undefined;
    const read = vi.fn(() => Effect.sync(() => [(cached ??= resolved)]));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello" }));
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read,
              label: () => Effect.succeed("Work"),
              invalidate: () =>
                Effect.sync(() => {
                  cached = undefined;
                }),
            }),
          ),
        ),
      ),
    );
    const transcribe = (pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer)) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechCustomWords: [{ term: "T3 Code", aliases: [] }],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({
      openai: true,
      xai: true,
      openrouter: false,
      assemblyai: false,
      groq: false,
    });
    yield* Effect.flip(transcribe(new Uint8Array(3)));
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello");
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      {
        openai: "https://api.openai.com/v1/audio/transcriptions",
        xai: "https://api.x.ai/v1/stt",
      }[provider],
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(
      provider === "openai" ? "gpt-transcribe" : "grok-voice-transcribe-2.0",
    );
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual(["T3 Code"]);
    expect(form.get(provider === "openai" ? "languages[]" : "language")).toBe("en");
    expect([...form.keys()].at(-1)).toBe("file");
    const wav = new DataView(yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getInt16(46, true)).toBe(16384);
    upstream.mockResolvedValueOnce(new Response("sensitive upstream diagnostic", { status: 401 }));
    expect(yield* Effect.flip(transcribe())).toMatchObject({ provider, reason: "rejected-key" });
    yield* service.setKey(provider, null);
    expect((yield* service.configured)[provider]).toBe(false);
    yield* Effect.flip(transcribe());
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* service.setKey(provider, reference);
    expect((yield* service.configured)[provider]).toBe(true);
    expect(read).not.toHaveBeenCalled();
    resolved = "resolved-fixture";
    expect(yield* transcribe()).toBe("hello");
    expect(read).toHaveBeenCalledWith([reference]);
    expect(new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer resolved-fixture",
    );
    resolved = undefined;
    expect(yield* Effect.flip(transcribe())).toMatchObject({
      provider,
      reason: "unreadable-key",
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  }),
);

it.effect("uploads to OpenRouter only for a listed exact model, as zero-retention JSON WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "acme/transcribe-1" }, { id: "acme/transcribe-2" }] })
        : Response.json({ text: "hello" }),
    );
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const uploads = () =>
      upstream.mock.calls.filter(([url]) => String(url).endsWith("/audio/transcriptions"));
    const transcribe = (model: string | undefined) =>
      service
        .transcribe(
          "openrouter",
          new Uint8Array(new Float32Array([0, 0.5]).buffer),
          { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "en" },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey("openrouter", Redacted.make("router-key"));
    expect(yield* Effect.flip(transcribe(undefined))).toMatchObject({ provider: "openrouter" });
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(yield* Effect.flip(transcribe("acme/transcribe-2"))).toMatchObject({
      reason: "unavailable",
    });
    expect(yield* Effect.flip(transcribe("acme/delisted"))).toMatchObject({
      provider: "openrouter",
    });
    expect(uploads()).toEqual([]);
    expect(yield* transcribe("acme/transcribe-2")).toBe("hello");
    const [[url, init]] = uploads() as [[URL, RequestInit]];
    expect(new URL(String(upstream.mock.calls[0]![0])).searchParams.get("zdr")).toBe("true");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer router-key");
    expect(headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(yield* Effect.promise(() => new Response(init.body).text())) as {
      model: string;
      models?: unknown;
      provider: { zdr: boolean };
      input_audio: { format: string; data: string };
    };
    expect(body).toMatchObject({
      model: "acme/transcribe-2",
      provider: { zdr: true },
      input_audio: { format: "wav" },
    });
    expect(body.models).toBeUndefined();
    const wav = Buffer.from(body.input_audio.data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readInt16LE(46)).toBe(16384);
  }),
);

it.effect("removing a key while a catalog read is pending prevents the upload", () =>
  Effect.gen(function* () {
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const catalogStarted = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<Response>();
    const uploads: string[] = [];
    const upstream: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname.endsWith("/models")) {
        catalogStarted.resolve();
        return catalog.promise;
      }
      uploads.push(String(input));
      return Response.json({ text: "unexpected" });
    };
    yield* service.setKey("openrouter", Redacted.make("old-key"));
    const job = yield* service
      .transcribe(
        "openrouter",
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        "acme/voice",
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => catalogStarted.promise);
    yield* service.setKey("openrouter", null);
    catalog.resolve(Response.json({ data: [{ id: "acme/voice" }] }));
    const exit = yield* Fiber.await(job);
    expect(uploads).toEqual([]);
    expect(exit._tag).toBe("Failure");
  }),
);

it.effect(
  "AssemblyAI sends WAV and config only to the Sync API and bounds clips before upload",
  () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello T3" }));
      const service = yield* CloudSpeech.CloudSpeech.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
      );
      yield* service.setKey("assemblyai", Redacted.make("assembly-fixture"));
      const samples = (count: number) => {
        const audio = new Float32Array(count);
        audio.set([0.5, -0.5]);
        return new Uint8Array(audio.buffer);
      };
      const transcribe = (count: number, options: Partial<SpeechTranscriptionOptions> = {}) =>
        service
          .transcribe("assemblyai", samples(count), {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage: "en",
            speechCustomWords: [
              { term: "Closura", aliases: ["closer a"] },
              { term: "T3 Code", aliases: [] },
            ],
            ...options,
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      expect(yield* transcribe(1600)).toBe("hello T3");
      const [url, init] = upstream.mock.calls[0]!;
      expect(String(url)).toBe("https://sync.assemblyai.com/v1/transcribe");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("assembly-fixture");
      expect(headers.get("X-AAI-Model")).toBe("universal-3-5-pro");
      const form = init?.body as FormData;
      expect([...form.keys()]).toEqual(["config", "audio"]);
      expect(JSON.parse(String(form.get("config")))).toEqual({
        language_code: "en",
        word_boost: ["Closura", "T3 Code"],
      });
      const audio = form.get("audio") as File;
      expect([audio.type, audio.name]).toEqual(["audio/wav", "dictation.wav"]);
      const wav = new DataView(yield* Effect.promise(() => audio.arrayBuffer()));
      // RIFF/WAVE, PCM, mono, 16 kHz, 32000 B/s, 2-byte frames, 16-bit, 3200 data bytes.
      expect([
        new TextDecoder().decode(wav.buffer.slice(0, 4)),
        new TextDecoder().decode(wav.buffer.slice(8, 12)),
        wav.getUint16(20, true),
        wav.getUint16(22, true),
        wav.getUint32(24, true),
        wav.getUint32(28, true),
        wav.getUint16(32, true),
        wav.getUint16(34, true),
        wav.getUint32(40, true),
        wav.getInt16(44, true),
        wav.getInt16(46, true),
      ]).toEqual(["RIFF", "WAVE", 1, 1, 16_000, 32_000, 2, 16, 3200, 16384, -16384]);
      upstream.mockResolvedValueOnce(Response.json({ text: "uh ship it" }));
      expect(yield* transcribe(1600, { speechLanguage: "auto" })).toBe("ship it");
      const autoForm = upstream.mock.calls[1]![1]!.body as FormData;
      expect(JSON.parse(String(autoForm.get("config")))).toEqual({
        word_boost: ["Closura", "T3 Code"],
      });
      upstream.mockResolvedValueOnce(Response.json({ text: "Um, ship closer a today" }));
      expect(yield* transcribe(1600)).toBe("ship Closura today");
      upstream.mockResolvedValueOnce(Response.json({ text: "Um, ship closer a today" }));
      expect(yield* transcribe(1600, { speechRemoveFillerWords: false })).toBe(
        "Um, ship Closura today",
      );
      expect(yield* Effect.flip(transcribe(1_920_001))).toMatchObject({ reason: "audio-duration" });
      expect(yield* Effect.flip(transcribe(100))).toMatchObject({ reason: "audio-duration" });
      expect(upstream).toHaveBeenCalledTimes(4);
      for (const [status, reason] of [
        [401, "rejected-key"],
        [402, "rejected-key"],
        [403, "rejected-key"],
        [429, "rate-limit"],
        [500, "unavailable"],
      ] as const) {
        upstream.mockResolvedValueOnce(new Response("private diagnostic", { status }));
        const error = yield* Effect.flip(transcribe(1600));
        expect(error).toMatchObject({ provider: "assemblyai", reason });
        expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("private diagnostic");
      }
      yield* service.setKey("assemblyai", null);
      expect((yield* service.configured).assemblyai).toBe(false);
      expect(yield* Effect.flip(transcribe(1600))).toMatchObject({ reason: "missing-key" });
    }),
);

it.effect(
  "host-injected AssemblyAI and Groq keys work without settings and never outrank a saved key",
  () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello" }));
      process.env.ASSEMBLYAI_API_KEY = "host-fixture";
      process.env.GROQ_API_KEY = "groq-host-fixture";
      const service = yield* CloudSpeech.CloudSpeech.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    ASSEMBLYAI_API_KEY: " host-fixture\n",
                    GROQ_API_KEY: "groq-host-fixture",
                  },
                }),
              ),
            ),
          ),
        ),
      );
      // Agent subprocesses must not inherit the key.
      expect(process.env.ASSEMBLYAI_API_KEY).toBeUndefined();
      expect(process.env.GROQ_API_KEY).toBeUndefined();
      const authorization = () =>
        new Headers(upstream.mock.calls.at(-1)![1]?.headers).get("authorization");
      const transcribe = () =>
        service
          .transcribe("assemblyai", new Uint8Array(new Float32Array(1600).buffer), {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      expect(yield* service.configured).toEqual({
        openai: false,
        xai: false,
        openrouter: false,
        assemblyai: true,
        groq: true,
        hostManaged: ["assemblyai", "groq"],
      });
      expect(yield* transcribe()).toBe("hello");
      expect(authorization()).toBe("host-fixture");
      yield* service.setKey("assemblyai", Redacted.make("saved-fixture"));
      expect((yield* service.configured).hostManaged).toEqual(["groq"]);
      yield* transcribe();
      expect(authorization()).toBe("saved-fixture");
      yield* service.setKey("assemblyai", null);
      expect((yield* service.configured).hostManaged).toEqual(["assemblyai", "groq"]);
      yield* transcribe();
      expect(authorization()).toBe("host-fixture");
      expect(
        yield* service
          .transcribe("groq", new Uint8Array(new Float32Array(1600).buffer), {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage: "en",
            speechCustomWords: [
              { term: "T3 Code", aliases: [] },
              { term: "Closura", aliases: [] },
            ],
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      ).toBe("hello");
      const [url, init] = upstream.mock.calls.at(-1)!;
      expect(String(url)).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(init?.redirect).toBe("error");
      expect(authorization()).toBe("Bearer groq-host-fixture");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      expect(form.get("language")).toBe("en");
      expect(form.get("prompt")).toBe("T3 Code, Closura");
      upstream.mockResolvedValueOnce(new Response(null, { status: 429 }));
      expect(
        yield* Effect.flip(
          service
            .transcribe("groq", new Uint8Array(new Float32Array(1600).buffer), {
              ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            })
            .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
        ),
      ).toMatchObject({ provider: "groq", reason: "rate-limit" });
      yield* service.setKey("groq", Redacted.make("groq-saved-fixture"));
      expect((yield* service.configured).hostManaged).toEqual(["assemblyai"]);
    }),
);
