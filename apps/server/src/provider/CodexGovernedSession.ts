import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { makeCodexSessionObservation } from "./CodexSessionObservation.ts";
import type { CodexSkillConsumer, CodexSkillTurn } from "./CodexSkillConsumer.ts";
import type { CurrentSkillRequest } from "./CurrentSkillRequest.ts";

const encodeConversation = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const processes = new WeakMap<
  object,
  { readonly pid: number; readonly version: string; readonly generation: string }
>();
// Only the factory holding the spawned child records this in server memory.
export const recordCodexProcess = (
  client: object,
  process: { readonly pid: number; readonly version: string; readonly generation: string },
) => processes.set(client, Object.freeze(process));

/** The supported child registration forms, shared by ingress and registration. */
export function codexChildReader(item: unknown, root: string): boolean {
  if (!Predicate.isObject(item)) return false;
  if (item.type === "collabAgentToolCall")
    return (
      item.tool === "spawnAgent" &&
      Array.isArray(item.receiverThreadIds) &&
      item.receiverThreadIds.some((id) => typeof id === "string" && id !== root)
    );
  if (item.type !== "subAgentActivity" || item.kind !== "started" || item.agentThreadId === root)
    return false;
  const path = typeof item.agentPath === "string" ? item.agentPath.replace(/\/+$/, "") : null;
  return path !== "" && path !== "/root";
}

