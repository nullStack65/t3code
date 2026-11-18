import type { CloudSpeechProvider, EnvironmentId } from "@t3tools/contracts";

/** What turns speech into text. The environment that runs it is a separate, defaulted choice. */
export type VoiceBackend = CloudSpeechProvider | "local";

/** Menu order. This fork recommends AssemblyAI; its key comes from the host's vault. */
export const VOICE_BACKENDS: ReadonlyArray<VoiceBackend> = [
  "assemblyai",
  "openai",
  "xai",
  "openrouter",
  "local",
];
export const RECOMMENDED_VOICE_BACKEND: VoiceBackend = "assemblyai";

export interface VoiceEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly capabilities:
    | { readonly voiceTranscription?: boolean; readonly cloudVoiceTranscription?: boolean }
    | undefined;
}

export function voiceBackendEnvironments<E extends VoiceEnvironmentCandidate>(
  backend: VoiceBackend,
  environments: ReadonlyArray<E>,
): E[] {
  return environments.filter(
    (environment) =>
      environment.capabilities?.[
        backend === "local" ? "voiceTranscription" : "cloudVoiceTranscription"
      ] === true,
  );
}

/**
 * The environment a backend runs on unless the user overrides it: the current one, then this
 * device's own environment, then the first connected one.
 */
export function defaultVoiceEnvironment(
  backend: VoiceBackend,
  environments: ReadonlyArray<VoiceEnvironmentCandidate>,
  preferred: { readonly current: EnvironmentId | null; readonly primary: EnvironmentId | null },
): EnvironmentId | null {
  const candidates = voiceBackendEnvironments(backend, environments);
  const pick = (id: EnvironmentId | null) =>
    id === null ? undefined : candidates.find((environment) => environment.environmentId === id);
  const primary = pick(preferred.primary);
  return (
    (
      pick(preferred.current) ??
      (primary?.connected ? primary : undefined) ??
      candidates.find((environment) => environment.connected) ??
      primary ??
      candidates[0]
    )?.environmentId ?? null
  );
}
