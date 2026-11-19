import { OrchestratorMcpLinkRenewResult, type PeerLink } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelAlertReactor from "../orchestration-v2/ModelAlertReactor.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** A link renews once this little of its 30 days is left, leaving weeks to retry a peer that is off. */
const RENEW_WITHIN_DAYS = 20;
/** A peer that is only off or unreachable is retried quietly until the link has this little left. */
const ALERT_TRANSIENT_WITHIN_DAYS = 7;
const FIRST_SWEEP_AFTER = Duration.minutes(2);
const SWEEP_EVERY = Duration.hours(1);
const RENEW_TIMEOUT = Duration.seconds(60);

/** Why a renewal failed, and whether retrying later can fix it without a person. */
interface RenewalFailure {
  readonly transient: boolean;
  readonly detail: string;
}

/** Whether the sweep tries this link now: inside the renewal window, or already expired. */
export const renewalDue = (link: Pick<PeerLink, "expiresAt">, now: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(link.expiresAt, DateTime.add(now, { days: RENEW_WITHIN_DAYS }));

/** Whether a failed renewal tells the watcher now, rather than retrying quietly. */
export const alertDue = (
  failure: RenewalFailure,
  link: Pick<PeerLink, "expiresAt">,
  now: DateTime.Utc,
) =>
  !failure.transient ||
  DateTime.isLessThanOrEqualTo(
    link.expiresAt,
    DateTime.add(now, { days: ALERT_TRANSIENT_WITHIN_DAYS }),
  );

/**
 * Renews this environment's links before they expire. A link's credential is a 30-day session
 * on the peer; the peer signs the same session again with a later expiry (`t3_link_renew`), so
 * nobody pairs again and work bound to the session stays bound. A link that cannot renew tells
 * the watcher once, through the model alert outbox, until a renewal succeeds.
 */
export class PeerLinkRenewal extends Context.Service<
  PeerLinkRenewal,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Renews every due link once. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/peer/PeerLinkRenewal") {}

export const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const alerts = yield* ModelAlertReactor.ModelAlertReactor;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  /** The new expiry, or why there is none. */
  const attempt = Effect.fnUntraced(function* (link: PeerLink) {
    const resolved = yield* links.resolve(link.environmentId).pipe(
      Effect.mapError((error): RenewalFailure => ({
        transient: error.reason === "unreachable" || error.reason === "storage",
        detail: error.message,
      })),
    );
    if (resolved.capabilities.linkRenewal !== true) {
      return yield* Effect.fail<RenewalFailure>({
        transient: false,
        detail: `${resolved.link.label} runs a T3 Code version that cannot renew links. Update ${resolved.link.label}.`,
      });
    }
    // Full access here narrows nothing: the peer renews the session at the access it already has.
    const renewed = yield* peers
      .call({
        environmentId: link.environmentId,
        tool: "t3_link_renew",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        expectedIncarnation: resolved.incarnation,
        success: OrchestratorMcpLinkRenewResult,
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: RENEW_TIMEOUT,
          orElse: () =>
            Effect.fail({
              code: "orchestration_error" as const,
              message: `${resolved.link.label} did not answer within a minute.`,
            }),
        }),
        Effect.mapError((failure): RenewalFailure => ({
          transient: failure.code !== "capability_denied" && failure.code !== "invalid_request",
          detail: failure.message,
        })),
      );
    const expiresAt = DateTime.make(renewed.expiresAt);
    if (Option.isNone(expiresAt)) {
      return yield* Effect.fail<RenewalFailure>({
        transient: false,
        detail: `${resolved.link.label} answered in a shape this version does not understand. Update both environments.`,
      });
    }
    const kept = yield* links
      .renewed({
        environmentId: link.environmentId,
        incarnation: resolved.incarnation,
        token: renewed.accessToken,
        expiresAt: DateTime.toUtc(expiresAt.value),
      })
      .pipe(
        Effect.mapError((error): RenewalFailure => ({ transient: true, detail: error.message })),
      );
    return { kept, expiresAt: DateTime.toUtc(expiresAt.value) };
  });

  const renewOne = Effect.fnUntraced(function* (link: PeerLink, now: DateTime.Utc) {
    // An expired link's token is refused there, so only linking again brings it back.
    const expired = DateTime.isLessThanOrEqualTo(link.expiresAt, now);
    const outcome = expired
      ? Result.fail<RenewalFailure>({
          transient: false,
          detail: `The link expired before it could renew. Link it again with a new pairing code from ${link.label}.`,
        })
      : yield* Effect.result(attempt(link));
    if (outcome._tag === "Success") {
      if (outcome.success.kept) {
        yield* Effect.logInfo("peer link renewed", {
          linkedEnvironmentId: link.environmentId,
          expiresAt: DateTime.formatIso(outcome.success.expiresAt),
        });
      } else {
        // Forgotten or linked again meanwhile: the new link is fresh, so nothing is left to alert.
        yield* Effect.logInfo("peer link renewed after it was replaced; the renewal was not kept", {
          linkedEnvironmentId: link.environmentId,
        });
      }
      yield* alerts.linkRenewal({ _tag: "renewed", linkedEnvironmentId: link.environmentId });
      return;
    }
    const failure = outcome.failure;
    // The session names this link, so linking again starts a fresh alert. Forgotten between
    // listing and now: nothing is left to renew or report.
    const linkSession = yield* links.session(link.environmentId);
    if (Option.isNone(linkSession)) return;
    if (!expired) {
      yield* Effect.logWarning("peer link renewal failed", {
        linkedEnvironmentId: link.environmentId,
        expiresAt: DateTime.formatIso(link.expiresAt),
        transient: failure.transient,
        detail: failure.detail,
      });
    }
    if (!alertDue(failure, link, now)) return;
    const descriptor = yield* environment.getDescriptor;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* alerts.linkRenewal({
      _tag: "failed",
      alert: {
        type: "peer-link-renewal",
        id: `peer-link-renewal:${link.environmentId}:${nowMs}`,
        environmentId: descriptor.environmentId,
        environmentLabel: descriptor.label,
        linkedEnvironmentId: link.environmentId,
        linkedLabel: link.label,
        linkSession: linkSession.value,
        expiresAt: DateTime.formatIso(link.expiresAt),
        detail: failure.detail,
        occurredAt: DateTime.formatIso(now),
      },
    });
  });

  const sweep: PeerLinkRenewal["Service"]["sweep"] = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const now = yield* DateTime.now;
    const stored = yield* links.stored;
    for (const link of stored) {
      if (!renewalDue(link, now)) continue;
      // One link's defect never stops the others from renewing.
      yield* renewOne(link, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("peer link renewal failed unexpectedly", {
            linkedEnvironmentId: link.environmentId,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("peer link renewal sweep failed", { cause })),
  );

  const start: PeerLinkRenewal["Service"]["start"] = Effect.fn("PeerLinkRenewal.start")(
    function* () {
      yield* forkParked(
        Effect.sleep(FIRST_SWEEP_AFTER).pipe(
          Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)))),
        ),
      );
    },
  );

  return PeerLinkRenewal.of({ start, sweep });
});

export const layer = Layer.effect(PeerLinkRenewal, make);
