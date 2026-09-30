/**
 * Derives the launch-preflight consumer from the selected production provider
 * instance. The consumer is what decides whether `git add --sparse` is
 * required by the launch itself (OpenCode snapshot staging) or only by the
 * repository's sparse-checkout configuration (T3's own checkpoint fallback).
 *
 * The facts come from the same settings the provider runtime uses:
 * `ServerSettings.providerInstances`, each instance's configured environment,
 * and — for the default OpenCode provider — the effective
 * `OPENCODE_CONFIG_CONTENT` snapshot setting. An instance pointed at an
 * external OpenCode server owns its own process and Git, so the local Git this
 * T3 server resolves cannot establish that process's capability.
 *
 * @module provider/launchPreflightConsumer
 */
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  OpenCodeSettings,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import type { LaunchPreflightConsumer } from "../environment/LaunchPreflight.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveOpenCodeConfigContent } from "./opencodeRuntime.ts";

const decodeOpenCodeSettings = Schema.decodeUnknownOption(OpenCodeSettings);

const OPENCODE_DRIVER: ProviderDriverKind = "opencode" as ProviderDriverKind;

/**
 * Parses the inline `OPENCODE_CONFIG_CONTENT` byte-for-byte the way OpenCode
 * itself does. OpenCode v1.18.x loads this value through `loadConfig`, which
 * uses a JSONC parser, so comments and trailing commas are valid in a config
 * that OpenCode accepts. `jsonc-parser` is the same small parser the web app
 * already depends on; this reads only the in-memory string (no file or tree
 * discovery, no network).
 */
const parseInlineOpenCodeConfig = (
  configContent: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  const errors: ParseError[] = [];
  const value = parseJsonc(configContent, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  return errors.length > 0 ? { ok: false } : { ok: true, value };
};

/**
 * Whether the effective OpenCode config still stages Git snapshots. OpenCode
 * defaults snapshots on, so only an explicit boolean `false` disables the
 * provider-specific requirement; an absent config keeps that default. An
 * inline config that cannot be parsed at all is `"unknown"`: the preflight must
 * not assert snapshots are definitely enabled, so it does not force the
 * provider-specific `--sparse` requirement from unparsed content. This
 * intentionally does not search config files or call out.
 */
export const openCodeSnapshotsEnabled = (configContent: string): boolean | "unknown" => {
  const parsed = parseInlineOpenCodeConfig(configContent);
  if (!parsed.ok) return "unknown";
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const snapshot = (value as { readonly snapshot?: unknown }).snapshot;
  if (snapshot === undefined || snapshot === true) return true;
  if (snapshot === false) return false;
  return "unknown";
};

export interface ResolveLaunchPreflightConsumerInput {
  readonly provider?: ProviderDriverKind | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly settings?: ServerSettings | undefined;
  /** Host environment used as the instance environment's base. Defaults to `process.env`. */
  readonly hostEnv?: NodeJS.ProcessEnv | undefined;
}

/**
 * Resolves the consumer/operation about to launch. Returns `undefined` when no
 * provider is known yet (nothing consumer-specific to check).
 */
export const resolveLaunchPreflightConsumer = (
  input: ResolveLaunchPreflightConsumerInput,
): LaunchPreflightConsumer | undefined => {
  const { provider } = input;
  if (provider === undefined) return undefined;

  if (provider !== OPENCODE_DRIVER) {
    // T3's own checkpoint path only needs `--sparse` in a sparse checkout, which
    // the preflight detects from the repository itself. No provider-specific
    // requirement applies to other consumers.
    return { driver: provider, snapshotsEnabled: true };
  }

  const entry =
    input.providerInstanceId !== undefined
      ? input.settings?.providerInstances[input.providerInstanceId]
      : undefined;
  const decoded = decodeOpenCodeSettings(entry?.config ?? {});
  const config = decoded._tag === "Some" ? decoded.value : undefined;

  if (config !== undefined && config.serverUrl.trim().length > 0) {
    // External-server branch: no local OpenCode process is launched, so local
    // PATH evidence cannot establish that server's Git.
    return { driver: provider, snapshotsEnabled: false };
  }

  const environment = mergeProviderInstanceEnvironment(entry?.environment, input.hostEnv);
  const snapshotsEnabled = openCodeSnapshotsEnabled(resolveOpenCodeConfigContent(environment));
  return { driver: provider, snapshotsEnabled };
};
