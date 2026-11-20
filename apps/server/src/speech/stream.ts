import {
  AuthOrchestrationOperateScope,
  CloudSpeechError,
  GROQ_SPEECH_STREAM_PATH,
  SPEECH_STREAM_PATH,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  SpeechStreamCommand,
  SPEECH_MAX_OPTIONS_BYTES,
  type SpeechStreamEvent,
  type ServerSettingsError,
  type SpeechStreamText,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import { startGroqSpeechStream } from "./GroqSpeechStream.ts";
import * as SpeechService from "./SpeechService.ts";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechStreamCommand));
const isCloudSpeechError = Schema.is(CloudSpeechError);

type SpeechStreamError =
  | SpeechService.SpeechError
  | CloudSpeechError
  | SpeechService.SpeechInvalidAudioError
  | ServerSettingsError;

type SpeechStreamStarter = {
  readonly startStream: (options: SpeechTranscriptionOptions) => Effect.Effect<
    {
      readonly feed: (
        pcm: Uint8Array,
      ) => Effect.Effect<
        { readonly revision: number; readonly text: SpeechStreamText | null },
        SpeechStreamError
      >;
      readonly finish: Effect.Effect<string, SpeechStreamError>;
    },
    SpeechStreamError,
    Scope.Scope
  >;
};

/** One socket owns one stream. Audio is processed and acknowledged in arrival order. */
export const runSpeechSocket = Effect.fn("speech.runSocket")(function* (
  socket: Socket.Socket,
  speech: SpeechStreamStarter,
) {
  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  const send = (event: SpeechStreamEvent) => writer.write(JSON.stringify(event));
  let stream: Effect.Success<ReturnType<SpeechStreamStarter["startStream"]>> | undefined;
  let ended = false;
  const fail = Effect.fn("speech.failSocket")(function* (message: string) {
    if (ended) return;
    ended = true;
    yield* send({ type: "error", message });
    yield* writer.write(new Socket.CloseEvent(1008, "Speech stream ended"));
  });
  const receive = (data: string | Uint8Array) => {
    if (ended) return Effect.void;
    return Effect.gen(function* () {
      if (typeof data === "string") {
        if (new TextEncoder().encode(data).byteLength > SPEECH_MAX_OPTIONS_BYTES)
          return yield* fail("Invalid speech stream command.");
        const command = yield* decodeCommand(data);
        if (command.type === "start") {
          if (stream) return yield* fail("Speech stream already started.");
          stream = yield* speech.startStream(command.options).pipe(Scope.provide(scope));
          yield* send({ type: "ready" });
          return;
        }
        if (!stream) return yield* fail("Start speech transcription before finishing.");
        const text = yield* stream.finish;
        ended = true;
        yield* send({ type: "finished", text });
        yield* writer.write(new Socket.CloseEvent(1000));
      } else {
        if (data.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES)
          return yield* fail("Speech audio chunk is too large.");
        if (!stream) return yield* fail("Start speech transcription before sending audio.");
        const update = yield* stream.feed(data);
        yield* send({ type: "update", ...update });
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("live transcription operation failed", { cause }).pipe(
          Effect.andThen(
            fail(
              isCloudSpeechError(cause)
                ? cause.message
                : "Live transcription failed. Please try recording again.",
            ),
          ),
        ),
      ),
    );
  };
  const reader = yield* socket.reader;
  yield* Effect.gen(function* () {
    const pending = yield* Queue.bounded<string | Uint8Array>(2);
    yield* Effect.forever(Queue.take(pending).pipe(Effect.flatMap(receive))).pipe(
      Effect.forkScoped,
    );
    while (true) {
      const frames = yield* reader.pull;
      yield* Effect.forEach(frames, (frame) => Queue.offer(pending, frame), {
        discard: true,
      });
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 minutes",
      // The socket read loop is already interrupted here; its writer can no longer send.
      orElse: () => Effect.void,
    }),
    Effect.ignore,
  );
});

export const speechStreamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const speech = yield* SpeechService.SpeechService;
    const cloud = yield* CloudSpeech.CloudSpeech;
    const groq: SpeechStreamStarter = {
      startStream: (options) =>
        startGroqSpeechStream((pcm) => cloud.transcribe("groq", pcm, options)),
    };
    const route = (path: HttpRouter.PathInput, starter: SpeechStreamStarter) =>
      HttpRouter.add(
        "GET",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* auth
            .authenticateWebSocketUpgrade(request, "media")
            .pipe(Effect.result);
          if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
          if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
            return HttpServerResponse.empty({ status: 403 });
          const socket = yield* request.upgrade;
          yield* runSpeechSocket(socket, starter).pipe(Effect.scoped);
          return HttpServerResponse.empty();
        }),
      );
    return Layer.mergeAll(route(SPEECH_STREAM_PATH, speech), route(GROQ_SPEECH_STREAM_PATH, groq));
  }),
);
