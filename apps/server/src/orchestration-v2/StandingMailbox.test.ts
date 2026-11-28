// @effect-diagnostics nodeBuiltinImport:off -- Hashes the vendored conformance bytes to pin them to the Home source.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type MailboxMessage,
  type MailboxRoles,
  formatMailboxForProvider,
  mailboxFold,
  managerTurnOverBudget,
  mailboxSenderRole,
  planDequeue,
  rankQueuedRunsByMailbox,
} from "./StandingMailbox.ts";

const CONFORMANCE_URL = new URL("./laneEventRouting.conformance.json", import.meta.url);
// sha256 of closura-agent-config `config/lane-event-routing/conformance.json` at 40e39541c6.
// Re-vendor the file and update both together; a mismatch means the two sides drifted.
const CONFORMANCE_SHA256 = "e6460764fd173a4b7e4c3391f5b46f3e0ff8d0ac62a341ff41f025109c28a99f";

interface MailboxCase {
  readonly name: string;
  readonly queued: ReadonlyArray<MailboxMessage>;
  readonly current_priority?: number | null;
  readonly expect: Record<string, unknown>;
}

const conformanceBytes = NodeFS.readFileSync(CONFORMANCE_URL);
const mailboxCases = (
  JSON.parse(conformanceBytes.toString("utf8")) as { cases: ReadonlyArray<object> }
).cases.filter((entry): entry is MailboxCase => "queued" in entry);

describe("standing manager mailbox conformance", () => {
  it("vendors the Home contract byte for byte", () => {
    expect(NodeCrypto.createHash("sha256").update(conformanceBytes).digest("hex")).toBe(
      CONFORMANCE_SHA256,
    );
    expect(mailboxCases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(mailboxCases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const plan = planDequeue(entry.queued, entry.current_priority ?? null);
    const got: Record<string, unknown> = { ...plan };
    for (const [field, want] of Object.entries(entry.expect)) {
      expect(got[field], field).toEqual(want);
    }
  });
});

describe("standing manager mailbox", () => {
  it("batches seven queued messages into one turn with the founder first", () => {
    const queued: ReadonlyArray<MailboxMessage> = [
      { id: "a1", at: "2026-11-27T10:00:00Z", sender_role: "agent" },
      { id: "a2", at: "2026-11-27T10:01:00Z", sender_role: "agent" },
      { id: "c1", at: "2026-11-27T10:02:00Z", sender_role: "ceo" },
      { id: "a3", at: "2026-11-27T10:03:00Z", sender_role: "agent" },
      { id: "f1", at: "2026-11-27T10:04:00Z", sender_role: "founder" },
      { id: "a4", at: "2026-11-27T10:05:00Z", sender_role: "agent" },
      { id: "a5", at: "2026-11-27T10:06:00Z", sender_role: "agent" },
    ];
    expect(planDequeue(queued)).toEqual({
      turns: 1,
      batch: ["f1", "c1", "a1", "a2", "a3", "a4", "a5"],
      digest: [],
      preempt: false,
    });
  });

  it("classifies a typed message as the founder and the CEO seat by its standing name", () => {
    expect(mailboxSenderRole({ createdBy: "user", scheduledTaskId: undefined }, null)).toBe(
      "founder",
    );
    expect(mailboxSenderRole({ createdBy: "agent", scheduledTaskId: undefined }, " ceo ")).toBe(
      "ceo",
    );
    expect(mailboxSenderRole({ createdBy: "agent", scheduledTaskId: undefined }, "CTO")).toBe(
      "agent",
    );
  });

  it("flags a manager turn only past 300 seconds", () => {
    expect(managerTurnOverBudget(0, 300_000)).toBe(false);
    expect(managerTurnOverBudget(0, 300_001)).toBe(true);
  });
});

describe("standing manager mailbox on queued runs", () => {
  const model = { instanceId: "codex", model: "gpt" };
  const senders = [
    ["a1", "agent"],
    ["a2", "agent"],
    ["c1", "ceo"],
    ["a3", "agent"],
    ["f1", "founder"],
    ["a4", "agent"],
    ["a5", "agent"],
  ] as const;
  const projection = {
    messages: senders.map(([id, role]) => ({
      id: `message:${id}`,
      text: `from ${id}`,
      attachments: [],
      createdBy: role === "founder" ? "user" : "agent",
    })),
    runs: senders.map(([id], index) => ({
      id: `run:${id}`,
      ordinal: index + 1,
      queuePosition: index + 1,
      requestedAt: DateTime.makeUnsafe(`2026-11-27T10:0${index}:00Z`),
      status: "queued",
      userMessageId: `message:${id}`,
      providerInstanceId: "codex",
      modelSelection: model,
    })),
  } as never as Parameters<typeof mailboxFold>[0];
  const roles = new Map(
    senders.map(([id, role]) => [`message:${id}`, role]),
  ) as never as MailboxRoles;

  it("starts the founder's message and answers the other six in the same turn", () => {
    const [head] = rankQueuedRunsByMailbox(projection.runs, roles);
    expect(head?.id).toBe("run:f1");
    const { folded, mailbox } = mailboxFold(
      projection,
      head!,
      roles,
      DateTime.makeUnsafe("2026-11-27T11:00:00Z"),
    );
    expect(folded.map((run) => run.id)).toEqual([
      "run:c1",
      "run:a1",
      "run:a2",
      "run:a3",
      "run:a4",
      "run:a5",
    ]);
    expect(mailbox.map((entry) => entry.senderRole)).toEqual([
      "ceo",
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    const text = formatMailboxForProvider("from f1", mailbox);
    expect(text.startsWith("from f1\n")).toBe(true);
    expect(text).toContain('<queued-messages count="6">');
    expect(text.indexOf("from c1")).toBeLessThan(text.indexOf("from a1"));
  });

  it("leaves a typed message and a different model out of the batch", () => {
    const head = projection.runs[0]!;
    const { folded } = mailboxFold(
      {
        ...projection,
        runs: projection.runs.map((run) =>
          run.id === "run:a2" ? { ...run, modelSelection: { ...run.modelSelection, model: "other" } } : run,
        ),
      },
      head,
      roles,
      DateTime.makeUnsafe("2026-11-27T11:00:00Z"),
    );
    expect(folded.map((run) => run.id)).toEqual(["run:c1", "run:a3", "run:a4", "run:a5"]);
  });
});
