import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentId,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import { expect, vi } from "vite-plus/test";

import { warmBrowserAudioCapture } from "../src/speech/browserPcmCapture";
import { createBrowserVoiceInputPlatform } from "../src/speech/browserVoiceInput";
import { stubGlobal } from "./render";

export const PRESS_TO_RECORDING_BUDGET_MS = 400;
export const RELEASE_TO_TEXT_BUDGET_MS = 400;

const prepared = (() => {
  const target = new BearerConnectionTarget({
    environmentId: EnvironmentId.make("latency-transcription"),
    label: "Latency transcription",
    connectionId: "latency",
  });
  return {
    environmentId: target.environmentId,
    label: target.label,
    target,
    httpBaseUrl: "https://transcription.example.test",
    socketUrl: "wss://transcription.example.test/ws",
    httpAuthorization: { _tag: "Bearer" as const, token: "audio-grant" },
  };
})();

function speechStatus(streaming: boolean) {
  return {
    supported: true,
    state: "ready",
    modelId: "latency-model",
    model: "Latency model",
    size: 1,
    supportsStreaming: streaming,
    supportsBufferedStreaming: streaming,
    supportsTranslation: false,
    languages: ["en"],
    supportsLanguageDetection: false,
    acceleration: "cpu",
    modelUnloadTimeout: "never",
    gpuDevices: [],
    benchmarkTier: "cpu",
  } satisfies EnvironmentSpeechStatus;
}

export async function createVoiceLatencyHarness(options: {
  readonly streaming: boolean;
  readonly transcript?: string;
}) {
  const resources = new DisposableStack();
  const transcript = options.transcript ?? "dictated";
  let openServer!: () => void;
  const serverOpened = new Promise<void>((resolve) => {
    openServer = resolve;
  });
  const sockets: EventTarget[] = [];
  resources.use(
    stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          sockets.push(this);
          void serverOpened.then(() => this.dispatchEvent(new Event("open")));
        }
        send(data: string | Uint8Array) {
          const reply = (message: unknown) =>
            queueMicrotask(() =>
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })),
            );
          if (typeof data !== "string") return reply({ type: "update", revision: 0, text: null });
          const { type } = JSON.parse(data) as { type: string };
          if (type === "start") reply({ type: "ready" });
          if (type === "finish") reply({ type: "finished", text: transcript });
        }
        close() {}
      },
    ),
  );
  const fetch = globalThis.fetch;
  resources.use(
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === `${prepared.httpBaseUrl}/api/voice/status`) {
        await serverOpened;
        return Response.json(speechStatus(options.streaming));
      }
      if (request.url.includes("/api/auth/websocket-ticket/"))
        return Response.json({ ticket: "stream-ticket", expiresAt: "2030-01-01T00:00:00.000Z" });
      if (request.url === `${prepared.httpBaseUrl}/api/voice/transcribe`)
        return Response.json({ text: transcript });
      return fetch(input, init);
    }),
  );
  let meterUpdates = 0;
  const platform = createBrowserVoiceInputPlatform({
    prepared,
    hasAudioConsent: () => true,
    getStreamingEnabled: () => options.streaming,
    getTranscriptionOptions: () => DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    getMicrophoneId: () => "",
    onLevel: () => {
      meterUpdates += 1;
    },
    onDurationLimit() {},
    onText() {},
    onError() {},
  });
  const commitDraft = vi.fn<(text: string) => void>();
  const controller = new VoiceInputController({
    recorder: platform.recorder,
    retryFailedRecording: true,
    captureDuringPreparation: true,
    getTranscriber: () => platform.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => platform.cancelRecording(),
    deleteRecording: platform.deleteRecording,
    readDraft: () => ({ ownerKey: "draft", text: "", selection: { start: 0, end: 0 } }),
    commitDraft,
    onStateChange() {},
  });
  resources.defer(() => controller.dispose());
  await warmBrowserAudioCapture();

  return {
    controller,
    commitDraft,
    transcript,
    openServer,
    press: async () => {
      void controller.start();
      await vi.waitFor(() => expect(controller.currentState.phase).toBe("recording"), {
        timeout: PRESS_TO_RECORDING_BUDGET_MS,
        interval: 1,
      });
    },
    captureAudio: async () => {
      const seen = meterUpdates;
      await vi.waitFor(() => expect(meterUpdates).toBeGreaterThan(seen + 1));
    },
    connectServer: async () => {
      openServer();
      if (options.streaming) await vi.waitFor(() => expect(sockets).toHaveLength(1));
    },
    release: async () => {
      void controller.stop();
      await vi.waitFor(() => expect(commitDraft.mock.lastCall?.[0]).toBe(transcript), {
        timeout: RELEASE_TO_TEXT_BUDGET_MS,
        interval: 1,
      });
    },
    [Symbol.dispose]: () => resources.dispose(),
  };
}
