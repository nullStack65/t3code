// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off preferSchemaOverJson:off - this test owns a real temp workspace and a real server process.
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { execScriptSource, writeFakeCli } from "../src/testUtils/fakeCli.ts";

const DESKTOP_BOOTSTRAP_TOKEN = "envchk-p1-desktop-bootstrap-token";
const GROK_MODEL = "grok-4.6";
const PROJECT_ID = ProjectId.make("envchk-p1-project");
const THREAD_ID = ThreadId.make("envchk-p1-thread");
const MISSING_THREAD_ID = ThreadId.make("envchk-p1-missing-thread");
const GROK_INSTANCE = ProviderInstanceId.make("grok");
const GROK_MISSING_INSTANCE = ProviderInstanceId.make("grok-missing");

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

interface Fixture {
  readonly baseDir: string;
  readonly root: string;
  readonly fakeDir: string;
  readonly argvLogPath: string;
  readonly wrapperPath: string;
}

const makeFixture = (): Effect.Effect<Fixture> =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const baseDir = yield* Effect.promise(() =>
      fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "envchk-p1-")),
    );
    const root = yield* Effect.promise(() =>
      fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "envchk-p1-root-")),
    );
    const fakeDir = yield* Effect.promise(() =>
      fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "envchk-p1-fake-")),
    );
    const argvLogPath = NodePath.join(fakeDir, "argv.log");
    const mockAgentPath = NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../scripts/acp-mock-agent.ts",
    );
    const wrapperPath = writeFakeCli({
      directory: fakeDir,
      name: "fake-grok-envchk-p1",
      source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
    });
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          NodeChildProcess.execFile("git", ["init", "-q"], { cwd: root }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    return { baseDir, root, fakeDir, argvLogPath, wrapperPath };
  }).pipe(Effect.orDie);

interface SpawnedServer {
  readonly child: NodeChildProcess.ChildProcess;
  readonly port: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const spawnServer = async (input: {
  readonly baseDir: string;
  readonly root: string;
  readonly wrapperPath: string;
  readonly missingPath: string;
  readonly port: number;
}): Promise<SpawnedServer> => {
  const stateDir = NodePath.join(input.baseDir, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const settings = {
    sharedSessionRoot: input.root,
    providers: {
      grok: { enabled: true, binaryPath: input.wrapperPath },
    },
    providerInstances: {
      "grok-missing": {
        driver: "grok",
        enabled: true,
        config: { enabled: true, binaryPath: input.missingPath },
      },
    },
  };
  NodeFS.writeFileSync(NodePath.join(stateDir, "settings.json"), JSON.stringify(settings), "utf8");

  const bootstrapFile = NodePath.join(input.baseDir, "bootstrap.ndjson");
  NodeFS.writeFileSync(
    bootstrapFile,
    `${JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: input.port,
      host: "127.0.0.1",
      desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    })}\n`,
    "utf8",
  );

  const bootstrapFd = NodeFS.openSync(bootstrapFile, "r");
  const appsServerDir = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "src/bin.ts",
      "serve",
      "--bootstrap-fd",
      "3",
      "--base-dir",
      input.baseDir,
      "--port",
      String(input.port),
      "--host",
      "127.0.0.1",
      "--log-level",
      "info",
      input.root,
    ],
    {
      cwd: appsServerDir,
      stdio: ["ignore", "pipe", "pipe", bootstrapFd],
      env: { ...process.env },
    },
  );
  NodeFS.closeSync(bootstrapFd);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, port: input.port, stdout: () => stdout, stderr: () => stderr };
};

