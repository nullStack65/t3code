import {
  EventFilter,
  EventSelector,
  EventSubscription,
  EventSubscriptionInvalidError,
  EventSubscriptionPhase2Error,
  EventSubscriptionSelectorUnsupportedError,
  OrchestratorMcpFailure,
  QuietHours,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../../../persistence/Errors.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import {
  PullRequestHostRequiredError,
  PullRequestRepositoryInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestUrlInvalidError,
  PullRequestUrlUnavailableError,
} from "../../../pullRequest/pullRequestTarget.ts";
import { PullRequestUnavailableError } from "@t3tools/contracts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PullRequestWatchService.PullRequestWatchService,
];

const DeliveryInput = Schema.Struct({
  immediate: Schema.optional(Schema.Boolean),
  coalesceWindowSeconds: Schema.optional(Schema.Int),
  autoExpireOnClose: Schema.optional(Schema.Boolean),
  onlyWhenIdle: Schema.optional(Schema.Boolean),
  quietHours: Schema.optional(QuietHours),
  maxWakesPerHour: Schema.optional(Schema.Int),
});

export const EventSubscribeInput = Schema.Struct({
  selector: EventSelector,
  events: Schema.Array(EventFilter),
  ignoreAuthors: Schema.optional(Schema.Array(Schema.String)),
  delivery: Schema.optional(DeliveryInput),
});
export type EventSubscribeInput = typeof EventSubscribeInput.Type;

export const EventUnsubscribeInput = Schema.Struct({
  id: Schema.String,
});
export type EventUnsubscribeInput = typeof EventUnsubscribeInput.Type;

const failure = Schema.Union([
  OrchestratorMcpFailure,
  EventSubscriptionPhase2Error,
  EventSubscriptionSelectorUnsupportedError,
  EventSubscriptionInvalidError,
  PersistenceSqlError,
  PersistenceDecodeError,
  PullRequestWatchService.PullRequestWatchFailedError,
  PullRequestWatchService.PullRequestWatchFromSubagentError,
  PullRequestWatchService.PullRequestWatchThreadNotFoundError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestRepositoryInvalidError,
  PullRequestUrlUnavailableError,
  PullRequestUnavailableError,
]);

const SubscribeTool = Tool.make("t3_event_subscribe", {
  description:
    "Subscribe this thread to events. Phase 1 accepts a pull request URL or a thread id. Other selectors and external sources return a typed error and are not stored.",
  parameters: EventSubscribeInput,
  success: EventSubscription,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Subscribe to events")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UnsubscribeTool = Tool.make("t3_event_unsubscribe", {
  description: "Remove one of this thread's event subscriptions. Missing ids return removed=false.",
  parameters: EventUnsubscribeInput,
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Unsubscribe from events")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ListTool = Tool.make("t3_event_list", {
  description: "List this thread's event subscriptions.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ subscriptions: Schema.Array(EventSubscription) }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List event subscriptions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const EventsToolkit = Toolkit.make(SubscribeTool, UnsubscribeTool, ListTool);
