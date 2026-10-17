// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CodexSkillConsumerError } from "../CodexSkillConsumer.ts";
import type { CodexSkillTurnFacts } from "../CodexSkillConsumer.ts";
import { selectsCurrentSkill } from "../CodexSkillConsumer.ts";
import {
  bindCurrentSkillRequest,
  carryCurrentSkillRequest,
  currentSkillRequest,
} from "../CurrentSkillRequest.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const peer = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

it("current-message provenance survives native prompt assembly but cannot be imported from JSON", () => {
  const raw = {};
  const request = {
    messageId: MessageId.make("current"),
    text: "Actual current request",
    activationAllowed: true,
    conversation: Effect.succeed([]),
  };
  bindCurrentSkillRequest(raw, request);
  const assembled = { input: "Expanded composer/history text" };
  carryCurrentSkillRequest(raw, assembled);
  expect(currentSkillRequest(assembled)?.text).toBe(request.text);
  expect(currentSkillRequest({ ...assembled, currentRequest: request })).toBeUndefined();
});

it.effect(
  "fresh governed threads keep visible CSV corrections while old patch input and resume are absent",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-governed-runtime-" });
      const script = NodePath.join(directory, "script.json");
      yield* fs.writeFileString(
        script,
        encode({
          rootThreadId: "synthetic-root",
          freshThreads: true,
          recordAllRequests: true,
          notifications: [],
          turnIds: ["turn-1", "turn-2", "turn-3"],
          account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
        }),
      );
      const observed: CodexSkillTurnFacts[] = [];
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("synthetic-t3-thread"),
        providerInstanceId: ProviderInstanceId.make("synthetic-governed"),
        binaryPath: peer,
        cwd: directory,
        runtimeMode: "full-access",
        model: "fixture-6",
        resumeCursor: { threadId: "OLD_PATCH_PROVIDER_CONTEXT" },
        environment: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          HOME: directory,
          USERPROFILE: directory,
          CODEX_HOME: directory,
          T3_CODEX_COLLAB_SCRIPT: script,
        },
        governedSkills: (facts) =>
          Effect.sync(() => {
            observed.push(facts);
            return {
              discoveryRoot: directory,
              instructions:
                facts.model === "fixture-6"
                  ? "CURRENT_GENERATION_AGENTS"
                  : "CURRENT_AGENTS_WITHOUT_OLD_PATCH",
              skills: [
                ...(facts.model === "fixture-6"
                  ? [
                      {
                        type: "skill" as const,
                        name: "fix",
                        path: NodePath.join(directory, "patches/fix/SKILL.md"),
                      },
                    ]
                  : []),
                ...(facts.request?.activationAllowed &&
                selectsCurrentSkill(
                  facts.request.text,
                  "durable-app",
                  'Use for "act like I have amnesia".',
                )
                  ? [
                      {
                        type: "skill" as const,
                        name: "durable-app",
                        path: NodePath.join(directory, "request/durable-app/SKILL.md"),
                      },
                    ]
                  : []),
              ],
            };
          }),
      });
      yield* runtime.start();
      expect(
        yield* Effect.flip(runtime.sendTurn({ input: "No current server message provenance" })),
      ).toMatchObject({ _tag: "CodexAppServerRequestError" });
      const history = [
        { id: MessageId.make("csv"), role: "user", text: "Export the report as CSV." },
        { id: MessageId.make("correction"), role: "user", text: "Use semicolons, not commas." },
        {
          id: MessageId.make("report"),
          role: "assistant",
          text: "Tests reported passing; merge status unverified.",
        },
        { id: MessageId.make("hidden"), role: "developer", text: "OLD_HIDDEN_PATCH_FRAME" },
      ];
      for (const [index, model, text] of [
        [1, "fixture-6", "Implement the export."],
        [2, "fixture-7", "Act like I have amnesia. What is this chat?"],
        [3, "unknown-selected-model", 'Explain the imperative in "act like I have amnesia".'],
      ] as const) {
        const messageId = MessageId.make(`current-${index}`);
        const done = yield* Stream.runHead(
          runtime.events.pipe(Stream.filter((e) => e.method === "turn/completed")),
        ).pipe(Effect.forkScoped);
        yield* runtime.sendTurn({
          model,
          input: text,
          currentRequest: {
            messageId,
            text,
            activationAllowed: true,
            conversation: Effect.succeed([...history, { id: messageId, role: "user", text }]),
          },
        });
        yield* Fiber.join(done);
      }
      const lines = NodeFS.readFileSync(script + ".allRequests", "utf8")
        .trim()
        .split("\n")
        .map((line) => decode(line));
      const requests = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
        ),
      )(lines);
      expect(requests.some((r) => r.method === "thread/resume")).toBe(false);
      const turns = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            params: Schema.Struct({ threadId: Schema.String, input: Schema.Array(Schema.Unknown) }),
          }),
        ),
      )(requests.filter((r) => r.method === "turn/start"));
      expect(new Set(turns.map((t) => t.params.threadId)).size).toBe(3);
      const first = encode(turns[0]?.params.input),
        next = encode(turns[1]?.params.input),
        quoted = encode(turns[2]?.params.input);
      expect(first).toContain("patches/fix/SKILL.md");
      expect(next).not.toContain("patches/fix/SKILL.md");
      expect(next).not.toContain("CURRENT_GENERATION_AGENTS");
      expect(next).not.toContain("OLD_HIDDEN_PATCH_FRAME");
      for (const fact of [
        "Export the report as CSV",
        "Use semicolons",
        "Tests reported passing; merge status unverified",
      ])
        expect(next).toContain(fact);
      expect(next).toContain("request/durable-app/SKILL.md");
      expect(quoted).not.toContain("request/durable-app/SKILL.md");
      expect(quoted).not.toContain("patches/fix/SKILL.md");
      expect(observed.map((f) => f.model)).toEqual([
        "fixture-6",
        "fixture-7",
        "unknown-selected-model",
      ]);
      expect(
        observed.every(
          (f) =>
            f.harnessVersion === "0.162.1" &&
            f.accountEmail === "fixture@example.invalid" &&
            f.observation.process.pid > 0,
        ),
      ).toBe(true);
      expect(
        yield* Effect.flip(
          runtime.sendTurn({
            input: "replayed",
            currentRequest: {
              messageId: MessageId.make("current-3"),
              text: "replayed",
              activationAllowed: true,
              conversation: Effect.succeed([]),
            },
          }),
        ),
      ).toMatchObject({ _tag: "CodexAppServerRequestError" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const change of ["model", "account", "silentAccount"] as const) {
  for (const ingress of ["resolution", "extraRoots"] as const) {
    it.live(`withholds native turn input after ${change} drift during ${ingress}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-governed-drift-" });
        const script = NodePath.join(directory, "script.json");
        const notification =
          change === "account"
            ? { method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } }
            : {
                method: "model/rerouted",
                params: {
                  threadId: "synthetic-drift-fresh-2",
                  turnId: "no-turn-yet",
                  fromModel: "fixture-6",
                  toModel: "fixture-7",
                  reason: "highRiskCyberActivity",
                },
              };
        yield* fs.writeFileString(
          script,
          encode({
            rootThreadId: "synthetic-drift",
            freshThreads: true,
            recordAllRequests: true,
            notifications: [],
            accounts: [
              { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
              {
                type: "chatgpt",
                email: change === "model" ? "fixture@example.invalid" : "other@example.invalid",
                planType: "pro",
              },
            ],
            notificationsOnFeedback:
              change !== "silentAccount" && ingress === "resolution" ? [notification] : [],
            notificationsOnExtraRoots:
              change !== "silentAccount" && ingress === "extraRoots" ? [notification] : [],
          }),
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("synthetic-drift"),
          binaryPath: peer,
          cwd: directory,
          runtimeMode: "approval-required",
          model: "fixture-6",
          environment: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            PATHEXT: process.env.PATHEXT,
            HOME: directory,
            USERPROFILE: directory,
            CODEX_HOME: directory,
            T3_CODEX_COLLAB_SCRIPT: script,
          },
          governedSkills: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return { discoveryRoot: directory, instructions: "OLD_PATCH_INPUT", skills: [] };
            }),
        });
        yield* runtime.start();
        const messageId = MessageId.make("current");
        const result = yield* runtime
          .sendTurn({
            input: "Current request",
            currentRequest: {
              messageId,
              text: "Current request",
              activationAllowed: true,
              conversation: Effect.succeed([
                { id: messageId, role: "user", text: "Current request" },
              ]),
            },
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (ingress === "resolution")
          yield* runtime.uploadFeedback("synthetic ingress receipt only");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(result)).toMatchObject({ _tag: "CodexAppServerRequestError" });
        const requests = NodeFS.readFileSync(script + ".allRequests", "utf8")
          .trim()
          .split("\n");
        expect(requests.some((line) => line.includes('"method":"turn/start"'))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
}

for (const mode of ["completed", "active", "failed", "cancelled", "uncertain"] as const) {
  it.live(`owns candidate files across ${mode} native request lifetime`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-governed-lifetime-" });
      const script = NodePath.join(directory, "script.json");
      yield* fs.writeFileString(
        script,
        encode({
          rootThreadId: "lifetime",
          freshThreads: true,
          notifications: [],
          holdTurnOpen: mode === "active" || mode === "uncertain",
          holdTurnStartResponse: mode === "uncertain",
        }),
      );
      const candidates: string[] = [];
      const prepared = yield* Deferred.make<void>();
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("lifetime"),
        binaryPath: peer,
        cwd: directory,
        runtimeMode: "approval-required",
        model: "fixture-6",
        environment: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          HOME: directory,
          USERPROFILE: directory,
          CODEX_HOME: directory,
          T3_CODEX_COLLAB_SCRIPT: script,
        },
        governedSkills: () =>
          Effect.gen(function* () {
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "owned-candidate-" });
            candidates.push(root);
            yield* fs.writeFileString(NodePath.join(root, "SKILL.md"), "ACTIVE_BODY");
            yield* Deferred.succeed(prepared, undefined);
            if (mode === "failed")
              return yield* new CodexSkillConsumerError({ reason: "synthetic-resolution-failure" });
            if (mode === "cancelled") return yield* Effect.never;
            return {
              discoveryRoot: root,
              instructions: "current",
              skills: [
                { type: "skill" as const, name: "fixture", path: NodePath.join(root, "SKILL.md") },
              ],
            };
          }).pipe(
            Effect.mapError((error) => new CodexSkillConsumerError({ reason: error.message })),
          ),
      });
      yield* runtime.start();
      const send = (index: number) => {
        const messageId = MessageId.make(`current-${index}`);
        return runtime.sendTurn({
          input: "Current request",
          currentRequest: {
            messageId,
            text: "Current request",
            activationAllowed: true,
            conversation: Effect.succeed([
              { id: messageId, role: "user", text: "Current request" },
            ]),
          },
        });
      };
      if (mode === "completed") {
        expect(yield* Effect.flip(runtime.compactThread)).toMatchObject({
          _tag: "CodexAppServerRequestError",
        });
        for (let index = 0; index < 4; index++) {
          const completed = yield* Stream.runHead(
            runtime.events.pipe(Stream.filter((e) => e.method === "turn/completed")),
          ).pipe(Effect.forkScoped);
          yield* send(index);
          yield* Fiber.join(completed);
          expect(candidates.filter((p) => NodeFS.existsSync(p))).toEqual([candidates[index]]);
        }
      } else if (mode === "active") {
        yield* send(0);
        expect(yield* Effect.flip(send(1))).toMatchObject({ _tag: "CodexAppServerRequestError" });
        expect(NodeFS.readFileSync(NodePath.join(candidates[0]!, "SKILL.md"), "utf8")).toBe(
          "ACTIVE_BODY",
        );
      } else if (mode === "failed") {
        expect(yield* Effect.flip(send(0))).toMatchObject({ _tag: "CodexAppServerRequestError" });
        expect(NodeFS.existsSync(candidates[0]!)).toBe(false);
      } else {
        const started = yield* Stream.runHead(
          runtime.events.pipe(Stream.filter((e) => e.method === "turn/started")),
        ).pipe(Effect.forkScoped);
        const pending = yield* send(0).pipe(Effect.forkScoped);
        if (mode === "uncertain") yield* Fiber.join(started);
        else yield* Deferred.await(prepared);
        yield* Fiber.interrupt(pending);
        expect(NodeFS.existsSync(candidates[0]!)).toBe(mode === "uncertain");
        if (mode === "uncertain")
          expect(yield* Effect.flip(send(1))).toMatchObject({ _tag: "CodexAppServerRequestError" });
      }
      yield* runtime.close;
      expect(candidates.some((p) => NodeFS.existsSync(p))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
