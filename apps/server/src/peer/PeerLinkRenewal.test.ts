import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestratorMcpFailure,
  OrchestratorMcpLinkRenewResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Toolkit } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { linkRenew } from "../mcp/toolkits/orchestrator/handlers.ts";
import { LinkRenewTool } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ModelAlertReactor from "../orchestration-v2/ModelAlertReactor.ts";
import * as PeerLinkRenewal from "./PeerLinkRenewal.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const toolkit = Toolkit.make(LinkRenewTool);
const renewHandlers = McpToolAccess.toLayer(
  toolkit,
  Effect.map(linkRenew, (renew) => ({ t3_link_renew: renew })),
);

type Outcome = Parameters<ModelAlertReactor.ModelAlertReactor["Service"]["linkRenewal"]>[0];

/** A box that renews links, linked from A, with A's renewal sweep and the alerts it raised. */
const setup = (capabilities: { readonly linkRenewal?: boolean } = { linkRenewal: true }) =>
  Effect.gen(function* () {
    const box = descriptorOf("environment-box", "Box", capabilities);
    const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, renewHandlers));
    const context = yield* Layer.build(layerLinkingEnvironment(descriptorOf("environment-a", "A")));
    const links = Context.get(context, PeerLinks.PeerLinks);
    yield* linkTo(links, b, "full-access");
    const outcomes = yield* Ref.make<ReadonlyArray<Outcome>>([]);
    const renewal = yield* PeerLinkRenewal.make.pipe(
      Effect.provide(context),
      Effect.provide(
        Layer.mock(ModelAlertReactor.ModelAlertReactor)({
          linkRenewal: (outcome) => Ref.update(outcomes, (seen) => [...seen, outcome]),
        }),
      ),
    );
    const linkExpiry = links
      .get(box.environmentId)
      .pipe(Effect.map((link) => Option.getOrThrow(link).expiresAt));
    return { box, b, links, context, renewal, outcomes, linkExpiry };
  });

const days = (n: number) => DateTime.makeUnsafe(Duration.toMillis(Duration.days(n)));

