import { useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { environmentSession } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import {
  founderInboxLane,
  compositeThreadKey,
  defaultFounderInboxView,
  inboxIdentityFromSubject,
  canReadInbox,
  type Founder,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useThreadShells, readEnvironmentSupportsInbox } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { isElectron } from "../env";

/** A projection over native linked environments; every link retains its destination identity. */
export function FounderInbox() {
  const allThreads = useThreadShells();
  const { environments } = useEnvironments();
  const subjectsAtom = useMemo(
    () =>
      Atom.make((get) =>
        environments.map((environment) => {
          const state = get(environmentSession.sessionStateAtom(environment.environmentId));
          const session = Option.getOrNull(AsyncResult.value(state));
          return {
            environmentId: environment.environmentId,
            subject: session?.authenticated ? (session.subject ?? null) : null,
          };
        }),
      ),
    [environments],
  );
  const sessions = useAtomValue(subjectsAtom);
  const subjects = sessions.flatMap((session) =>
    session.subject === null ? [] : [session.subject],
  );
  const threads = allThreads.filter((thread) => {
    const subject = sessions.find(
      (session) => session.environmentId === thread.environmentId,
    )?.subject;
    if (subject === null || subject === undefined) return false;
    const identity = inboxIdentityFromSubject(subject);
    return identity === null || canReadInbox(identity, thread.inbox);
  });
  const identityKey = JSON.stringify(sessions);
  const [selection, setSelection] = useState<{
    identityKey: string;
    view: Founder | "operations";
  } | null>(null);
  const view =
    selection?.identityKey === identityKey ? selection.view : defaultFounderInboxView(subjects);
  const setView = (next: Founder | "operations") => setSelection({ identityKey, view: next });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const lanes = view === "operations" ? ["operations"] : ["action", "FYI"];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Personal inbox</h1>
      </WorkspacePageHeader>
      <main className="flex-1 overflow-auto p-5">
        <nav aria-label="Inbox view" className="mb-6 flex gap-2">
          {(["kameron", "jeff", "operations"] as const).map((value) => (
            <Button
              key={value}
              variant={view === value ? "default" : "outline"}
              size="sm"
              onClick={() => setView(value)}
            >
              {value === "kameron" ? "Kameron" : value === "jeff" ? "Jeff" : "Operations"}
            </Button>
          ))}
        </nav>
        {lanes.map((lane) => {
          const visible = threads.filter(
            (thread) =>
              view === "operations" ||
              (thread.archivedAt === null &&
                thread.settledAt === null &&
                founderInboxLane(thread.inbox, view) === lane),
          );
          return (
            <section key={lane} className="mb-8 max-w-3xl">
              <h2 className="mb-3 text-sm font-medium">
                {lane === "action"
                  ? "Needs you"
                  : lane === "FYI"
                    ? "For your information"
                    : "Authorized threads"}{" "}
                · {visible.length}
              </h2>
              {visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing here.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {visible.map((thread) => (
                    <li key={compositeThreadKey(thread.environmentId, thread.id)} className="py-3">
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams({
                          environmentId: thread.environmentId,
                          threadId: thread.id,
                        })}
                        className="text-sm font-medium hover:underline"
                      >
                        {thread.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {environments.find(
                          (environment) => environment.environmentId === thread.environmentId,
                        )?.label ?? thread.environmentId}
                        {view === "operations"
                          ? ` · ${thread.inbox?.audience ?? "Unknown legacy ownership"} · ${thread.inbox?.attentionKind ?? "unclassified"}`
                          : ""}
                      </p>
                      {thread.inbox && readEnvironmentSupportsInbox(thread.environmentId) && (
                        <div className="mt-2 flex gap-2 text-xs">
                          <label>
                            Assign to{" "}
                            <select
                              aria-label={`Assign ${thread.title}`}
                              value={
                                thread.inbox.assignee.kind === "human"
                                  ? thread.inbox.assignee.id
                                  : "agent"
                              }
                              onChange={(event) => {
                                const id = event.target.value;
                                if (id !== "kameron" && id !== "jeff") return;
                                void updateMetadata({
                                  environmentId: thread.environmentId,
                                  input: {
                                    threadId: thread.id,
                                    inboxRouting: {
                                      ...thread.inbox!,
                                      assignee: { kind: "human", id },
                                    },
                                  },
                                });
                              }}
                            >
                              <option value="kameron">Kameron</option>
                              <option value="jeff">Jeff</option>
                              <option value="agent" disabled>
                                Agent
                              </option>
                            </select>
                          </label>
                          <label>
                            Attention{" "}
                            <select
                              aria-label={`Attention for ${thread.title}`}
                              value={thread.inbox.attentionKind}
                              onChange={(event) => {
                                const attentionKind = event.target.value;
                                if (
                                  attentionKind !== "action" &&
                                  attentionKind !== "FYI" &&
                                  attentionKind !== "background"
                                )
                                  return;
                                void updateMetadata({
                                  environmentId: thread.environmentId,
                                  input: {
                                    threadId: thread.id,
                                    inboxRouting: { ...thread.inbox!, attentionKind },
                                  },
                                });
                              }}
                            >
                              <option value="action">Needs you</option>
                              <option value="FYI">FYI</option>
                              <option value="background">Background</option>
                            </select>
                          </label>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        <p className="max-w-3xl text-xs text-muted-foreground">
          Views show only what each connected server authorizes. Unclassified history stays in
          Operations. Servers without inbox support require an upgrade before they can classify
          threads.
        </p>
      </main>
    </SidebarInset>
  );
}
