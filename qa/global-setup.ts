// @effect-diagnostics nodeBuiltinImport:off - Playwright's runner owns this process, outside the server's Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AUTH_FILE, STATE_DIR, STATE_FILE, type RunState } from "./run-state.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
// Outside the checkout: the server turns off threads without a project when its home is inside a git repository.
const HOME = process.env.T3_QA_HOME ?? NodePath.join(NodeOS.tmpdir(), "t3-qa-home");

// Replay recordings the dev stack ships: free, deterministic turns through the real adapter.
const THREADS = [
  { key: "showcase", title: "QA showcase", model: "showcase", messages: ["Give me a tour"] },
  { key: "todo", title: "QA todo list", model: "todo-list", messages: ["Plan the work"] },
  { key: "approval", title: "QA approval", model: "approval", messages: ["Edit a file"] },
  { key: "question", title: "QA question", model: "question", messages: ["Ask me something"] },
  { key: "multi", title: "QA multi turn", model: "multi-turn", messages: ["First", "Second"] },
  { key: "command", title: "QA command output", model: "command-output", messages: ["Run it"] },
] as const;

const PROJECTS = ["desktop-light", "phone-light", "desktop-dark", "phone-dark"] as const;
// Specs that send messages each get a thread of their own per project.
const SEND_THREADS = PROJECTS.map((project) => ({
  key: `send@${project}`,
  title: `QA send ${project}`,
  model: "showcase",
  messages: ["Seed"],
}));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const cli = (args: ReadonlyArray<string>, allowExit: ReadonlyArray<number> = [0]) => {
  try {
    return NodeChildProcess.execFileSync(
      process.execPath,
      ["apps/server/src/bin.ts", ...args, "--base-dir", HOME],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== undefined && allowExit.includes(failure.status)) {
      return failure.stdout ?? "";
    }
    throw error;
  }
};

const waitFor = async (check: () => Promise<boolean>, what: string, seconds: number) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}.`);
};

const extraHeaders = (): Record<string, string> => {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
};

/** Signs in the way the pairing page does and stores the session cookies as Playwright state. */
const signIn = async (origin: string, credential: string) => {
  const response = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders() },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw new Error(`Sign-in failed with HTTP ${response.status}.`);
  const url = new URL(origin);
  const cookies = response.headers.getSetCookie().flatMap((line) => {
    const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
    const [name = "", ...value] = pair.split("=");
    const flags = Object.fromEntries(
      attributes.map((attribute) => {
        const [key = "", ...rest] = attribute.split("=");
        return [key.toLowerCase(), rest.join("=")];
      }),
    );
    const expires = flags["expires"] === undefined ? -1 : Date.parse(flags["expires"]) / 1000;
    if (expires !== -1 && expires < Date.now() / 1000) return [];
    return [
      {
        name,
        value: value.join("="),
        domain: url.hostname,
        path: flags["path"] ?? "/",
        expires,
        httpOnly: "httponly" in flags,
        secure: "secure" in flags,
        sameSite:
          ({ strict: "Strict", none: "None" } as const)[
            (flags["samesite"] ?? "").toLowerCase() as "strict" | "none"
          ] ?? "Lax",
      },
    ];
  });
  NodeFS.writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }));
};

// The server closes idle keep-alive sockets, and a request that reuses one fails once.
const environmentId = async (origin: string): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`, {
        headers: extraHeaders(),
      });
      return ((await response.json()) as { environmentId: string }).environmentId;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
};

