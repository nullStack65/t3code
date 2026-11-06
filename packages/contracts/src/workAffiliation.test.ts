import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { MessageId, RunId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { OrchestrationV2RunJson, OrchestrationV2WorkReference } from "./orchestrationV2.ts";

describe("declared work affiliation", () => {
  it("admits bounded namespaced references without task prose or URL credentials/queries", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2WorkReference);
    for (const kind of ["obligation", "root_assignment"] as const) {
      expect(decode({ kind, ref: "t3:thread:root/message:assignment" }).kind).toBe(kind);
    }
    for (const ref of [
      "task prose",
      "https://user:secret@host/path?token=private",
      "x:" + "a".repeat(1024),
      "",
    ]) {
      expect(() => decode({ kind: "obligation", ref })).toThrow();
    }
    expect(() => decode({ kind: "claim", ref: "claim:lease" })).toThrow();
  });

  it("roundtrips new affiliation while historical run JSON remains unknown", () => {
    const run = {
      id: RunId.make("run:fixture"),
      threadId: ThreadId.make("thread:fixture"),
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
      providerThreadId: null,
      userMessageId: MessageId.make("message:fixture"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "starting" as const,
      requestedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const encode = Schema.encodeSync(OrchestrationV2RunJson);
    const decode = Schema.decodeUnknownSync(OrchestrationV2RunJson);
    expect(decode(encode(run)).workAffiliation).toBeUndefined();
    const workAffiliation = {
      reference: { kind: "obligation" as const, ref: "github:fixture/repo#42" },
      establishedBy: { threadId: run.threadId, messageId: run.userMessageId },
      inheritedFrom: { threadId: ThreadId.make("thread:parent"), runId: RunId.make("run:parent") },
    };
    const roundTrip = decode(JSON.parse(JSON.stringify(encode({ ...run, workAffiliation }))));
    expect(roundTrip.workAffiliation).toEqual(workAffiliation);
  });
});
