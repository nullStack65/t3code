// @effect-diagnostics nodeBuiltinImport:off - Executes the actual workflow admission script with inert GitHub fixtures.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

const Step = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const Job = Schema.Struct({
  if: Schema.String,
  needs: Schema.optionalKey(Schema.String),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  environment: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(Step),
});
const workflow = Schema.decodeUnknownSync(
  Schema.Struct({
    on: Schema.Record(Schema.String, Schema.Unknown),
    permissions: Schema.Record(Schema.String, Schema.String),
    concurrency: Schema.Struct({ group: Schema.String, "cancel-in-progress": Schema.Boolean }),
    jobs: Schema.Record(Schema.String, Job),
  }),
)(
  parse(
    NodeFS.readFileSync(
      new URL("../../../.github/workflows/deploy-relay.yml", import.meta.url),
      "utf8",
    ),
  ),
);
const admit = workflow.jobs.admit!;
const deploy = workflow.jobs.deploy_relay!;
const validation = admit.steps.find((step) => step.id === "validate")!;
const script = Schema.decodeUnknownSync(Schema.String)(validation.with?.script);
const source = "a".repeat(40);

function fixture() {
  return {
    context: {
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      sha: source,
      actor: "nullStack65",
      payload: {
        repository: {
          full_name: "nullStack65/t3code",
          owner: { id: 112618179 },
          default_branch: "main",
        },
      },
    },
    env: {
      GITHUB_ACTOR_ID: "112618179",
      GITHUB_TRIGGERING_ACTOR: "nullStack65",
      GITHUB_RUN_ATTEMPT: "1",
      REVIEWED_SOURCE_SHA: source,
      WORKFLOW_SHA: source,
    },
  };
}

async function execute(input = fixture(), currentMain = source, apiFails = false) {
  const outputs: Record<string, string> = {};
  const requests: Array<unknown> = [];
  const execution: unknown = NodeVM.runInNewContext(
    `(async () => { ${script}\n })()`,
    {
      context: input.context,
      process: { env: input.env },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        rest: {
          repos: {
            getBranch: (request: unknown) => {
              requests.push(request);
              if (apiFails) throw new Error("GitHub unavailable");
              return { data: { commit: { sha: currentMain } } };
            },
          },
        },
      },
    },
    { timeout: 1_000 },
  );
  try {
    await execution;
    return { outputs, requests, admitted: true };
  } catch {
    return { outputs, requests, admitted: false };
  }
}

