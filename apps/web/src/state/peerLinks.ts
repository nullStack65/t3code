import { useAtomValue } from "@effect/atom-react";
import {
  appConnectionReports,
  appPairingAddresses,
  linkableMachines,
  linkedEnvironmentNames,
  linkRequestFailureMessage,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkAppAccess,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { connectPairing } from "../connection/onboarding";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  persistClientSettingsPatch,
} from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { mintPairingCodeOn } from "./peerPairingCode";
import { useEnvironmentIdentities, useEnvironments } from "./environments";
import { environmentPresentations } from "./presentation";
import { relayEnvironmentDiscovery } from "./relay";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/** Whether `environmentId` offers links, so its threads may name another machine. */
export const offersLinkedEnvironmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    offersLinkedEnvironments(get(environmentPresentations.serverConfigsAtom).get(environmentId)),
  ).pipe(Atom.withLabel(`peer-links:offered:${environmentId}`)),
);

const offersNoLinksAtom = Atom.make(false).pipe(Atom.withLabel("peer-links:offered:none"));

/**
 * The machines `environmentId` links to, by name, while it offers links, and none otherwise.
 * Its agents can read threads there. Listing asks each linked machine whether it answers, so
 * every caller shares one briefly cached list.
 */
export function useLinkedEnvironments(
  environmentId: EnvironmentId | null,
): ReadonlyMap<EnvironmentId, string> {
  const offered = useAtomValue(
    environmentId === null ? offersNoLinksAtom : offersLinkedEnvironmentsAtom(environmentId),
  );
  const identities = useEnvironmentIdentities();
  const links = useEnvironmentQuery(
    offered && environmentId !== null
      ? peerLinkEnvironment.list({ environmentId, input: {} })
      : null,
  );
  return linkedEnvironmentNames({
    links: offered ? (links.data?.links ?? []) : [],
    environments: identities,
  });
}

export function usePeerLinkHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      offersLinkedEnvironments(environment.serverConfig),
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}

/**
 * The user's other machines, for picking one to link `environmentId` to,
 * including those only on their T3 Connect account. Reads that environment's
 * links only while `enabled`, since listing them asks every linked machine
 * whether it answers.
 */
export function useLinkableMachines(environmentId: EnvironmentId, enabled: boolean) {
  const { environments } = useEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  // Connect hosts are listed only once something asked for them, so ask on open.
  const discoverIfUnasked = useEffectEvent(() => {
    if (discovery.environments.size === 0 && !discovery.refreshing) void refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discovery follows the picker's visibility, which a card's mount or a dialog's open sets
  useEffect(() => {
    if (enabled) discoverIfUnasked();
  }, [enabled]);
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  return linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: links.data?.links ?? [],
    connect: discovery.environments,
  });
}

/**
 * The hosts among `hosts` whose loaded list links `target`, for offering to unlink there too.
 * A list not loaded yet counts as not linking: the offer is a convenience, never the only way.
 */
export function hostsLinking(
  hosts: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  target: EnvironmentId,
): ReadonlyArray<EnvironmentId> {
  return hosts.flatMap(({ environmentId }) => {
    if (environmentId === target) return [];
    const known = AsyncResult.getOrElse(
      appAtomRegistry.get(peerLinkEnvironment.environments({ environmentId, input: {} })),
      () => null,
    );
    return known?.environments.some(
      (environment) => environment.environmentId === target && environment.link !== null,
    )
      ? [environmentId]
      : [];
  });
}

/**
 * Tells each connected environment that offers links which connections this app holds, so
 * its own list, and its agents, see them. Addresses and versions only, never a credential.
 */
