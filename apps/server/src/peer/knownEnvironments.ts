import type {
  AppConnectionReport,
  EnvironmentId,
  KnownEnvironment,
  KnownEnvironmentIssue,
  PeerLinkSummary,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

const versioned = (label: string, version: string | null) =>
  version === null ? label : `${label} ${version}`;

/** Where this server would send a link's credentials: https, or plain http only over Tailscale. */
const linkableUrl = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || isLocalLoopbackHost(parsed.hostname)) return false;
  return (
    parsed.protocol === "https:" || (parsed.protocol === "http:" && isTailnetHost(parsed.hostname))
  );
};

/** Why an environment is on only one side, and the one action that fixes it. */
const environmentIssue = (input: {
  readonly label: string;
  readonly serverVersion: string | null;
  readonly link: PeerLinkSummary | null;
  readonly app: AppConnectionReport | undefined;
}): KnownEnvironmentIssue | null => {
  const { label, link, app } = input;
  const named = versioned(label, input.serverVersion);
  if (link !== null) {
    if (link.status === "expired") {
      return {
        action: "relink",
        message: `The link to ${label} expired. Link it again with a new pairing code.`,
      };
    }
    if (app !== undefined) return null;
    if (link.status === "unreachable") {
      return {
        action: null,
        message: `${label} is linked for agents but not in the app, and is not answering, so it cannot be added now.`,
      };
    }
    return link.appPairing === true
      ? { action: "add-to-app", message: `${label} is linked for agents but not in the app.` }
      : {
          action: "update",
          message: `${named} is linked for agents but too old to add to the app. Update it.`,
        };
  }
  if (app === undefined) return null;
  if (app.keepsLinkLimits === false) {
    return {
      action: "update",
      message: `${named} is too old to link, so agents here cannot work there. Update it.`,
    };
  }
  if (!app.urls.some(linkableUrl)) {
    return {
      action: "add-address",
      message: `The app reaches ${label} only over plain http, which would send a link's credentials unencrypted. Add its https or Tailscale address, then link it.`,
    };
  }
  return {
    action: "link",
    message: `${label} is in the app but not linked, so agents here cannot work there.`,
  };
};

/**
 * One list of the environments this one knows: its links, in their order, then those only its
 * clients' apps hold. A machine on both sides is one entry, named as the app names it.
 */
export function knownEnvironments(input: {
  readonly self: EnvironmentId;
  readonly links: ReadonlyArray<PeerLinkSummary>;
  readonly reports: Iterable<AppConnectionReport>;
}): ReadonlyArray<KnownEnvironment> {
  const app = new Map<EnvironmentId, AppConnectionReport>();
  for (const report of input.reports) {
    if (report.environmentId === input.self) continue;
    const seen = app.get(report.environmentId);
    app.set(
      report.environmentId,
      seen === undefined ? report : { ...seen, urls: [...new Set([...seen.urls, ...report.urls])] },
    );
  }
  const linked = input.links.filter((link) => link.environmentId !== input.self);
  const linkedIds = new Set(linked.map((link) => link.environmentId));
  const entry = (
    environmentId: EnvironmentId,
    link: PeerLinkSummary | null,
    report: AppConnectionReport | undefined,
  ) => {
    const label = report?.label ?? link?.label ?? "";
    const serverVersion = link?.serverVersion ?? report?.serverVersion ?? null;
    return {
      environmentId,
      label,
      urls: [...new Set([...(link?.urls ?? []), ...(report?.urls ?? [])])],
      serverVersion,
      link,
      inApp: report !== undefined,
      issue: environmentIssue({ label, serverVersion, link, app: report }),
    } satisfies KnownEnvironment;
  };
  return [
    ...linked.map((link) => entry(link.environmentId, link, app.get(link.environmentId))),
    ...[...app.values()]
      .filter((report) => !linkedIds.has(report.environmentId))
      .map((report) => entry(report.environmentId, null, report)),
  ];
}