const waitForHttp = async (port: number, attempted: () => string): Promise<void> => {
  const url = `http://127.0.0.1:${port}/api/auth/session`;
  // A cold start runs the full migration + module load; on a busy native host
  // that can take tens of seconds, so allow a generous bounded window.
  for (let i = 0; i < 400; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status > 0) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never responded; stderr=\n${attempted()}`);
};

/**
 * Terminates a fixture-owned server and awaits its actual exit before its state
 * directories are removed. Bounded so a wedged process cannot hang cleanup.
 */
const killAndAwaitExit = (child: NodeChildProcess.ChildProcess): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => resolve(), 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGKILL");
      }),
  );

const bootstrapCookie = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: DESKTOP_BOOTSTRAP_TOKEN }),
  });
  if (!response.ok) {
    throw new Error(
      `browser-session bootstrap failed: ${response.status} ${await response.text()}`,
    );
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("bootstrap returned no session cookie");
  return setCookie.split(";")[0] ?? "";
};

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return { cookie, url: next.toString() };
};

const wsRpcProtocolLayer = (wsUrl: string) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      const socket = new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols as string | string[] | undefined,
        cookie ? { headers: { cookie } } : undefined,
      );
      return socket as unknown as globalThis.WebSocket;
    },
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const readFileLines = async (path: string): Promise<ReadonlyArray<string>> => {
  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
};

const activitiesOf = (items: ReadonlyArray<OrchestrationThreadStreamItem>) =>
  items.flatMap((item) =>
    item.kind === "event" && item.event.type === "thread.activity-appended"
      ? [item.event.payload.activity]
      : [],
  );

it.live(
  "ENVCHK:P1 authenticated production WebSocket smoke: preflight warning delivered over the wire",
  () => {
    let cleanupFixture: Fixture | undefined;
    const removeFixture = () =>
      Effect.promise(async () => {
        const fixture = cleanupFixture;
        if (fixture === undefined) return;
        const fs = await import("node:fs/promises");
        await Promise.all([
          fs.rm(fixture.baseDir, { recursive: true, force: true }),
          fs.rm(fixture.fakeDir, { recursive: true, force: true }),
          fs.rm(fixture.root, { recursive: true, force: true }),
        ]);
      });
    return Effect.gen(function* () {
      const fixture = yield* makeFixture();
      cleanupFixture = fixture;
      const port = yield* Effect.promise(findFreePort);
      const missingPath = NodePath.join(fixture.fakeDir, "not-a-real-grok");
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          spawnServer({
            baseDir: fixture.baseDir,
            root: fixture.root,
            wrapperPath: fixture.wrapperPath,
            missingPath,
            port,
          }),
        ),
        (spawned) => killAndAwaitExit(spawned.child),
      );

      yield* Effect.promise(() => waitForHttp(port, server.stderr));
      yield* Effect.logInfo(`ENVCHK_P1_HTTP_READY port=${port}`);
      const startupLog = `${server.stdout()}\n${server.stderr()}`;
      const cookie = yield* Effect.promise(() => bootstrapCookie(port));
      yield* Effect.logInfo(`ENVCHK_P1_BOOTSTRAP_OK cookie_present=${cookie.length > 0}`);

      const wsUrl = `ws://127.0.0.1:${port}/ws#cookie=${encodeURIComponent(cookie)}`;
      const received = yield* Ref.make<ReadonlyArray<OrchestrationThreadStreamItem>>([]);
      const missingReceived = yield* Ref.make<ReadonlyArray<OrchestrationThreadStreamItem>>([]);

      const wsOutcome = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.create",
              commandId: CommandId.make("envchk-p1-project-create"),
              projectId: PROJECT_ID,
              title: "ENVCHK:P1",
              workspaceRoot: fixture.root,
              createdAt: "2026-09-28T00:00:00.000Z",
            });
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.create",
              commandId: CommandId.make("envchk-p1-thread-create"),
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              title: "ENVCHK:P1",
              modelSelection: { instanceId: GROK_INSTANCE, model: GROK_MODEL },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-09-28T00:00:00.000Z",
            });

            const stream = client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            });
            yield* stream.pipe(
              Stream.tap((item) => Ref.update(received, (current) => [...current, item])),
              Stream.runDrain,
              Effect.forkScoped,
            );

            let synchronized = false;
            for (let i = 0; i < 200 && !synchronized; i += 1) {
              const items = yield* Ref.get(received);
              synchronized = items.some((item) => item.kind === "synchronized");
              if (!synchronized) yield* Effect.sleep("50 millis");
            }
            if (!synchronized) {
              return yield* Effect.die(new Error("thread subscription never synchronized"));
            }

            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("envchk-p1-turn-start"),
              threadId: THREAD_ID,
              message: {
                messageId: MessageId.make("envchk-p1-message"),
                role: "user",
                text: "envchk bounded launch probe",
                attachments: [],
              },
              modelSelection: { instanceId: GROK_INSTANCE, model: GROK_MODEL },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: "2026-09-28T00:00:00.000Z",
            });

            let found = false;
            for (let i = 0; i < 400 && !found; i += 1) {
              const items = yield* Ref.get(received);
              found = activitiesOf(items).some((activity) => activity.kind === "launch.preflight");
              if (!found) yield* Effect.sleep("50 millis");
            }

            // Configured-executable failure path: a second grok instance whose
            // configured binary does not exist. The provider session must fail
            // before any model work, and that failure must reach this same
            // authenticated wire subscription.
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.create",
              commandId: CommandId.make("envchk-p1-missing-thread-create"),
              threadId: MISSING_THREAD_ID,
              projectId: PROJECT_ID,
              title: "ENVCHK:P1 missing",
              modelSelection: { instanceId: GROK_MISSING_INSTANCE, model: GROK_MODEL },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-09-28T00:00:00.000Z",
            });
            const missingStream = client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId: MISSING_THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            });
            yield* missingStream.pipe(
              Stream.tap((item) => Ref.update(missingReceived, (current) => [...current, item])),
              Stream.runDrain,
              Effect.forkScoped,
            );
            let missingSynchronized = false;
            for (let i = 0; i < 200 && !missingSynchronized; i += 1) {
              const missingItems = yield* Ref.get(missingReceived);
              missingSynchronized = missingItems.some((item) => item.kind === "synchronized");
              if (!missingSynchronized) yield* Effect.sleep("50 millis");
            }
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("envchk-p1-missing-turn-start"),
              threadId: MISSING_THREAD_ID,
              message: {
                messageId: MessageId.make("envchk-p1-missing-message"),
                role: "user",
                text: "envchk missing executable probe",
                attachments: [],
              },
              modelSelection: { instanceId: GROK_MISSING_INSTANCE, model: GROK_MODEL },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: "2026-09-28T00:00:00.000Z",
            });
            let failureObserved = false;
            for (let i = 0; i < 600 && !failureObserved; i += 1) {
              const missingItems = yield* Ref.get(missingReceived);
              failureObserved = missingItems.some((item) => {
                if (item.kind !== "event") return false;
                if (item.event.type === "thread.activity-appended") {
                  return (
                    (item.event.payload as { activity: { kind: string } }).activity.kind ===
                    "provider.turn.start.failed"
                  );
                }
                if (item.event.type === "thread.session-set") {
                  return (
                    (item.event.payload as { session: { status: string } }).session.status ===
                    "error"
                  );
                }
                return false;
              });
              if (!failureObserved) yield* Effect.sleep("50 millis");
            }
          }),
        ),
      ).pipe(Effect.timeoutOption("90 seconds"));

      if (wsOutcome._tag === "None") {
        return yield* Effect.die(new Error(`WS smoke timed out; stderr=\n${server.stderr()}`));
      }
      yield* Effect.logInfo("ENVCHK_P1_WS_PHASE_DONE");

      const items = yield* Ref.get(received);
      const warning = activitiesOf(items).find((activity) => activity.kind === "launch.preflight");
      if (warning === undefined) {
        return yield* Effect.die(
          new Error(
            `no launch.preflight activity reached the WS subscription; stderr=\n${server.stderr()}`,
          ),
        );
      }
      const summary = (warning as { summary: string }).summary;
      const payload = (warning as { payload: { code?: string; cwd?: string } }).payload;
      const tone = (warning as { tone: string }).tone;
      assert.strictEqual(tone, "error");
      assert.strictEqual(payload.code, "shared-root-git");
      assert.strictEqual(payload.cwd, fixture.root);
      assert.include(summary, fixture.root);
      assert.include(summary, "shared session root");

      const invocations = yield* Effect.promise(() => readFileLines(fixture.argvLogPath));
      const sessionInvocations = invocations.filter((line) => line.startsWith("agent"));

      const eventTypes = items.flatMap((item) => (item.kind === "event" ? [item.event.type] : []));
      const activityDetails = activitiesOf(items).map((activity) => ({
        kind: (activity as { kind: string }).kind,
        tone: (activity as { tone: string }).tone,
        summary: (activity as { summary: string }).summary,
      }));

      const missingItems = yield* Ref.get(missingReceived);
      const missingEventTypes = missingItems.flatMap((item) =>
        item.kind === "event" ? [item.event.type] : [],
      );
      const missingActivityDetails = activitiesOf(missingItems).map((activity) => ({
        kind: (activity as { kind: string }).kind,
        tone: (activity as { tone: string }).tone,
        summary: (activity as { summary: string }).summary,
      }));
      const missingSessions = missingItems.flatMap((item) =>
        item.kind === "event" && item.event.type === "thread.session-set"
          ? [
              {
                status: (item.event.payload as { session: { status: string } }).session.status,
                lastError: (item.event.payload as { session: { lastError: string | null } }).session
                  .lastError,
              },
            ]
          : [],
      );
      const missingFailureDetail = [
        ...missingSessions.map((session) => session.lastError ?? ""),
        ...missingItems.flatMap((item) =>
          item.kind === "event" && item.event.type === "thread.activity-appended"
            ? [JSON.stringify((item.event.payload as { activity: unknown }).activity)]
            : [],
        ),
      ].join("\n");
      const mainFailureText = items
        .filter((item) => item.kind === "event")
        .map((item) => JSON.stringify((item as { event: unknown }).event))
        .join("\n");

      const evidence = {
        port,
        root: fixture.root,
        startupPreflightLogged: startupLog.includes("launch preflight"),
        warning: { tone, code: payload.code, cwd: payload.cwd, summary },
        providerInvocations: invocations,
        sessionStartCount: sessionInvocations.length,
        streamItemCount: items.length,
        eventTypes,
        activityDetails,
        missingExecutable: {
          eventTypes: missingEventTypes,
          activityDetails: missingActivityDetails,
          sessions: missingSessions,
          failureDetail: missingFailureDetail.slice(0, 4000),
          mentionsGrok: missingFailureDetail.includes("grok"),
          mentionsMissingPath: missingFailureDetail.includes("not-a-real-grok"),
        },
        mainThreadFailure: {
          sawTurnStartFailed: activityDetails.some(
            (activity) => activity.kind === "provider.turn.start.failed",
          ),
          failureText: mainFailureText.slice(0, 4000),
        },
      };
      yield* Effect.logInfo(`ENVCHK_P1_EVIDENCE=${JSON.stringify(evidence)}`);
      assert.strictEqual(sessionInvocations.length, 1);
      assert.strictEqual(evidence.startupPreflightLogged, true);
      assert.strictEqual(evidence.mainThreadFailure.sawTurnStartFailed, false);
      const missingSawFailure =
        missingSessions.some((session) => session.status === "error") ||
        missingActivityDetails.some((activity) => activity.kind === "provider.turn.start.failed");
      assert.strictEqual(missingSawFailure, true);
      assert.strictEqual(
        missingFailureDetail.includes("grok") || missingFailureDetail.includes("not-a-real-grok"),
        true,
      );

    }).pipe(
      // Bound the whole attempt (startup, auth, subscription, cleanup), not just
      // the WebSocket phase, so a wedged start cannot hang the run. Generous
      // because a cold native start can take tens of seconds.
      Effect.timeoutOption("180 seconds"),
      Effect.flatMap((outcome) =>
        outcome._tag === "None"
          ? Effect.die(new Error("ENVCHK wire smoke timed out"))
          : Effect.void,
      ),
      // Cleanup runs on success and failure alike: the server is killed and its
      // exit awaited before its state directories are removed.
      Effect.ensuring(removeFixture()),
      Effect.provide(NodeServices.layer),
    );
  },
);
