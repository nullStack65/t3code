/**
 * Managed-launch identity is deliberately separate from ordinary provider
 * auth metadata.  Host identity is derived from the persisted environment
 * and configured instance; key identifiers are accepted only when a provider
 * supplies a real public identifier.  No local value is a substitute.
 */
import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  keyIds: Schema.Array(ProviderKeyIdentifier).check(Schema.isNonEmpty()),
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
      // Key IDs are a set by contract. Sorting and deduplicating makes the
      // projection deterministic without treating duplicates as new keys.
      keyIds: normalizeKeyIds(input.keyIds),
      providerHostInstance: input.providerHostInstance,
    },
  };
};

export type ManagedProviderLaunchDrift =
  | "subject-drift"
  | "key-id-drift"
  | "host-drift"
  | "unknown-identity";

type KeyIdSet = ReadonlyMap<string, ReadonlySet<string>>;

const normalizeKeyIds = (
  keyIds: ReadonlyArray<ProviderKeyIdentifier>,
): ReadonlyArray<ProviderKeyIdentifier> => {
  const sorted = [...keyIds].sort((left, right) =>
    left.namespace === right.namespace
      ? left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0
      : left.namespace < right.namespace
        ? -1
        : 1,
  );
  return sorted.filter(
    (keyId, index) =>
      index === 0 ||
      keyId.namespace !== sorted[index - 1]?.namespace ||
      keyId.id !== sorted[index - 1]?.id,
  );
};

// Keep namespace and ID as separate map keys. A delimiter-joined string would
// make tuples containing that delimiter collide and could hide key rotation.
const keyIdSet = (keyIds: ReadonlyArray<ProviderKeyIdentifier>): KeyIdSet => {
  const byNamespace = new Map<string, Set<string>>();
  for (const keyId of keyIds) {
    const ids = byNamespace.get(keyId.namespace) ?? new Set<string>();
    ids.add(keyId.id);
    byNamespace.set(keyId.namespace, ids);
  }
  return byNamespace;
};

const equalKeyIdSets = (left: KeyIdSet, right: KeyIdSet): boolean => {
  if (left.size !== right.size) return false;
  for (const [namespace, ids] of left) {
    const otherIds = right.get(namespace);
    if (!otherIds || ids.size !== otherIds.size || [...ids].some((id) => !otherIds.has(id))) {
      return false;
    }
  }
  return true;
};

/** Exact comparison used by re-authorization/rotation gates. */
export const compareManagedProviderLaunchIdentity = (
  expected: ManagedProviderLaunchIdentity | undefined,
  actual: ManagedProviderLaunchIdentity | undefined,
): "match" | ManagedProviderLaunchDrift => {
  if (!expected || !actual) return "unknown-identity";
  if (expected.subject !== actual.subject) return "subject-drift";
  if (!equalKeyIdSets(keyIdSet(expected.keyIds), keyIdSet(actual.keyIds))) return "key-id-drift";
  if (
    expected.providerHostInstance.environmentId !== actual.providerHostInstance.environmentId ||
    expected.providerHostInstance.providerInstanceId !==
      actual.providerHostInstance.providerInstanceId
  ) {
    return "host-drift";
  }
  return "match";
};
