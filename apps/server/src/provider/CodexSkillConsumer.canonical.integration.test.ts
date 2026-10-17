// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeCodexSessionObservation } from "./CodexSessionObservation.ts";
import { makeCodexSkillConsumer } from "./CodexSkillConsumer.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

// Cross-repository source qualification is explicitly opt-in. CI's standalone
// tests use the CLI contract stand-in; this executes the actual pinned resolver
// without vendoring its policy, copying credentials or starting a model.
const source = process.env.T3_CODEX_SKILL_SOURCE;
const commit = process.env.T3_CODEX_SKILL_SOURCE_COMMIT;
it.live.skipIf(!source || !commit)(
  "actual canonical runtime candidate reaches native Skill input for a current Amnesia request",
  () =>
    Effect.gen(function* () {
      expect(
        NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: source!,
          encoding: "utf8",
        }).trim(),
      ).toBe(commit);
      const consume = yield* makeCodexSkillConsumer({
        directory: source!,
        sourceCommit: commit!,
        pythonPath: "python3",
        provider: "codex",
        principal: {
          id: "kameron",
          emailSha256: NodeCrypto.createHash("sha256")
            .update("synthetic@example.invalid")
            .digest("hex"),
        },
        generations: {},
      });
      const observer = makeCodexSessionObservation({
        threadId: ThreadId.make("synthetic-canonical-protocol"),
        pid: 123,
        processGeneration: "synthetic-only",
      });
      observer.initialized();
      observer.opened("synthetic-provider-thread", "fixture-model", false);
      const facts = {
        observation: yield* observer.reader.read,
        model: null,
        harnessVersion: "0.162.1",
        accountEmail: "synthetic@example.invalid",
        cwd: source!,
        request: {
          messageId: MessageId.make("request"),
          text: "Act like I have amnesia. What is this chat?",
          activationAllowed: true,
          conversation: Effect.succeed([]),
        },
      };
      const selected = yield* consume(facts);
      expect(
        selected.skills.map((s) => s.name),
        selected.instructions.split("\n").find((line) => line.startsWith("amnesia:")),
      ).toEqual(["amnesia"]);
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "synthetic-provider-thread",
        runtimePolicy: {
          cwd: source!,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("synthetic-canonical"),
          model: "fixture-model",
        },
        codexInput: [{ type: "text", text: selected.instructions }, ...selected.skills],
      });
      expect(params.input).toContainEqual({
        type: "skill",
        name: "amnesia",
        path: selected.skills[0]!.path,
      });
      expect(selected.instructions).toContain("Exact activation paths");
      const quoted = yield* consume({
        ...facts,
        request: { ...facts.request, text: 'Explain the grammar of "act like I have amnesia".' },
      });
      expect(quoted.skills).toEqual([]);
      const unknownUser = yield* consume({ ...facts, accountEmail: null });
      expect(unknownUser.skills).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60000,
);
