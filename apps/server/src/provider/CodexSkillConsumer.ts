import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { parse as parseYaml } from "yaml";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { parseRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import type { CodexNativeObservation } from "./CodexSessionObservation.ts";
import type { CurrentSkillRequest } from "./CurrentSkillRequest.ts";

const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const CodexSkillSource = Schema.Struct({
  directory: Schema.NonEmptyString,
  sourceCommit: Commit,
  pythonPath: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  principal: Schema.Struct({
    id: Schema.NonEmptyString,
    emailSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  generations: Schema.Record(Schema.String, Schema.String),
});
export type CodexSkillSource = typeof CodexSkillSource.Type;

const Receipt = Schema.Struct({
  schema_version: Schema.Literal(1),
  state: Schema.Literal("runtime-admission-candidate"),
  context: Schema.Unknown,
  permissions_granted: Schema.Literal(false),
  installed: Schema.Literal(false),
  behavior_verified: Schema.Literal(false),
  source: Schema.Struct({ commit: Commit, dirty: Schema.Literal(false) }),
  files: Schema.Record(Schema.String, Schema.String),
  target_contract: Schema.Struct({
    skills: Schema.Literal(".codex/skills"),
    instructions: Schema.Literal(".codex/AGENTS.md"),
    activation_paths: Schema.Array(Schema.String),
  }),
  decisions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      discoverable: Schema.Boolean,
      load: Schema.Boolean,
      runtime_admitted: Schema.Boolean,
      artifact_kind: Schema.optionalKey(Schema.String),
      projected_path: Schema.optionalKey(Schema.String),
      discovery_path: Schema.optionalKey(Schema.String),
      reasons: Schema.Array(Schema.String),
    }),
  ),
});
const Discovery = Schema.Struct({ name: Schema.String, description: Schema.String });
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class CodexSkillConsumerError extends Schema.TaggedError<CodexSkillConsumerError>()(
  "CodexSkillConsumerError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export interface CodexSkillTurn {
  readonly skills: ReadonlyArray<{
    readonly type: "skill";
    readonly name: string;
    readonly path: string;
  }>;
  readonly discoveryRoot: string;
  readonly instructions: string;
}
export interface CodexSkillTurnFacts {
  readonly observation: CodexNativeObservation;
  readonly model: string | null;
  readonly harnessVersion: string;
  readonly accountEmail: string | null;
  readonly cwd: string;
  readonly request?: CurrentSkillRequest;
}
export type CodexSkillConsumer = (
  facts: CodexSkillTurnFacts,
) => Effect.Effect<CodexSkillTurn, CodexSkillConsumerError>;

// Selection is deliberately conservative. The eligible source's discovery
// description supplies natural-language phrases; quoted/history text is never
// searched for activations. This selects instructions, not permissions.
export function selectsCurrentSkill(text: string, name: string, description: string): boolean {
  const request = text.trim().replace(/^(?:please\s+|can you\s+|could you\s+)/i, "");
  if (request.startsWith(`$${name}`) && /^(?:\s|[.!?]|$)/.test(request.slice(name.length + 1)))
    return true;
  const phrases = [...description.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]!.toLowerCase());
  return phrases.some(
    (phrase) =>
      request.toLowerCase().startsWith(phrase) && /^(?:[.!?]|$)/.test(request.slice(phrase.length)),
  );
}

