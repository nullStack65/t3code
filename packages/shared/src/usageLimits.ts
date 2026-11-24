import {
  type EnvironmentId,
  type ModelSelection,
  type ServerSettings,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderResetCredits,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { isLocalLoopbackHost, isWildcardHost } from "./hostClassification.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function exhaustedUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string,
) {
  const windows = provider?.usageLimits?.windows ?? [];
  const exhausted = windows.filter(
    (window) =>
      (window.usedPercent ?? 0) >= 100 &&
      (model === undefined || window.modelIds === undefined || window.modelIds.includes(model)) &&
      (model === undefined ||
        window.providerIds === undefined ||
        window.providerIds.includes(model.split("/")[0] ?? "")) &&
      (!window.resetsAt ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) > now),
  );
  if (model === undefined) return exhausted[0];
  switch (provider?.driver) {
    case "cursor": {
      const api = exhausted.find((window) => window.id === "apiPercentUsed");
      const auto = exhausted.find((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? auto && api : api;
    }
    case "antigravity": {
      const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
      return exhausted.find((window) => {
        const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
        return (
          pool === undefined ||
          family === undefined ||
          pool === family ||
          (pool === "3p" && (family === "claude" || family === "gpt"))
        );
      });
    }
    case "codex": {
      // Seat-based plans spend credits only past their plan windows, so the credit cap blocks only plans without them.
      const hasPlanWindows = windows.some(
        (window) => window.id === "primary" || window.id === "secondary",
      );
      return exhausted.find((window) => window.id !== "individual" || !hasPlanWindows);
    }
    case "opencode":
      return exhausted.find(
        (window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"),
      );
    default:
      return exhausted[0];
  }
}

export function resolveNewThreadModelSelection(input: {
  readonly defaultSelection: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}) {
  const selection = input.explicitSelection ?? input.defaultSelection;
  const unchanged = { selection, fallback: null };
  if (input.explicitSelection || !selection || !input.fallbackSelection) return unchanged;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const window = exhaustedUsageWindow(provider, input.now, selection.model);
  const fallback = input.providers.find(
    (entry) => entry.instanceId === input.fallbackSelection?.instanceId,
  );
  if (
    !provider ||
    !window ||
    !fallback?.enabled ||
    !fallback.installed ||
    fallback.auth.status === "unauthenticated" ||
    !isProviderAvailable(fallback) ||
    exhaustedUsageWindow(fallback, input.now, input.fallbackSelection.model) ||
    (input.settings &&
      !resolveProjectProviderInstanceEnabled(
        input.settings,
        input.projectId ?? null,
        fallback.instanceId,
      ))
  )
    return unchanged;
  return {
    selection: input.fallbackSelection,
    fallback: { provider, resetsAt: window.resetsAt ?? null },
  };
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "All usage on your plan this billing cycle.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok, Composer, and Auto use this allowance.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Usage allowance for third-party models such as Claude, GPT, and Gemini.",
  },
] as const;

export function cursorUsageWindowDetails(id: string, pool: LimitPool) {
  const details = CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
  return details &&
    ((pool.windows.length === 1 && id === "totalPercentUsed") || hasDuplicateCursorTotal(pool))
    ? { ...details, label: null, description: undefined }
    : details;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

function providersWithLimits(providers: readonly ServerProvider[]): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export interface LimitServerConfig {
  readonly providers: readonly ServerProvider[];
  readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
  readonly settings?:
    | { readonly usageAccountOwners?: Readonly<Record<string, string>> | undefined }
    | undefined;
}

export interface LimitPresentation {
  readonly entry: { readonly target: { readonly label: string } };
  /** Absent means connected: callers that only hold live configs need not say so. */
  readonly connection?: { readonly phase: string } | undefined;
  readonly serverConfig: LimitServerConfig | null;
}

export type LimitPresentations = ReadonlyMap<EnvironmentId, LimitPresentation>;

export interface OfflineLimitEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The newest check in its last config: about when it stopped answering. */
  readonly since: string | null;
}

function latestCheck(config: LimitServerConfig): string | null {
  const checks = [
    ...config.providers.flatMap((provider) => [
      provider.checkedAt,
      provider.usageLimits?.checkedAt,
    ]),
    ...(config.usageLimitSources ?? []).map((source) => source.checkedAt),
  ];
  let latest: string | null = null;
  for (const checkedAt of checks) {
    if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) continue;
    if (latest === null || Date.parse(checkedAt) > Date.parse(latest)) latest = checkedAt;
  }
  return latest;
}

