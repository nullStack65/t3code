import { CodexSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderDriverError } from "../Errors.ts";
import { CodexSkillSource } from "../CodexSkillConsumer.ts";
import { makeCodexDriver, type CodexDriverEnv } from "./CodexDriver.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { CodexTypedSkillCandidate } from "../CodexSessionObservation.ts";
export { CodexTypedSkillCandidate } from "../CodexSessionObservation.ts";

// A reference to an offline candidate is a request, never a trusted observation
// or permission. In particular, review-only candidates cannot authorize a turn.
export const CodexTypedSkillsSettings = Schema.Struct({
  launch: Schema.NullOr(Schema.Struct({ codex: CodexSettings, source: CodexSkillSource })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  candidate: Schema.NullOr(CodexTypedSkillCandidate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});

export class CodexTypedSkillAdmissionRefused extends Schema.TaggedError<CodexTypedSkillAdmissionRefused>()(
  "CodexTypedSkillAdmissionRefused",
  {
    instanceId: ProviderInstanceId,
    admissionAuthorized: Schema.Literal(false),
    reason: Schema.Literal("native-boundary-unqualified"),
  },
) {
  override get message(): string {
    return (
      "Typed Skill admission refused: native-boundary-unqualified. " +
      "Configure a pinned canonical source and explicit governed launch to resolve current Skills. " +
      "An offline candidate reference alone cannot authorize a native turn. " +
      "No candidate was read and no provider process was started."
    );
  }
}

/**
 * Reserve a distinct route rather than an optional field on the legacy driver:
 * older T3 builds reject unknown drivers instead of stripping an unfamiliar
 * policy field and silently starting an ungoverned Codex session.
 *
 * Only an explicit server configuration can enable the canonical consumer.
 * Candidate references retain the original no-process refusal. The launch
 * resolves each request and starts fresh provider context; it does not claim
 * exclusive filesystem access or control over unmanaged shared skills/plugins.
 */
export const CodexTypedSkillsDriver: ProviderDriver<
  typeof CodexTypedSkillsSettings.Type,
  CodexDriverEnv
> = {
  driverKind: ProviderDriverKind.make("codex-typed-skills"),
  metadata: {
    displayName: "Codex (typed Skill admission required)",
    supportsMultipleInstances: true,
  },
  configSchema: CodexTypedSkillsSettings,
  defaultConfig: () => ({ candidate: null, launch: null }),
  create: (input) => {
    const { instanceId } = input;
    if (input.config.launch)
      return makeCodexDriver(input.config.launch.source).create({
        ...input,
        config: input.config.launch.codex,
      });
    const refusal = new CodexTypedSkillAdmissionRefused({
      instanceId,
      admissionAuthorized: false,
      reason: "native-boundary-unqualified",
    });
    return Effect.fail(
      new ProviderDriverError({
        driver: "codex-typed-skills",
        instanceId,
        detail: refusal.message,
        cause: refusal,
      }),
    );
  },
};
