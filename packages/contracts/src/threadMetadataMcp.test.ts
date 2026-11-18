import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });
});

it("accepts agent routing and rejects ambiguous metadata actions", () => {
  assert.deepEqual(
    decodeUpdate({
      action: "route",
      inboxRouting: { assignee: { kind: "human", id: "jeff" }, attentionKind: "FYI" },
    }).inboxRouting,
    { assignee: { kind: "human", id: "jeff" }, attentionKind: "FYI" },
  );
  assert.throws(() => decodeUpdate({ action: "route" }));
  assert.throws(() => decodeUpdate({ action: "rename", title: "x", inboxRouting: {} }));
  assert.throws(() => decodeUpdate({ action: "route", inboxRouting: { owner: "other" } }));
  assert.throws(() => decodeUpdate({ action: "request_decision" }));
  assert.throws(() =>
    decodeUpdate({
      action: "resolve_decision",
      decision: { founder: "kameron", kind: "decision", question: "Ship?" },
    }),
  );
});