/**
 * Only connected environments count. A disconnected one keeps its last config,
 * and with it the errors it last reported; a stopped machine would repeat them
 * forever. It becomes one offline line instead. One still on its first connect
 * has nothing to say yet, so it is left out.
 */
export function splitLimitPresentations(presentations: LimitPresentations): {
  readonly live: LimitPresentations;
  readonly offline: readonly OfflineLimitEnvironment[];
} {
  const live = new Map<EnvironmentId, LimitPresentation>();
  const offline: OfflineLimitEnvironment[] = [];
  for (const [environmentId, presentation] of presentations) {
    const phase = presentation.connection?.phase ?? "connected";
    if (phase === "connected") {
      live.set(environmentId, presentation);
      continue;
    }
    if (phase === "connecting") continue;
    offline.push({
      environmentId,
      label: presentation.entry.target.label,
      since: presentation.serverConfig ? latestCheck(presentation.serverConfig) : null,
    });
  }
  return { live, offline };
}

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");

// Source ids are environment-local, so only a remote endpoint names the same hub across environments.
function hubIdentity(environmentId: EnvironmentId, source: UsageLimitSourceSnapshot): string {
  // The server supplies canonical endpoints; native URL polyfills can misparse IPv6 hosts.
  const endpoint = source.endpoint;
  const host = endpoint?.match(/^https?:\/\/(\[[\da-f:.]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/)?.[1];
  const local =
    !host ||
    isLocalLoopbackHost(host) ||
    isWildcardHost(host) ||
    // Each machine resolves these to itself too; shared host classification leaves them out.
    /\.localhost\.*$|^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host);
  return endpoint && !local ? endpoint : `${environmentId}:${source.id}`;
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly status: NonNullable<UsageLimitSourceAccount["status"]> | null;
  readonly statusDetail: string | null;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const planSources = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption to clear its routing cooldown too; displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previousPlan = planSources.get(key);
    if (
      next.plan &&
      (!previousPlan ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousPlan.limits.checkedAt))
    ) {
      planSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    const sides = [previous, next];
    const generic = (name: string | null | undefined) =>
      !!name && name.toLowerCase() === PROVIDER_DISPLAY_NAMES[previous.driver]?.toLowerCase();
    // Either row may arrive first. A renamed instance names that route; a
    // generic "Grok" does not hide a later "Grok · Emergency (direct)". A hub
    // alias replaces only that generic name, and a null hub name does not hide
    // a later alias.
    const chosen = sides.find(
      (account) =>
        account.environments.length > 0 && account.displayName && !generic(account.displayName),
    )?.displayName;
    const hubNames = sides
      .filter((account) => account.environments.length === 0)
      .map((account) => account.displayName?.trim() || null);
    const hubName = hubNames.find((name) => name) ?? null;
    const anyHub = hubNames.length > 0;
    const nativeName =
      sides.find((account) => account.environments.length > 0)?.displayName ?? null;
    const displayName = chosen
      ? chosen
      : anyHub
        ? (hubName ?? (generic(nativeName) ? null : nativeName))
        : nativeName;
    const statusAccount =
      sides.find((account) => account.status === "signed-out") ??
      sides.find((account) => account.status);
    const status = statusAccount?.status ?? null;
    const statusDetail = statusAccount?.statusDetail ?? null;
    accounts.set(key, {
      ...previous,
      displayName,
      status,
      statusDetail,
      plan: planSources.get(key)?.plan ?? previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        status: null,
        statusDetail: null,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const resolved = resolveKey(account);
        // A resolved account already has an identity; its public key must stay distinct from others'.
        const hub = resolved ? `${environmentId}:${source.id}` : hubIdentity(environmentId, source);
        const key = `${hub}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolved ?? key, {
          key,
          driver: account.driver,
          displayName:
            account.displayName?.trim() || (account.email ? null : hubAccountName(account)),
          email: account.email,
          plan: account.plan,
          status: account.status ?? null,
          statusDetail: account.statusDetail ?? null,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices = new Set<string>();
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const name = provider.displayName?.trim() || String(provider.driver);
      const unavailable = provider.usageLimits?.unavailable;
      if (unavailable?.reason === "unsupported") {
        const message = unavailable.message?.trim();
        if (
          provider.driver === "antigravity" &&
          message &&
          !message.startsWith(NOT_APPLICABLE_PREFIX)
        ) {
          notices.add(`${label(environmentLabel, name)}: ${message}`);
        }
        continue;
      }
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.add(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
      for (const account of source.accounts) {
        const unavailable = account.usageLimits.unavailable;
        if (source.kind === "magpie" && isBillingRefusal(unavailable)) {
          // A real billing state, not "no quota here"; every machine sees the same account, so once.
          notices.add(
            `${source.label} · ${sourceAccountName(account)}: the vendor says payment is required, so this subscription's billing needs attention.`,
          );
          continue;
        }
        if (unavailable?.reason !== "probeFailed") continue;
        const subject = `${source.label} · ${sourceAccountName(account)}`;
        notices.add(
          `${label(environmentLabel, subject)}: ${limitsNotice(account.usageLimits) ?? ""}`,
        );
      }
    }
  }
  return [...notices];
}

