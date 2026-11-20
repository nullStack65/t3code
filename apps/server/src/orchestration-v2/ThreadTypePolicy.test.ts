import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ThreadTypePolicy from "./ThreadTypePolicy.ts";
import { THREAD_TYPE_POLICY_FIXTURE, threadTypeThread } from "./ThreadTypePolicy.testFixtures.ts";

describe("ThreadTypePolicy", () => {
  it.each([
    ["CoS", false, "standing"],
    ["CTO daily", false, "standing"],
    ["Product Designer", false, "standing"],
    ["JEFFDESK:DESK — Jeff Omarchy operations desktop", false, "standing"],
    ["CoS", true, "coding"],
    ["[standing] PR landing manager", true, "standing"],
    ["[Standing] PR landing manager", true, "standing"],
    ["[CODING] a standing role thread", true, "coding"],
    ["[research] CoS notes", false, "research"],
    ["KSS ----> analyses with Kameron", false, "conversational"],
    ["Independent code-review of CLO-924", true, "review"],
    ["Token burn analysis and plan", false, "research"],
    ["OPS-1:ASTRA — R720 CI & Grafana alert delivery", false, "ops"],
    ["Standing bot threads look different in T3", false, "coding"],
  ] as const)("classifies %s (child %s) as %s", (title, child, expected) => {
    assert.equal(
      ThreadTypePolicy.classifyThread(
        THREAD_TYPE_POLICY_FIXTURE,
        threadTypeThread(title, { child }),
      ),
      expected,
    );
  });

  it("treats a thread with a standing persona as standing whatever its title", () => {
    assert.equal(
      ThreadTypePolicy.classifyThread(
        THREAD_TYPE_POLICY_FIXTURE,
        threadTypeThread("[coding] CLO-924 per-thread-type policy", { standing: true }),
      ),
      "standing",
    );
  });

  it.effect("refuses gpt-6-astra on standing threads in any provider spelling", () =>
    Effect.gen(function* () {
      for (const model of [
        "gpt-6-astra",
        "codex/gpt-6-astra",
        " OpenAI/GPT-6-Astra ",
        "openai.gpt-6-astra",
        "openai/gpt-6-astra-fast",
        "openrouter/openai/gpt-6-astra",
        "magpie/gpt-6-astra",
        "openai/codex/gpt-6-astra",
        "gpt-6-astra[1m]",
      ]) {
        const refused = yield* ThreadTypePolicy.resolveThreadTypeLaunch(
          THREAD_TYPE_POLICY_FIXTURE,
          threadTypeThread("Lead"),
          model,
        ).pipe(Effect.flip);
        assert.equal(refused._tag, "ThreadTypeModelRefusedError");
        assert.equal(refused.threadType, "standing");
        assert.equal(refused.model, "gpt-6-astra");
      }
    }),
  );

  it.effect("allows gpt-6-astra on named short task threads and returns the type values", () =>
    Effect.gen(function* () {
      const review = yield* ThreadTypePolicy.resolveThreadTypeLaunch(
        THREAD_TYPE_POLICY_FIXTURE,
        threadTypeThread("Review PR 953"),
        "gpt-6-astra",
      );
      assert.deepEqual(review, {
        type: "review",
        claudeContextWindow: 200_000,
        codexContextWindow: 272_000,
        compactAt: 120_000,
        cacheTtl: "5m",
      });
      const standing = yield* ThreadTypePolicy.resolveThreadTypeLaunch(
        THREAD_TYPE_POLICY_FIXTURE,
        threadTypeThread("CoS"),
        "gpt-6.1-sol",
      );
      assert.deepEqual(standing, {
        type: "standing",
        claudeContextWindow: 200_000,
        codexContextWindow: 272_000,
        compactAt: 165_000,
        cacheTtl: "1h",
        summaryCap: 8_000,
      });
    }),
  );

  it.effect("reads a policy file and treats a missing or invalid one as no policy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped();
      const valid = `${dir}/policy.json`;
      const invalid = `${dir}/invalid.json`;
      yield* fileSystem.writeFileString(valid, JSON.stringify(THREAD_TYPE_POLICY_FIXTURE));
      yield* fileSystem.writeFileString(invalid, JSON.stringify({ schema: "other" }));
      assert.deepEqual(
        yield* ThreadTypePolicy.readThreadTypePolicy(valid),
        THREAD_TYPE_POLICY_FIXTURE,
      );
      assert.isUndefined(yield* ThreadTypePolicy.readThreadTypePolicy(invalid));
      assert.isUndefined(yield* ThreadTypePolicy.readThreadTypePolicy(`${dir}/missing.json`));
      const possessive = `${dir}/possessive.json`;
      yield* fileSystem.writeFileString(
        possessive,
        JSON.stringify({
          ...THREAD_TYPE_POLICY_FIXTURE,
          classify: [{ type: "standing", top_level_only: true, title: "a*+" }],
        }),
      );
      assert.isUndefined(yield* ThreadTypePolicy.readThreadTypePolicy(possessive));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("caps a carried summary at one token per two characters", () => {
    assert.equal(ThreadTypePolicy.carriedSummaryWithinCap(8_000, "a".repeat(16_000)), true);
    assert.equal(ThreadTypePolicy.carriedSummaryWithinCap(8_000, "a".repeat(16_001)), false);
    assert.match(ThreadTypePolicy.carriedSummaryInstruction(8_000), /8000 tokens/);
  });

  it("reads the policy from the Closura config path unless the environment overrides it", () => {
    assert.match(
      ThreadTypePolicy.threadTypePolicyPath({}),
      /\/\.config\/closura\/thread-type-policy\.json$/,
    );
    assert.equal(
      ThreadTypePolicy.threadTypePolicyPath({ T3_THREAD_TYPE_POLICY_PATH: "/etc/policy.json" }),
      "/etc/policy.json",
    );
  });
});
