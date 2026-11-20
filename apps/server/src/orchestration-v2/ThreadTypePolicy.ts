import * as NodeOs from "node:os";

import { isDelegatedAppThread, OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const THREAD_TYPE_POLICY_PATH_ENV = "T3_THREAD_TYPE_POLICY_PATH";
export const THREAD_TYPES = [
  "standing",
  "coding",
  "review",
  "research",
  "ops",
  "conversational",
] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

const ThreadTypeName = Schema.Literals(THREAD_TYPES);
const CacheTtl = Schema.Literals(["5m", "1h"]);
const TokenCount = Schema.Int.check(Schema.isGreaterThan(0));

const ThreadTypeEntry = Schema.Struct({
  compact_at: TokenCount,
  cache_ttl: CacheTtl,
  refused_models: Schema.Array(Schema.String),
  summary_cap: Schema.optional(TokenCount),
});

const ContextWindows = Schema.Struct({
  claude: TokenCount,
  codex: TokenCount,
});

export const ThreadTypePolicyFile = Schema.Struct({
  schema: Schema.Literal("thread-type-policy-v1"),
  source: Schema.String,
  decision: Schema.String,
  context_window: ContextWindows,
  default_type: ThreadTypeName,
  classify: Schema.Array(
    Schema.Struct({ type: ThreadTypeName, top_level_only: Schema.Boolean, title: Schema.String }),
  ),
  types: Schema.Struct({
    standing: ThreadTypeEntry,
    coding: ThreadTypeEntry,
    review: ThreadTypeEntry,
    research: ThreadTypeEntry,
    ops: ThreadTypeEntry,
    conversational: ThreadTypeEntry,
  }),
});
export type ThreadTypePolicyFile = typeof ThreadTypePolicyFile.Type;

export interface ThreadTypeLaunch {
  readonly type: ThreadType;
  readonly claudeContextWindow: number;
  readonly codexContextWindow: number;
  readonly compactAt: number;
  readonly cacheTtl: "5m" | "1h";
  readonly summaryCap?: number;
}

export class ThreadTypeModelRefusedError extends Schema.TaggedError<ThreadTypeModelRefusedError>()(
  "ThreadTypeModelRefusedError",
  {
    threadId: ThreadId,
    threadType: Schema.String,
    model: Schema.String,
  },
) {
  override get message(): string {
    return `${this.model} is refused on ${this.threadType} threads by the Closura thread type policy. Pick another model, or tag the title with a type that allows it, such as [coding].`;
  }
}

export const isThreadTypeModelRefusedError = Schema.is(ThreadTypeModelRefusedError);

const TITLE_TAG = /^\s*\[([a-z]+)\]/i;

export function normalizeModel(model: string): string {
  let value = model.trim().toLowerCase();
  const slash = value.lastIndexOf("/");
  if (slash >= 0) value = value.slice(slash + 1);
  if (value.startsWith("openai.")) value = value.slice("openai.".length);
  value = value.replaceAll("[1m]", "");
  if (value.endsWith("-fast")) value = value.slice(0, -"-fast".length);
  return value;
}

const isThreadType = (value: string): value is ThreadType =>
  (THREAD_TYPES as ReadonlyArray<string>).includes(value);

export function classifyThread(
  policy: ThreadTypePolicyFile,
  thread: Pick<OrchestrationV2AppThread, "title" | "standing" | "lineage" | "delegatedFrom">,
): ThreadType {
  if (thread.standing != null) return "standing";
  const title = thread.title ?? "";
  const tag = TITLE_TAG.exec(title)?.[1]?.toLowerCase();
  if (tag !== undefined && isThreadType(tag)) return tag;
  const child = isDelegatedAppThread(thread);
  for (const rule of policy.classify) {
    if (rule.top_level_only && child) continue;
    try {
      if (new RegExp(rule.title, "i").test(title)) return rule.type;
    } catch {
      continue;
    }
  }
  return policy.default_type;
}

export function resolveThreadTypeLaunch(
  policy: ThreadTypePolicyFile,
  thread: Pick<OrchestrationV2AppThread, "id" | "title" | "standing" | "lineage" | "delegatedFrom">,
  model: string,
): Effect.Effect<ThreadTypeLaunch, ThreadTypeModelRefusedError> {
  const type = classifyThread(policy, thread);
  const entry = policy.types[type];
  const bare = normalizeModel(model);
  if (entry.refused_models.map(normalizeModel).includes(bare)) {
    return Effect.fail(
      new ThreadTypeModelRefusedError({ threadId: thread.id, threadType: type, model: bare }),
    );
  }
  return Effect.succeed({
    type,
    claudeContextWindow: policy.context_window.claude,
    codexContextWindow: policy.context_window.codex,
    compactAt: entry.compact_at,
    cacheTtl: entry.cache_ttl,
    ...(entry.summary_cap === undefined ? {} : { summaryCap: entry.summary_cap }),
  });
}

export const SUMMARY_CAP_CHARS_PER_TOKEN = 2;

export function carriedSummaryWithinCap(summaryCap: number, text: string): boolean {
  return Math.ceil(text.length / SUMMARY_CAP_CHARS_PER_TOKEN) <= summaryCap;
}

export function carriedSummaryInstruction(summaryCap: number): string {
  return [
    `The carried summary of this compaction must stay within ${summaryCap} tokens.`,
    `Count one token per ${SUMMARY_CAP_CHARS_PER_TOKEN} characters and stop at ${summaryCap * SUMMARY_CAP_CHARS_PER_TOKEN} characters.`,
    "Keep decisions, open work and exact identifiers; drop narration.",
  ].join(" ");
}

export function threadTypePolicyPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[THREAD_TYPE_POLICY_PATH_ENV];
  return override !== undefined && override.length > 0
    ? override
    : `${NodeOs.homedir()}/.config/closura/thread-type-policy.json`;
}

const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTypePolicyFile));
const policyWarningKeys = new Set<string>();

const warnPolicyOnce = (path: string, state: string, message: string, detail?: unknown) => {
  const key = `${state}|${path}`;
  if (policyWarningKeys.has(key)) return Effect.void;
  policyWarningKeys.add(key);
  return Effect.logWarning(message, detail === undefined ? { path, state } : { path, state, detail });
};

const classifyRulesCompile = (policy: ThreadTypePolicyFile): boolean => {
  for (const rule of policy.classify) {
    try {
      new RegExp(rule.title, "i");
    } catch {
      return false;
    }
  }
  return true;
};

export const readThreadTypePolicy = Effect.fn("ThreadTypePolicy.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path).pipe(
    Effect.map((value): string | undefined => value),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? warnPolicyOnce(
            path,
            "missing",
            "No thread type policy is installed; turns keep their current behavior",
          ).pipe(Effect.as(undefined))
        : warnPolicyOnce(path, "unreadable", "Could not read the thread type policy", error).pipe(
            Effect.as(undefined),
          ),
    ),
  );
  if (text === undefined) return undefined;
  const decoded = yield* decodePolicy(text).pipe(
    Effect.map((value): ThreadTypePolicyFile | undefined => value),
    Effect.catch((error) =>
      warnPolicyOnce(path, "invalid", "Ignoring an invalid thread type policy", error).pipe(
        Effect.as(undefined),
      ),
    ),
  );
  if (decoded === undefined) return undefined;
  if (!classifyRulesCompile(decoded)) {
    yield* warnPolicyOnce(
      path,
      "uncompilable",
      "Ignoring a thread type policy whose title pattern JavaScript cannot compile",
    );
    return undefined;
  }
  return decoded;
});