export default async function globalSetup() {
  NodeFS.mkdirSync(STATE_DIR, { recursive: true });
  // `serve.ts` keeps one app running between runs; reuse it while it still answers.
  if (process.env.T3_QA_REUSE === "1" && NodeFS.existsSync(STATE_FILE)) {
    const known = JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as RunState;
    if ((await fetch(`${known.origin}/.well-known/t3/environment`).catch(() => undefined))?.ok)
      return;
  }
  const remote = process.env.T3_QA_BASE_URL;
  if (remote !== undefined && remote !== "") {
    // An existing deployment: its sign-in credential comes from the caller's secret store.
    const credential = process.env.T3_QA_CREDENTIAL;
    if (!credential)
      throw new Error("T3_QA_BASE_URL needs T3_QA_CREDENTIAL (a browser-session credential).");
    await signIn(remote, credential);
    const state: RunState = {
      origin: remote,
      mode: "remote",
      environmentId: await environmentId(remote),
      threads: {},
      projectPath: "",
    };
    NodeFS.writeFileSync(STATE_FILE, JSON.stringify(state));
    return;
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  if (!NodeFS.existsSync(NodePath.join(ROOT, "apps/web/dist/index.html"))) {
    throw new Error(
      "apps/web/dist is missing: run `vp build` in apps/web first (verify.ts does this).",
    );
  }
  NodeFS.rmSync(HOME, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(HOME, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(HOME, "bin"), { recursive: true });
  // Generated text cannot go to the replay agent, so every real provider is off and Codex is a
  // command that only fails: no run reaches a paid model.
  const noModel = NodePath.join(HOME, "bin", "no-model");
  NodeFS.writeFileSync(noModel, "#!/bin/sh\necho 'QA runs no model' >&2\nexit 1\n", {
    mode: 0o755,
  });
  const realProviders = [
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "muse",
    "pi",
    "opencode",
    "antigravity",
  ];
  NodeFS.writeFileSync(
    NodePath.join(HOME, "userdata", "settings.json"),
    JSON.stringify({
      defaultModelSelection: { instanceId: "devReplay", model: "showcase" },
      providerInstances: {
        ...Object.fromEntries(
          realProviders.map((driver) => [
            driver,
            {
              driver,
              enabled: false,
              ...(driver === "codex" ? { config: { binaryPath: noModel } } : {}),
            },
          ]),
        ),
        // What the dev server seeds on its own (seedDevReplayInstance): a free ACP agent that
        // replays recorded turns. Only `--dev-url` servers seed it, and those redirect to Vite.
        devReplay: {
          displayName: "Replay (dev)",
          driver: "acpRegistry",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [NodePath.join(ROOT, "apps/server/scripts/dev-replay-agent.ts")],
          },
        },
      },
    }),
  );
  const log = NodeFS.openSync(NodePath.join(STATE_DIR, "app.log"), "w");
  // The built client is served by the server itself. Its own process group, so one signal ends it.
  const app = NodeChildProcess.spawn(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      HOME,
      "--no-browser",
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        PATH: `${NodePath.join(HOME, "bin")}:${process.env.PATH ?? ""}`,
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
        T3CODE_ENVIRONMENT_LABEL: "QA",
        T3CODE_ENVIRONMENT_MACHINE_KIND: "laptop",
      },
    },
  );
  const stop = () => {
    if (app.pid !== undefined) {
      try {
        process.kill(-app.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
  process.once("exit", stop);
  try {
    await waitFor(
      async () => (await fetch(`${origin}/.well-known/t3/environment`)).ok,
      "the app to answer",
      240,
    );
    console.log("qa: app answers");
    // Only dev servers honor a fixed dev token; a built server signs in with a pairing token.
    const pairing = JSON.parse(
      cli(["auth", "pairing", "create", "--json", "--label", "qa", "--ttl", "1h"]),
    ) as {
      credential: string;
    };
    await signIn(origin, pairing.credential);

    console.log("qa: signed in");
    const project = NodePath.join(HOME, "workspaces", "qa-demo");
    NodeFS.mkdirSync(NodePath.join(project, "src"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, "README.md"),
      "# QA demo\n\nA project for the feature QA suite.\n",
    );
    NodeFS.writeFileSync(NodePath.join(project, "src", "math.ts"), "export const sum = 1 + 1;\n");
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: project, stdio: "ignore" });
    git("init", "--quiet", "--initial-branch=main");
    git("add", "--all");
    git(
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial commit",
    );
    cli(["project", "add", project, "--title", "QA demo"]);

    const threads: Record<string, string> = {};
    for (const spec of [...THREADS, ...SEND_THREADS]) {
      const [first = "Start", ...rest] = spec.messages;
      const started = cli(
        [
          "thread",
          "start",
          project,
          first,
          "--title",
          spec.title,
          "--provider",
          "devReplay",
          "--model",
          spec.model,
          "--wait",
          "--json",
        ],
        [0, 2],
      );
      const { threadId } = JSON.parse(started) as { threadId: string };
      for (const message of rest)
        cli(["thread", "send", threadId, message, "--wait", "--json"], [0, 2]);
      threads[spec.key] = threadId;
    }
    console.log("qa: threads seeded");
    const state: RunState = {
      origin,
      mode: "local",
      environmentId: await environmentId(origin),
      threads,
      projectPath: project,
    };
    NodeFS.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
