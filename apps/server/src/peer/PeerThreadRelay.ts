import {
  OrchestrationV2GetTurnItemResult,
  type OrchestrationV2MessageSentBy,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadStreamItem,
  PEER_LINK_THREAD_HISTORY_ROUTE,
  PEER_LINK_THREAD_ITEM_ROUTE,
  PEER_LINK_THREAD_SEND_ROUTE,
  PEER_LINK_THREAD_STREAM_ROUTE,
  PeerLinkError,
  type PeerLinkThreadHistoryInput,
  type PeerLinkThreadInput,
  type PeerLinkThreadItemInput,
  PeerLinkThreadReadError,
  type PeerLinkThreadSendInput,
  PeerLinkThreadSendResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/**
 * The linked environment sends a heartbeat every 20 seconds, so a stream this quiet has lost its
 * connection without closing it.
 */
const SILENT_STREAM_TIMEOUT = Duration.seconds(75);

/**
 * Relays a linked environment's thread to a client of this environment, over the link this
 * environment already holds. The stream is the linked environment's own thread subscription,
 * passed on item by item; nothing is held here once the client stops listening.
 */
export class PeerThreadRelay extends Context.Service<
  PeerThreadRelay,
  {
    /** A snapshot of the thread, then its live items, until the client or the peer ends it. */
    readonly subscribe: (
      input: PeerLinkThreadInput,
    ) => Stream.Stream<OrchestrationV2ThreadStreamItem, PeerLinkThreadReadError>;
    /** The turns before a snapshot's window, as the owner's client pages them. */
    readonly historyPage: (
      input: PeerLinkThreadHistoryInput,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, PeerLinkThreadReadError>;
    /** One item in full, for a row the reader opens. */
    readonly item: (
      input: PeerLinkThreadItemInput,
    ) => Effect.Effect<OrchestrationV2GetTurnItemResult, PeerLinkThreadReadError>;
    /** Sends a user-origin message to a linked environment's thread over this server's peer link. */
    readonly send: (
      input: PeerLinkThreadSendInput,
      options?: { readonly sentBy?: OrchestrationV2MessageSentBy },
    ) => Effect.Effect<PeerLinkThreadSendResult, PeerLinkError>;
  }
>()("t3/peer/PeerThreadRelay") {}

const decodeStreamItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadStreamItem)),
);
const decodeHistoryPage = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
);
const decodeItem = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));
const decodeSendResult = Schema.decodeUnknownEffect(PeerLinkThreadSendResult);
const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

const unreachable = (label: string, cause?: unknown) =>
  new PeerLinkThreadReadError({
    reason: "unreachable",
    label,
    message: `${label} did not answer.`,
    ...(cause === undefined ? {} : { cause }),
  });

/** A link that cannot be used, as the client that asked hears it. */
const fromLinkError = (error: PeerLinkError, label: string) =>
  new PeerLinkThreadReadError({
    reason:
      error.reason === "unknown_link" ||
      error.reason === "expired" ||
      error.reason === "incompatible"
        ? error.reason
        : "unreachable",
    label,
    message: error.message,
    cause: error,
  });

