import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isRoomOpen,
  openPromises,
  promiseState,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadDecisionRequest,
  type ThreadHandoff,
  type ThreadId,
  type ThreadRoom,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ArrowRightLeftIcon, ClockIcon, SignpostIcon, UsersIcon } from "lucide-react";

import { useNowAcross } from "../../hooks/useDeadline";
import { useQuietThreadShell } from "../../state/entities";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Cards for a thread's room, promises, handoff, and a founder decision with options. They only
 * read the shell; every action fills the composer, so the person still sends the words.
 */
export function useCollaborationBannerItems({
  environmentId,
  shell,
  viewerFounder,
  timestampFormat,
  onCompose,
}: {
  readonly environmentId: EnvironmentId;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly viewerFounder: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onCompose: (text: string) => void;
}): ReadonlyArray<ComposerBannerStackItem> {
  const collaboration = shell?.collaboration;
  const promises = openPromises(collaboration);
  const handoffDueAt = collaboration?.handoff?.dueAt;
  const nowMs = useNowAcross([
    ...promises.map((promise) => Date.parse(promise.dueAt)),
    ...(handoffDueAt === undefined ? [] : [Date.parse(handoffDueAt)]),
  ]);
  const decision = shell?.inbox?.decisionRequest;
  const items: ComposerBannerStackItem[] = [];
  if (decision?.options !== undefined && (viewerFounder ?? decision.founder) === decision.founder) {
    items.push(decisionItem(decision, onCompose));
  }
  if (isRoomOpen(collaboration?.room)) {
    items.push(roomItem(environmentId, collaboration.room, onCompose));
  }
  if (promises.length > 0) {
    const overdue = promises.filter((promise) => promiseState(promise, nowMs) === "overdue");
    const [first] = overdue.length > 0 ? overdue : promises;
    items.push({
      id: "collaboration-promises",
      variant: overdue.length > 0 ? "error" : "info",
      icon: <ClockIcon />,
      title: `${overdue.length > 0 ? "Overdue" : "Promised"}: ${first!.text}`,
      description: [
        `${overdue.length > 0 ? "was due" : "due"} ${formatUpcomingTimestamp(first!.dueAt, timestampFormat, nowMs)}`,
        ...(first!.owner === undefined ? [] : [first!.owner]),
        ...(promises.length > 1
          ? [
              `${promises.length - 1} more open${overdue.length > 1 ? `, ${overdue.length - 1} overdue` : ""}`,
            ]
          : []),
      ].join(" · "),
    });
  }
  if (collaboration?.handoff !== undefined) {
    items.push(handoffItem(collaboration.handoff, timestampFormat, nowMs));
  }
  return items;
}

const replyPrefix = { decision: "Decision", review: "Review", approval: "Approval" } as const;

function decisionItem(
  decision: ThreadDecisionRequest,
  onCompose: (text: string) => void,
): ComposerBannerStackItem {
  return {
    id: "collaboration-decision",
    variant: "warning",
    icon: <SignpostIcon />,
    title: decision.question,
    description: "Pick one to draft your reply.",
    children: (
      <ComposerBanner.Body className="flex flex-col gap-1.5 pt-1 pb-1.5 pe-2">
        {decision.options!.map((option) => {
          const recommended = option.label === decision.recommendation;
          return (
            <div key={option.label} className="flex min-w-0 items-start gap-2">
              <Button
                size="xs"
                variant={recommended ? "default" : "outline"}
                onClick={() => onCompose(`${replyPrefix[decision.kind]}: ${option.label}`)}
              >
                {option.label}
              </Button>
              <span className="min-w-0 pt-0.5 text-xs text-muted-foreground">
                {recommended ? "Recommended. " : ""}
                {option.effect}
              </span>
            </div>
          );
        })}
      </ComposerBanner.Body>
    ),
  };
}

function roomItem(
  environmentId: EnvironmentId,
  room: ThreadRoom,
  onCompose: (text: string) => void,
): ComposerBannerStackItem {
  return {
    id: "collaboration-room",
    variant: "info",
    icon: <UsersIcon />,
    title: `Room: ${room.topic}`,
    description: (
      <>
        {room.members.map((member, index) => (
          <span key={member}>
            {index > 0 ? ", " : ""}
            <RoomMember environmentId={environmentId} threadId={member} />
          </span>
        ))}
        {room.linearIssue === undefined ? null : ` · records to ${room.linearIssue}`}
      </>
    ),
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          onCompose(
            "Close the room: summarize it, list the decisions with owners and due times, and record them.",
          )
        }
      >
        Close room
      </Button>
    ),
  };
}

function RoomMember({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const member = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  return member?.title ?? threadId;
}

function handoffItem(
  handoff: ThreadHandoff,
  timestampFormat: TimestampFormat,
  nowMs: number,
): ComposerBannerStackItem {
  const overdue = handoff.dueAt !== undefined && Date.parse(handoff.dueAt) <= nowMs;
  return {
    id: "collaboration-handoff",
    variant: overdue ? "error" : "default",
    icon: <ArrowRightLeftIcon />,
    title: `${handoff.from} → ${handoff.to}: ${handoff.what}`,
    ...(handoff.dueAt === undefined
      ? {}
      : {
          description: `${overdue ? "was due" : "due"} ${formatUpcomingTimestamp(handoff.dueAt, timestampFormat, nowMs)}`,
        }),
  };
}
