// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnStartCount = 0;
let accountReadCount = 0;
let threadStartCount = 0;
let currentThreadId = script.rootThreadId;
let activeTurn;
// Server->client requests the runtime must answer (approval prompts), keyed
// by the numeric JSON-RPC id this peer allocated for them.
const openServerRequests = new Map();
const writePreviousRootCollaboration = () => {
  const previousThreadId = `${script.rootThreadId}-fresh-${threadStartCount - 1}`;
  const reader = script.collabReader ?? "tool";
  if (reader === "thread-spawn" || reader === "root-thread" || reader === "root-started") {
    write({
      method: "thread/started",
      params: {
        thread: {
          ...fixture.responses.threadStart.thread,
          id: reader.startsWith("thread-") ? "still-reading" : currentThreadId,
          parentThreadId: previousThreadId,
          source:
            reader === "root-started"
              ? "cli"
              : {
                  subAgent: {
                    thread_spawn: {
                      depth: 1,
                      parent_thread_id: previousThreadId,
                      agent_path: "/root/reader",
                    },
                  },
                },
        },
      },
    });
    return;
  }
  if (reader === "foreign-turn") {
    write({
      method: "turn/started",
      params: {
        threadId: "still-reading",
        turn: {
          ...fixture.responses.turnStart.turn,
          id: "child-turn",
          status: "inProgress",
        },
      },
    });
    return;
  }
  if (reader !== "tool") {
    const started = reader === "activity-started";
    write({
      method: started ? "item/started" : "item/completed",
      params: {
        threadId: previousThreadId,
        turnId: activeTurn.id,
        [started ? "startedAtMs" : "completedAtMs"]: 1,
        item: {
          type: "subAgentActivity",
          id: "observed-reader",
          kind: "started",
          agentThreadId: reader === "root-id" ? currentThreadId : "still-reading",
          agentPath:
            reader === "root-path" ? "/root" : reader === "root-slash" ? "/" : "/root/reader",
        },
      },
    });
    return;
  }
  write({
    method: "item/started",
    params: {
      threadId: previousThreadId,
      turnId: activeTurn.id,
      startedAtMs: 1,
      item: {
        type: "collabAgentToolCall",
        id: "late-child",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: `${script.rootThreadId}-fresh-${threadStartCount - 1}`,
        receiverThreadIds: ["still-reading"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    },
  });
};
const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (script.recordAllRequests && method) {
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.allRequests`,
      `${JSON.stringify({ method, params: message.params })}\n`,
    );
  }
  if (openServerRequests.has(id)) {
    // The runtime answered an approval request. Record the response so tests
    // can assert settlement behavior, then emit serverRequest/resolved as a
    // deterministic receipt (tests wait on the runtime's event stream rather
    // than polling the sidecar file). Real codex identifies the resolved
    // request by its item id — the key the runtime correlates on — so the
    // receipt exercises the same path that closes the approval card in the
    // UI.
    const request = openServerRequests.get(id);
    openServerRequests.delete(id);
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.approvalResponses`,
      `${JSON.stringify({ id, label: request.label, result: message.result ?? null })}\n`,
    );
    write({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: {
        threadId: script.rootThreadId,
        requestId: request.itemId ?? request.label,
      },
    });
    return;
  }
  if (method === undefined && script.serverRequests?.some((request) => request.id === id)) {
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.responses`,
      `${JSON.stringify({ id, result: message.result, error: message.error })}\n`,
    );
    if (script.completeTurnOnServerResponse && activeTurn) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...activeTurn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    if (script.collabOnFinalAccount && accountReadCount === 3) writePreviousRootCollaboration();
    write({
      id,
      result: {
        account: script.accounts?.[Math.min(accountReadCount, script.accounts.length - 1)] ??
          script.account ?? { type: "apiKey" },
        requiresOpenaiAuth: false,
      },
    });
    accountReadCount++;
    return;
  }
  if (method === "skills/list" || method === "model/list") {
    write({ id, result: { data: [] } });
    return;
  }
  if (method === "skills/extraRoots/set") {
    if (
      (message.params.extraRoots.length === 0 && script.collabOnDetach) ||
      (message.params.extraRoots.length > 0 && turnStartCount === 1 && script.collabOnReattach)
    ) {
      writePreviousRootCollaboration();
    }
    for (const notification of script.notificationsOnExtraRoots ?? []) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    write({ id, result: {} });
    return;
  }
  if (method === "thread/start") {
    threadStartCount++;
    if (script.freshThreads) {
      currentThreadId = `${script.rootThreadId}-fresh-${threadStartCount}`;
      write({
        id,
        result: {
          ...fixture.responses.threadStart,
          model: message.params.model ?? fixture.responses.threadStart.model,
          thread: { ...fixture.responses.threadStart.thread, id: currentThreadId },
        },
      });
    } else write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "feedback/upload") {
    for (const notification of script.notificationsOnFeedback ?? []) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    // The response is a deterministic ingress receipt: the real client's
    // sequential decoder handles preceding notifications before resolving it.
    write({ id, result: { threadId: script.rootThreadId } });
    return;
  }
  if (method === "thread/resume") {
    if (script.recordRequests) {
      NodeFS.appendFileSync(
        `${process.env.T3_CODEX_COLLAB_SCRIPT}.requests`,
        `${JSON.stringify({ method, params: message.params })}\n`,
      );
    }
    const threadId = message.params?.threadId;
    const childSnapshot = script.childResumeSnapshots?.[threadId];
    if (script.resumeRequestMarker) {
      write({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: script.rootThreadId,
          requestId: script.resumeRequestMarker,
        },
      });
    }
    if (childSnapshot?.hang) {
      return;
    }
    if (childSnapshot?.error) {
      write({ id, error: { code: -32000, message: childSnapshot.error } });
      return;
    }
    if (childSnapshot) {
      write({
        id,
        result: {
          ...fixture.responses.threadStart,
          model: childSnapshot.model,
          reasoningEffort: childSnapshot.reasoningEffort,
          thread: {
            ...fixture.responses.threadStart.thread,
            id: threadId,
            sessionId: threadId,
          },
        },
      });
      for (const notification of childSnapshot.notifications ?? []) {
        write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
      }
      return;
    }
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    activeTurn = turn;
    turnStartCount += 1;
    if (!script.holdTurnStartResponse)
      write({ id, result: { ...fixture.responses.turnStart, turn } });
    const rootThreadId = currentThreadId;
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    for (const [index, request] of (script.serverRequests ?? []).entries()) {
      if (request.id !== undefined) {
        // Legacy form: caller-supplied JSON-RPC ids recorded in .responses.
        write({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
        continue;
      }
      // Scripted server->client requests (approval prompts). String values in
      // params may reference "${threadId}" / "${turnId}" placeholders that are
      // substituted with the ids this peer actually allocated.
      const requestId = 9000 + index;
      const label = request.label ?? `approval-${requestId}`;
      openServerRequests.set(requestId, { label, itemId: request.params?.itemId });
      const params = JSON.parse(
        JSON.stringify(request.params)
          .replaceAll("${threadId}", String(rootThreadId))
          .replaceAll("${turnId}", String(turn.id)),
      );
      write({ jsonrpc: "2.0", id: requestId, method: request.method, params });
    }
    if (script.holdTurnOpen !== true) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
