import { it, vi } from "vite-plus/test";

import { createVoiceLatencyHarness } from "../../test/voiceLatencyHarness";

vi.mock("../connection/runtime", async () => {
  const [{ Atom }, { layerRemoteHttpClient }] = await Promise.all([
    import("effect/reactivity"),
    import("@t3tools/client-runtime/rpc"),
  ]);
  return {
    connectionAtomRuntime: Atom.runtime(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    ),
  };
});

it.each([{ streaming: false }, { streaming: true }])(
  "records within 400 ms of the press while the server is still answering, and inserts text within 400 ms of release: %j",
  async ({ streaming }) => {
    using voice = await createVoiceLatencyHarness({ streaming });
    await voice.press();
    await voice.captureAudio();
    await voice.connectServer();
    await voice.release();
  },
);