it.effect("renews a link inside its last 20 days in place, so it outlives its first 30", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { box, b, links, context, renewal, outcomes, linkExpiry } = yield* setup();
      expect(yield* linkExpiry).toEqual(days(30));
      const [session] = yield* b.linkedSessions;
      const incarnation = yield* links.session(box.environmentId);

      // With 21 days left the sweep leaves the link alone.
      yield* TestClock.adjust(Duration.days(9));
      yield* renewal.sweep;
      expect(yield* linkExpiry).toEqual(days(30));
      expect(yield* Ref.get(outcomes)).toEqual([]);

      // With 19 days left it renews: the same session there, signed for 30 more days.
      yield* TestClock.adjust(Duration.days(2));
      yield* renewal.sweep;
      expect(yield* linkExpiry).toEqual(days(41));
      expect(yield* Ref.get(outcomes)).toEqual([
        { _tag: "renewed", linkedEnvironmentId: box.environmentId },
      ]);
      const after = yield* b.linkedSessions;
      expect(after.map((current) => current.sessionId)).toEqual([session!.sessionId]);
      expect(after[0]!.expiresAt).toEqual(days(41));
      // The same incarnation here, so work bound to the session stays bound.
      expect(yield* links.session(box.environmentId)).toEqual(incarnation);

      // Past the first 30 days the link still works, on the renewed token.
      yield* TestClock.adjust(Duration.days(25));
      const again = yield* Context.get(context, PeerMcpClient.PeerMcpClient).call({
        environmentId: box.environmentId,
        tool: "t3_link_renew",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: OrchestratorMcpLinkRenewResult,
      });
      expect(DateTime.makeUnsafe(again.expiresAt)).toEqual(days(66));
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a peer that cannot renew alerts at once, with why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { renewal, outcomes, linkExpiry } = yield* setup({});
      yield* TestClock.adjust(Duration.days(11));
      yield* renewal.sweep;
      expect(yield* linkExpiry).toEqual(days(30));
      const [outcome] = yield* Ref.get(outcomes);
      expect(outcome).toMatchObject({
        _tag: "failed",
        alert: {
          type: "peer-link-renewal",
          environmentId: "environment-a",
          linkedEnvironmentId: "environment-box",
          linkedLabel: "Box",
          expiresAt: DateTime.formatIso(days(30)),
        },
      });
      expect(outcome?._tag === "failed" && outcome.alert.detail).toContain("cannot renew links");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a session revoked on the peer is not renewed and alerts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { b, renewal, outcomes, linkExpiry } = yield* setup();
      const [session] = yield* b.linkedSessions;
      expect(yield* b.auth.revokeSession(session!.sessionId)).toBe(true);
      yield* TestClock.adjust(Duration.days(11));
      yield* renewal.sweep;
      expect(yield* linkExpiry).toEqual(days(30));
      expect((yield* Ref.get(outcomes)).map((outcome) => outcome._tag)).toEqual(["failed"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an expired link is not tried again and alerts that it needs linking again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { box, b, links, renewal, outcomes } = yield* setup();
      const session = Option.getOrThrow(yield* links.session(box.environmentId));
      const before = (yield* Ref.get(b.bearers)).length;
      yield* TestClock.adjust(Duration.days(31));
      yield* renewal.sweep;
      expect((yield* Ref.get(b.bearers)).length).toBe(before);
      const [outcome] = yield* Ref.get(outcomes);
      expect(outcome).toMatchObject({ _tag: "failed", alert: { linkSession: session } });
      expect(outcome?._tag === "failed" && outcome.alert.detail).toContain("Link it again");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it("a peer that is only off alerts in the link's last week; anything else alerts at once", () => {
  const link = { expiresAt: days(30) };
  const transient = { transient: true, detail: "Box did not answer." };
  const permanent = { transient: false, detail: "revoked" };
  expect(PeerLinkRenewal.renewalDue(link, days(9))).toBe(false);
  expect(PeerLinkRenewal.renewalDue(link, days(10))).toBe(true);
  expect(PeerLinkRenewal.renewalDue(link, days(31))).toBe(true);
  expect(PeerLinkRenewal.alertDue(transient, link, days(22))).toBe(false);
  expect(PeerLinkRenewal.alertDue(transient, link, days(23))).toBe(true);
  expect(PeerLinkRenewal.alertDue(permanent, link, days(11))).toBe(true);
});

const caller = (
  client: Partial<McpInvocationContext.McpClientCaller> | undefined,
  thread?: McpInvocationContext.McpThreadCaller,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-box"),
  requestNamespace: "caller",
  thread,
  client:
    client === undefined
      ? undefined
      : { sessionId: "session", label: "Caller", access: "full-access", ...client },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  linkedEnvironments: true,
});

// Discovery offers the tool to links only. The handler must refuse everyone else on its own.
it.effect.each<{
  readonly name: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly code: OrchestratorMcpFailure["code"];
}>([
  { name: "an outside agent", scope: caller({}), code: "capability_denied" },
  {
    name: "an agent's thread here",
    scope: caller(undefined, {
      threadId: ThreadId.make("thread:agent"),
      providerSessionId: "provider:agent",
      providerInstanceId: ProviderInstanceId.make("codex"),
    }),
    code: "capability_denied",
  },
  {
    name: "a link calling for one of its agent threads",
    scope: caller({
      linked: true,
      senderThread: {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("thread:linked-agent"),
        title: "Agent",
      },
    }),
    code: "capability_denied",
  },
  // The link itself gets past both checks, to where this harness has no auth.
  { name: "the link itself", scope: caller({ linked: true }), code: "orchestration_error" },
])("$name calling t3_link_renew gets $code", ({ scope, code }) =>
  Effect.gen(function* () {
    const built = yield* toolkit;
    const { result } = yield* built
      .handle("t3_link_renew", {})
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
    expect(result).toMatchObject({ code });
  }).pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(renewHandlers)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  ),
);