/** A hub account by its email, else its id without the `provider:` prefix sources add. */
function sourceAccountName(account: {
  readonly id: string;
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
}) {
  return account.displayName?.trim() || account.email || account.id.replace(/^[\w-]+:/, "");
}

/** "Payment Required" from a vendor: a lapsed or unpaid subscription, which needs a person. */
function isBillingRefusal(
  unavailable: ServerProviderUsageLimits["unavailable"] | undefined,
): boolean {
  return (
    unavailable?.reason === "unsupported" && /payment required/i.test(unavailable.message ?? "")
  );
}

export interface NotApplicableEntry {
  readonly environment: string;
  readonly subject: string;
  /** Why, without the "Not applicable:" lead-in. */
  readonly reason: string;
}

const GATEWAY_REPORTED_NOT_APPLICABLE = /custom model provider|gateway reports/i;

function magpieHasReadableAccount(
  sources: ReadonlyArray<{
    readonly kind: string;
    readonly accounts: ReadonlyArray<{
      readonly driver: string;
      readonly usageLimits: { readonly unavailable?: unknown };
    }>;
  }>,
  driver: string,
): boolean {
  return sources.some(
    (source) =>
      source.kind === "magpie" &&
      source.accounts.some(
        (account) => account.driver === driver && account.usageLimits.unavailable === undefined,
      ),
  );
}

/**
 * Usage that cannot be read on its current setup (a key with no subscription,
 * an instance whose gateway reports for it), so a missing bar reads as "not
 * applicable". Only entries that say why are listed, one per environment.
 */