export const makeCodexSkillConsumer = Effect.fn("makeCodexSkillConsumer")(function* (
  source: CodexSkillSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // macOS temp paths can pass through /var or /tmp symlinks. The canonical
  // builder refuses linked output ancestors, so use the owned directory's real path.
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-governed-skills-" })
    .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
  const run = (binary: string, args: ReadonlyArray<string>, cwd = source.directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make(binary, args, { cwd }));
        const [stdout, , exit] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.runDrain(child.stderr),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exit !== 0)
          return yield* new CodexSkillConsumerError({ reason: "canonical-command-failed" });
        return stdout;
      }),
    ).pipe(Effect.timeout("20 seconds"));
  const checkSource = Effect.gen(function* () {
    const head = (yield* run("git", ["rev-parse", "HEAD"])).trim();
    const dirty = (yield* run("git", ["status", "--porcelain"])).trim();
    if (head !== source.sourceCommit || dirty)
      return yield* new CodexSkillConsumerError({ reason: "source-head-or-worktree-changed" });
  });
  let sequence = 0;
  const consume: CodexSkillConsumer = (facts) =>
    Effect.gen(function* () {
      yield* checkSource;
      if (
        facts.observation.closed ||
        !facts.observation.initialized ||
        !facts.observation.providerThreadId
      )
        return yield* new CodexSkillConsumerError({ reason: "native-session-unavailable" });
      const principal =
        facts.accountEmail !== null && digest(facts.accountEmail) === source.principal.emailSha256
          ? source.principal.id
          : null;
      // Read the task checkout, not the canonical policy checkout or prompt.
      // Reuse the shared Git identity parser; absent/unsupported origin stays unknown.
      const repository = yield* run(
        "git",
        ["config", "--get", "remote.origin.url"],
        facts.cwd,
      ).pipe(
        Effect.map((url) => parseRepositoryNameWithOwnerFromRemoteUrl(url)),
        Effect.orElseSucceed(() => null),
      );
      const context = {
        target: "codex",
        admission_mode: "runtime",
        principal,
        team: null,
        repository,
        provider: facts.model ? source.provider : null,
        model: facts.model,
        generation: facts.model ? source.generations[facts.model] || null : null,
        harness: "codex",
        harness_version: facts.harnessVersion,
        os: yield* HostProcessPlatform,
        capabilities: [],
        conditions: {},
        data: {},
        as_of: DateTime.formatIso(yield* DateTime.now),
        activation: {
          phase: "discovery",
          explicit: [] as string[],
          intents: [],
          task_context: [],
          requested_writes: [],
        },
      };
      const directory = path.join(root, String(++sequence));
      yield* fs.makeDirectory(directory);
      const build = Effect.fnUntraced(function* (phase: string, explicit: string[]) {
        const expected = { ...context, activation: { ...context.activation, phase, explicit } };
        const contextPath = path.join(directory, `${phase}.json`);
        const output = path.join(directory, phase);
        yield* fs.writeFileString(contextPath, encodeJson(expected));
        const args = [
          path.join(source.directory, "scripts/build_skill_session.py"),
          "--context",
          contextPath,
          "--output",
          output,
        ];
        yield* run(source.pythonPath, args);
        const admission = yield* fs.readFileString(path.join(output, "admission.json"));
        const receipt = yield* decodeReceipt(admission);
        if (
          !NodeUtil.isDeepStrictEqual(receipt.context, expected) ||
          receipt.source.commit !== source.sourceCommit
        )
          return yield* new CodexSkillConsumerError({
            reason: "receipt-context-or-source-mismatch",
          });
        for (const relative of Object.keys(receipt.files)) {
          if (
            path.isAbsolute(relative) ||
            !path.resolve(output, relative).startsWith(output + path.sep)
          )
            return yield* new CodexSkillConsumerError({ reason: "candidate-path-escape" });
        }
        const member = (relative: string) => path.resolve(output, relative);
        const verified = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              state: Schema.Literal("sandbox-files-verified"),
              admission_sha256: Schema.String,
              live_installed: Schema.Literal(false),
              model_behavior_verified: Schema.Literal(false),
            }),
          ),
        )(yield* run(source.pythonPath, [...args, "--verify"]));
        if (verified.admission_sha256 !== digest(admission))
          return yield* new CodexSkillConsumerError({ reason: "verification-admission-mismatch" });
        for (const [relative, hash] of Object.entries(receipt.files)) {
          const file = member(relative);
          if (digest(yield* fs.readFile(file)) !== hash)
            return yield* new CodexSkillConsumerError({ reason: "candidate-content-changed" });
        }
        if ((yield* fs.readFileString(path.join(output, "admission.json"))) !== admission)
          return yield* new CodexSkillConsumerError({
            reason: "admission-changed-during-verification",
          });
        return { receipt, output, member };
      });
      const discovery = yield* build("discovery", []);
      const explicit: string[] = [];
      if (facts.request?.activationAllowed) {
        for (const decision of discovery.receipt.decisions) {
          if (
            !decision.discoverable ||
            !decision.runtime_admitted ||
            !decision.discovery_path ||
            !discovery.receipt.files[decision.discovery_path] ||
            decision.artifact_kind === "compatibility-patch"
          )
            continue;
          const stub = yield* fs.readFileString(discovery.member(decision.discovery_path));
          const metadata = yield* Schema.decodeUnknownEffect(Discovery)(
            parseYaml(stub.split("---", 3)[1] ?? ""),
          );
          if (selectsCurrentSkill(facts.request.text, metadata.name, metadata.description))
            explicit.push(decision.id);
        }
      }
      const startup = yield* build("startup", []);
      const request = yield* build("request", explicit);
      const skills: Array<{ type: "skill"; name: string; path: string }> = [];
      for (const candidate of [startup, request]) {
        for (const decision of candidate.receipt.decisions) {
          if (!decision.load) continue;
          if (
            !decision.runtime_admitted ||
            !decision.projected_path ||
            !candidate.receipt.files[decision.projected_path] ||
            !candidate.receipt.target_contract.activation_paths.includes(decision.projected_path)
          )
            return yield* new CodexSkillConsumerError({ reason: "loaded-path-not-admitted" });
          if (
            decision.artifact_kind === "compatibility-patch" &&
            !decision.projected_path.startsWith("patches/")
          )
            return yield* new CodexSkillConsumerError({ reason: "patch-in-ordinary-discovery" });
          skills.push({
            type: "skill",
            name: decision.id,
            path: candidate.member(decision.projected_path),
          });
        }
      }
      yield* checkSource;
      const agents = yield* Effect.forEach(
        [startup, request],
        Effect.fnUntraced(function* (candidate) {
          const relative = candidate.receipt.target_contract.instructions;
          if (!candidate.receipt.files[relative])
            return yield* new CodexSkillConsumerError({ reason: "candidate-instructions-missing" });
          const text = yield* fs.readFileString(candidate.member(relative));
          return `Candidate root: ${candidate.output}\n${text}`;
        }),
      );
      const discoveryRoot = path.join(discovery.output, ".codex/skills");
      // A valid resolution with no eligible Skills still needs an empty native
      // root; candidate digests cover files, not otherwise empty directories.
      yield* fs.makeDirectory(discoveryRoot, { recursive: true });
      return {
        skills,
        discoveryRoot,
        instructions:
          "Governed source selection for this request only; selected-model applicability, not served-model attestation. Skills grant no permissions. Only these admitted paths were activated:\n" +
          skills.map((s) => `- ${s.path}`).join("\n") +
          "\n" +
          agents.join("\n") +
          "\nResolution reasons:\n" +
          request.receipt.decisions.map((d) => `${d.id}: ${d.reasons.join(", ")}`).join("\n"),
      };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(CodexSkillConsumerError)(cause)
          ? cause
          : new CodexSkillConsumerError({ reason: "canonical-resolution-or-verification-failed" }),
      ),
    );
  return consume;
});