describe("production relay admission", () => {
  it("admits a first owner dispatch only for the exact reviewed current source", async () => {
    expect(await execute()).toEqual({
      admitted: true,
      outputs: { source_sha: source },
      requests: [{ owner: "nullStack65", repo: "t3code", branch: "main" }],
    });
  });

  for (const field of ["eventName", "ref", "sha", "actor"] as const) {
    it(`denies wrong ${field} without producing a deployment source`, async () => {
      const input = fixture();
      input.context[field] = field === "sha" ? "b".repeat(40) : "wrong";
      expect(await execute(input)).toEqual({ admitted: false, outputs: {}, requests: [] });
    });
  }

  for (const event of ["push", "pull_request", "workflow_run", "repository_dispatch"]) {
    it(`does not schedule a relay workflow for ${event}, including its own source merge`, async () => {
      expect(Object.hasOwn(workflow.on, event)).toBe(false);
      const input = fixture();
      input.context.eventName = event;
      expect((await execute(input)).admitted).toBe(false);
    });
  }

  for (const field of ["full_name", "default_branch"] as const) {
    it(`denies wrong repository ${field}`, async () => {
      const input = fixture();
      input.context.payload.repository[field] = "wrong";
      expect(await execute(input)).toEqual({ admitted: false, outputs: {}, requests: [] });
    });
  }

  it("denies another repository owner even when the name is unchanged", async () => {
    const input = fixture();
    input.context.payload.repository.owner.id = 999;
    expect(await execute(input)).toEqual({ admitted: false, outputs: {}, requests: [] });
  });

  for (const [field, value] of [
    ["GITHUB_ACTOR_ID", "999"],
    ["GITHUB_TRIGGERING_ACTOR", "another-operator"],
    ["GITHUB_RUN_ATTEMPT", "2"],
    ["GITHUB_RUN_ATTEMPT", ""],
    ["REVIEWED_SOURCE_SHA", ""],
    ["REVIEWED_SOURCE_SHA", "main"],
    ["REVIEWED_SOURCE_SHA", "A".repeat(40)],
    ["REVIEWED_SOURCE_SHA", "b".repeat(40)],
    ["REVIEWED_SOURCE_SHA", "a".repeat(40) + "\nthrow new Error('injected')"],
    ["WORKFLOW_SHA", "b".repeat(40)],
  ] as const) {
    it(`denies ${field}=${JSON.stringify(value)}`, async () => {
      const input = fixture();
      input.env[field] = value;
      expect(await execute(input)).toEqual({ admitted: false, outputs: {}, requests: [] });
    });
  }

  it("denies another actor rerunning an owner's accepted request", async () => {
    const input = fixture();
    input.env.GITHUB_TRIGGERING_ACTOR = "another-operator";
    input.env.GITHUB_RUN_ATTEMPT = "2";
    expect(await execute(input)).toEqual({ admitted: false, outputs: {}, requests: [] });
  });

  it("denies stale main and API failures without emitting an admission output", async () => {
    expect(await execute(fixture(), "b".repeat(40))).toMatchObject({
      admitted: false,
      outputs: {},
    });
    expect(await execute(fixture(), source, true)).toMatchObject({ admitted: false, outputs: {} });
  });

  it("keeps the entire production job behind a successful admission and pinned checkout", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.jobs)).toEqual(["admit", "deploy_relay"]);
    expect(admit.steps).toHaveLength(1);
    expect(deploy.steps.map((step) => step.name)).toEqual([
      "Checkout",
      "Setup Vite+",
      "Deploy production relay stage",
      "Publish relay deploy commit status",
    ]);
    expect(deploy.needs).toBe("admit");
    expect(deploy.if.replace(/\s+/g, " ").trim()).toBe(
      "needs.admit.result == 'success' && needs.admit.outputs.source_sha == github.sha && github.run_attempt == '1'",
    );
    expect(admit.outputs).toEqual({ source_sha: "${{ steps.validate.outputs.source_sha }}" });
    expect(validation.uses).toBe("actions/github-script@v8");
    expect(validation.env).toEqual({
      REVIEWED_SOURCE_SHA: "${{ inputs.reviewed_source_sha }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(script).not.toContain("${{");
    expect(admit.environment).toBeUndefined();
    expect(admit.env).toBeUndefined();
    expect(JSON.stringify(admit)).not.toContain("secrets.");
    expect(workflow.permissions).toEqual({ contents: "read", "id-token": "none" });
    expect(deploy.permissions).toEqual({ contents: "read", "id-token": "none", statuses: "write" });
    expect(deploy.environment).toEqual({ name: "production" });
    expect(workflow.concurrency).toEqual({
      group: "relay-production",
      "cancel-in-progress": false,
    });
    expect(deploy.steps[0]?.uses).toBe("actions/checkout@v6");
    expect(deploy.steps[0]?.with?.ref).toBe("${{ needs.admit.outputs.source_sha }}");
    expect(deploy.steps[0]?.with?.["persist-credentials"]).toBe(false);
    const productionStep = deploy.steps.find(
      (step) => step.name === "Deploy production relay stage",
    )!;
    expect(productionStep.run).toBe(
      "vp run --filter t3code-relay deploy --stage prod --yes --no-input",
    );
    expect(
      Object.entries(productionStep.env ?? {}).filter(([, value]) => value.includes("secrets.")),
    ).toEqual(
      [
        "CLOUDFLARE_API_TOKEN",
        "PLANETSCALE_API_TOKEN_ID",
        "PLANETSCALE_API_TOKEN",
        "AXIOM_TOKEN",
        "CLERK_SECRET_KEY",
        "APNS_PRIVATE_KEY",
        "FCM_SERVICE_ACCOUNT",
      ].map((name) => [name, "${{ secrets." + name + " }}"]),
    );
  });

  it("rejects unqualified runner admission before using the read-only GitHub token", () => {
    expect(admit.if.replace(/\s+/g, " ").trim()).toBe(
      "github.event_name == 'workflow_dispatch' && github.repository == 'nullStack65/t3code' && github.repository_owner_id == '112618179' && github.event.repository.default_branch == 'main' && github.ref == 'refs/heads/main' && github.actor == 'nullStack65' && github.actor_id == '112618179' && github.triggering_actor == 'nullStack65' && github.run_attempt == '1'",
    );
  });
});
