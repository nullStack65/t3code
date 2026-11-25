import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
  type ThreadMetadataMcpUpdateInput,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const retired = ThreadId.make("thread:redirect-gate:retired");
const live = ThreadId.make("thread:redirect-gate:live");
const fullAccessCaller = ThreadId.make("thread:redirect-gate:full-access");
const supervisedCaller = ThreadId.make("thread:redirect-gate:supervised");
const planCaller = ThreadId.make("thread:redirect-gate:plan");

const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [retired, liveThreadShell(retired, { activeRunId: null })],
  [live, liveThreadShell(live, { activeRunId: null })],
  [fullAccessCaller, liveThreadShell(fullAccessCaller)],
  [supervisedCaller, liveThreadShell(supervisedCaller, { runtimeMode: "approval-required" })],
  [planCaller, liveThreadShell(planCaller, { interactionMode: "plan" })],
]);

const scopeFor = (
  thread: ThreadId | undefined,
  client?: McpInvocationScope["client"],
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test:redirect-gate",
  thread:
    thread === undefined
      ? undefined
      : {
          threadId: thread,
          providerSessionId: `provider:${thread}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const client = (
  access: "read-only" | "approval-required" | "full-access",
  narrowedTo?: { runtimeMode: "auto" | "full-access"; interactionMode: "plan" | "default" },
): NonNullable<McpInvocationScope["client"]> => ({
  sessionId: "session",
  label: "Test client",
  access,
  ...(narrowedTo === undefined ? {} : { narrowedTo }),
});

const setRedirect = (replacedByThreadId: ThreadId | null): ThreadMetadataMcpUpdateInput => ({
  threadId: retired,
  action: "set_redirect",
  replacedByThreadId,
  clientRequestId: "redirect-request",
});

const run = (scope: McpInvocationScope, input: ThreadMetadataMcpUpdateInput) => {
  const dispatched: Array<unknown> = [];
  const layer = ThreadMetadataMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SecureRandom.SecureRandom)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
    const outcome = yield* service.update(scope, input).pipe(
      Effect.map(() => "updated" as const),
      Effect.catch((error) => Effect.succeed(error.code)),
    );
    return { outcome, dispatched };
  }).pipe(Effect.provide(layer));
};

describe("ThreadMetadataMcpService set_redirect authority", () => {
  it.effect("lets a full-access, default-mode thread set and clear a redirect", () =>
    Effect.gen(function* () {
      const set = yield* run(scopeFor(fullAccessCaller), setRedirect(live));
      expect(set.outcome).toBe("updated");
      expect(set.dispatched).toHaveLength(1);
      const cleared = yield* run(scopeFor(fullAccessCaller), setRedirect(null));
      expect(cleared.outcome).toBe("updated");
    }),
  );

  it.effect("lets a full-access client without a thread set a redirect", () =>
    Effect.gen(function* () {
      const set = yield* run(scopeFor(undefined, client("full-access")), setRedirect(live));
      expect(set.outcome).toBe("updated");
    }),
  );

  it.effect("refuses a caller thread in a narrower runtime mode", () =>
    Effect.gen(function* () {
      for (const input of [setRedirect(live), setRedirect(null)]) {
        const denied = yield* run(scopeFor(supervisedCaller), input);
        expect(denied.outcome).toBe("capability_denied");
        expect(denied.dispatched).toHaveLength(0);
      }
    }),
  );

  it.effect("refuses a caller thread in plan mode", () =>
    Effect.gen(function* () {
      const denied = yield* run(scopeFor(planCaller), setRedirect(live));
      expect(denied.outcome).toBe("capability_denied");
      expect(denied.dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses a client below full access, or narrowed below it", () =>
    Effect.gen(function* () {
      const scopes = [
        scopeFor(undefined, client("approval-required")),
        scopeFor(undefined, client("read-only")),
        scopeFor(
          undefined,
          client("full-access", { runtimeMode: "auto", interactionMode: "default" }),
        ),
        scopeFor(
          undefined,
          client("full-access", { runtimeMode: "full-access", interactionMode: "plan" }),
        ),
        // A full-access thread behind a narrowed client keeps the client's cap.
        scopeFor(
          fullAccessCaller,
          client("full-access", { runtimeMode: "auto", interactionMode: "default" }),
        ),
        // No thread and no client is the lowest ceiling.
        scopeFor(undefined),
      ];
      for (const scope of scopes) {
        const denied = yield* run(scope, setRedirect(live));
        expect(denied.outcome).toBe("capability_denied");
        expect(denied.dispatched).toHaveLength(0);
      }
    }),
  );

  it.effect("refuses when the calling thread cannot be read", () =>
    Effect.gen(function* () {
      const denied = yield* run(
        scopeFor(ThreadId.make("thread:redirect-gate:unknown")),
        setRedirect(live),
      );
      expect(denied.outcome).toBe("capability_denied");
      expect(denied.dispatched).toHaveLength(0);
    }),
  );

  it.effect("leaves other metadata updates open to a narrower caller", () =>
    Effect.gen(function* () {
      const renamed = yield* run(scopeFor(supervisedCaller), {
        threadId: retired,
        action: "rename",
        title: "Renamed",
        clientRequestId: "rename-request",
      });
      expect(renamed.outcome).toBe("updated");
    }),
  );
});
