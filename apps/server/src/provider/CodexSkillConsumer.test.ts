// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { makeCodexSessionObservation } from "./CodexSessionObservation.ts";
import { makeCodexSkillConsumer, selectsCurrentSkill } from "./CodexSkillConsumer.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hash = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");
const description =
  'Use when the current user asks "act like I have amnesia" or "what is this chat".';

it("selects current natural-language requests while quotes and historical mentions remain data", () => {
  for (const text of [
    "Act like I have amnesia. What happened?",
    "Please what is this chat?",
    "$durable-app explain this",
  ])
    expect(selectsCurrentSkill(text, "durable-app", description)).toBe(true);
  for (const text of [
    'Explain the grammar of "act like I have amnesia".',
    '"act like I have amnesia"',
    "> act like I have amnesia",
    'Yesterday I asked "what is this chat".',
    'SKDEL: user previously said "act like I have amnesia".',
  ])
    expect(selectsCurrentSkill(text, "durable-app", description)).toBe(false);
});

// Protocol stand-in, not a second policy resolver. The precomputed selected
// tuple cases model canonical CLI output; policy correctness stays in config.
const builder = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const args=process.argv.slice(2),ctx=JSON.parse(fs.readFileSync(args[args.indexOf('--context')+1],'utf8')),out=args[args.indexOf('--output')+1];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
if(args.includes('--verify')){const raw=fs.readFileSync(path.join(out,'admission.json'));const r=JSON.parse(raw);for(const [f,h] of Object.entries(r.files))if(hash(fs.readFileSync(path.join(out,f)))!==h)process.exit(2);if(JSON.parse(fs.readFileSync('contract.json')).verifyFailure)process.exit(3);console.log(JSON.stringify({state:'sandbox-files-verified',admission_sha256:hash(raw),live_installed:false,model_behavior_verified:false}));process.exit(0);}
const fixture=JSON.parse(fs.readFileSync('contract.json','utf8')),phase=ctx.activation.phase;
const patch=fixture.qualified.includes(JSON.stringify([ctx.provider,ctx.model,ctx.generation,ctx.harness_version]));
const app=ctx.principal==='fixture-user',files={},decisions=[];
const appPath='.codex/skills/durable-app/SKILL.md',patchPath='patches/fix/SKILL.md';
const activeApp=app&&phase==='request'&&ctx.activation.explicit.includes('durable-app');
if(app)files[appPath]='---\nname: durable-app\ndescription: '+JSON.stringify(fixture.description)+'\n---\n'+(activeApp?'DURABLE_BODY':'');
decisions.push({id:'durable-app',discoverable:app,load:activeApp,runtime_admitted:app,artifact_kind:'skill',...(app?activeApp?{projected_path:appPath}:{discovery_path:appPath}:{}),reasons:[app?'eligible':'principal-mismatch']});
const activePatch=patch&&phase==='startup';if(activePatch)files[patchPath]='---\nname: fix\ndescription: Synthetic qualified patch\n---\nPATCH_BODY';
decisions.push({id:'fix',discoverable:patch,load:activePatch,runtime_admitted:true,artifact_kind:'compatibility-patch',...(activePatch?{projected_path:patchPath}:{}),reasons:[patch?'qualified':'tuple-mismatch']});
const loaded=decisions.filter(d=>d.load).map(d=>d.projected_path);files['.codex/AGENTS.md']='SOURCE_GENERATED_AGENTS\n'+loaded.join('\n');
const receipt={schema_version:1,state:fixture.state??'runtime-admission-candidate',context:fixture.stale?{...ctx,model:'old'}:ctx,permissions_granted:false,installed:false,behavior_verified:false,source:{commit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:false},files:Object.fromEntries(Object.entries(files).map(([f,b])=>[f,hash(b)])),decisions,target_contract:{skills:'.codex/skills',instructions:'.codex/AGENTS.md',activation_paths:loaded}};
fs.mkdirSync(out,{recursive:true});for(const [f,b]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(out,f)),{recursive:true});fs.writeFileSync(path.join(out,f),b);}if(fixture.tamper)fs.appendFileSync(path.join(out,'.codex/AGENTS.md'),'TAMPER');fs.writeFileSync(path.join(out,'admission.json'),JSON.stringify(receipt));console.log('{}');
`;

function fixture(
  options: {
    state?: string;
    stale?: boolean;
    requalified?: boolean;
    tamper?: boolean;
    verifyFailure?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-canonical-cli-contract-" });
    yield* fs.makeDirectory(NodePath.join(dir, "scripts"));
    yield* fs.writeFileString(NodePath.join(dir, "scripts/build_skill_session.py"), builder);
    yield* fs.writeFileString(
      NodePath.join(dir, "contract.json"),
      encode({
        ...options,
        description,
        qualified: [
          encode(["codex", "fixture-6", "gen6", "0.162.1"]),
          ...(options.requalified ? [encode(["codex", "fixture-7", "gen7", "0.162.1"])] : []),
        ],
      }),
    );
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Synthetic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const consume = yield* makeCodexSkillConsumer({
      directory: dir,
      sourceCommit: git("rev-parse", "HEAD"),
      pythonPath: process.execPath,
      provider: "codex",
      principal: { id: "fixture-user", emailSha256: hash("fixture@example.invalid") },
      generations: { "fixture-6": "gen6", "fixture-7": "gen7" },
    });
    const observer = makeCodexSessionObservation({
      threadId: ThreadId.make("fixture"),
      providerInstanceId: ProviderInstanceId.make("fixture-instance"),
      pid: 42,
      processGeneration: "fixture-process",
    });
    observer.initialized();
    observer.opened("fixture-provider-thread", "fixture-6", false);
    const observation = yield* observer.reader.read;
    const facts = {
      observation,
      model: "fixture-6",
      harnessVersion: "0.162.1",
      accountEmail: "fixture@example.invalid",
      cwd: dir,
      request: {
        messageId: MessageId.make("current"),
        text: "Act like I have amnesia. Explain this chat.",
        activationAllowed: true,
        conversation: Effect.succeed([]),
      },
    };
    return { consume, facts, dir };
  });
}

it.live(
  "passes selected tuples and consumes only freshly verified native paths and source AGENTS",
  () =>
    Effect.gen(function* () {
      const { consume, facts } = yield* fixture();
      const positive = yield* consume(facts);
      expect(positive.skills.map((s) => s.name)).toEqual(["fix", "durable-app"]);
      expect(positive.skills[0]?.path).toContain("/patches/fix/SKILL.md");
      expect(positive.discoveryRoot).not.toContain("patches");
      expect(positive.instructions).toContain("SOURCE_GENERATED_AGENTS");
      expect(
        NodeFS.readFileSync(NodePath.join(positive.discoveryRoot, "durable-app/SKILL.md"), "utf8"),
      ).not.toContain("DURABLE_BODY");
      expect(NodeFS.readdirSync(positive.discoveryRoot)).toEqual(["durable-app"]);
      for (const changed of [
        { model: "fixture-7" },
        { model: null },
        { harnessVersion: "other" },
      ]) {
        const next = yield* consume({ ...facts, ...changed });
        expect(next.skills.map((s) => s.name)).toEqual(["durable-app"]);
        expect(next.instructions).not.toContain("patches/fix");
      }
      const wrongUser = yield* consume({ ...facts, accountEmail: null });
      expect(wrongUser.skills.map((s) => s.name)).toEqual(["fix"]);
      const quote = yield* consume({
        ...facts,
        request: { ...facts.request, text: 'Explain "act like I have amnesia".' },
      });
      expect(quote.skills.map((s) => s.name)).toEqual(["fix"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("accepts a newly pinned requalified source and rejects stale or review-only receipts", () =>
  Effect.gen(function* () {
    const renewed = yield* fixture({ requalified: true });
    expect(
      (yield* renewed.consume({ ...renewed.facts, model: "fixture-7" })).skills.map((s) => s.name),
    ).toEqual(["fix", "durable-app"]);
    for (const options of [
      { stale: true },
      { state: "review-candidate" },
      { tamper: true },
      { verifyFailure: true },
    ]) {
      const f = yield* fixture(options);
      expect(yield* Effect.flip(f.consume(f.facts))).toBeDefined();
    }
    const f = yield* fixture();
    NodeFS.appendFileSync(NodePath.join(f.dir, "contract.json"), " ");
    expect(yield* Effect.flip(f.consume(f.facts))).toMatchObject({
      reason: "source-head-or-worktree-changed",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
