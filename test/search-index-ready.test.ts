import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("search index readiness", () => {
  it("shares the cold-start rebuild before direct and smart searches run", async () => {
    // Given: the first rebuild read is held open on an empty index.
    vi.resetModules();
    const firstList = deferred<never[]>();
    const firstListStarted = deferred<void>();
    const listScopes: string[] = [];
    const kv = {
      list: async <T>(scope: string): Promise<T[]> => {
        listScopes.push(scope);
        if (listScopes.length === 1) {
          firstListStarted.resolve();
          return firstList.promise;
        }
        return [];
      },
    };
    const { KV } = await import("../src/state/schema.js");
    const { rebuildKeywordIndex, ensureSearchIndexReady, getSearchIndex, registerSearchFunction } = await import(
      "../src/functions/search.js"
    );
    const handlers = new Map<
      string,
      (data: { query: string }) => Promise<unknown>
    >();
    const sdk = {
      registerFunction: (
        id: string,
        handler: (data: { query: string }) => Promise<unknown>,
      ) => handlers.set(id, handler),
    };
    registerSearchFunction(sdk as never, kv as never);
    const search = vi.spyOn(getSearchIndex(), "search");

    // When: startup, direct search, and the smart-search closure overlap.
    const startup = rebuildKeywordIndex(kv as never);
    await firstListStarted.promise;
    const handler = handlers.get("mem::search");
    if (!handler) throw new Error("mem::search was not registered");
    const directSearch = handler({ query: "auth" });
    const smartSearch = (async () => {
      await ensureSearchIndexReady(kv as never);
      return getSearchIndex().search("auth");
    })();

    // Then: one rebuild owns KV reads and neither search runs early.
    expect(listScopes).toEqual([KV.memories]);
    expect(search).not.toHaveBeenCalled();

    firstList.resolve([]);
    await Promise.all([startup, directSearch, smartSearch]);

    expect(listScopes).toEqual([KV.memories, KV.sessions]);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
