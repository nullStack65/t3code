// @effect-diagnostics nodeBuiltinImport:off -- Hashes the vendored contract bytes against the Home pin.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  laneFailureClass,
  replayLaneEvents,
  type LaneEvent,
  type LaneWorld,
} from "./laneEventRouting.ts";

// sha256 of config/lane-event-routing/conformance.json in nullStack65/closura-agent-config at
// 40e39541c6. Update both together; the Python reference and this port must agree on one contract.
const HOME_CONFORMANCE_SHA256 = "e6460764fd173a4b7e4c3391f5b46f3e0ff8d0ac62a341ff41f025109c28a99f";

const raw = NodeFS.readFileSync(new URL("./laneEventRouting.conformance.json", import.meta.url));
const contract = JSON.parse(raw.toString("utf8")) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly world?: LaneWorld;
    readonly events?: ReadonlyArray<LaneEvent>;
    readonly expect_actions?: ReadonlyArray<string>;
    readonly expect_wakes?: number;
  }>;
};
const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

describe("lane event routing conformance", () => {
  it("vendors the Home contract byte for byte", () => {
    assert.strictEqual(sha256(raw), HOME_CONFORMANCE_SHA256);
    // Set in a Home + t3code checkout to catch drift before the pin is bumped.
    const homeCopy = process.env.CLOSURA_LANE_EVENT_CONFORMANCE;
    if (homeCopy && NodeFS.existsSync(homeCopy)) {
      assert.strictEqual(sha256(NodeFS.readFileSync(homeCopy)), HOME_CONFORMANCE_SHA256);
    }
  });

  const eventCases = contract.cases.filter((c) => c.events !== undefined);

  it("covers every lane-event case in the contract", () => {
    assert.isAtLeast(eventCases.length, 7);
  });

  it.each(eventCases)("$name", (testCase) => {
    const decisions = replayLaneEvents(
      testCase.events ?? [],
      testCase.world ?? { threads: {}, delivered: [] },
    );
    assert.deepStrictEqual(
      decisions.map((decision) => decision.action),
      testCase.expect_actions,
    );
    assert.strictEqual(
      decisions.filter((decision) => decision.action === "wake").length,
      testCase.expect_wakes,
    );
  });

  it("routes every c964fe48 alert about 98fbc01a away from the settled launcher", () => {
    const replay = contract.cases.find((c) => c.name.startsWith("replay-c964fe48-98fbc01a"));
    assert.isDefined(replay);
    const decisions = replayLaneEvents(replay?.events ?? [], replay?.world as LaneWorld);
    assert.strictEqual(decisions.length, 6);
    for (const decision of decisions) {
      assert.notStrictEqual(decision.recipient, "c964fe48");
      assert.notStrictEqual(decision.action, "wake");
    }
  });

  it("classes provider limits together and strips digits and uuids", () => {
    assert.strictEqual(laneFailureClass("HTTP 429 Too Many Requests"), "provider-limit");
    assert.strictEqual(laneFailureClass("Out of usage until 7pm"), "provider-limit");
    assert.strictEqual(
      laneFailureClass("run 0b6d8a8e-1c1f-4d1e-9b0a-1a2b3c4d5e6f failed after 12 tries"),
      laneFailureClass("run 9f9f9f9f-0000-4000-8000-000000000000 failed after 3 tries"),
    );
    assert.strictEqual(laneFailureClass(null), "none");
  });
});
