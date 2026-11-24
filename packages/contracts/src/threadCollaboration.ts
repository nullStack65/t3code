import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Collaboration state a thread carries: a room it facilitates, promises it made, and the handoff
 * that started it. All of it rides the thread's metadata update and is small enough for the shell.
 */

export const ROOM_MAX_MEMBERS = 8;
export const THREAD_MAX_PROMISES = 10;
export const ROOM_MAX_DECISIONS = 20;

const singleLine = (max: number) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((value) =>
      /[\p{Cc}]/u.test(value) ? "Must be a single line of text." : true,
    ),
  );

const text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const DueAt = IsoDateTime.check(
  Schema.makeFilter((value) =>
    Number.isNaN(Date.parse(value))
      ? "Must be an ISO date-time, such as 2026-11-25T22:00:00Z."
      : true,
  ),
);

export const LinearIssueKey = singleLine(32)
  .check(
    Schema.makeFilter((value) =>
      /^[A-Z][A-Z0-9]*-\d+$/.test(value) ? true : "Must be a Linear issue key, such as ENG-123.",
    ),
  )
  .annotate({
    description: "Linear issue key the room records its decisions on, such as ENG-123.",
  });

/** What opening (or re-opening to change members of) a room writes. */
export const ThreadRoomOpen = Schema.Struct({
  topic: singleLine(200),
  members: Schema.Array(ThreadId).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(ROOM_MAX_MEMBERS),
    Schema.makeFilter((members) =>
      new Set(members).size === members.length ? true : "Each member is listed once.",
    ),
  ),
  linearIssue: Schema.optionalKey(LinearIssueKey),
});
export type ThreadRoomOpen = typeof ThreadRoomOpen.Type;

export const RoomDecision = Schema.Struct({
  text: text(1000),
  owner: Schema.optionalKey(singleLine(80)),
  dueAt: Schema.optionalKey(DueAt),
});
export type RoomDecision = typeof RoomDecision.Type;

/** What the facilitator writes when the room closes. */
export const ThreadRoomClose = Schema.Struct({
  summary: text(4000),
  decisions: Schema.Array(RoomDecision).check(Schema.isMaxLength(ROOM_MAX_DECISIONS)),
});
export type ThreadRoomClose = typeof ThreadRoomClose.Type;

export const ThreadRoom = Schema.Struct({
  ...ThreadRoomOpen.fields,
  openedAt: IsoDateTime,
  closedAt: Schema.optionalKey(IsoDateTime),
  close: Schema.optionalKey(ThreadRoomClose),
});
export type ThreadRoom = typeof ThreadRoom.Type;

export const ThreadPromise = Schema.Struct({
  /** Stable key the thread picks, so it can update or keep the promise later. */
  id: singleLine(64),
  text: singleLine(300),
  dueAt: DueAt,
  owner: Schema.optionalKey(singleLine(80)),
});
export type ThreadPromise = typeof ThreadPromise.Type;

export const StoredThreadPromise = Schema.Struct({
  ...ThreadPromise.fields,
  keptAt: Schema.optionalKey(IsoDateTime),
});
export type StoredThreadPromise = typeof StoredThreadPromise.Type;

export const ThreadHandoff = Schema.Struct({
  from: singleLine(80),
  to: singleLine(80),
  what: text(1000),
  dueAt: Schema.optionalKey(DueAt),
});
export type ThreadHandoff = typeof ThreadHandoff.Type;

export const ThreadCollaboration = Schema.Struct({
  room: Schema.optionalKey(ThreadRoom),
  promises: Schema.optionalKey(Schema.Array(StoredThreadPromise)),
  handoff: Schema.optionalKey(ThreadHandoff),
});
export type ThreadCollaboration = typeof ThreadCollaboration.Type;

/** Read back from storage or a peer. A value a later rule rejects reads as no collaboration. */
export const StoredThreadCollaboration = ThreadCollaboration.pipe(
  Schema.catchDecoding(() => Effect.succeedSome({})),
);

export const ThreadCollaborationUpdate = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open_room"), room: ThreadRoomOpen }),
  Schema.Struct({ type: Schema.Literal("close_room"), close: ThreadRoomClose }),
  Schema.Struct({ type: Schema.Literal("set_promise"), promise: ThreadPromise }),
  Schema.Struct({ type: Schema.Literal("keep_promise"), promiseId: singleLine(64) }),
  Schema.Struct({ type: Schema.Literal("set_handoff"), handoff: Schema.NullOr(ThreadHandoff) }),
]);
export type ThreadCollaborationUpdate = typeof ThreadCollaborationUpdate.Type;

export function isRoomOpen(room: ThreadRoom | undefined): room is ThreadRoom {
  return room !== undefined && room.closedAt === undefined;
}

/** Why an update cannot apply to the current state, or null when it can. */
export function collaborationUpdateError(
  current: ThreadCollaboration | undefined,
  update: ThreadCollaborationUpdate,
): string | null {
  switch (update.type) {
    case "close_room":
      return isRoomOpen(current?.room) ? null : "This thread has no open room to close.";
    case "keep_promise":
      return current?.promises?.some((promise) => promise.id === update.promiseId)
        ? null
        : `No promise with id '${update.promiseId}' on this thread.`;
    case "set_promise": {
      const open = (current?.promises ?? []).filter(
        (promise) => promise.keptAt === undefined && promise.id !== update.promise.id,
      );
      return open.length >= THREAD_MAX_PROMISES
        ? `A thread holds at most ${THREAD_MAX_PROMISES} open promises. Keep one first.`
        : null;
    }
    case "open_room":
      // A closed room keeps its close record; only an open room takes new topic or members.
      return current?.room !== undefined && !isRoomOpen(current.room)
        ? "This thread's room is closed and keeps its record. Open a new room on another thread."
        : null;
    case "set_handoff":
      return null;
  }
}

