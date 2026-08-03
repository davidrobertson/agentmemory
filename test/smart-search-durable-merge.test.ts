import { expect, it, vi } from "vitest";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

it("keeps an exact durable hit when unrelated hybrid results fill the limit", async () => {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T | undefined) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      let entries = store.get(scope);
      if (!entries) {
        entries = new Map();
        store.set(scope, entries);
      }
      entries.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
  const functions = new Map<string, (data: never) => unknown>();
  const sdk = {
    registerFunction: (id: string, handler: (data: never) => unknown): void => {
      functions.set(id, handler);
    },
    trigger: async (id: string, data: unknown): Promise<unknown> => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(data as never);
    },
  };
  const memory: Memory = {
    id: "mem_exact_page",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    type: "fact",
    title: "exact durable needle",
    content: "exact durable needle",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
    project: "project-a",
    agentId: "agent-a",
  };
  await kv.set(KV.memories, memory.id, memory);
  const hybrid = [0, 1, 2].map((index) => {
    const observation: CompressedObservation = {
      id: `obs_unrelated_${index}`,
      sessionId: "ses_unrelated",
      timestamp: "2026-02-01T00:00:00Z",
      type: "decision",
      title: `unrelated ${index}`,
      facts: [],
      narrative: `unrelated ${index}`,
      concepts: [],
      files: [],
      importance: 5,
      agentId: "agent-a",
    };
    return {
      observation,
      vectorScore: 0.9,
      bm25Score: 0,
      combinedScore: 0.9 - index / 10,
      sessionId: observation.sessionId,
    };
  });
  registerSmartSearchFunction(sdk as never, kv as never, async () => hybrid);

  const result = (await sdk.trigger("mem::smart-search", {
    query: "exact durable needle",
    project: "project-a",
    agentId: "agent-a",
    limit: 3,
    includeLessons: false,
  })) as { results: Array<{ obsId: string; score: number }> };

  expect(result.results.map((item) => item.obsId)).toContain(memory.id);
  expect(result.results).toHaveLength(3);
  expect(result.results.find((item) => item.obsId === memory.id)?.score).toBe(0.7);
});