export const makeCodexGovernedSession = Effect.fn("makeCodexGovernedSession")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly lifetime: Scope.Closeable;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly consume: CodexSkillConsumer;
}) {
  const process = processes.get(input.client);
  const refuse = (message: string) =>
    CodexErrors.CodexAppServerRequestError.internalError(message, "turn/start");
  if (!process)
    return yield* refuse("Governed launch has no owned provider process/version observation.");
  const observation = makeCodexSessionObservation({
    threadId: input.threadId,
    providerInstanceId: input.instanceId,
    pid: process.pid,
    processGeneration: process.generation,
  });
  const lock = yield* Semaphore.make(1);
  let childReaders = false;
  let active = false;
  let uncertain = false;
  let retained: Scope.Closeable | undefined;
  const commands = new Set<string>();
  const consumed = new Set<string>();
  const rootTurns = new Map<string, string | undefined>();
  const ready = Effect.gen(function* () {
    const current = yield* observation.reader.read;
    if (
      active ||
      childReaders ||
      commands.size > 0 ||
      uncertain ||
      current.closed ||
      (current.initialized && current.invalidated !== null)
    )
      return yield* refuse(
        "Governed route revocation, native readers or uncertain work require a session restart.",
      );
  });
  const observe = (method: string, payload: unknown) => {
    if (!Predicate.isObject(payload)) return;
    if (method === "account/updated") {
      observation.invalidate("account-changed");
      return;
    }
    if (method === "thread/closed" && payload.threadId === currentRoot) {
      observation.invalidate("thread-closed");
      return;
    }
    if (method === "thread/settings/updated" || method === "model/rerouted") {
      if (payload.threadId === currentRoot) observation.invalidate("model-or-route-changed");
      return;
    }
    if (method === "thread/started" && Predicate.isObject(payload.thread)) {
      const thread = payload.thread;
      const source =
        Predicate.isObject(thread.source) &&
        Predicate.isObject(thread.source.subAgent) &&
        Predicate.isObject(thread.source.subAgent.thread_spawn)
          ? thread.source.subAgent.thread_spawn
          : undefined;
      const parent = thread.parentThreadId ?? source?.parent_thread_id;
      if (
        typeof thread.id === "string" &&
        !rootTurns.has(thread.id) &&
        typeof parent === "string" &&
        rootTurns.has(parent)
      )
        childReaders = true;
    }
    const knownRoot = typeof payload.threadId === "string" && rootTurns.has(payload.threadId);
    if (
      knownRoot &&
      (rootTurns.get(payload.threadId as string) === payload.turnId ||
        (payload.threadId === currentRoot && active)) &&
      (method === "item/started" || method === "item/completed") &&
      codexChildReader(payload.item, payload.threadId as string)
    )
      childReaders = true;
    if (payload.threadId !== currentRoot) return;
    if (
      (method === "item/started" || method === "item/completed") &&
      Predicate.isObject(payload.item)
    ) {
      if (codexChildReader(payload.item, currentRoot)) childReaders = true;
      if (payload.item.type === "commandExecution" && typeof payload.item.id === "string") {
        if (method === "item/started") commands.add(payload.item.id);
        else commands.delete(payload.item.id);
      }
    }
    if (
      (method === "turn/started" || method === "turn/completed") &&
      Predicate.isObject(payload.turn) &&
      typeof payload.turn.id === "string"
    ) {
      observation.lifecycle(currentRoot, payload.turn.id);
      if (method === "turn/completed") active = false;
    }
  };
  let currentRoot = "";
  return {
    observation,
    observe,
    initialized: () => observation.initialized(),
    opened: (threadId: string, model: string | null) => {
      currentRoot = threadId;
      rootTurns.set(threadId, undefined);
      observation.opened(threadId, model, false);
    },
    acknowledged: (generation: number, turnId: string) => {
      rootTurns.set(currentRoot, turnId);
      observation.acknowledgedTurn(generation, turnId);
    },
    prepare: <A, E, R, E2, R2>(request: {
      readonly current: CurrentSkillRequest | undefined;
      readonly model: string;
      readonly cwd: string;
      readonly fresh: Effect.Effect<void, E, R>;
      readonly submit: (
        selection: CodexSkillTurn,
        conversation: string,
        commit: Effect.Effect<void, CodexErrors.CodexAppServerError>,
      ) => Effect.Effect<A, E2, R2>;
    }) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* ready;
          if (!request.current)
            return yield* refuse(
              "Current server message provenance is required for governed input.",
            );
          if (consumed.has(request.current.messageId))
            return yield* refuse("Governed requests cannot be replayed.");
          const current = request.current;
          consumed.add(current.messageId);
          const messages = yield* current.conversation.pipe(
            Effect.mapError(() => refuse("Visible conversation could not be read.")),
          );
          const boundary = messages.findIndex((m) => m.id === current.messageId);
          if (boundary < 0)
            return yield* refuse(
              "Current message is absent from the visible conversation projection.",
            );
          const conversation = yield* encodeConversation(
            messages
              .slice(0, boundary)
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map(({ role, text }) => ({ role, text })),
          ).pipe(Effect.mapError(() => refuse("Visible conversation could not be encoded.")));
          yield* request.fresh;
          yield* ready;
          const account = yield* input.client.request("account/read", { refreshToken: false });
          const email = account.account?.type === "chatgpt" ? account.account.email : null;
          const before = yield* observation.reader.read;
          if (before.invalidated)
            return yield* refuse("Native route is invalidated; fresh qualification is required.");
          const candidates = yield* Scope.make();
          yield* Scope.addFinalizer(input.lifetime, Scope.close(candidates, Exit.void));
          let exposed = false;
          return yield* Effect.gen(function* () {
            const selected = yield* input
              .consume({
                observation: before,
                accountEmail: email,
                model: request.model,
                cwd: request.cwd,
                harnessVersion: process.version,
                request: current,
              })
              .pipe(Effect.provideService(Scope.Scope, candidates));
            yield* ready;
            if ((yield* observation.reader.read).revision !== before.revision)
              return yield* refuse("Native route changed during Skill resolution.");
            yield* input.client.request("skills/extraRoots/set", { extraRoots: [] });
            yield* ready;
            exposed = true;
            yield* input.client.request("skills/extraRoots/set", {
              extraRoots: [selected.discoveryRoot],
            });
            yield* ready;
            const commit = Effect.gen(function* () {
              const finalAccount = yield* input.client.request("account/read", {
                refreshToken: false,
              });
              yield* ready;
              if (
                (finalAccount.account?.type === "chatgpt" ? finalAccount.account.email : null) !==
                email
              )
                return yield* refuse("Account changed during governed Skill resolution.");
              if ((yield* observation.reader.read).revision !== before.revision)
                return yield* refuse("Native route changed before governed submission.");
              // Sequential retirement commit: later events refuse submission but cannot
              // undo an unlink already issued. This is not an atomic future-reader lease.
              if (retained) {
                yield* ready;
                yield* Scope.close(retained, Exit.void);
                retained = undefined;
              }
              yield* ready;
              if ((yield* observation.reader.read).revision !== before.revision)
                return yield* refuse("Native route changed during governed input retirement.");
              retained = candidates;
              active = true;
            });
            return yield* request.submit(selected, conversation, commit);
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void;
              if (exposed) {
                uncertain = true;
                return Effect.void;
              }
              return Scope.close(candidates, exit);
            }),
          );
        }),
      ),
  };
});
