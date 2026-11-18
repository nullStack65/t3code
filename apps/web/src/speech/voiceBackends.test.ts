import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { defaultVoiceEnvironment, voiceBackendEnvironments } from "./voiceBackends";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const both = { voiceTranscription: true, cloudVoiceTranscription: true };
const environments = [
  { environmentId: server, connected: true, capabilities: both },
  { environmentId: laptop, connected: true, capabilities: { cloudVoiceTranscription: true } },
];

it("a backend only runs where an environment supports it", () => {
  expect(voiceBackendEnvironments("local", environments).map((e) => e.environmentId)).toEqual([
    server,
  ]);
  expect(voiceBackendEnvironments("assemblyai", environments)).toHaveLength(2);
});

it("picking a backend keeps the current environment, else prefers this device's own", () => {
  expect(
    defaultVoiceEnvironment("assemblyai", environments, { current: server, primary: laptop }),
  ).toBe(server);
  expect(
    defaultVoiceEnvironment("assemblyai", environments, { current: null, primary: laptop }),
  ).toBe(laptop);
  // The current environment can't run a local model, so the backend moves to one that can.
  expect(defaultVoiceEnvironment("local", environments, { current: laptop, primary: laptop })).toBe(
    server,
  );
});

it("an offline primary environment yields to a connected one", () => {
  const offline = environments.map((environment) =>
    environment.environmentId === laptop ? { ...environment, connected: false } : environment,
  );
  expect(defaultVoiceEnvironment("openai", offline, { current: null, primary: laptop })).toBe(
    server,
  );
  expect(defaultVoiceEnvironment("openai", [], { current: null, primary: laptop })).toBeNull();
});
