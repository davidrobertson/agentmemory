import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  persistGraphDelta,
  registerGraphFunction,
} from "../src/functions/graph.js";
import { isGraphObservationProcessed } from "../src/state/graph-observations.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphEdge,
  GraphQueryResult,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
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
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(`<entities>
<entity type="file" name="src/index.ts"><property key="path">src/index.ts</property></entity>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`),
  summarize: vi.fn(),
};

// Structured fields stay empty so the deterministic heuristic pass
// contributes nothing and these tests keep exercising the LLM XML
// parse + persist path in isolation.
const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit index file",
  facts: ["Modified main function"],
  narrative: "Updated index.ts with main function",
  concepts: [],
  files: [],
  importance: 7,
};

describe("Graph Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const ORIG_GRAPH_FLAG = process.env["GRAPH_EXTRACTION_ENABLED"];

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  afterEach(() => {
    if (ORIG_GRAPH_FLAG === undefined) delete process.env["GRAPH_EXTRACTION_ENABLED"];
    else process.env["GRAPH_EXTRACTION_ENABLED"] = ORIG_GRAPH_FLAG;
  });

  it("graph-extract creates nodes and edges from XML response", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);
    expect(nodes.find((n) => n.name === "src/index.ts")).toBeDefined();
    expect(nodes.find((n) => n.name === "main")).toBeDefined();

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("uses");
    expect(await isGraphObservationProcessed(kv as never, testObs.id)).toBe(
      true,
    );
  });

  it("skips an already processed observation before invoking the provider", async () => {
    const first = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };
    expect(first).toMatchObject({ success: true, nodesAdded: 2, edgesAdded: 1 });

    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/different.ts"/>
<entity type="function" name="different"/>
</entities>
<relationships>
<relationship type="uses" source="src/different.ts" target="different"/>
</relationships>`);
    const repeated = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(repeated).toMatchObject({ success: true, nodesAdded: 0, edgesAdded: 0 });
    expect(mockProvider.compress).toHaveBeenCalledTimes(1);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);
    expect(await kv.list<GraphEdge>("mem:graph:edges")).toHaveLength(1);
  });

  it("retries a lookup-index failure without leaving graph records behind", async () => {
    const set = kv.set.bind(kv);
    let rejectNameIndex = true;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === "mem:graph:name-index" && rejectNameIndex) {
        rejectNameIndex = false;
        throw new Error("name index unavailable");
      }
      return set(scope, key, data);
    }) as typeof kv.set;

    const failed = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(failed.success).toBe(false);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(0);

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(retried.success).toBe(true);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);
    expect(await kv.list<GraphEdge>("mem:graph:edges")).toHaveLength(1);
  });

  it.each([
    ["node", "mem:graph:name-shards"],
    ["edge", "mem:graph:adjacency"],
  ])("repairs snapshot state after a post-record %s index failure", async (_kind, failedScope) => {
    const set = kv.set.bind(kv);
    let rejectIndex = true;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === failedScope && rejectIndex) {
        rejectIndex = false;
        throw new Error("derived index unavailable");
      }
      return set(scope, key, data);
    }) as typeof kv.set;

    const failed = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(failed.success).toBe(false);

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(retried.success).toBe(true);
    const snapshot = await kv.get<{
      stats: { totalNodes: number; totalEdges: number };
    }>("mem:graph:snapshot", "current");
    expect(snapshot?.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
  });

  it("repairs endpoint degrees and snapshot state after a post-record failure", async () => {
    const set = kv.set.bind(kv);
    let degreeWrites = 0;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === "mem:graph:node-degree" && ++degreeWrites === 4) {
        throw new Error("second endpoint unavailable");
      }
      return set(scope, key, data);
    }) as typeof kv.set;

    const failed = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(failed.success).toBe(false);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);
    expect(await kv.list<GraphEdge>("mem:graph:edges")).toHaveLength(1);

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(retried.success).toBe(true);

    const edge = (await kv.list<GraphEdge>("mem:graph:edges"))[0];
    expect(await kv.get("mem:graph:node-degree", edge.sourceNodeId)).toBe(1);
    expect(await kv.get("mem:graph:node-degree", edge.targetNodeId)).toBe(1);
    const snapshot = await kv.get<{
      stats: { totalNodes: number; totalEdges: number };
      topEdges: GraphEdge[];
    }>("mem:graph:snapshot", "current");
    expect(snapshot?.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
    expect(snapshot?.topEdges).toHaveLength(1);
  });

  it("retries an adjacency read failure before committing endpoint degrees", async () => {
    const get = kv.get.bind(kv);
    const set = kv.set.bind(kv);
    let adjacencyWrites = 0;
    let rejectDegreeRead = false;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      const result = await set(scope, key, data);
      if (scope === "mem:graph:adjacency" && ++adjacencyWrites === 2) {
        rejectDegreeRead = true;
      }
      return result;
    }) as typeof kv.set;
    kv.get = vi.fn(async <T,>(scope: string, key: string): Promise<T | null> => {
      if (scope === "mem:graph:adjacency" && rejectDegreeRead) {
        rejectDegreeRead = false;
        throw new Error("adjacency read unavailable");
      }
      return get<T>(scope, key);
    }) as typeof kv.get;

    const failed = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(failed.success).toBe(false);
    expect(await isGraphObservationProcessed(kv as never, testObs.id)).toBe(
      false,
    );

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(retried.success).toBe(true);

    const edge = (await kv.list<GraphEdge>("mem:graph:edges"))[0];
    expect(await kv.get("mem:graph:node-degree", edge.sourceNodeId)).toBe(1);
    expect(await kv.get("mem:graph:node-degree", edge.targetNodeId)).toBe(1);
    expect(await isGraphObservationProcessed(kv as never, testObs.id)).toBe(
      true,
    );
  });

  it("clears pre-reset adjacency before reusing a node ID", async () => {
    const resetAt = "2026-02-01T00:00:00.000Z";
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: resetAt,
      dirty: false,
      resetAt,
    });
    await kv.set("mem:graph:name-index", "concept|stable-a", "stable-a");
    await kv.set("mem:graph:nodes", "stable-a", {
      id: "stable-a",
      type: "concept",
      name: "stable-a",
      properties: {},
      sourceObservationIds: [],
      createdAt: resetAt,
    });
    await kv.set("mem:graph:adjacency", "stable-a", ["old-e1", "old-e2"]);

    const nodes: GraphNode[] = [
      {
        id: "stable-a",
        type: "concept",
        name: "stable-a",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-02-02T00:00:00.000Z",
      },
      {
        id: "stable-b",
        type: "concept",
        name: "stable-b",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-02-02T00:00:00.000Z",
      },
    ];
    const edges: GraphEdge[] = [{
      id: "new-edge",
      type: "related_to",
      sourceNodeId: "stable-a",
      targetNodeId: "stable-b",
      weight: 1,
      sourceObservationIds: [],
      createdAt: "2026-02-02T00:00:00.000Z",
    }];

    await persistGraphDelta(kv as never, nodes, edges, []);

    expect(await kv.get("mem:graph:adjacency", "stable-a")).toEqual([
      "new-edge",
    ]);
    expect(await kv.get("mem:graph:node-degree", "stable-a")).toBe(1);
  });

  it("replans an incomplete batch after graph reset", async () => {
    const oldCreatedAt = "2026-01-01T00:00:00.000Z";
    const oldNodes: GraphNode[] = ["stable-a", "stable-b"].map((id) => ({
      id,
      type: "concept",
      name: id,
      properties: { generation: "old" },
      sourceObservationIds: [],
      createdAt: oldCreatedAt,
    }));
    const oldEdge: GraphEdge = {
      id: "stable-edge",
      type: "related_to",
      sourceNodeId: "stable-a",
      targetNodeId: "stable-b",
      weight: 1,
      sourceObservationIds: [],
      createdAt: oldCreatedAt,
    };
    for (const node of oldNodes) {
      await kv.set("mem:graph:nodes", node.id, node);
      await kv.set("mem:graph:name-index", `${node.type}|${node.name}`, node.id);
    }
    await kv.set("mem:graph:edges", oldEdge.id, oldEdge);
    await kv.set(
      "mem:graph:edge-key",
      "stable-a|stable-b|related_to",
      oldEdge.id,
    );
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      topNodes: oldNodes,
      topEdges: [oldEdge],
      topDegrees: { "stable-a": 1, "stable-b": 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { concept: 2 },
        edgesByType: { related_to: 1 },
      },
      updatedAt: oldCreatedAt,
      dirty: false,
    });

    const set = kv.set.bind(kv);
    let rejectFirstIndex = true;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === "mem:graph:name-shards" && rejectFirstIndex) {
        rejectFirstIndex = false;
        throw new Error("index unavailable");
      }
      return set(scope, key, data);
    }) as typeof kv.set;
    await expect(
      persistGraphDelta(kv as never, oldNodes, [oldEdge], ["obs_reset_batch"]),
    ).rejects.toThrow("index unavailable");

    await sdk.trigger("mem::graph-reset", {});
    const reset = await kv.get<{ resetAt: string }>(
      "mem:graph:snapshot",
      "current",
    );
    const newCreatedAt = reset!.resetAt;
    const freshNodes = oldNodes.map((node) => ({
      ...node,
      properties: { generation: "new" },
      createdAt: newCreatedAt,
    }));
    const freshEdge = { ...oldEdge, createdAt: newCreatedAt };

    await persistGraphDelta(
      kv as never,
      freshNodes,
      [freshEdge],
      ["obs_reset_batch"],
    );

    const snapshot = await kv.get<{
      stats: { totalNodes: number; totalEdges: number };
    }>("mem:graph:snapshot", "current");
    expect(snapshot?.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
    const persisted = await kv.get<GraphNode>(
      "mem:graph:nodes",
      "stable-a",
    );
    expect(persisted?.properties).toMatchObject({ generation: "new" });
    expect(persisted!.createdAt > reset!.resetAt).toBe(true);
  });

  it.each([
    ["before persistence", false],
    ["after persistence", true],
  ])("retries a snapshot timeout %s without double-counting", async (_label, persistFirst) => {
    const set = kv.set.bind(kv);
    let rejectSnapshot = true;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === "mem:graph:snapshot" && rejectSnapshot) {
        rejectSnapshot = false;
        if (persistFirst) await set(scope, key, data);
        throw new Error("snapshot acknowledgement timed out");
      }
      return set(scope, key, data);
    }) as typeof kv.set;

    const failed = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(failed.success).toBe(false);

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean };
    expect(retried.success).toBe(true);
    const snapshot = await kv.get<{
      stats: { totalNodes: number; totalEdges: number };
    }>("mem:graph:snapshot", "current");
    expect(snapshot?.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
  });

  it("accounts for an older failed batch after a newer batch succeeds", async () => {
    const firstXml = `<entities>
<entity type="file" name="src/first.ts"/>
<entity type="function" name="first"/>
</entities>
<relationships>
<relationship type="uses" source="src/first.ts" target="first"/>
</relationships>`;
    const secondXml = `<entities>
<entity type="file" name="src/second.ts"/>
<entity type="function" name="second"/>
</entities>
<relationships>
<relationship type="uses" source="src/second.ts" target="second"/>
</relationships>`;
    mockProvider.compress
      .mockResolvedValueOnce(firstXml)
      .mockResolvedValueOnce(secondXml)
      .mockResolvedValueOnce(firstXml);

    const set = kv.set.bind(kv);
    let rejectFirstSnapshot = true;
    kv.set = vi.fn(async (scope: string, key: string, data: unknown) => {
      if (scope === "mem:graph:snapshot" && rejectFirstSnapshot) {
        rejectFirstSnapshot = false;
        throw new Error("first snapshot unavailable");
      }
      return set(scope, key, data);
    }) as typeof kv.set;

    const first = (await sdk.trigger("mem::graph-extract", {
      observations: [{ ...testObs, id: "obs_first" }],
    })) as { success: boolean };
    expect(first.success).toBe(false);

    const second = (await sdk.trigger("mem::graph-extract", {
      observations: [{ ...testObs, id: "obs_second" }],
    })) as { success: boolean };
    expect(second.success).toBe(true);
    expect(
      await kv.get<{ stats: { totalNodes: number; totalEdges: number } }>(
        "mem:graph:snapshot",
        "current",
      ),
    ).toMatchObject({ stats: { totalNodes: 2, totalEdges: 1 } });

    const retried = (await sdk.trigger("mem::graph-extract", {
      observations: [{ ...testObs, id: "obs_first" }],
    })) as { success: boolean };
    expect(retried.success).toBe(true);
    expect(
      await kv.get<{ stats: { totalNodes: number; totalEdges: number } }>(
        "mem:graph:snapshot",
        "current",
      ),
    ).toMatchObject({ stats: { totalNodes: 4, totalEdges: 2 } });
  });

  it("links only current observations when repairing an existing node index", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });
    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    const historicalIds = Array.from(
      { length: 10_000 },
      (_, index) => `historical_${index}`,
    );
    for (const node of nodes) {
      await kv.set("mem:graph:nodes", node.id, {
        ...node,
        sourceObservationIds: [...historicalIds, testObs.id],
      });
    }

    const get = kv.get.bind(kv);
    const historicalStateReads: string[] = [];
    kv.get = vi.fn(async <T,>(scope: string, key: string): Promise<T | null> => {
      if (
        (scope.startsWith("mem:graph:obs-state:v1:") ||
          scope === "mem:graph:obs-nodes") &&
        key.startsWith("historical_")
      ) {
        historicalStateReads.push(key);
      }
      return get<T>(scope, key);
    }) as typeof kv.get;

    const nextObservation = { ...testObs, id: "obs_2" };
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [nextObservation],
    })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(historicalStateReads).toEqual([]);
  });

  it("graph-extract accepts self-closing entity tags", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/index.ts"/>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.some((n) => n.name === "src/index.ts")).toBe(true);
    expect(nodes.some((n) => n.name === "main")).toBe(true);

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
  });

  it("graph-extract tolerates reordered attributes", async () => {
    // Codex CLI's LLM tends to emit attribute order name→type and
    // source→target→type rather than the hard-coded type-first /
    // type/source/target/weight sequence the old parser required.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity name="src/index.ts" type="file"/>
<entity name="main" type="function"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship source="src/index.ts" target="main" type="uses" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.find((n) => n.name === "src/index.ts")?.type).toBe("file");
    expect(nodes.find((n) => n.name === "main")?.type).toBe("function");

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
    expect(edges[0].weight).toBeCloseTo(0.9, 5);
  });

  it("graph-query with search returns matching nodes", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-query", {
      query: "index",
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n) => n.name.includes("index"))).toBe(true);
  });

  it("graph-query with startNodeId does BFS traversal", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    const fileNode = nodes.find((n) => n.name === "src/index.ts")!;

    const result = (await sdk.trigger("mem::graph-query", {
      startNodeId: fileNode.id,
      maxDepth: 2,
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.depth).toBe(2);
  });

  it("graph-stats returns counts by type", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-stats", {})) as {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByType: Record<string, number>;
    };

    expect(result.totalNodes).toBe(2);
    expect(result.totalEdges).toBe(1);
    expect(result.nodesByType.file).toBe(1);
    expect(result.nodesByType.function).toBe(1);
    expect(result.edgesByType.uses).toBe(1);
  });

  it("graph-extract returns error for empty observations", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [],
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("No observations");
  });

  it("caps an unbounded graph-query body to a default page and reports totals", async () => {
    // Seed a graph with more nodes than the default page size.
    const NODE_COUNT = 1200;
    for (let i = 0; i < NODE_COUNT; i++) {
      const node: GraphNode = {
        id: `n_${i.toString().padStart(4, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }
    // A few edges among the first 50 nodes so high-degree ranking has
    // something to grade.
    for (let i = 0; i < 50; i++) {
      const edge: GraphEdge = {
        id: `e_${i}`,
        type: "related_to",
        sourceNodeId: `n_${i.toString().padStart(4, "0")}`,
        targetNodeId: `n_${((i + 1) % 50).toString().padStart(4, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      } as GraphEdge;
      await kv.set("mem:graph:edges", edge.id, edge);
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const unbounded = (await sdk.trigger(
      "mem::graph-query",
      {},
    )) as GraphQueryResult;

    expect(unbounded.totalNodes).toBe(NODE_COUNT);
    expect(unbounded.nodes.length).toBe(500);
    expect(unbounded.truncated).toBe(true);
    expect(unbounded.limit).toBe(500);
    expect(unbounded.offset).toBe(0);
    // The 50 connected nodes should be on the first page since the
    // default ranks by degree.
    const connectedOnPage = unbounded.nodes.filter((n) => /^n_00[0-4]\d$/.test(n.id));
    expect(connectedOnPage.length).toBe(50);
  });

  it("honors limit and offset for paged graph-query traversal", async () => {
    for (let i = 0; i < 50; i++) {
      const node: GraphNode = {
        id: `p_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page1 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    const page2 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 10,
    })) as GraphQueryResult;

    expect(page1.nodes.length).toBe(10);
    expect(page2.nodes.length).toBe(10);
    expect(page1.totalNodes).toBe(50);
    expect(page2.totalNodes).toBe(50);
    expect(page1.truncated).toBe(true);
    // The two pages must not overlap.
    const overlap = page1.nodes.filter((n) =>
      page2.nodes.some((p) => p.id === n.id),
    );
    expect(overlap.length).toBe(0);
  });

  it("clamps an explicit limit above the cap to the cap value", async () => {
    for (let i = 0; i < 10; i++) {
      await kv.set("mem:graph:nodes", `c_${i}`, {
        id: `c_${i}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const huge = (await sdk.trigger("mem::graph-query", {
      limit: 999999,
    })) as GraphQueryResult;
    expect(huge.limit).toBeLessThanOrEqual(5000);
    expect(huge.nodes.length).toBe(10);
    expect(huge.truncated).toBe(false);
  });

  it("paginate excludes edges whose endpoints fall outside the page", async () => {
    for (let i = 0; i < 60; i++) {
      await kv.set("mem:graph:nodes", `x_${i.toString().padStart(3, "0")}`, {
        id: `x_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }
    // Make the first 10 nodes a tightly connected cluster so they
    // rank highest by degree and land on the page deterministically.
    for (let i = 0; i < 10; i++) {
      const next = (i + 1) % 10;
      await kv.set("mem:graph:edges", `cluster_${i}`, {
        id: `cluster_${i}`,
        type: "related_to",
        sourceNodeId: `x_${i.toString().padStart(3, "0")}`,
        targetNodeId: `x_${next.toString().padStart(3, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      });
    }
    // Cross-page edge: source in the high-degree cluster (on page),
    // target is an isolated node (degree 1; cluster nodes have
    // degree 2 so the target ranks below the cap).
    await kv.set("mem:graph:edges", "cross", {
      id: "cross",
      type: "related_to",
      sourceNodeId: "x_005",
      targetNodeId: "x_055",
      weight: 1,
      evidence: [],
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-01T00:00:00Z",
    });

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    // The cross-page edge should not appear in the page response —
    // otherwise the viewer renders a dangling line to a node it
    // doesn't have.
    expect(page.edges.find((e) => e.id === "cross")).toBeUndefined();
    // Cluster edges among page nodes ARE present.
    expect(page.edges.filter((e) => e.id.startsWith("cluster_")).length).toBe(10);
    // totalEdges counts every edge in the full result universe.
    expect(page.totalEdges).toBe(11);
  });

  describe("snapshot cache", () => {
    async function seed(nodeCount: number, edgeCount: number) {
      for (let i = 0; i < nodeCount; i++) {
        await kv.set("mem:graph:nodes", `n_${i}`, {
          id: `n_${i}`,
          type: i % 3 === 0 ? "file" : "function",
          name: `node-${i}`,
          properties: {},
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          observationCount: 1,
          stale: false,
        });
      }
      for (let i = 0; i < edgeCount; i++) {
        const src = `n_${i % nodeCount}`;
        const dst = `n_${(i + 1) % nodeCount}`;
        await kv.set("mem:graph:edges", `e_${i}`, {
          id: `e_${i}`,
          type: i % 2 === 0 ? "uses" : "imports",
          sourceNodeId: src,
          targetNodeId: dst,
          weight: 1,
          evidence: [],
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          stale: false,
        });
      }
    }

    it("snapshot-rebuild persists top-degree subgraph + aggregate stats", async () => {
      await seed(50, 100);
      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", { force: true })) as {
        success: boolean;
        totalNodes: number;
        totalEdges: number;
        topNodes: number;
        topEdges: number;
      };
      expect(result.success).toBe(true);
      expect(result.totalNodes).toBe(50);
      expect(result.totalEdges).toBe(100);
      // 50 nodes is below the SNAPSHOT_TOP_NODES cap, so every node
      // lands in the snapshot.
      expect(result.topNodes).toBe(50);

      const snap = await kv.get<{
        version: number;
        topNodes: unknown[];
        stats: { totalNodes: number; nodesByType: Record<string, number> };
      }>("mem:graph:snapshot", "current");
      expect(snap).not.toBeNull();
      expect(snap!.version).toBe(1);
      expect(snap!.stats.totalNodes).toBe(50);
      // nodesByType reflects every type seen.
      expect(snap!.stats.nodesByType["file"]).toBeGreaterThan(0);
      expect(snap!.stats.nodesByType["function"]).toBeGreaterThan(0);
    });

    it("keeps full provenance in graph records without duplicating it into the snapshot", async () => {
      const sourceObservationIds = Array.from(
        { length: 10_000 },
        (_, index) => `obs_${index}`,
      );
      await kv.set("mem:graph:nodes", "n_provenance", {
        id: "n_provenance",
        type: "concept",
        name: "provenance",
        properties: {},
        sourceObservationIds,
        createdAt: "2026-01-01T00:00:00Z",
      });

      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const raw = await kv.get<{ sourceObservationIds: string[] }>(
        "mem:graph:nodes",
        "n_provenance",
      );
      const snapshot = await kv.get<{
        topNodes: Array<{ sourceObservationIds: string[] }>;
      }>("mem:graph:snapshot", "current");
      const query = (await sdk.trigger(
        "mem::graph-query",
        {},
      )) as GraphQueryResult & { provenanceOmitted?: boolean };

      expect(raw?.sourceObservationIds).toHaveLength(10_000);
      expect(snapshot?.topNodes[0]?.sourceObservationIds).toEqual([]);
      expect(query.provenanceOmitted).toBe(true);
    });

    it("graph-query empty-body branch serves from snapshot once it exists", async () => {
      await seed(20, 30);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;
      expect(result.fromSnapshot).toBe(true);
      expect(result.totalNodes).toBe(20);
      expect(result.totalEdges).toBe(30);
    });

    it("graph-query nodeType filter respects snapshot type counts", async () => {
      await seed(30, 0);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const fileQuery = (await sdk.trigger("mem::graph-query", {
        nodeType: "file",
      })) as GraphQueryResult;
      expect(fileQuery.fromSnapshot).toBe(true);
      // 30 nodes, every 3rd is "file" → 10 files.
      expect(fileQuery.totalNodes).toBe(10);
      for (const n of fileQuery.nodes) {
        expect(n.type).toBe("file");
      }
    });

    it("graph-stats returns from snapshot when not dirty", async () => {
      await seed(15, 25);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
      };
      expect(stats.fromSnapshot).toBe(true);
      expect(stats.totalNodes).toBe(15);
      expect(stats.totalEdges).toBe(25);
    });

    it("graph-extract updates snapshot inline (no kv.list, dirty stays false)", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const snap = await kv.get<{
        dirty: boolean;
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.dirty).toBe(false);
      // testObs produces 2 nodes (src/index.ts, main) + 1 edge.
      expect(snap?.stats.totalNodes).toBeGreaterThanOrEqual(1);
    });

    it("graph-extract maintains name-index for O(1) dedup on re-extract", async () => {
      // First extract creates nodes.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const nameIndex = await kv.get<string>(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(typeof nameIndex).toBe("string");

      // Re-extract the same observation. With name-index lookup the
      // existing node merges; no duplicates.
      const repeated = (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { nodesAdded: number; edgesAdded: number };
      const nodes = await kv.list<{ name: string; type: string }>(
        "mem:graph:nodes",
      );
      const fileNodes = nodes.filter(
        (n) => n.name === "src/index.ts" && n.type === "file",
      );
      expect(fileNodes.length).toBe(1);
      expect(repeated).toMatchObject({ nodesAdded: 0, edgesAdded: 0 });
    });

    it("graph-stats returns empty envelope + warning when no snapshot exists", async () => {
      await seed(5, 5);

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
        warning?: string;
      };
      expect(stats.fromSnapshot).toBe(false);
      expect(stats.totalNodes).toBe(0);
      expect(stats.warning).toMatch(/snapshot-rebuild|graph\/reset/);
    });

    it("graph-reset clears state and writes empty snapshot", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const result = (await sdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
        cleared: Record<string, number>;
      };
      expect(result.success).toBe(true);

      const snap = await kv.get<{
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);

      expect(await isGraphObservationProcessed(kv as never, testObs.id)).toBe(
        false,
      );
      const replayed = (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { success: boolean; nodesAdded: number; edgesAdded: number };
      expect(replayed).toMatchObject({
        success: true,
        nodesAdded: 2,
        edgesAdded: 1,
      });
      expect(await isGraphObservationProcessed(kv as never, testObs.id)).toBe(
        true,
      );
    });

    it("graph-reset writes empty snapshot; legacy rows stay as orphans", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      // Index entries exist after the extract.
      const nameBefore = await kv.get(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(nameBefore).not.toBeNull();

      await sdk.trigger("mem::graph-reset", {});

      const snap = await kv.get<{
        stats: { totalNodes: number; totalEdges: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);
      expect(snap?.stats.totalEdges).toBe(0);
    });

    it("snapshot rebuild keeps reset isolation and counts self-loops once", async () => {
      const oldCreatedAt = "2026-01-01T00:00:00.000Z";
      await kv.set("mem:graph:nodes", "legacy", {
        id: "legacy",
        type: "concept",
        name: "legacy",
        properties: {},
        sourceObservationIds: [],
        createdAt: oldCreatedAt,
      });
      await sdk.trigger("mem::graph-reset", {});
      const reset = await kv.get<{ resetAt: string }>(
        "mem:graph:snapshot",
        "current",
      );
      const currentCreatedAt = new Date(
        Date.parse(reset!.resetAt) + 1,
      ).toISOString();
      await kv.set("mem:graph:nodes", "current", {
        id: "current",
        type: "concept",
        name: "current",
        properties: {},
        sourceObservationIds: [],
        createdAt: currentCreatedAt,
      });
      await kv.set("mem:graph:edges", "self", {
        id: "self",
        type: "related_to",
        sourceNodeId: "current",
        targetNodeId: "current",
        weight: 1,
        sourceObservationIds: [],
        createdAt: currentCreatedAt,
      });

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {
        force: true,
      })) as { success: boolean; totalNodes: number; totalEdges: number };
      const snapshot = await kv.get<{
        resetAt?: string;
        stats: { totalNodes: number; totalEdges: number };
        topDegrees: Record<string, number>;
      }>("mem:graph:snapshot", "current");

      expect(result).toMatchObject({
        success: true,
        totalNodes: 1,
        totalEdges: 1,
      });
      expect(snapshot?.resetAt).toBe(reset?.resetAt);
      expect(snapshot?.stats).toMatchObject({ totalNodes: 1, totalEdges: 1 });
      expect(snapshot?.topDegrees.current).toBe(1);
      expect(await kv.get("mem:graph:node-degree", "current")).toBe(1);
    });
  });

  // CodeRabbit feedback: cover the timeout-budget fallback path and
  // the oversized-corpus rebuild refusal. The hot path never enumerates
  // any more, but the rebuild endpoint AND the BFS / query branches
  // still call kv.list — both need explicit failure-mode tests.
  describe("snapshot write must not fail open", () => {
    async function seedSnapshot(totalNodes: number) {
      await kv.set("mem:graph:snapshot", "current", {
        version: 1,
        topNodes: [],
        topEdges: [],
        topDegrees: {},
        stats: { totalNodes, totalEdges: 0, nodesByType: {}, edgesByType: {} },
        updatedAt: "2026-01-01T00:00:00Z",
        dirty: false,
      });
    }

    async function extractWithFlakySnapshot(kvImpl: ReturnType<typeof mockKV>) {
      registerGraphFunction(sdk as never, kvImpl as never, mockProvider as never);
      return (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { success: boolean; error?: string; nodesAdded?: number };
    }

    function flakyKV(failures: number) {
      let reads = 0;
      const realGet = kv.get.bind(kv);
      return {
        ...kv,
        get: async <T>(scope: string, key: string): Promise<T | null> => {
          if (scope === "mem:graph:snapshot" && reads++ < failures) {
            throw new Error("Invocation timeout after 180000ms: state::get");
          }
          return realGet<T>(scope, key);
        },
      };
    }

    it("a persistent read failure aborts the delta instead of zeroing the snapshot", async () => {
      await seedSnapshot(40000);

      const result = await extractWithFlakySnapshot(flakyKV(Number.POSITIVE_INFINITY));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invocation timeout");

      const snap = await kv.get<{ stats: { totalNodes: number } }>(
        "mem:graph:snapshot",
        "current",
      );
      expect(snap!.stats.totalNodes).toBe(40000);
    });

    it("retries a transient read failure once and then merges onto the real snapshot", async () => {
      await seedSnapshot(40000);

      const result = await extractWithFlakySnapshot(flakyKV(1));

      expect(result.success).toBe(true);
      const snap = await kv.get<{ stats: { totalNodes: number } }>(
        "mem:graph:snapshot",
        "current",
      );
      expect(snap!.stats.totalNodes).toBeGreaterThan(39999);
    });

    it("a snapshot under an unknown schema version aborts instead of reading as empty", async () => {
      await kv.set("mem:graph:snapshot", "current", {
        version: 2,
        stats: { totalNodes: 40000, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      });

      const result = await extractWithFlakySnapshot(kv);

      expect(result.success).toBe(false);
      expect(result.error).toContain("unknown schema version");

      const snap = await kv.get<{ version: number }>("mem:graph:snapshot", "current");
      expect(snap!.version).toBe(2);
    });

    it("an absent snapshot is still a clean first run", async () => {
      const result = await extractWithFlakySnapshot(kv);

      expect(result.success).toBe(true);
      const snap = await kv.get<{ version: number; stats: { totalNodes: number } }>(
        "mem:graph:snapshot",
        "current",
      );
      expect(snap).not.toBeNull();
      expect(snap!.stats.totalNodes).toBe(2);
    });
  });

  describe("snapshot-reported total floor", () => {
    function seedSnapshot(
      stats: { totalNodes: number; nodesByType: Record<string, number> },
      topNodeCount: number,
    ) {
      const topNodes = Array.from({ length: topNodeCount }, (_, i) => ({
        id: `n_${i}`,
        type: "file",
        name: `node-${i}`,
        properties: {},
        sourceObservationIds: [`obs_${i}`],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
        stale: false,
      }));
      return kv.set("mem:graph:snapshot", "current", {
        version: 1,
        topNodes,
        topEdges: [],
        topDegrees: {},
        stats: {
          totalNodes: stats.totalNodes,
          totalEdges: 0,
          nodesByType: stats.nodesByType,
          edgesByType: {},
        },
        updatedAt: "2026-01-01T00:00:00Z",
        dirty: false,
      });
    }

    it("does not report fewer nodes than it returns when the counter is low", async () => {
      await seedSnapshot({ totalNodes: 101, nodesByType: { file: 101 } }, 343);

      const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;

      expect(result.nodes.length).toBe(343);
      expect(result.totalNodes).toBe(343);
      expect(result.truncated).toBe(false);
    });

    it("leaves a healthy counter above the top-N cap alone and raises the banner", async () => {
      await seedSnapshot({ totalNodes: 40000, nodesByType: { file: 40000 } }, 343);

      const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;

      expect(result.nodes.length).toBe(343);
      expect(result.totalNodes).toBe(40000);
      expect(result.truncated).toBe(true);
    });

    it("applies the same floor to the type-filtered total", async () => {
      await seedSnapshot({ totalNodes: 101, nodesByType: { file: 101 } }, 343);

      const result = (await sdk.trigger("mem::graph-query", {
        nodeType: "file",
      })) as GraphQueryResult;

      expect(result.nodes.length).toBe(343);
      expect(result.totalNodes).toBe(343);
      expect(result.truncated).toBe(false);
    });
  });

  describe("budget + tooLarge guards", () => {
    function slowKV(delayMs: number) {
      const base = mockKV();
      return {
        ...base,
        list: async <T>(scope: string): Promise<T[]> => {
          await new Promise((r) => setTimeout(r, delayMs));
          return base.list<T>(scope);
        },
      };
    }

    it("graph-query startNodeId returns warning envelope when enumeration exceeds budget", async () => {
      const slow = slowKV(7000); // > LIVE_ENUMERATION_BUDGET_MS (6000ms)
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, slow as never, mockProvider as never);

      const result = (await localSdk.trigger("mem::graph-query", {
        startNodeId: "n_missing",
      })) as GraphQueryResult;

      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/budget|enumeration/i);
    }, 10000);

    // CodeRabbit raised that slowKV(setTimeout) doesn't simulate a
    // blocked event loop. The real production failure is iii rejecting
    // the trigger with "Invocation stopped" after the worker dies
    // (heartbeat starvation). A rejecting kv.list mock covers that
    // catch-path directly without introducing a busy-wait that would
    // also starve the budget timer and produce a flaky test.
    function rejectingKV() {
      const base = mockKV();
      return {
        ...base,
        list: async <T>(_scope: string): Promise<T[]> => {
          throw new Error("Invocation stopped");
        },
      };
    }

    it("graph-query rejects-from-engine path returns warning envelope (worker-death simulation)", async () => {
      const rejector = rejectingKV();
      const localSdk = mockSdk();
      registerGraphFunction(
        localSdk as never,
        rejector as never,
        mockProvider as never,
      );

      const result = (await localSdk.trigger("mem::graph-query", {
        startNodeId: "n_missing",
      })) as GraphQueryResult;

      expect(result.warning).toBeTruthy();
      expect(result.nodes).toEqual([]);
    });

    it("graph-snapshot-rebuild refuses corpora past REBUILD_SAFE_NODE_CEILING", async () => {
      // Direct-poke the mock store with > 25K node values so kv.list
      // returns them without paying the per-set cost. Each node only
      // needs id/type/name/stale=false for the rebuild path.
      const localKv = mockKV();
      // Walk the implementation detail: mockKV stores entries in a
      // Map under the scope key. Push directly to that map via the
      // public `set` API in a tight loop.
      const COUNT = 25001;
      const sets: Array<Promise<unknown>> = [];
      for (let i = 0; i < COUNT; i++) {
        sets.push(
          localKv.set("mem:graph:nodes", `bn_${i}`, {
            id: `bn_${i}`,
            type: "concept",
            name: `bulk-${i}`,
            properties: {},
            sourceObservationIds: [],
            createdAt: "2026-01-01T00:00:00Z",
            stale: false,
          }),
        );
      }
      await Promise.all(sets);

      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        { force: true },
      )) as { success: boolean; tooLarge?: boolean; totalNodes?: number };
      expect(result.success).toBe(false);
      expect(result.tooLarge).toBe(true);
      expect(result.totalNodes).toBeGreaterThanOrEqual(25001);
    });

    it("graph-snapshot-rebuild refuses on legacy corpus (no snapshot) without force", async () => {
      const localKv = mockKV();
      await localKv.set("mem:graph:nodes", "legacy_n", {
        id: "legacy_n",
        type: "concept",
        name: "legacy",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        stale: false,
      });
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        {},
      )) as { success: boolean; legacyCorpus?: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.legacyCorpus).toBe(true);
      expect(result.error).toMatch(/graph\/reset|force/);
    });

    it("graph-reset is enumeration-free (does not call kv.list)", async () => {
      // Wrap the mock kv.list with a counter; assert it stays at 0
      // across a full reset cycle.
      const localKv = mockKV();
      let listCalls = 0;
      const baseList = localKv.list;
      localKv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(localKv, scope) as Promise<T[]>;
      };
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(listCalls).toBe(0);
    });
  });
});