export function collectNotApplicable(
  presentations: LimitPresentations,
): readonly NotApplicableEntry[] {
  const entries = new Map<string, NotApplicableEntry>();
  const add = (environment: string, subject: string, reason: string) => {
    entries.set(`${environment}\u0000${subject}`, {
      environment,
      subject,
      reason: reason.replace(/^Not applicable:\s*/, ""),
    });
  };
  for (const presentation of presentations.values()) {
    const environment = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      // Only an explicit "Not applicable:" reason: other unsupported messages
      // (a sign-in prompt, a sharing notice shown as a link) ask for action.
      const unavailable = provider.usageLimits?.unavailable;
      if (
        unavailable?.reason !== "unsupported" ||
        !unavailable.message?.startsWith(NOT_APPLICABLE_PREFIX) ||
        provider.usageLimits?.externalUsage
      ) {
        continue;
      }
      // Magpie already published this driver's cards, so the instance is not an empty row.
      if (
        GATEWAY_REPORTED_NOT_APPLICABLE.test(unavailable.message) &&
        magpieHasReadableAccount(
          presentation.serverConfig?.usageLimitSources ?? [],
          provider.driver,
        )
      ) {
        continue;
      }
      add(
        environment,
        provider.displayName?.trim() || String(provider.driver),
        unavailable.message,
      );
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      // Magpie maps only standing vendor refusals to unsupported.
      if (source.kind !== "magpie") continue;
      for (const account of source.accounts) {
        const unavailable = account.usageLimits.unavailable;
        if (unavailable?.reason !== "unsupported" || isBillingRefusal(unavailable)) continue;
        add(
          environment,
          `${source.label} · ${sourceAccountName(account)}`,
          unavailable.message ?? "This account has no subscription limits.",
        );
      }
    }
  }
  return [...entries.values()];
}

/**
 * The same instance and reason on several machines is one row naming the
 * machines, so the list grows with setups, not with the fleet.
 */
export function groupNotApplicable(entries: readonly NotApplicableEntry[]): ReadonlyArray<{
  readonly subject: string;
  readonly reason: string;
  readonly environments: readonly string[];
}> {
  const groups = new Map<string, { subject: string; reason: string; environments: string[] }>();
  for (const entry of entries) {
    const key = `${entry.subject}\u0000${entry.reason}`;
    const group = groups.get(key);
    if (group) {
      if (!group.environments.includes(entry.environment))
        group.environments.push(entry.environment);
    } else {
      groups.set(key, {
        subject: entry.subject,
        reason: entry.reason,
        environments: [entry.environment],
      });
    }
  }
  return [...groups.values()];
}

export const UNASSIGNED_OWNER = "Unassigned";

const NOT_APPLICABLE_PREFIX = "Not applicable:";

/** `owner@example.com · Team` and `Owner@Example.com` look up the same owner. */
function ownerLookupKey(email: string): string {
  return email.split(" · ")[0]!.trim().toLowerCase();
}

/** The email → owner map from every connected environment; the first to name an email wins. */
export function collectAccountOwners(
  presentations: LimitPresentations,
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const presentation of presentations.values()) {
    const map = presentation.serverConfig?.settings?.usageAccountOwners ?? {};
    for (const [email, owner] of Object.entries(map)) {
      const key = ownerLookupKey(email);
      if (key && owner.trim() && !owners.has(key)) owners.set(key, owner.trim());
    }
  }
  return owners;
}

function accountOwner(
  account: Pick<LimitAccount, "email">,
  owners: ReadonlyMap<string, string>,
): string {
  return (account.email && owners.get(ownerLookupKey(account.email))) || UNASSIGNED_OWNER;
}

/**
 * Accounts split by owner, each owner's accounts pooled per provider as
 * {@link collectLimitPools} does. Owners keep the order the map names them;
 * Unassigned comes last. With no owner map there is one group, so the view
 * reads as it did before owners existed.
 */
export function collectLimitOwnerGroups(
  accounts: readonly LimitAccount[],
  owners: ReadonlyMap<string, string>,
  now: number,
): ReadonlyArray<{ readonly owner: string; readonly pools: readonly LimitPool[] }> {
  const order = [...new Set(owners.values())];
  const byOwner = new Map<string, LimitAccount[]>();
  for (const account of accounts) {
    const owner = accountOwner(account, owners);
    const list = byOwner.get(owner);
    if (list) list.push(account);
    else byOwner.set(owner, [account]);
  }
  const rank = (owner: string) =>
    owner === UNASSIGNED_OWNER ? Number.POSITIVE_INFINITY : order.indexOf(owner);
  return [...byOwner]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([owner, members]) => ({ owner, pools: collectLimitPools(members, now) }));
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