export function AppConnectionReporter() {
  const { environments } = useEnvironments();
  const hosts = usePeerLinkHosts();
  const reportable = useEnvironmentsWithScope(hosts, AuthAccessWriteScope);
  const report = useAtomCommand(peerLinkEnvironment.reportAppConnections, {
    reportFailure: false,
  });
  const connections = appConnectionReports(environments);
  const key = JSON.stringify([[...reportable].toSorted(), connections]);
  // Takes the snapshot it fires for, so the effect names what it depends on.
  const send = useEffectEvent((_snapshot: string) => {
    for (const environmentId of reportable) {
      void report({ environmentId, input: { connections } });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes this app's connections to each server, outside React, when they or the servers change
  useEffect(() => send(key), [key]);
  return null;
}

/**
 * Links `machine` from `hostId` with a code this client mints there with its own session,
 * the way the Link dialog does. Resolves to the failure to show, or null once linked.
 */
export async function linkFromThisApp(
  hostId: EnvironmentId,
  machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly urls: ReadonlyArray<string>;
  },
  access: AuthMcpClientAccess,
): Promise<string | null> {
  const [url, ...alternateUrls] = machine.urls;
  if (url === undefined)
    return `This app has no address for ${machine.label} that another machine can reach.`;
  const code = await mintPairingCodeOn(machine.environmentId, access);
  if (code._tag === "Failure") return linkRequestFailureMessage(code.failure);
  const linked = await peerLinkEnvironment.link.run(appAtomRegistry, {
    environmentId: hostId,
    input: {
      url,
      ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
      expectedEnvironmentId: machine.environmentId,
      expectedLabel: machine.label,
      pairingCode: code.success,
      access,
    },
  });
  return linked._tag === "Success" ? null : String(squashAtomCommandFailure(linked));
}

export type AddToAppOutcome =
  | { readonly _tag: "Added"; readonly access: PeerLinkAppAccess }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Interrupted" };

/**
 * Adds a machine `hostId` links to this app: the peer mints a single-use code over the link,
 * capped at the link's access, and this client pairs with it at the addresses it reaches.
 * "Add to this app" and the automatic add both run this.
 */
export async function addLinkedEnvironmentToApp(
  hostId: EnvironmentId,
  machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly onHostMachine: boolean;
  },
): Promise<AddToAppOutcome> {
  const issued = await peerLinkEnvironment.addToApp.run(appAtomRegistry, {
    environmentId: hostId,
    input: { environmentId: machine.environmentId },
  });
  if (issued._tag === "Failure") {
    return isAtomCommandInterrupted(issued)
      ? { _tag: "Interrupted" }
      : { _tag: "Failed", message: String(squashAtomCommandFailure(issued)) };
  }
  // Where the peer just answered first, then its other addresses this client reaches. One that
  // does not answer as this machine never receives the code, so the next can.
  let failure: string | null = null;
  for (const host of appPairingAddresses(issued.value.urls, machine.onHostMachine)) {
    const result = await connectPairing.run(appAtomRegistry, {
      host,
      pairingCode: issued.value.credential,
      expectedEnvironmentId: machine.environmentId,
    });
    if (result._tag === "Success") return { _tag: "Added", access: issued.value.access };
    if (isAtomCommandInterrupted(result)) return { _tag: "Interrupted" };
    failure = String(squashAtomCommandFailure(result));
  }
  return {
    _tag: "Failed",
    message: failure ?? `${machine.label} answers only at addresses this device cannot open.`,
  };
}

// A patch shows in the settings snapshot at once, before it is stored, so the automatic add
// never sees a removed machine as missing and not dismissed.
const setDismissed = async (environmentId: EnvironmentId, dismissed: boolean) => {
  if (!isClientSettingsHydrated()) {
    await ensureClientSettingsHydrated().catch(() => undefined);
  }
  const others = getClientSettings().dismissedLinkedEnvironmentIds.filter(
    (id) => id !== environmentId,
  );
  return persistClientSettingsPatch({
    dismissedLinkedEnvironmentIds: dismissed ? [...others, environmentId] : others,
  });
};

/**
 * Keeps a linked machine the user removes from this app out of it: it is no longer added on
 * its own. Call it before removing. Unlinking leaves it in place; only adding by hand clears it.
 */
export function dismissLinkedEnvironment(environmentId: EnvironmentId): Promise<void> {
  return setDismissed(environmentId, true);
}

/** Lets a linked machine be added on its own again: the user chose Add to this app. */
export function undismissLinkedEnvironment(environmentId: EnvironmentId): Promise<void> {
  return setDismissed(environmentId, false);
}

/** Links the user chose while adding a connection, kept until that connection connects. */
const pendingLinksAtom = Atom.make<
  ReadonlyMap<
    EnvironmentId,
    { readonly access: AuthMcpClientAccess; readonly hosts: ReadonlyArray<EnvironmentId> }
  >
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("peer-links:pending-on-connect"));

/** Links `environmentId` from `hosts` once this app connects to it: adding it was the approval. */
export function linkOnConnect(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
  hosts: ReadonlyArray<EnvironmentId>,
) {
  const hostsElsewhere = hosts.filter((host) => host !== environmentId);
  if (hostsElsewhere.length === 0) return forgetLinkOnConnect(environmentId);
  appAtomRegistry.set(
    pendingLinksAtom,
    new Map(appAtomRegistry.get(pendingLinksAtom)).set(environmentId, {
      access,
      hosts: hostsElsewhere,
    }),
  );
}

/**
 * Drops a `linkOnConnect` choice that has not run yet. Call it when the environment is
 * removed, or added again without the link, so an old choice never links it later.
 */
export function forgetLinkOnConnect(environmentId: EnvironmentId) {
  const pending = appAtomRegistry.get(pendingLinksAtom);
  if (!pending.has(environmentId)) return;
  const remaining = new Map(pending);
  remaining.delete(environmentId);
  appAtomRegistry.set(pendingLinksAtom, remaining);
}

/** Carries out `linkOnConnect` choices as their connections come up. */
export function LinkOnConnectCoordinator() {
  const pending = useAtomValue(pendingLinksAtom);
  const { environments } = useEnvironments();
  const ready = environments.filter(
    (environment) =>
      pending.has(environment.environmentId) &&
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null,
  );
  const link = useEffectEvent(() => {
    if (ready.length === 0) return;
    const remaining = new Map(pending);
    for (const environment of ready) {
      const choice = pending.get(environment.environmentId);
      remaining.delete(environment.environmentId);
      const [report] = appConnectionReports([environment]);
      if (choice === undefined || report === undefined) continue;
      if (report.keepsLinkLimits === false) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `${report.label} was added but not linked`,
            description: `${report.label}${report.serverVersion === null ? "" : ` ${report.serverVersion}`} is too old to link, so agents cannot work there. Update it, then link it from Linked environments.`,
          }),
        );
        continue;
      }
      for (const host of choice.hosts) {
        void linkFromThisApp(host, report, choice.access).then((failure) =>
          toastManager.add(
            failure === null
              ? { type: "success", title: `Linked ${report.label} for agents` }
              : stackedThreadToast({
                  type: "error",
                  title: `${report.label} was added but not linked`,
                  description: failure,
                }),
          ),
        );
      }
    }
    appAtomRegistry.set(pendingLinksAtom, remaining);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links a machine on another server once its connection here comes up
  useEffect(() => link(), [ready.map((environment) => environment.environmentId).join("\n")]);
  return null;
}
