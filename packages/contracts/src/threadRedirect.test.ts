import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ThreadId } from "./baseSchemas.ts";
import {
  MAX_REDIRECT_HOPS,
  redirectLinkError,
  resolveActiveThreadTargetWith,
  type ThreadRedirectNode,
} from "./threadRedirect.ts";

const id = (name: string) => ThreadId.make(`thread:${name}`);

/** A thread table: `name -> replacement name` for a retired thread, `null` for a live one. */
const table = (links: Record<string, string | null>, deleted: ReadonlyArray<string> = []) => {
  const lookups: string[] = [];
  const lookup = (threadId: ThreadId) =>
    Effect.sync((): ThreadRedirectNode | null => {
      lookups.push(threadId);
      const name = threadId.replace("thread:", "");
      if (!(name in links)) return null;
      const next = links[name];
      return {
        replacedByThreadId: next === null || next === undefined ? null : id(next),
        deletedAt: deleted.includes(name) ? "2026-01-01T00:00:00.000Z" : null,
      };
    });
  return { lookup, lookups };
};

const chain = (length: number) =>
  Object.fromEntries(
    Array.from({ length: length + 1 }, (_, index) => [
      `n${index}`,
      index === length ? null : `n${index + 1}`,
    ]),
  );

describe("resolveActiveThreadTargetWith", () => {
  it.effect("resolves a live thread to itself in one read", () =>
    Effect.gen(function* () {
      const { lookup, lookups } = table({ live: null });
      const target = yield* resolveActiveThreadTargetWith(lookup, id("live"));
      expect(target).toEqual({ threadId: id("live"), hopCount: 0, retiredChain: [] });
      expect(lookups).toHaveLength(1);
    }),
  );

  it.effect("leaves a missing thread to the caller's own not-found handling", () =>
    Effect.gen(function* () {
      const { lookup } = table({});
      const target = yield* resolveActiveThreadTargetWith(lookup, id("ghost"));
      expect(target.threadId).toBe(id("ghost"));
      expect(target.hopCount).toBe(0);
    }),
  );

  it.effect("follows several hops to the live replacement", () =>
    Effect.gen(function* () {
      const { lookup } = table({ a: "b", b: "c", c: "d", d: null });
      const target = yield* resolveActiveThreadTargetWith(lookup, id("a"));
      expect(target).toEqual({
        threadId: id("d"),
        hopCount: 3,
        retiredChain: [id("a"), id("b"), id("c")],
      });
    }),
  );

  it.effect("follows exactly the maximum number of hops", () =>
    Effect.gen(function* () {
      const { lookup } = table(chain(MAX_REDIRECT_HOPS));
      const target = yield* resolveActiveThreadTargetWith(lookup, id("n0"));
      expect(target.threadId).toBe(id(`n${MAX_REDIRECT_HOPS}`));
      expect(target.hopCount).toBe(MAX_REDIRECT_HOPS);
    }),
  );

  it.effect("fails closed past the maximum number of hops", () =>
    Effect.gen(function* () {
      const { lookup } = table(chain(MAX_REDIRECT_HOPS + 1));
      const error = yield* Effect.flip(resolveActiveThreadTargetWith(lookup, id("n0")));
      expect(error._tag).toBe("ThreadRedirectError");
      expect(error.reason).toBe("too_deep");
    }),
  );

  it.effect("fails closed on a cycle", () =>
    Effect.gen(function* () {
      const { lookup } = table({ a: "b", b: "c", c: "a" });
      const error = yield* Effect.flip(resolveActiveThreadTargetWith(lookup, id("a")));
      expect(error.reason).toBe("cycle");
      expect(error.chain).toEqual([id("a"), id("b"), id("c"), id("a")]);
    }),
  );

  it.effect("fails closed on a self-redirect", () =>
    Effect.gen(function* () {
      const { lookup } = table({ a: "a" });
      const error = yield* Effect.flip(resolveActiveThreadTargetWith(lookup, id("a")));
      expect(error.reason).toBe("cycle");
    }),
  );

  it.effect("fails closed when the replacement is missing", () =>
    Effect.gen(function* () {
      const { lookup } = table({ a: "gone" });
      const error = yield* Effect.flip(resolveActiveThreadTargetWith(lookup, id("a")));
      expect(error.reason).toBe("dead_end");
    }),
  );

  it.effect("fails closed when the replacement is deleted", () =>
    Effect.gen(function* () {
      const { lookup } = table({ a: "b", b: null }, ["b"]);
      const error = yield* Effect.flip(resolveActiveThreadTargetWith(lookup, id("a")));
      expect(error.reason).toBe("dead_end");
    }),
  );
});

describe("redirectLinkError", () => {
  it.effect("accepts a live replacement", () =>
    Effect.gen(function* () {
      const { lookup } = table({ old: null, next: null });
      expect(yield* redirectLinkError(lookup, id("old"), id("next"))).toBeNull();
    }),
  );

  it.effect("refuses a self-redirect", () =>
    Effect.gen(function* () {
      const { lookup } = table({ old: null });
      expect(yield* redirectLinkError(lookup, id("old"), id("old"))).toMatch(/itself/);
    }),
  );

  it.effect("refuses a missing or deleted replacement", () =>
    Effect.gen(function* () {
      const { lookup } = table({ old: null, gone: null }, ["gone"]);
      expect(yield* redirectLinkError(lookup, id("old"), id("nowhere"))).toMatch(/not found/);
      expect(yield* redirectLinkError(lookup, id("old"), id("gone"))).toMatch(/not found/);
    }),
  );

  it.effect("refuses a link that would close a loop", () =>
    Effect.gen(function* () {
      // b -> c already; retiring c behind b would loop.
      const { lookup } = table({ b: "c", c: null });
      expect(yield* redirectLinkError(lookup, id("c"), id("b"))).toMatch(/cycle/);
    }),
  );

  it.effect("refuses a link that would make the chain too long", () =>
    Effect.gen(function* () {
      const { lookup } = table({ head: null, ...chain(MAX_REDIRECT_HOPS + 1) });
      expect(yield* redirectLinkError(lookup, id("head"), id("n0"))).toMatch(/longer/);
    }),
  );

  it.effect("refuses a link whose replacement already has the longest chain", () =>
    Effect.gen(function* () {
      const { lookup } = table({ head: null, ...chain(MAX_REDIRECT_HOPS) });
      expect(yield* redirectLinkError(lookup, id("head"), id("n0"))).toMatch(/longer/);
    }),
  );

  it.effect("accepts a link that lands exactly on the limit", () =>
    Effect.gen(function* () {
      const { lookup } = table({ head: null, ...chain(MAX_REDIRECT_HOPS - 1) });
      expect(yield* redirectLinkError(lookup, id("head"), id("n0"))).toBeNull();
    }),
  );
});
