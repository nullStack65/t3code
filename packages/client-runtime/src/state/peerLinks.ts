import { type EnvironmentId, type PeerLinkSummary, WS_METHODS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPeerLinkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:list",
    tag: WS_METHODS.peerLinksList,
    // Listing probes every linked environment, so a list stays fresh briefly.
    staleTimeMs: 10_000,
  });
  // The links and the app connections together; Settings and the sidebar read it.
  const environments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:environments",
    tag: WS_METHODS.peerLinksEnvironments,
    staleTimeMs: 10_000,
  });
  const linkedSidebar = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:linked-sidebar",
    tag: WS_METHODS.peerLinksLinkedSidebar,
    staleTimeMs: 10_000,
  });
  const refreshLists = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: {} }));
      registry.refresh(environments({ environmentId, input: {} }));
    });
  return {
    list,
    environments,
    linkedSidebar,
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:link",
      tag: WS_METHODS.peerLinksLink,
      onSuccess: ({ environmentId }, registry) => refreshLists(environmentId, registry),
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:unlink",
      tag: WS_METHODS.peerLinksUnlink,
      onSuccess: ({ environmentId }, registry) => refreshLists(environmentId, registry),
    }),
    /** A pairing credential the linked environment mints, for adding it to this app. */
    addToApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:add-to-app",
      tag: WS_METHODS.peerLinksAddToApp,
    }),
    /** Tells the environment which connections this app holds, never their credentials. */
    reportAppConnections: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:report-app-connections",
      tag: WS_METHODS.peerLinksReportAppConnections,
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(environments({ environmentId, input: {} }))),
    }),
    // An agent's link card. One answer per card at a time.
    answerRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:answer-request",
      tag: WS_METHODS.peerLinksAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
      onSuccess: ({ environmentId }, registry) => refreshLists(environmentId, registry),
    }),
  };
}

const EXPIRY_WARNING_DAYS = 5;

export type PeerLinkHealth =
  | { readonly kind: "reachable"; readonly expiresInDays: number | null }
  | { readonly kind: "unreachable"; readonly detail: string | null }
  | { readonly kind: "failing"; readonly detail: string }
  | { readonly kind: "expired" };

/**
 * Listing only checks that the peer answers, so a link whose last call failed
 * (the peer revoked it, say) is `failing` with the recorded reason; the next
 * successful call clears it.
 */
export function peerLinkHealth(link: PeerLinkSummary, now: DateTime.Utc): PeerLinkHealth {
  if (link.status === "expired" || DateTime.isLessThanOrEqualTo(link.expiresAt, now)) {
    return { kind: "expired" };
  }
  if (link.status === "unreachable") return { kind: "unreachable", detail: link.lastError };
  if (link.lastError !== null) return { kind: "failing", detail: link.lastError };
  const days = Math.ceil(Duration.toDays(DateTime.distance(now, link.expiresAt)));
  return { kind: "reachable", expiresInDays: days <= EXPIRY_WARNING_DAYS ? days : null };
}
