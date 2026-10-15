import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderDriverError } from "../Errors.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";

// A reference to an offline candidate is a request, never a trusted observation
// or permission. In particular, review-only candidates cannot authorize a turn.
export const CodexTypedSkillCandidate = Schema.Struct({
  directory: Schema.NonEmptyString,
  sourceRepository: Schema.Literal("nullStack65/closura-agent-config"),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  admissionSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export const CodexTypedSkillsSettings = Schema.Struct({
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
      "Codex requires independently trusted route/source admission, exclusive Skill discovery, " +
      "body/read/expansion enforcement and retained-context invalidation before activation. " +
      "No candidate was read and no provider process was started."
    );
  }
}

/**
 * Reserve a distinct route rather than an optional field on the legacy driver:
 * older T3 builds reject unknown drivers instead of stripping an unfamiliar
 * policy field and silently starting an ungoverned Codex session.
 *
 * This build supports refusal only. Do not delegate to CodexDriver or materialize
 * its shadow home: that shares skills/plugins, and extraRoots is additive.
 * No settings, model output, offline receipt or caller boolean can enable it.
 */
export const CodexTypedSkillsDriver: ProviderDriver<typeof CodexTypedSkillsSettings.Type> = {
  driverKind: ProviderDriverKind.make("codex-typed-skills"),
  metadata: {
    displayName: "Codex (typed Skill admission required)",
    supportsMultipleInstances: true,
  },
  configSchema: CodexTypedSkillsSettings,
  defaultConfig: () => ({ candidate: null }),
  create: ({ instanceId }) => {
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
