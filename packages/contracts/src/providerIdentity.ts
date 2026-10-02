/**
 * Managed-launch identity is deliberately separate from ordinary provider
 * auth metadata.  Host identity is derived from the persisted environment
 * and configured instance; key identifiers are accepted only when a provider
 * supplies a real public identifier.  No local value is a substitute.
 */
import * as Schema from "effect/Schema";
import { EnvironmentId } from "./environment.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderKeyIdentifier = Schema.Struct({
  /** Provider or issuer namespace; IDs from different namespaces never match. */
  namespace: TrimmedNonEmptyString,
  /** Opaque provider-issued public identifier. Never a token, digest, or UUID fallback. */
  id: TrimmedNonEmptyString,
});
export type ProviderKeyIdentifier = typeof ProviderKeyIdentifier.Type;

export const ProviderHostInstanceIdentity = Schema.Struct({
  /** Persisted T3 environment identity. A new state directory is a new host. */
  environmentId: EnvironmentId,
  /** Configured provider routing identity within that environment. */
  providerInstanceId: ProviderInstanceId,
});
export type ProviderHostInstanceIdentity = typeof ProviderHostInstanceIdentity.Type;

/** Derive the structured host identity from the two existing persisted values. */
export const makeProviderHostInstanceIdentity = (input: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
}): ProviderHostInstanceIdentity => ({
  environmentId: input.environmentId,
  providerInstanceId: input.providerInstanceId,
});

export const ManagedProviderLaunchIdentity = Schema.Struct({
  /** Non-secret authenticated principal from the verified session. */
  subject: TrimmedNonEmptyString,
  /** One or more provider-issued public IDs; omission is not qualification. */
  keyIds: Schema.Array(ProviderKeyIdentifier),
  providerHostInstance: ProviderHostInstanceIdentity,
});
export type ManagedProviderLaunchIdentity = typeof ManagedProviderLaunchIdentity.Type;

export const ManagedProviderLaunchNotQualifiedReason = Schema.Literals([
  "missing-subject",
  "missing-key-id",
  "missing-host-identity",
]);
export type ManagedProviderLaunchNotQualifiedReason =
  typeof ManagedProviderLaunchNotQualifiedReason.Type;

export type ManagedProviderLaunchQualification =
  | { readonly qualified: true; readonly identity: ManagedProviderLaunchIdentity }
  | {
      readonly qualified: false;
      readonly reason: ManagedProviderLaunchNotQualifiedReason;
    };

/**
 * Project the three independent launch inputs without manufacturing any
 * identity. This is intentionally fail-closed when the provider has no real
 * key ID or when the authenticated session is anonymous. Session/access-token
 * and DPoP-key rotation are not drift when the subject/key ID is unchanged;
 * provider key replacement, subject replacement, or host changes are drift.
 */
export const qualifyManagedProviderLaunch = (input: {
  readonly subject?: string | undefined;
  readonly keyIds?: ReadonlyArray<ProviderKeyIdentifier> | undefined;
  readonly providerHostInstance?: ProviderHostInstanceIdentity | undefined;
}): ManagedProviderLaunchQualification => {
  const subject = input.subject?.trim();
  if (!subject) return { qualified: false, reason: "missing-subject" };
  if (!input.keyIds || input.keyIds.length === 0) {
    return { qualified: false, reason: "missing-key-id" };
  }
  if (!input.providerHostInstance) {
    return { qualified: false, reason: "missing-host-identity" };
  }
  return {
    qualified: true,
    identity: {
      subject,
      keyIds: [...input.keyIds],
      providerHostInstance: input.providerHostInstance,
    },
  };
};

export type ManagedProviderLaunchDrift =
  | "subject-drift"
  | "key-id-drift"
  | "host-drift"
  | "unknown-identity";

const keyIdSet = (keyIds: ReadonlyArray<ProviderKeyIdentifier>): Set<string> =>
  new Set(keyIds.map((keyId) => `${keyId.namespace}\u0000${keyId.id}`));

const equalSets = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** Exact comparison used by re-authorization/rotation gates. */
export const compareManagedProviderLaunchIdentity = (
  expected: ManagedProviderLaunchIdentity | undefined,
  actual: ManagedProviderLaunchIdentity | undefined,
): "match" | ManagedProviderLaunchDrift => {
  if (!expected || !actual) return "unknown-identity";
  if (expected.subject !== actual.subject) return "subject-drift";
  if (!equalSets(keyIdSet(expected.keyIds), keyIdSet(actual.keyIds))) return "key-id-drift";
  if (
    expected.providerHostInstance.environmentId !== actual.providerHostInstance.environmentId ||
    expected.providerHostInstance.providerInstanceId !==
      actual.providerHostInstance.providerInstanceId
  ) {
    return "host-drift";
  }
  return "match";
};