function hasDuplicateCursorTotal(pool: LimitPool): boolean {
  if (pool.windows.length !== 2) return false;
  const total = pool.windows.find((window) => window.id === "totalPercentUsed");
  const auto = pool.windows.find((window) => window.id === "autoPercentUsed");
  return (
    total !== undefined &&
    auto !== undefined &&
    total.members.length === auto.members.length &&
    total.members.every(({ account, window }) =>
      account.limits.windows.some(
        (candidate) =>
          candidate.id === auto.id &&
          candidate.kind === auto.kind &&
          candidate.usedPercent === window.usedPercent &&
          candidate.resetsAt === window.resetsAt,
      ),
    )
  );
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool);
  return pool.windows
    .filter((window) => !hideTotal || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // One unknown plan makes the pool incomparable by plan, so every member then counts once.
    const capacities = members.map((m) => planCapacity(m.account, first.kind));
    const weights = capacities.every((capacity) => capacity !== undefined)
      ? capacities
      : members.map(() => 1);
    const weightOf = new Map(members.map((m, index) => [m, weights[index]!]));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const usedPercent =
      members.reduce((sum, m) => sum + m.window.usedPercent * weightOf.get(m)!, 0) / totalWeight;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: weightOf.get(m)! }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.elapsed * t.weight, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(
                  (member.refillPercent * weightOf.get(member)!) / totalWeight,
                ),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
  readonly input: ProviderConsumeResetCreditInput;
}

export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) => (at ? formatDuration(Date.parse(at) - now) : null);
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      return {
        key: option.creditId,
        summary: `${option.label} · ${option.availableCount} left${expires ? ` · expires in ${expires}` : ""}`,
        actionLabel: "Use",
        confirmDescription: `${option.label}: ${option.description} This cannot be undone.`,
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? "No reset credits banked"
          : compact
            ? `${count} banked${expires ? ` · expires in ${expires}` : ""}`
            : `${count} ${count === 1 ? "reset credit" : "reset credits"} banked${expires ? ` · next expires in ${expires}` : ""}`,
      actionLabel: "Use reset",
      confirmDescription:
        "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      availableCount: count,
      input,
    },
  ];
}

export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const supportedDrivers = new Set([
    ...providersWithLimits(providers).map((provider) => provider.driver),
    ...sources.flatMap((source) => source.accounts.map((account) => account.driver)),
  ]);
  const unreadableSource = sources.some(
    (source) => source.error !== undefined && source.accounts.length === 0,
  );
  return providers.map((provider) => {
    if (!unreadableSource && !supportedDrivers.has(provider.driver)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null; chosenName: string | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (provider.driver !== selected.driver || !provider.usageLimits) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = resolveKey(nativeReport(provider)) ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    const trimmedName = provider.displayName?.trim() || null;
    const chosenName =
      trimmedName &&
      trimmedName.toLowerCase() !== PROVIDER_DISPLAY_NAMES[provider.driver]?.toLowerCase()
        ? trimmedName
        : null;
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
      chosenName: previous?.chosenName ?? chosenName,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
    chosenName,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    const relatedHubs = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null && resolveKey(account) === key && account.driver === provider.driver,
      );
    const statusAccount =
      relatedHubs.find(({ account }) => account.status === "signed-out")?.account ??
      relatedHubs.find(({ account }) => account.status)?.account;
    const nativeLabel = chosenName ?? (provider.displayName?.trim() || null);
    const hubLabel =
      relatedHubs.map(({ account }) => account.displayName?.trim() || null).find((name) => name) ??
      null;
    const generic =
      !!nativeLabel &&
      nativeLabel.toLowerCase() === PROVIDER_DISPLAY_NAMES[provider.driver]?.toLowerCase();
    const displayName = nativeLabel && !generic ? nativeLabel : (hubLabel ?? nativeLabel);
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(displayName ? { displayName } : {}),
      ...(statusAccount?.status ? { status: statusAccount.status } : {}),
      ...(statusAccount?.statusDetail ? { statusDetail: statusAccount.statusDetail } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      const hubName = account.displayName?.trim();
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: hubName || `${source.label} · ${hubAccountName(account)}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(hubName ? { displayName: hubName } : {}),
        ...(account.status ? { status: account.status } : {}),
        ...(account.statusDetail ? { statusDetail: account.statusDetail } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
