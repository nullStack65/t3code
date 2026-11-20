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
});

export const ThreadTypePolicyFile = Schema.Struct({
  schema: Schema.Literal("thread-type-policy-v1"),
  source: Schema.String,
  decision: Schema.String,
  context_window: TokenCount,
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
  readonly contextWindow: number;
  readonly compactAt: number;
  readonly cacheTtl: "5m" | "1h";
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
    return `${this.model} is refused on ${this.threadType} threads by the Closura thread type policy. Pick another model to continue.`;
  }
}

export const isThreadTypeModelRefusedError = Schema.is(ThreadTypeModelRefusedError);

const MODEL_PREFIXES = ["codex/", "claude/", "openai/", "anthropic/", "magpie-go/"];
const TITLE_TAG = /^\s*\[([a-z]+)\]/;

export function normalizeModel(model: string): string {
  let value = model.trim().toLowerCase();
  for (const prefix of MODEL_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  return value.replaceAll("[1m]", "");
}

const isThreadType = (value: string): value is ThreadType =>
  (THREAD_TYPES as ReadonlyArray<string>).includes(value);

export function classifyThread(
  policy: ThreadTypePolicyFile,
  thread: Pick<OrchestrationV2AppThread, "title" | "standing" | "lineage" | "delegatedFrom">,
): ThreadType {
  if (thread.standing != null) return "standing";
  const title = thread.title ?? "";
  const tag = TITLE_TAG.exec(title)?.[1];
  if (tag !== undefined && isThreadType(tag)) return tag;
  const child = isDelegatedAppThread(thread);
  for (const rule of policy.classify) {
    if (rule.top_level_only && child) continue;
    if (new RegExp(rule.title, "i").test(title)) return rule.type;
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
    contextWindow: policy.context_window,
    compactAt: entry.compact_at,
    cacheTtl: entry.cache_ttl,
  });
}

export function threadTypePolicyPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[THREAD_TYPE_POLICY_PATH_ENV];
  return override !== undefined && override.length > 0
    ? override
    : `${NodeOs.homedir()}/.config/closura/thread-type-policy.json`;
}

const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTypePolicyFile));

export const readThreadTypePolicy = Effect.fn("ThreadTypePolicy.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path).pipe(
    Effect.map((value): string | undefined => value),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.undefined
        : Effect.logWarning("Could not read the thread type policy", { path, error }).pipe(
            Effect.as(undefined),
          ),
    ),
  );
  if (text === undefined) return undefined;
  return yield* decodePolicy(text).pipe(
    Effect.map((value): ThreadTypePolicyFile | undefined => value),
    Effect.catch((error) =>
      Effect.logWarning("Ignoring an invalid thread type policy", { path, error }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
});
