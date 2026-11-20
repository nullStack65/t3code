import { type OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";

import type { ThreadTypePolicyFile } from "./ThreadTypePolicy.ts";

export const THREAD_TYPE_POLICY_FIXTURE: ThreadTypePolicyFile = {
  schema: "thread-type-policy-v1",
  source: "closura-agent-config config/thread-type-policy.json",
  decision: "CLO-924",
  context_window: { claude: 200_000, codex: 272_000 },
  default_type: "coding",
  classify: [
    {
      type: "standing",
      top_level_only: true,
      title:
        "^\\s*(cos|ceo|cto|cfo|coo|chief of staff|meta[- ]?thread|lead|eng lead|jeff lead|builder|arc ops|product designer|grok ?bot|pool dispatcher|dispatcher)\\b|\\bstanding (role|session|lane|thread)\\b|\\bdesk\\b",
    },
    {
      type: "conversational",
      top_level_only: true,
      title: "\\bwith kameron\\b|\\bworking session\\b|\\bbrainstorm|\\bkss\\b",
    },
    {
      type: "review",
      top_level_only: false,
      title: "\\b(review|reviewer|re-?review|code-review|second opinion|audit)\\b",
    },
    {
      type: "research",
      top_level_only: false,
      title:
        "\\b(research|analysis|analy[sz]e|investigat\\w*|survey|eval|evals|benchmark|forensic|root cause)\\b",
    },
    {
      type: "ops",
      top_level_only: false,
      title:
        "^\\s*ops\\b|\\b(runner|runners|fleet|failover|tailnet|backups?|alerts?|grafana|ssh)\\b",
    },
  ],
  types: {
    standing: {
      compact_at: 165_000,
      cache_ttl: "1h",
      refused_models: ["gpt-6-astra"],
      summary_cap: 8_000,
    },
    coding: { compact_at: 168_000, cache_ttl: "5m", refused_models: [] },
    review: { compact_at: 120_000, cache_ttl: "5m", refused_models: [] },
    research: { compact_at: 168_000, cache_ttl: "1h", refused_models: [] },
    ops: { compact_at: 168_000, cache_ttl: "5m", refused_models: [] },
    conversational: { compact_at: 168_000, cache_ttl: "5m", refused_models: [] },
  },
};

const threadId = ThreadId.make("thread:thread-type-policy");

export const threadTypeThread = (
  title: string,
  options: { readonly child?: boolean; readonly standing?: boolean } = {},
): Pick<OrchestrationV2AppThread, "id" | "title" | "standing" | "lineage" | "delegatedFrom"> => ({
  id: threadId,
  title,
  lineage: {
    parentThreadId: options.child === true ? ThreadId.make("thread:parent") : null,
    relationshipToParent: options.child === true ? ("subagent" as const) : null,
    rootThreadId: threadId,
  },
  ...(options.standing === true
    ? { standing: { name: "CoS", role: "Chief of staff", avatarId: "owl", accent: "blue" } }
    : {}),
});
