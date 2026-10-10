import { describe, it, expect } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { backfillGraphIndexes } from "../src/state/graph-indexes.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, GraphNode, GraphEdge } from "../src/types.js";

const obs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: new Date().toISOString(),
  type: "file_edit",
  title: "Edit auth middleware",
  subtitle: "JWT validation",
  facts: ["Added token check"],
  narrative:
    "Modified the AuthMiddleware in src/middleware/auth.ts to validate JWT tokens",
  concepts: ["authentication", "jwt"],
  files: ["src/middleware/auth.ts"],
  importance: 7,
};

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listed: string[] = [];
  const reads: string[] = [];
  return {
    listed,
    reads,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      reads.push(scope);
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listed.push(scope);
      reads.push(scope);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

async function indexedKV() {
  const kv = mockKV();
  const nodes: GraphNode[] = ["AuthMiddleware", "JWT"].map((name, index) => ({
    id: `node_${index + 1}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [`obs_${index + 1}`],
    createdAt: obs.timestamp,
  }));
  const edge: GraphEdge = {
    id: "edge_1",
    type: "uses",
    sourceNodeId: "node_1",
    targetNodeId: "node_2",
    sourceObservationIds: ["obs_1", "obs_2"],
    createdAt: obs.timestamp,
    weight: 0.8,
  };
  for (const node of nodes) await kv.set(KV.graphNodes, node.id, node);
  await kv.set(KV.graphEdges, edge.id, edge);
  await backfillGraphIndexes(kv as never, nodes, [edge]);
  await kv.set(KV.observations(obs.sessionId), obs.id, obs);
  await kv.set(KV.observations(obs.sessionId), "obs_2", { ...obs, id: "obs_2" });
  kv.reads.length = 0;
  return kv;
}

async function searchWith(graphWeight: number | undefined) {
  const bm25 = new SearchIndex();
  bm25.add(obs);
  const kv = await indexedKV();
  const hybrid =
    graphWeight === undefined
      ? new HybridSearch(bm25, null, null, kv as never)
      : new HybridSearch(bm25, null, null, kv as never, 0.4, 0.6, graphWeight);
  const results = await hybrid.search(
    "AuthMiddleware src/middleware/auth.ts JWT",
    10,
  );
  return {
    results,
    graphLists: kv.listed.filter((s) => s.startsWith("mem:graph:")),
    graphReads: kv.reads.filter((s) => s.startsWith("mem:graph:")),
  };
}

describe("graph weight 0 skips graph retrieval", () => {
  it("control: the default weight contributes indexed graph results", async () => {
    const { results, graphLists } = await searchWith(undefined);
    expect(results.find((result) => result.observation.id === "obs_1")?.graphScore).toBeGreaterThan(0);
    expect(graphLists).toEqual([]);
  });

  it("weight 0 never reads a graph scope", async () => {
    const { graphReads } = await searchWith(0);
    expect(graphReads).toEqual([]);
  });

  it("weight 0 still returns the BM25 result", async () => {
    const { results } = await searchWith(0);
    expect(
      results.map((r) => r.observation?.id ?? (r as { obsId?: string }).obsId),
    ).toContain("obs_1");
  });
});

describe("graph weight 0 also skips vector-chunk graph expansion", () => {
  // Lowercase query with no entity-like tokens, so only the expansion
  // traversal (driven by the top vector hits) can read the graph.
  const embedder = {
    name: "fake",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (t: string[]) => t.map(() => new Float32Array([1, 0, 0])),
  };

  async function vectorSearchWith(graphWeight: number) {
    const bm25 = new SearchIndex();
    bm25.add(obs);
    bm25.add({ ...obs, id: "obs_2" });
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([1, 0, 0]));
    const kv = await indexedKV();
    const hybrid = new HybridSearch(
      bm25,
      vector,
      embedder as never,
      kv as never,
      0.4,
      0.6,
      graphWeight,
    );
    const results = await hybrid.search("validate tokens", 10);
    return {
      results,
      graphReads: kv.reads.filter((sc) => sc.startsWith("mem:graph:")),
      graphLists: kv.listed.filter((sc) => sc.startsWith("mem:graph:")),
    };
  }

  it("control: a positive weight expands through the graph", async () => {
    const { results, graphLists } = await vectorSearchWith(0.3);
    expect(results.find((result) => result.observation.id === "obs_2")?.graphScore).toBeGreaterThan(0);
    expect(graphLists).toEqual([]);
  });

  it("weight 0 does not expand through the graph", async () => {
    expect((await vectorSearchWith(0)).graphReads).toEqual([]);
  });
});
