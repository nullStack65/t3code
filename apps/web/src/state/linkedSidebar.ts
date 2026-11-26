import { sidebarFromServerLinks } from "@t3tools/client-runtime/state/linked-sidebar";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, LinkedSidebarResult, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

export const linkedSidebarByHostAtom = Atom.make<ReadonlyMap<EnvironmentId, LinkedSidebarResult>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("linked-sidebar:by-host"));

const sameIdentity = (
  left: { readonly environmentId: EnvironmentId; readonly label: string },
  right: { readonly environmentId: EnvironmentId; readonly label: string },
) => left.environmentId === right.environmentId && left.label === right.label;

const sameProject = (left: EnvironmentProject, right: EnvironmentProject) =>
  left.environmentId === right.environmentId &&
  left.id === right.id &&
  left.title === right.title &&
  left.updatedAt === right.updatedAt;

const sameThread = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
  left.environmentId === right.environmentId &&
  left.id === right.id &&
  left.title === right.title &&
  left.updatedAt === right.updatedAt &&
  left.projectId === right.projectId &&
  left.settledOverride === right.settledOverride &&
  left.snoozedUntil === right.snoozedUntil &&
  left.runtime?.status === right.runtime?.status &&
  left.lastVisitedAt === right.lastVisitedAt &&
  left.standing?.name === right.standing?.name &&
  left.standing?.role === right.standing?.role &&
  left.standing?.avatarId === right.standing?.avatarId &&
  left.standing?.accent === right.standing?.accent &&
  left.latestRun?.completedAt === right.latestRun?.completedAt &&
  left.lineage.parentThreadId === right.lineage.parentThreadId &&
  left.lineage.relationshipToParent === right.lineage.relationshipToParent &&
  left.source.inbox?.owner === right.source.inbox?.owner &&
  left.source.inbox?.audience === right.source.inbox?.audience &&
  left.source.inbox?.attentionKind === right.source.inbox?.attentionKind;

const linkedSidebarSupplementAtom = Atom.make((get) => {
  const catalog = get(environmentSummaries.identitiesAtom).map(
    (identity) => identity.environmentId,
  );
  const environments = [...get(linkedSidebarByHostAtom).values()].flatMap(
    (result) => result.environments,
  );
  const next = sidebarFromServerLinks({ catalogEnvironmentIds: catalog, environments }, m);
  const previous = Option.getOrNull(get.self<ReturnType<typeof sidebarFromServerLinks>>());
  if (
    previous !== null &&
    previous.identities.length === next.identities.length &&
    previous.projects.length === next.projects.length &&
    previous.threads.length === next.threads.length &&
    previous.identities.every((identity, index) =>
      sameIdentity(identity, next.identities[index]!),
    ) &&
    previous.projects.every((project, index) => sameProject(project, next.projects[index]!)) &&
    previous.threads.every((thread, index) => sameThread(thread, next.threads[index]!))
  ) {
    return previous;
  }
  return next;
}).pipe(Atom.keepAlive, Atom.withLabel("linked-sidebar:supplement"));

const sidebarEnvironmentIdentitiesAtom = Atom.make((get) => {
  const catalog = get(environmentSummaries.identitiesAtom);
  const extra = get(linkedSidebarSupplementAtom).identities;
  const next = extra.length === 0 ? catalog : [...catalog, ...extra];
  const previous = Option.getOrNull(
    get.self<ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>>(),
  );
  return previous !== null &&
    previous.length === next.length &&
    next.every((identity, index) => sameIdentity(identity, previous[index]!))
    ? previous
    : next;
}).pipe(Atom.withLabel("linked-sidebar:identities"));

const sidebarProjectsAtom = Atom.make((get) => {
  const local = get(environmentProjects.projectsAtom);
  const extra = get(linkedSidebarSupplementAtom).projects;
  if (extra.length === 0) return local;
  const next = [...local, ...extra];
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentProject>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((project, index) => project === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("linked-sidebar:projects"));

const sidebarThreadShellsAtom = Atom.make((get) => {
  const local = get(environmentThreadShells.quietThreadShellsAtom);
  const extra = get(linkedSidebarSupplementAtom).threads;
  if (extra.length === 0) return local;
  const next = [...local, ...extra];
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentThreadShell>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((thread, index) => thread === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("linked-sidebar:threads"));

export function readLinkedSidebarThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return (
    appAtomRegistry
      .get(linkedSidebarSupplementAtom)
      .threads.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      ) ?? null
  );
}

export function linkedSidebarEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return appAtomRegistry
    .get(linkedSidebarSupplementAtom)
    .identities.map((identity) => identity.environmentId);
}

export function useLinkedOnlyEnvironment(environmentId: EnvironmentId | null) {
  const identities = useAtomValue(linkedSidebarSupplementAtom).identities;
  return environmentId === null
    ? null
    : (identities.find((identity) => identity.environmentId === environmentId) ?? null);
}

export function useSidebarEnvironmentIdentities() {
  return useAtomValue(sidebarEnvironmentIdentitiesAtom);
}

export function useSidebarProjects() {
  return useAtomValue(sidebarProjectsAtom);
}

export function useSidebarThreadShells() {
  return useAtomValue(sidebarThreadShellsAtom);
}