/**
 * The state after an update. Updates that `collaborationUpdateError` rejects leave the state as it
 * was, so a replayed command can never fail the decider.
 */
export function applyCollaborationUpdate(
  current: ThreadCollaboration | undefined,
  update: ThreadCollaborationUpdate,
  nowIso: string,
): ThreadCollaboration {
  const base = current ?? {};
  if (collaborationUpdateError(base, update) !== null) return base;
  switch (update.type) {
    case "open_room": {
      // Re-opening an open room changes its topic or members without restarting it.
      const openedAt = isRoomOpen(base.room) ? base.room.openedAt : nowIso;
      return { ...base, room: { ...update.room, openedAt } };
    }
    case "close_room":
      return { ...base, room: { ...base.room!, closedAt: nowIso, close: update.close } };
    case "set_promise": {
      const others = (base.promises ?? []).filter((promise) => promise.id !== update.promise.id);
      // Kept promises make room for new ones, earliest due first.
      const kept = others.filter((promise) => promise.keptAt !== undefined);
      const open = others.filter((promise) => promise.keptAt === undefined);
      const keptRoom = Math.max(0, THREAD_MAX_PROMISES - open.length - 1);
      return {
        ...base,
        promises: [...open, ...kept.slice(kept.length - keptRoom), update.promise].sort(byDueAt),
      };
    }
    case "keep_promise":
      return {
        ...base,
        promises: base.promises!.map((promise) =>
          promise.id === update.promiseId && promise.keptAt === undefined
            ? { ...promise, keptAt: nowIso }
            : promise,
        ),
      };
    case "set_handoff": {
      if (update.handoff !== null) return { ...base, handoff: update.handoff };
      const { handoff: _cleared, ...rest } = base;
      return rest;
    }
  }
}

function byDueAt(left: { readonly dueAt: string }, right: { readonly dueAt: string }): number {
  return Date.parse(left.dueAt) - Date.parse(right.dueAt);
}

export type PromiseState = "open" | "overdue" | "kept";

export function promiseState(promise: StoredThreadPromise, nowMs: number): PromiseState {
  if (promise.keptAt !== undefined) return "kept";
  return Date.parse(promise.dueAt) <= nowMs ? "overdue" : "open";
}

/** Open promises, soonest first. */
export function openPromises(
  collaboration: ThreadCollaboration | undefined,
): ReadonlyArray<StoredThreadPromise> {
  return (collaboration?.promises ?? [])
    .filter((promise) => promise.keptAt === undefined)
    .sort(byDueAt);
}

/**
 * The turn note a room's facilitator reads. The facilitator does the fan-out itself with
 * t3_thread_send / t3_thread_wait / t3_thread_read, so the server never runs member turns.
 */
export function roomFacilitatorNote(room: ThreadRoom | undefined): string {
  if (room === undefined || !isRoomOpen(room)) return "";
  return [
    `You facilitate the room "${room.topic}" with members ${room.members.join(", ")}.`,
    "For each founder message: t3_thread_send it to every member (say it comes from this room), t3_thread_wait each, t3_thread_read its reply, then answer here with each member's view attributed by name and a short synthesis. Keep turns fair and ask the founder when members disagree.",
    `When the founder closes the room: t3_thread_update action:'close_room' with the summary and decisions, then post the returned linearComment${room.linearIssue === undefined ? "" : ` on ${room.linearIssue}`} and save the returned memoryEntry with your Linear and memory tools.`,
  ].join("\n");
}

function decisionLine(decision: RoomDecision): string {
  const owner = decision.owner === undefined ? "" : ` (owner: ${decision.owner}`;
  const due =
    decision.dueAt === undefined ? "" : `${owner === "" ? " (" : ", "}due ${decision.dueAt}`;
  return `- ${decision.text}${owner}${due}${owner === "" && due === "" ? "" : ")"}`;
}

/** What a closed room writes out: a Linear comment and a memory entry, as plain text. */
export function roomCloseRecord(room: ThreadRoom): {
  readonly linearIssue: string | null;
  readonly linearComment: string;
  readonly memoryEntry: string;
} | null {
  if (room.close === undefined || room.closedAt === undefined) return null;
  const decisions =
    room.close.decisions.length === 0
      ? ["- No decisions."]
      : room.close.decisions.map(decisionLine);
  const linearComment = [
    `## Room closed: ${room.topic}`,
    "",
    room.close.summary,
    "",
    "### Decisions",
    ...decisions,
    "",
    `Members: ${room.members.join(", ")}. Opened ${room.openedAt}, closed ${room.closedAt}.`,
  ].join("\n");
  const memoryEntry = [
    `Room decision record: ${room.topic} (closed ${room.closedAt}${room.linearIssue === undefined ? "" : `, ${room.linearIssue}`}).`,
    ...decisions,
  ].join("\n");
  return { linearIssue: room.linearIssue ?? null, linearComment, memoryEntry };
}
