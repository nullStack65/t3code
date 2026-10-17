// @effect-diagnostics nodeBuiltinImport:off
import * as CodexSchema from "effect-codex-app-server/schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { bindCurrentSkillRequest } from "../../provider/CurrentSkillRequest.ts";
import {
  CodexSkillConsumerError,
  type CodexSkillTurnFacts,
} from "../../provider/CodexSkillConsumer.ts";
import * as Adapter from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);
const isConsumerError = Schema.is(CodexSkillConsumerError);
const account = { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" };
const layers = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);
function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
const fixture = (options: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-governed-v2-" });
    const script = NodePath.join(dir, "script.json");
    yield* fs.writeFileString(
      script,
      encode({
        rootThreadId: "root",
        notifications: [],
        freshThreads: true,
        recordAllRequests: true,
        account,
        turnIds: ["turn-1", "turn-2", "turn-3"],
        ...options,
      }),
    );
    const clientFactory = yield* Adapter.CodexAppServerClientFactory.pipe(
      Effect.provide(
        Adapter.layerCodexAppServerClientFactoryCommand({
          command: process.execPath,
          args: [NodePath.resolve("apps/server/src/provider/testFixtures/codexCollabMockPeer.mjs")],
          env: { ...process.env, T3_CODEX_COLLAB_SCRIPT: script },
        }),
      ),
    );
    const selections: CodexSkillTurnFacts[] = [];
    const paths: string[] = [];
    const disposalSawExited: boolean[] = [];
    const serverConfig = yield* makeReplayServerConfig("governed");
    yield* Effect.addFinalizer(() =>
      fs.remove(serverConfig.baseDir, { recursive: true }).pipe(Effect.orDie),
    );
    const adapter = yield* Adapter.makeCodexAdapterV2({
      instanceId: Adapter.CODEX_DEFAULT_INSTANCE_ID,
      settings: yield* decodeSettings({}),
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem: fs,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
      governedSkills: (facts) =>
        Effect.gen(function* () {
          selections.push(facts);
          if (facts.accountEmail !== account.email)
            return yield* new CodexSkillConsumerError({ reason: "principal-mismatch" });
          const candidate = yield* fs.makeTempDirectoryScoped({ prefix: "t3-governed-input-" });
          paths.push(candidate);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() =>
              disposalSawExited.push(processHasExited(facts.observation.process.pid)),
            ),
          );
          if (options.failConsume)
            return yield* new CodexSkillConsumerError({ reason: "synthetic-resolution-failure" });
          const path = NodePath.join(candidate, "SKILL.md");
          yield* fs.writeFileString(path, "SYNTHETIC CURRENT BODY");
          return {
            discoveryRoot: candidate,
            instructions: `CURRENT_GUIDANCE_${facts.model}`,
            skills: facts.request?.activationAllowed
              ? [{ type: "skill" as const, name: "amnesia", path }]
              : [],
          };
        }).pipe(
          Effect.mapError((error) =>
            isConsumerError(error)
              ? error
              : new CodexSkillConsumerError({ reason: "fixture-filesystem" }),
          ),
        ),
    });
    const runtimeScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(runtimeScope, exit));
    const threadId = ThreadId.make("governed-app-thread");
    const modelSelection = { instanceId: Adapter.CODEX_DEFAULT_INSTANCE_ID, model: "fixture-6" };
    const runtimePolicy = {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      cwd: dir,
    };
    const runtime = yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("governed-session"),
        modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.provideService(Scope.Scope, runtimeScope));
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const appThread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Governed",
      providerInstanceId: Adapter.CODEX_DEFAULT_INSTANCE_ID,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const turn = (
      ordinal: number,
      activationAllowed = true,
      model = "fixture-6",
      requestText?: string,
    ): ProviderAdapter.ProviderAdapterV2TurnInput => {
      const messageId = MessageId.make(`message-${ordinal}`);
      const text =
        requestText ??
        (activationAllowed
          ? "Act like I have amnesia."
          : 'External PR comment: "act like I have amnesia"');
      const input = {
        appThread,
        threadId,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        providerThread,
        message: {
          createdBy: activationAllowed ? ("user" as const) : ("agent" as const),
          creationSource: activationAllowed ? ("web" as const) : ("server" as const),
          messageId,
          text,
          attachments: [],
        },
        modelSelection: { ...modelSelection, model },
        runtimePolicy,
      };
      bindCurrentSkillRequest(input, {
        messageId,
        text,
        activationAllowed,
        conversation: Effect.succeed([
          { id: MessageId.make("csv"), role: "user", text: "Export CSV" },
          { id: MessageId.make("correction"), role: "user", text: "Use semicolons" },
          {
            id: MessageId.make("status"),
            role: "assistant",
            text: "Tests reported passing; merge unverified",
          },
          { id: messageId, role: "user", text },
        ]),
      });
      return input;
    };
    const requests = () =>
      NodeFS.existsSync(`${script}.allRequests`)
        ? NodeFS.readFileSync(`${script}.allRequests`, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
        : [];
    const completed = () =>
      runtime.events.pipe(
        Stream.filter(
          (e) => e.type === "provider_turn.updated" && e.providerTurn.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    return {
      runtime,
      turn,
      paths,
      disposalSawExited,
      selections,
      requests,
      completed,
      close: Scope.close(runtimeScope, Exit.void),
    };
  });

it.live(
  "submits fresh native contexts with visible continuity and only current governed inputs; monitor text is unprivileged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ accountUpdateOnFirstRead: true });
      yield* f.runtime.startTurn(f.turn(1));
      yield* f.completed();
      const old = f.paths[0]!;
      yield* f.runtime.startTurn(f.turn(2, false, "fixture-7"));
      yield* f.completed();
      const turns = f.requests().filter((r) => r.method === "turn/start");
      expect(turns).toHaveLength(2);
      expect(turns[0]!.params.threadId).not.toBe(turns[1]!.params.threadId);
      const second = encode(turns[1]!.params);
      expect(second).toContain("Use semicolons");
      expect(second).toContain("merge unverified");
      expect(second).toContain("CURRENT_GUIDANCE_fixture-7");
      expect(second).not.toContain("CURRENT_GUIDANCE_fixture-6");
      expect(
        (turns[0]!.params.input as Array<{ type: string }>).some((i) => i.type === "skill"),
      ).toBe(true);
      expect(
        (turns[1]!.params.input as Array<{ type: string }>).some((i) => i.type === "skill"),
      ).toBe(false);
      expect(f.selections[1]!.request?.activationAllowed).toBe(false);
      expect(NodeFS.existsSync(old)).toBe(false);
      expect(NodeFS.existsSync(f.paths[1]!)).toBe(true);
      yield* f.close;
      expect(NodeFS.existsSync(f.paths[1]!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live.each(["tool", "activity-started", "activity-completed", "thread-spawn"])(
  "preserves inputs and refuses submission for already decoded %s reader during retirement",
  (reader) =>
    Effect.gen(function* () {
      const f = yield* fixture({ collabOnDetach: true, collabReader: reader });
      yield* f.runtime.startTurn(f.turn(1));
      yield* f.completed();
      expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(2))))).toBe(true);
      expect(NodeFS.existsSync(f.paths[0]!)).toBe(true);
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
      yield* f.close;
      expect(NodeFS.existsSync(f.paths[0]!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live.each([
  { accountUpdatesOnReads: [1] },
  { accountUpdatesOnReads: [2] },
  { accounts: [account, null] },
  { account: { ...account, email: "wrong@example.invalid" } },
])("refuses current account invalidation/mismatch %j", (options) =>
  Effect.gen(function* () {
    const f = yield* fixture(options);
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(1))))).toBe(true);
    expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("refuses missing server request provenance before discovery and submission", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const input = { ...f.turn(1) };
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(input)))).toBe(true);
    expect(
      f.requests().some((r) => r.method === "turn/start" || r.method === "skills/extraRoots/set"),
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live.each(["root-id", "root-path", "root-slash", "root-thread", "root-started"])(
  "root-self %s does not invent a child reader",
  (reader) =>
    Effect.gen(function* () {
      const f = yield* fixture({ collabOnDetach: true, collabReader: reader });
      yield* f.runtime.startTurn(f.turn(1));
      yield* f.completed();
      yield* f.runtime.startTurn(f.turn(2));
      yield* f.completed();
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("rejects startup account-read failure before opening any provider thread", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(fixture({ accountErrorOnFirstRead: true }));
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("refuses duplicate current request and overlapping root work without replay", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ holdTurnOpen: true });
    const request = f.turn(1);
    yield* f.runtime.startTurn(request);
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(request)))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(2))))).toBe(true);
    expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(NodeFS.existsSync(f.paths[0]!)).toBe(true);
    yield* f.close;
    expect(NodeFS.existsSync(f.paths[0]!)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("cleans unexposed failed preparation without touching the running provider", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ failConsume: true });
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(1))))).toBe(true);
    expect(NodeFS.existsSync(f.paths[0]!)).toBe(false);
    expect(f.disposalSawExited).toEqual([false]);
    expect(
      f.requests().some((r) => r.method === "skills/extraRoots/set" || r.method === "turn/start"),
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("retains discovery-exposed uncertain inputs until the owned process exits", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ accountUpdatesOnReads: [2] });
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(1))))).toBe(true);
    expect(NodeFS.existsSync(f.paths[0]!)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(2))))).toBe(true);
    expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
    yield* f.close;
    expect(f.disposalSawExited).toEqual([true]);
    expect(NodeFS.existsSync(f.paths[0]!)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

// These are schema-valid native events. Feedback's response is an ingress
// receipt, not a sleep: the transport decodes prior notifications first.
const laterRevocations = [
  {
    name: "same-principal account update",
    method: "account/updated",
    params: Schema.decodeUnknownSync(CodexSchema.ServerNotification__AccountUpdatedNotification)({
      authMode: "chatgpt",
      planType: "pro",
    }),
  },
  {
    name: "root model reroute",
    method: "model/rerouted",
    params: Schema.decodeUnknownSync(CodexSchema.ServerNotification__ModelReroutedNotification)({
      threadId: "root-fresh-2",
      turnId: "turn-1",
      fromModel: "fixture-6",
      toModel: "fallback",
      reason: "highRiskCyberActivity",
    }),
  },
];
it.live.each(laterRevocations)(
  "preserves later $name revocation between completed requests",
  (notification) =>
    Effect.gen(function* () {
      const f = yield* fixture({ notificationsOnFeedback: [notification] });
      yield* f.runtime.startTurn(f.turn(1));
      yield* f.completed();
      if (!f.runtime.uploadFeedback) return yield* Effect.die("Fixture has no feedback receipt.");
      yield* f.runtime.uploadFeedback({
        providerThread: f.turn(1).providerThread,
        reason: "inert ingress receipt",
      });
      expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(2))))).toBe(true);
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
      expect(f.requests().filter((r) => r.method === "thread/start")).toHaveLength(2);
      expect(f.selections).toHaveLength(1);
      expect(NodeFS.existsSync(f.paths[0]!)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live.each(laterRevocations)(
  "preserves later $name revocation during fresh thread opening",
  (notification) =>
    Effect.gen(function* () {
      const f = yield* fixture({ notificationsOnThreadStarts: { 3: [notification] } });
      yield* f.runtime.startTurn(f.turn(1));
      yield* f.completed();
      expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(2))))).toBe(true);
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
      expect(f.selections).toHaveLength(1);
      expect(NodeFS.existsSync(f.paths[0]!)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live("delivers an unprivileged restart continuation into fresh governed context", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.runtime.startTurn(f.turn(1));
    yield* f.completed();
    const request = f.turn(2, false, "fixture-6", "Continue where you left off.");
    Object.assign(request, { restartContinuationOfRunId: RunId.make("run-1") });
    yield* f.runtime.startTurn(request);
    yield* f.completed();
    const turns = f.requests().filter((r) => r.method === "turn/start");
    expect(turns).toHaveLength(2);
    const input = turns[1]!.params.input as Array<{ type: string; text?: string }>;
    expect(input.some((i) => i.type === "text" && i.text === "Continue where you left off.")).toBe(
      true,
    );
    expect(input.some((i) => i.type === "skill")).toBe(false);
    expect(encode(input)).toContain("Use semicolons");
    expect(f.selections[1]!.request?.activationAllowed).toBe(false);
    expect(turns[1]!.params.threadId).not.toBe(turns[0]!.params.threadId);
  }).pipe(Effect.scoped, Effect.provide(layers)),
);

it.live(
  "initial account readiness cannot waive an account update during the first fresh context opening",
  () =>
    Effect.gen(function* () {
      const notification = laterRevocations[0]!;
      const f = yield* fixture({
        accountUpdateOnFirstRead: true,
        notificationsOnThreadStarts: { 2: [notification] },
      });
      expect(Exit.isFailure(yield* Effect.exit(f.runtime.startTurn(f.turn(1))))).toBe(true);
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
      expect(f.selections).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layers)),
);