/** The linked environment's refusal, as the client that asked hears it. */
const fromStatus = (status: number, code: string | undefined, label: string) => {
  if (status === 404 && code === "thread_not_found") {
    return new PeerLinkThreadReadError({
      reason: "thread_not_found",
      label,
      message: `That thread is no longer on ${label}.`,
    });
  }
  // An address that stopped serving the route, as after a downgrade there.
  if (status === 404) {
    return new PeerLinkThreadReadError({
      reason: "incompatible",
      label,
      message: `${label} runs a T3 Code version that does not share its threads over a link. Update it to read its threads from here.`,
    });
  }
  if (status === 401 || status === 403) {
    return new PeerLinkThreadReadError({
      reason: "rejected",
      label,
      message:
        code === "linked_environments_off"
          ? `${label} has Linked environments turned off. Turn it on in its Settings → Labs.`
          : `${label} refused the read. Its link may have been revoked there; link it again.`,
    });
  }
  return unreachable(label, `HTTP ${status}`);
};

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;

  /**
   * Asks the linked environment for `route` of the thread. The response stays open until the
   * scope closes, which is what ends a stream the client stopped listening to.
   */
  const open = Effect.fn("PeerThreadRelay.open")(function* (
    input: PeerLinkThreadInput,
    route: string,
    params: Record<string, string>,
  ): Effect.fn.Return<
    {
      readonly label: string;
      readonly response: HttpClientResponse.HttpClientResponse;
      /** How long the peer may take over the rest of an answer that is not a stream. */
      readonly timeout: Duration.Duration;
    },
    PeerLinkThreadReadError,
    Scope.Scope
  > {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkThreadReadError({
        reason: "disabled",
        label: null,
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const link = yield* links.get(input.environmentId).pipe(
      Effect.mapError(
        (error) =>
          new PeerLinkThreadReadError({
            reason: "unreachable",
            label: null,
            message: "This environment could not read its links.",
            cause: error,
          }),
      ),
    );
    if (Option.isNone(link)) {
      return yield* new PeerLinkThreadReadError({
        reason: "unknown_link",
        label: null,
        message: "This environment is no longer linked to the one this thread is on.",
      });
    }
    const { label } = link.value;
    const resolved = yield* links
      .resolve(input.environmentId)
      .pipe(Effect.mapError((error) => fromLinkError(error, label)));
    if (resolved.capabilities.linkThreadStream !== true) {
      return yield* fromStatus(404, undefined, label);
    }
    const timeout = PeerLinks.probeTimeout(resolved.url);
    const query = new URLSearchParams({ thread: input.threadId, ...params });
    const response = yield* HttpClient.withScope(httpClient)
      .execute(
        HttpClientRequest.get(`${resolved.url}${route}?${query}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
        ),
      )
      .pipe(
        // Bounds the headers only: an open stream stays quiet for as long as the thread does.
        Effect.timeout(timeout),
        Effect.mapError((error) => unreachable(label, error)),
        Effect.tapError((error) =>
          links.recordOutcome(input.environmentId, { error: error.message }),
        ),
      );
    if (response.status !== 200) {
      // A refusal whose body never arrives is still the refusal its status names.
      const refusal = yield* response.json.pipe(
        Effect.timeout(timeout),
        Effect.map(decodeRefusal),
        Effect.orElseSucceed(() => Option.none()),
      );
      const failure = fromStatus(response.status, Option.getOrUndefined(refusal)?.error, label);
      // A refusal is still an answer: the link reached the peer, except where it was turned away.
      yield* links.recordOutcome(input.environmentId, {
        error: failure.reason === "thread_not_found" ? null : failure.message,
      });
      return yield* failure;
    }
    yield* links.recordOutcome(input.environmentId, { error: null });
    // A peer renews a link each time it is used, and says when it now ends.
    const renewed = Option.flatMap(
      Option.fromNullishOr(response.headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
      DateTime.make,
    );
    if (Option.isSome(renewed)) yield* links.recordExpiry(input.environmentId, renewed.value);
    return { label, response, timeout };
  });

  const readJson = <A>(
    opened: ReturnType<typeof open>,
    decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    opened.pipe(
      Effect.flatMap(({ label, response, timeout }) =>
        response.json.pipe(
          // A peer that sends headers and then stalls must not leave the read waiting.
          Effect.timeout(timeout),
          Effect.flatMap(decode),
          Effect.mapError((error) => unreachable(label, error)),
        ),
      ),
      Effect.scoped,
    );

  const subscribe: PeerThreadRelay["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      open(input, PEER_LINK_THREAD_STREAM_ROUTE, {}).pipe(
        Effect.map(({ label, response }) =>
          response.stream.pipe(
            Stream.timeoutOrElse({
              duration: SILENT_STREAM_TIMEOUT,
              orElse: () => Stream.fail(unreachable(label)),
            }),
            Stream.decodeText,
            Stream.pipeThroughChannel(Sse.decode()),
            // An item this version cannot read is skipped, as the owner's own client skips it.
            // That includes an event type from a newer peer, which cannot be encoded again.
            Stream.filterMap((event) => {
              const item = decodeStreamItem(event.data);
              return Option.isSome(item) && item.value.kind !== "unknown-event"
                ? Result.succeed(item.value)
                : Result.failVoid;
            }),
            Stream.mapError((error) =>
              error._tag === "PeerLinkThreadReadError" ? error : unreachable(label, error),
            ),
            // The peer closed the stream: the client hears it and asks again.
            Stream.concat(Stream.fail(unreachable(label))),
          ),
        ),
      ),
    ).pipe(Stream.withSpan("PeerThreadRelay.subscribe"));

  const send: PeerThreadRelay["Service"]["send"] = Effect.fn("PeerThreadRelay.send")(function* (
    input: PeerLinkThreadSendInput,
    options?: { readonly sentBy?: OrchestrationV2MessageSentBy },
  ) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const link = yield* links.get(input.environmentId);
    if (Option.isNone(link)) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: "This environment is no longer linked to the one this thread is on.",
      });
    }
    const { label } = link.value;
    const resolved = yield* links.resolve(input.environmentId);
    const timeout = PeerLinks.probeTimeout(resolved.url);
    const query = new URLSearchParams({ thread: input.threadId });
    const payload = {
      message: input.message,
      ...(options?.sentBy?.founder === undefined ? {} : { founder: options.sentBy.founder }),
      ...(options?.sentBy?.device ? { device: options.sentBy.device } : {}),
      ...(options?.sentBy?.deviceType ? { deviceType: options.sentBy.deviceType } : {}),
    };
    const response = yield* HttpClient.withScope(httpClient)
      .execute(
        HttpClientRequest.post(`${resolved.url}${PEER_LINK_THREAD_SEND_ROUTE}?${query}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
          HttpClientRequest.bodyJsonUnsafe(payload),
        ),
      )
      .pipe(
        Effect.timeout(timeout),
        Effect.mapError(
          (error) =>
            new PeerLinkError({
              reason: "unreachable",
              message: `${label} did not answer.`,
              cause: error,
            }),
        ),
        Effect.tapError((error) =>
          links.recordOutcome(input.environmentId, { error: error.message }),
        ),
      );
    if (response.status !== 200) {
      const refusal = yield* response.json.pipe(
        Effect.timeout(timeout),
        Effect.map(decodeRefusal),
        Effect.orElseSucceed(() => Option.none()),
      );
      const code = Option.getOrUndefined(refusal)?.error;
      const failure =
        response.status === 404 && code === "thread_not_found"
          ? new PeerLinkError({
              reason: "unknown_link",
              message: `That thread is no longer on ${label}.`,
            })
          : response.status === 404
            ? new PeerLinkError({
                reason: "incompatible",
                message: `${label} runs a T3 Code version that does not accept messages over a link. Update it to send messages from here.`,
              })
            : response.status === 401 || response.status === 403
              ? new PeerLinkError({
                  reason: "pairing_rejected",
                  message:
                    code === "read_only_link" ||
                    code === "runtime_mode_ceiling_exceeded" ||
                    code === "link_fence_denied"
                      ? `${label} refused the message because this link does not grant enough access.`
                      : code === "linked_environments_off"
                        ? `${label} has Linked environments turned off. Turn it on in its Settings → Labs.`
                        : `${label} refused the message. Its link may have been revoked there; link it again.`,
                })
              : new PeerLinkError({
                  reason: "unreachable",
                  message: `${label} could not deliver the message (HTTP ${response.status}).`,
                });
      yield* links.recordOutcome(input.environmentId, {
        error: code === "thread_not_found" ? null : failure.message,
      });
      return yield* failure;
    }
    yield* links.recordOutcome(input.environmentId, { error: null });
    const renewed = Option.flatMap(
      Option.fromNullishOr(response.headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
      DateTime.make,
    );
    if (Option.isSome(renewed)) yield* links.recordExpiry(input.environmentId, renewed.value);
    return yield* response.json.pipe(
      Effect.timeout(timeout),
      Effect.flatMap(decodeSendResult),
      Effect.mapError(
        (error) =>
          new PeerLinkError({
            reason: "incompatible",
            message: `${label} answered in a shape this version does not understand.`,
            cause: error,
          }),
      ),
    );
  }, Effect.scoped);

  return PeerThreadRelay.of({
    subscribe,
    historyPage: Effect.fn("PeerThreadRelay.historyPage")((input) =>
      readJson(
        open(input, PEER_LINK_THREAD_HISTORY_ROUTE, { cursor: input.cursor }),
        decodeHistoryPage,
      ),
    ),
    item: Effect.fn("PeerThreadRelay.item")((input) =>
      readJson(open(input, PEER_LINK_THREAD_ITEM_ROUTE, { item: input.itemId }), decodeItem),
    ),
    send,
  });
});

export const layer = Layer.effect(PeerThreadRelay, make);
