import type { IIIClient } from "iii-sdk";
import type {
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  GraphSnapshot,
  CompressedObservation,
  MemoryProvider,
} from "../types.js";
import {
  KV,
  fingerprintId,
  generateId,
  graphShardKey,
} from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  GRAPH_INDEX_NODE_CEILING,
  GraphIndexReader,
  backfillGraphIndexes,
  clearNameShards,
  graphIndexesReady,
  indexGraphEdge,
  indexGraphNode,
  isLiveGraphRecord,
  loadNameCatalog,
  markGraphIndexesReady,
} from "../state/graph-indexes.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import { isGraphExtractionEnabled } from "../config.js";
import { recordAudit, safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import { scrubRecord } from "./privacy.js";
import {
  isGraphObservationProcessed,
  markGraphObservationsProcessed,
} from "../state/graph-observations.js";

const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;
const SNAPSHOT_KEY = "current";

// `state::list` over a 75K-node scope can exceed the iii invocation
// timeout. The query handler races the enumeration against this budget
// and falls back to the snapshot (or a warning envelope) when the live
// path is too slow. 6000ms leaves headroom under the default 8s engine
// invocation deadline.
const LIVE_ENUMERATION_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

export async function readGraphSnapshot(
  kv: StateKV,
  throwOnError = false,
): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return snap;
    }
    return null;
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readSnapshotStrict(kv: StateKV): Promise<GraphSnapshot | null> {
  let raw: unknown;
  try {
    raw = await kv.get<unknown>(KV.graphSnapshot, SNAPSHOT_KEY);
  } catch (err) {
    logger.warn("Graph snapshot read failed, retrying once", {
      error: err instanceof Error ? err.message : String(err),
    });
    raw = await kv.get<unknown>(KV.graphSnapshot, SNAPSHOT_KEY);
  }
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
    return raw as GraphSnapshot;
  }
  throw new Error(
    `Graph snapshot has unknown schema version: ${JSON.stringify(
      (raw as { version?: unknown }).version,
    )}`,
  );
}

function compactSnapshotNode(node: GraphNode): GraphNode {
  return { ...node, sourceObservationIds: [] };
}

function compactSnapshotEdge(edge: GraphEdge): GraphEdge {
  return { ...edge, sourceObservationIds: [] };
}

function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphSnapshot {
  const liveNodes = nodes.filter((n) => !n.stale);
  const liveEdges = edges.filter((e) => !e.stale);
  // Build the global degree map once so we can both rank by it AND
  // snapshot the per-top-node values into topDegrees for synchronous
  // re-sort after incremental edge writes.
  const degree = new Map<string, number>();
  for (const e of liveEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    if (e.targetNodeId !== e.sourceNodeId) {
      degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
    }
  }
  const ranked = [...liveNodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, SNAPSHOT_TOP_NODES);
  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges = liveEdges.filter(
    (e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) {
    topDegrees[n.id] = degree.get(n.id) ?? 0;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of liveNodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const e of liveEdges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }
  return {
    version: 1,
    topNodes: ranked.map(compactSnapshotNode),
    topEdges: topEdges.map(compactSnapshotEdge),
    topDegrees,
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType,
      edgesByType,
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const totalRaw = filterType
    ? snap.stats.nodesByType[filterType] ?? 0
    : snap.stats.totalNodes;
  const total = Math.max(totalRaw, filteredNodes.length);
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  const degrees: Record<string, number> = {};
  for (const n of pageNodes) {
    const d = snap.topDegrees?.[n.id];
    if (typeof d === "number") degrees[n.id] = d;
  }
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
    provenanceOmitted: true,
    degrees,
  };
}

// #814 v2: the rebuild path won't terminate on corpora large enough
// that kv.list returns a payload too big to JSON.parse without
// starving the iii heartbeat. We don't actually know the corpus size
// without enumerating, but we can refuse to start a rebuild if the
// snapshot's recorded `totalNodes` already exceeds this threshold —
// the rebuild path is unreliable above it, and an incremental
// extract-driven snapshot is the right approach for those corpora.
// Operators above the threshold should use mem::graph-reset and let
// future extracts rebuild incrementally.
const REBUILD_SAFE_NODE_CEILING = GRAPH_INDEX_NODE_CEILING;

// Bounds the index-served BFS in mem::graph-query so a dense corpus
// can't expand into an unbounded number of targeted gets. Hitting the
// cap returns a truncated page with an explanatory warning.
const TRAVERSAL_VISIT_CAP = 5000;

async function queryViaIndexes(
  kv: StateKV,
  query: string,
  limit: number,
  offset: number,
): Promise<GraphQueryResult> {
  const reader = await GraphIndexReader.open(kv);
  const lower = query.toLowerCase();
  const catalog = await loadNameCatalog(kv);
  const matched = new Map<string, GraphNode>();
  for (const entry of catalog) {
    if (!entry.name.toLowerCase().includes(lower)) continue;
    const node = await reader.getNode(entry.id);
    if (node) matched.set(node.id, node);
  }

  const snap = await readGraphSnapshot(kv);
  let partialPropertyCoverage = false;
  for (const node of snap?.topNodes ?? []) {
    if (node.stale || matched.has(node.id)) continue;
    const propMatch = Object.values(node.properties).some(
      (v) => typeof v === "string" && v.toLowerCase().includes(lower),
    );
    if (propMatch) matched.set(node.id, node);
  }
  if (!snap || snap.stats.totalNodes > snap.topNodes.length) {
    partialPropertyCoverage = true;
  }

  const nodes = [...matched.values()];
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const edge of await reader.getIncidentEdges(node.id)) {
      if (edgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  }

  const result = paginate(nodes, edges, 0, limit, offset);
  if (partialPropertyCoverage) {
    return {
      ...result,
      warning:
        "Property-value matches are served from the top-degree snapshot; " +
        "nodes outside it are matched by name only.",
    };
  }
  return result;
}

async function traverseViaIndexes(
  kv: StateKV,
  startNodeId: string,
  nodeType: string | undefined,
  maxDepth: number,
  limit: number,
  offset: number,
): Promise<GraphQueryResult> {
  const reader = await GraphIndexReader.open(kv);
  const visited = new Set<string>();
  const visitedEdges = new Set<string>();
  const resultNodes: GraphNode[] = [];
  const resultEdges: GraphEdge[] = [];
  const queue: Array<{ nodeId: string; depth: number }> = [
    { nodeId: startNodeId, depth: 0 },
  ];
  let capped = false;

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (visited.has(nodeId) || depth > maxDepth) continue;
    if (visited.size >= TRAVERSAL_VISIT_CAP) {
      capped = true;
      break;
    }
    visited.add(nodeId);

    const node = await reader.getNode(nodeId);
    if (node && (!nodeType || node.type === nodeType)) {
      resultNodes.push(node);
    }

    for (const edge of await reader.getIncidentEdges(nodeId)) {
      if (!visitedEdges.has(edge.id)) {
        visitedEdges.add(edge.id);
        resultEdges.push(edge);
      }
      const nextId =
        edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      if (!visited.has(nextId)) {
        queue.push({ nodeId: nextId, depth: depth + 1 });
      }
    }
  }

  const result = paginate(resultNodes, resultEdges, maxDepth, limit, offset);
  if (capped) {
    return {
      ...result,
      truncated: true,
      warning:
        `Traversal stopped after visiting ${TRAVERSAL_VISIT_CAP} nodes. ` +
        `Lower maxDepth or start from a lower-degree node for a complete walk.`,
    };
  }
  return result;
}

function nameIndexKey(type: string, name: string): string {
  return `${type}|${name}`;
}

function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

type GraphBatchPlan = {
  version: 1;
  complete: boolean;
  resetAt?: string;
  nodeIdsByKey: Record<string, string>;
  edgeIdsByKey: Record<string, string>;
  newNodeIds: string[];
  newEdgeIds: string[];
};

function graphBatchId(
  nodes: GraphNode[],
  edges: GraphEdge[],
  observationIds: string[],
): string {
  if (observationIds.length > 0) {
    return fingerprintId("gb", `obs:${[...observationIds].sort().join("\0")}`);
  }
  const nodeKeyById = new Map(
    nodes.map((node) => [node.id, nameIndexKey(node.type, node.name)]),
  );
  const identities = [
    ...nodes.map((node) => `n:${nameIndexKey(node.type, node.name)}`),
    ...edges.map((edge) =>
      `e:${nodeKeyById.get(edge.sourceNodeId) ?? edge.sourceNodeId}|${
        nodeKeyById.get(edge.targetNodeId) ?? edge.targetNodeId
      }|${edge.type}`
    ),
  ];
  return fingerprintId("gb", `graph:${identities.sort().join("\0")}`);
}

function graphBatchScope(batchId: string): string {
  return KV.graphBatchState(graphShardKey(batchId));
}

async function cleanupGraphBatch(
  kv: StateKV,
  snap: GraphSnapshot,
  batchId: string,
  scope: string,
): Promise<void> {
  const applied = snap.appliedBatchIds ?? [];
  try {
    if (applied.includes(batchId)) {
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, {
        ...snap,
        appliedBatchIds: applied.filter((id) => id !== batchId),
      });
    }
    await kv.delete(scope, batchId);
  } catch (err) {
    logger.warn("Graph batch cleanup deferred", {
      batchId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Reconciles a node's degree from its bounded adjacency index and
// maintains the top-N ranking. Absolute writes make retries safe when
// a prior attempt stopped between endpoint updates. Top-N membership
// flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
async function reconcileNodeDegree(
  kv: StateKV,
  snap: GraphSnapshot,
  nodeId: string,
): Promise<number> {
  const edgeIds = await kv.get<string[]>(KV.graphAdjacency, nodeId);
  const next = Array.isArray(edgeIds) ? edgeIds.length : 0;
  await kv.set(KV.graphNodeDegree, nodeId, next);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available — fetch + promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(compactSnapshotNode(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) delete snap.topDegrees[evicted.id];
      snap.topNodes.push(compactSnapshotNode(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (!snap.topEdges.find((e) => e.id === edge.id)) {
      snap.topEdges.push(compactSnapshotEdge(edge));
    }
  }
}

export const MAX_GRAPH_SOURCE_OBSERVATIONS = 32;

export function boundSources(existing: string[], incoming: string[]): string[] {
  const merged = new Set(existing);
  for (const id of incoming) {
    merged.delete(id);
    merged.add(id);
  }
  return [...merged].slice(-MAX_GRAPH_SOURCE_OBSERVATIONS);
}

export function boundRecordSources<R extends object>(record: R): R {
  const sources = (record as { sourceObservationIds?: unknown } | null)?.sourceObservationIds;
  if (!Array.isArray(sources) || sources.length <= MAX_GRAPH_SOURCE_OBSERVATIONS) return record;
  return { ...record, sourceObservationIds: boundSources([], sources as string[]) };
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  capturedAt: string,
): GraphNode {
  return {
    ...existing,
    sourceObservationIds: boundSources(
      existing.sourceObservationIds ?? [],
      incoming.sourceObservationIds ?? [],
    ),
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
  };
}

function mergeEdge(existing: GraphEdge, incoming: GraphEdge): GraphEdge {
  return {
    ...existing,
    sourceObservationIds: boundSources(
      existing.sourceObservationIds ?? [],
      incoming.sourceObservationIds ?? [],
    ),
  };
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when BOTH endpoints land in the page — half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseGraphXml(
  xml: string,
  observationIds: string[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();

  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"];
    if (!type || !name) return;
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      properties[propMatch[1]] = propMatch[2];
    }
    nodes.push({
      id: generateId("gn"),
      type,
      name,
      properties,
      sourceObservationIds: observationIds,
      createdAt: now,
    });
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const relRegex = /<relationship\b([^>]*?)\/>/g;
  while ((match = relRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceName = attrs["source"];
    const targetName = attrs["target"];
    if (!type || !sourceName || !targetName) continue;
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;

    const sourceNode = nodes.find((n) => n.name === sourceName);
    const targetNode = nodes.find((n) => n.name === targetName);
    if (!sourceNode || !targetNode) continue;
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      sourceObservationIds: observationIds,
      createdAt: now,
    });
  }

  return { nodes, edges };
}

const HEURISTIC_EDGE_WEIGHT = 0.4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;

export function extractGraphHeuristics(
  observations: CompressedObservation[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeByPair = new Map<string, GraphEdge>();

  const nodeFor = (
    type: GraphNode["type"],
    name: string,
    obsId: string,
  ): GraphNode | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = `${type} ${trimmed.toLowerCase()}`;
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: generateId("gn"),
        type,
        name: trimmed,
        properties: {},
        sourceObservationIds: [obsId],
        createdAt: now,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    } else if (!node.sourceObservationIds.includes(obsId)) {
      node.sourceObservationIds.push(obsId);
    }
    return node;
  };

  for (const obs of observations) {
    let budget = MAX_HEURISTIC_EDGES_PER_OBS;
    const link = (a: GraphNode | null, b: GraphNode | null): void => {
      if (!a || !b || a.id === b.id) return;
      const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = edgeByPair.get(pair);
      if (existing) {
        if (!existing.sourceObservationIds.includes(obs.id)) {
          existing.sourceObservationIds.push(obs.id);
        }
        return;
      }
      if (budget <= 0) return;
      budget -= 1;
      const edge: GraphEdge = {
        id: generateId("ge"),
        type: "related_to",
        sourceNodeId: a.id,
        targetNodeId: b.id,
        weight: HEURISTIC_EDGE_WEIGHT,
        sourceObservationIds: [obs.id],
        createdAt: now,
      };
      edgeByPair.set(pair, edge);
      edges.push(edge);
    };

    const fileNodes = (obs.files ?? []).map((f) =>
      nodeFor("file", f, obs.id),
    );
    const conceptNodes = (obs.concepts ?? []).map((c) =>
      nodeFor("concept", c, obs.id),
    );

    for (const concept of conceptNodes) {
      for (const file of fileNodes) link(concept, file);
    }
    for (let i = 0; i + 1 < conceptNodes.length; i++) {
      link(conceptNodes[i], conceptNodes[i + 1]);
    }
    for (let i = 0; i + 1 < fileNodes.length; i++) {
      link(fileNodes[i], fileNodes[i + 1]);
    }
  }

  return { nodes, edges };
}

// Shared persistence for a batch of extracted/imported nodes and edges.
// Factored out of mem::graph-extract so structural importers (graphify)
// reuse the exact same name-index upsert, degree bookkeeping, and snapshot
// maintenance — which also makes re-imports idempotent: an existing
// (type, name) resolves through the name index and merges instead of
// duplicating.
//
// #814 v2: targeted name-index lookups replace the O(n) scan over
// `kv.list<GraphNode>(KV.graphNodes)`. At 75K nodes the list payload
// exceeds the iii heartbeat budget and the worker dies before merge can
// complete. Each name-index entry is a single small kv.get/set pair.
async function persistGraphDeltaUnlocked(
  kv: StateKV,
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  obsIds: string[],
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  const nodes = rawNodes.map((node) => scrubRecord(node));
  const edges = rawEdges.map((edge) => boundRecordSources(scrubRecord(edge)));
  const snap = (await readSnapshotStrict(kv)) ?? emptySnapshot();
  const now = new Date().toISOString();
  const capturedAt = snap.resetAt && now <= snap.resetAt
    ? new Date(Date.parse(snap.resetAt) + 1).toISOString()
    : now;
  const batchId = graphBatchId(nodes, edges, obsIds);
  const batchScope = graphBatchScope(batchId);
  const storedPlanForAnyReset = await kv.get<GraphBatchPlan>(
    batchScope,
    batchId,
  );
  const storedPlan = storedPlanForAnyReset?.resetAt === snap.resetAt
    ? storedPlanForAnyReset
    : null;

  if (storedPlan?.complete) {
    await cleanupGraphBatch(kv, snap, batchId, batchScope);
    return { newNodeCount: 0, newEdgeCount: 0 };
  }

  const batchAlreadyApplied = (snap.appliedBatchIds ?? []).includes(batchId);
  const plan: GraphBatchPlan = storedPlan ?? {
    version: 1,
    complete: false,
    ...(snap.resetAt ? { resetAt: snap.resetAt } : {}),
    nodeIdsByKey: {},
    edgeIdsByKey: {},
    newNodeIds: [],
    newEdgeIds: [],
  };
  let planChanged = storedPlan === null;
  const idRemap = new Map<string, string>();
  const plannedNodes: GraphNode[] = [];

  for (const node of nodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    let persistedId = plan.nodeIdsByKey[indexKey];
    if (!persistedId) {
      if (batchAlreadyApplied) continue;
      const indexedId = await kv.get<string>(KV.graphNameIndex, indexKey);
      const indexedNode = indexedId
        ? await kv.get<GraphNode>(KV.graphNodes, indexedId)
        : null;
      const existing = isLiveGraphRecord(indexedNode, snap.resetAt)
        ? indexedNode
        : null;
      persistedId = existing?.id ?? node.id;
      plan.nodeIdsByKey[indexKey] = persistedId;
      if (!existing && !plan.newNodeIds.includes(persistedId)) {
        plan.newNodeIds.push(persistedId);
      }
      planChanged = true;
    }
    idRemap.set(node.id, persistedId);
    plannedNodes.push({ ...node, id: persistedId });
  }

  const plannedEdges: GraphEdge[] = [];
  for (const rawEdge of edges) {
    const edge = {
      ...rawEdge,
      sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
      targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId,
    };
    const indexKey = edgeIndexKey(
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.type,
    );
    let persistedId = plan.edgeIdsByKey[indexKey];
    if (!persistedId) {
      if (batchAlreadyApplied) continue;
      const indexedId = await kv.get<string>(KV.graphEdgeKey, indexKey);
      const indexedEdge = indexedId
        ? await kv.get<GraphEdge>(KV.graphEdges, indexedId)
        : null;
      const existing = isLiveGraphRecord(indexedEdge, snap.resetAt)
        ? indexedEdge
        : null;
      persistedId = existing?.id ?? edge.id;
      plan.edgeIdsByKey[indexKey] = persistedId;
      if (!existing && !plan.newEdgeIds.includes(persistedId)) {
        plan.newEdgeIds.push(persistedId);
      }
      planChanged = true;
    }
    plannedEdges.push({ ...edge, id: persistedId });
  }

  if (planChanged) {
    await kv.set(batchScope, batchId, plan);
  }

  let snapMutated = false;
  for (const node of plannedNodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    const current = await kv.get<GraphNode>(KV.graphNodes, node.id);
    const existing = isLiveGraphRecord(current, snap.resetAt)
      ? current
      : null;

    if (existing) {
      const merged = mergeNode(existing, node, capturedAt);
      await kv.set(KV.graphNameIndex, indexKey, existing.id);
      await kv.set(KV.graphNodes, existing.id, merged);
      await indexGraphNode(kv, merged, node.sourceObservationIds);
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = compactSnapshotNode(merged);
        snapMutated = true;
      }
    } else {
      const persistedNode = boundRecordSources(snap.resetAt && node.createdAt <= snap.resetAt
        ? { ...node, createdAt: capturedAt }
        : node);
      await kv.set(KV.graphNameIndex, indexKey, node.id);
      await kv.set(KV.graphAdjacency, node.id, []);
      await kv.set(KV.graphNodeDegree, node.id, 0);
      await kv.set(KV.graphNodes, node.id, persistedNode);
      await indexGraphNode(kv, persistedNode, node.sourceObservationIds);
    }
  }

  for (const edge of plannedEdges) {
    const indexKey = edgeIndexKey(
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.type,
    );
    const current = await kv.get<GraphEdge>(KV.graphEdges, edge.id);
    const existing = isLiveGraphRecord(current, snap.resetAt)
      ? current
      : null;
    let persistedEdge = edge;
    await kv.set(KV.graphEdgeKey, indexKey, edge.id);

    if (existing) {
      const merged = mergeEdge(existing, edge);
      await kv.set(KV.graphEdges, existing.id, merged);
      await indexGraphEdge(kv, merged);
      persistedEdge = merged;
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = compactSnapshotEdge(merged);
        snapMutated = true;
      }
    } else {
      persistedEdge = snap.resetAt && edge.createdAt <= snap.resetAt
        ? { ...edge, createdAt: capturedAt }
        : edge;
      await kv.set(KV.graphEdges, edge.id, persistedEdge);
      await indexGraphEdge(kv, persistedEdge);
    }

    const endpointIds =
      persistedEdge.sourceNodeId === persistedEdge.targetNodeId
        ? [persistedEdge.sourceNodeId]
        : [persistedEdge.sourceNodeId, persistedEdge.targetNodeId];
    for (const nodeId of endpointIds) {
      await reconcileNodeDegree(kv, snap, nodeId);
    }
    snapMutated = true;
  }

  let newNodeCount = 0;
  let newEdgeCount = 0;
  const newEdgesForTopCheck: GraphEdge[] = [];
  if (!batchAlreadyApplied) {
    for (const nodeId of new Set(plan.newNodeIds)) {
      const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
      if (!isLiveGraphRecord(node, snap.resetAt)) continue;
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      if (
        snap.topNodes.length < SNAPSHOT_TOP_NODES &&
        !snap.topNodes.some((candidate) => candidate.id === node.id)
      ) {
        snap.topNodes.push(compactSnapshotNode(node));
        snap.topDegrees[node.id] =
          (await kv.get<number>(KV.graphNodeDegree, node.id)) ?? 0;
      }
    }

    for (const edgeId of new Set(plan.newEdgeIds)) {
      const edge = await kv.get<GraphEdge>(KV.graphEdges, edgeId);
      if (!isLiveGraphRecord(edge, snap.resetAt)) continue;
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      newEdgesForTopCheck.push(edge);
    }

    for (const edge of newEdgesForTopCheck) {
      snapshotPushEdgeIfBothInTop(snap, edge);
    }
    snap.appliedBatchIds = [
      ...new Set([...(snap.appliedBatchIds ?? []), batchId]),
    ];
    snapMutated = true;
  }

  if (snapMutated) {
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    snap.topNodes = snap.topNodes.map(compactSnapshotNode);
    snap.topEdges = snap.topEdges.map(compactSnapshotEdge);
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }

  await markGraphObservationsProcessed(kv, obsIds);
  plan.complete = true;
  await kv.set(batchScope, batchId, plan);
  await cleanupGraphBatch(kv, snap, batchId, batchScope);

  return { newNodeCount, newEdgeCount };
}

export interface GraphCompactResult {
  nodesScanned: number;
  nodesTrimmed: number;
  edgesScanned: number;
  edgesTrimmed: number;
  historyScanned: number;
  historyTrimmed: number;
  idsRemoved: number;
  snapshotTrimmed: boolean;
  total?: number;
  nextOffset: number | null;
}

export type GraphCompactScope = "nodes" | "edges" | "history" | "snapshot";

export interface GraphCompactOptions {
  scope?: GraphCompactScope;
  offset?: number;
  limit?: number;
  dryRun?: boolean;
}

export const COMPACT_SCOPES: readonly GraphCompactScope[] = ["nodes", "edges", "history", "snapshot"];

export async function compactGraphProvenance(
  kv: StateKV,
  opts: GraphCompactOptions = {},
): Promise<GraphCompactResult> {
  const { scope } = opts;
  if (scope !== undefined && !COMPACT_SCOPES.includes(scope)) {
    throw new Error(`unknown compact scope: ${String(scope)}`);
  }
  const offset = opts.offset ?? 0;
  const dryRun = opts.dryRun === true;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`compact offset must be a non-negative integer: ${String(opts.offset)}`);
  }
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit > 0))) {
    throw new Error(`compact limit must be a positive integer: ${String(opts.limit)}`);
  }

  const result: GraphCompactResult = {
    nodesScanned: 0,
    nodesTrimmed: 0,
    edgesScanned: 0,
    edgesTrimmed: 0,
    historyScanned: 0,
    historyTrimmed: 0,
    idsRemoved: 0,
    snapshotTrimmed: false,
    nextOffset: null,
  };

  const trimScope = async <R extends { sourceObservationIds: string[] }>(
    listIds: () => Promise<unknown[]>,
    recordScope: string,
  ): Promise<{ scanned: number; trimmed: number }> => {
    const allIds = [...new Set(await listIds())]
      .filter((id): id is string => typeof id === "string")
      .sort();
    const end = Math.min(allIds.length, offset + limit);
    result.total = allIds.length;
    result.nextOffset = end < allIds.length ? end : null;
    let scanned = 0;
    let trimmed = 0;
    for (const id of allIds.slice(offset, end)) {
      await withKeyedLock("graph:persist", async () => {
        const record = await kv.get<R>(recordScope, id);
        if (!record) return;
        scanned += 1;
        const sources = record.sourceObservationIds ?? [];
        if (sources.length <= MAX_GRAPH_SOURCE_OBSERVATIONS) return;
        const bounded = boundSources([], sources);
        result.idsRemoved += sources.length - bounded.length;
        if (!dryRun) await kv.set(recordScope, id, { ...record, sourceObservationIds: bounded });
        trimmed += 1;
      });
    }
    return { scanned, trimmed };
  };

  const trimSnapshot = () =>
    withKeyedLock("graph:persist", async () => {
      const snap = await readGraphSnapshot(kv);
      if (!snap) return;
      const trimList = <R extends { sourceObservationIds: string[] }>(list: R[]) =>
        list.map((r) => {
          const sources = r.sourceObservationIds ?? [];
          if (sources.length <= MAX_GRAPH_SOURCE_OBSERVATIONS) return r;
          result.snapshotTrimmed = true;
          return { ...r, sourceObservationIds: boundSources([], sources) };
        });
      const topNodes = trimList(snap.topNodes);
      const topEdges = trimList(snap.topEdges);
      if (result.snapshotTrimmed && !dryRun) {
        await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, { ...snap, topNodes, topEdges });
      }
    });

  if (scope === undefined || scope === "nodes") {
    const n = await trimScope<GraphNode>(() => kv.list<string>(KV.graphNameIndex), KV.graphNodes);
    result.nodesScanned = n.scanned;
    result.nodesTrimmed = n.trimmed;
  }
  if (scope === undefined || scope === "edges") {
    const e = await trimScope<GraphEdge>(() => kv.list<string>(KV.graphEdgeKey), KV.graphEdges);
    result.edgesScanned = e.scanned;
    result.edgesTrimmed = e.trimmed;
  }
  if (scope === undefined || scope === "history") {
    const h = await trimScope<GraphEdge>(
      async () => (await kv.list<GraphEdge>(KV.graphEdgeHistory)).map((r) => r?.id),
      KV.graphEdgeHistory,
    );
    result.historyScanned = h.scanned;
    result.historyTrimmed = h.trimmed;
  }
  if (scope === undefined || scope === "snapshot") {
    await trimSnapshot();
  }
  if (scope === undefined) {
    delete result.total;
    result.nextOffset = null;
  }
  return result;
}

export function persistGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[] = [],
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  // shortcut: process-local lock; use state-backed CAS for multiple writers.
  return withKeyedLock("graph:persist", () =>
    persistGraphDeltaUnlocked(kv, nodes, edges, obsIds),
  );
}

export function registerGraphFunction(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::graph-extract",
    async (data: { observations: CompressedObservation[] }) => {
      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }

      let observations = data.observations;
      try {
        const resetAt = (await readSnapshotStrict(kv))?.resetAt ?? null;
        const processed: boolean[] = [];
        for (let i = 0; i < observations.length; i += 100) {
          processed.push(
            ...(await Promise.all(
              observations.slice(i, i + 100).map((observation) =>
                isGraphObservationProcessed(kv, observation.id, { resetAt })
              ),
            )),
          );
        }
        observations = observations.filter((_, index) => !processed[index]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
      if (observations.length === 0) {
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      }

      const obsIds = observations.map((o) => o.id);

      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];
      try {
        const heuristic = extractGraphHeuristics(observations);
        nodes = heuristic.nodes;
        edges = heuristic.edges;
      } catch (err) {
        logger.warn("heuristic graph extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const llmEnabled =
        isGraphExtractionEnabled() && !provider.name.includes("noop");
      let llmError: string | undefined;
      if (llmEnabled) {
        const prompt = buildGraphExtractionPrompt(
          observations.map((o) => ({
            title: o.title,
            narrative: o.narrative,
            concepts: o.concepts,
            files: o.files,
            type: o.type,
          })),
        );
        try {
          const response = await provider.compress(
            GRAPH_EXTRACTION_SYSTEM,
            prompt,
          );
          const parsed = parseGraphXml(response, obsIds);
          nodes = nodes.concat(parsed.nodes);
          edges = edges.concat(parsed.edges);
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          logger.error("LLM graph extraction failed", { error: llmError });
        }
      }

      if (nodes.length === 0 && edges.length === 0) {
        if (llmError) return { success: false, error: llmError };
        try {
          await markGraphObservationsProcessed(kv, obsIds);
          return { success: true, nodesAdded: 0, edgesAdded: 0 };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Graph extraction failed", { error: msg });
          return { success: false, error: msg };
        }
      }

      try {
        const { newNodeCount, newEdgeCount } = await persistGraphDelta(
          kv,
          nodes,
          edges,
          obsIds,
        );

        await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
          nodesExtracted: nodes.length,
          edgesExtracted: edges.length,
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
          llm: llmEnabled && !llmError,
        });
        return {
          success: true,
          nodesAdded: newNodeCount,
          edgesAdded: newEdgeCount,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);

      const noWalk = !data.query && !data.startNodeId;
      if (noWalk) {
        const snap = await readGraphSnapshot(kv);
        if (snap && snap.stats.totalNodes > 0) {
          return paginateFromSnapshot(snap, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a legacy corpus from an older " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // Query / startNodeId paths serve from the read side-indexes
      // when they have been built (boot backfill, snapshot-rebuild, or
      // graph-reset). Name matches come from the sharded name catalog
      // (64 bounded gets) and traversal expands via per-node adjacency
      // lists, so cost scales with matches x degree instead of corpus
      // size.
      if (await graphIndexesReady(kv)) {
        if (data.query) {
          return queryViaIndexes(kv, data.query, limit, offset);
        }
        return traverseViaIndexes(
          kv,
          data.startNodeId!,
          data.nodeType,
          maxDepth,
          limit,
          offset,
        );
      }

      // Without the side-indexes the query / startNodeId paths still
      // need broader access. Race the live enumeration against a
      // wall-clock budget so a long kv.list doesn't block the worker
      // indefinitely. On timeout the caller gets a snapshot-backed
      // approximation instead of a 500.
      let allNodes: GraphNode[];
      let allEdges: GraphEdge[];
      try {
        const [rawNodes, rawEdges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-query enumeration",
        );
        allNodes = rawNodes.filter((n) => !n.stale);
        allEdges = rawEdges.filter((e) => !e.stale);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph query enumeration timed out, using snapshot", {
          error: msg,
        });
        const snap = await readGraphSnapshot(kv);
        if (snap) {
          return {
            ...paginateFromSnapshot(snap, data.nodeType, limit, offset),
            warning:
              "Live graph enumeration exceeded budget. Query / " +
              "startNodeId paths degrade on >25K-node corpora until a " +
              "per-node edge index lands. Result reflects top-degree " +
              "snapshot, not the requested walk.",
          };
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "Graph enumeration exceeded budget and no snapshot is available.",
        };
      }

      if (data.query) {
        const lower = data.query.toLowerCase();
        const matchingNodes = allNodes.filter(
          (n) =>
            n.name.toLowerCase().includes(lower) ||
            Object.values(n.properties).some(
              (v) => typeof v === "string" && v.toLowerCase().includes(lower),
            ),
        );
        return paginate(matchingNodes, allEdges, 0, limit, offset);
      }

      if (data.startNodeId) {
        const visited = new Set<string>();
        const visitedEdges = new Set<string>();
        const resultNodes: GraphNode[] = [];
        const resultEdges: GraphEdge[] = [];
        const queue: Array<{ nodeId: string; depth: number }> = [
          { nodeId: data.startNodeId, depth: 0 },
        ];

        while (queue.length > 0) {
          const { nodeId, depth } = queue.shift()!;
          if (visited.has(nodeId) || depth > maxDepth) continue;
          visited.add(nodeId);

          const node = allNodes.find((n) => n.id === nodeId);
          if (node) {
            if (!data.nodeType || node.type === data.nodeType) {
              resultNodes.push(node);
            }
          }

          const neighborEdges = allEdges.filter(
            (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
          );
          for (const edge of neighborEdges) {
            if (!visitedEdges.has(edge.id)) {
              visitedEdges.add(edge.id);
              resultEdges.push(edge);
            }
            const nextId =
              edge.sourceNodeId === nodeId
                ? edge.targetNodeId
                : edge.sourceNodeId;
            if (!visited.has(nextId)) {
              queue.push({ nodeId: nextId, depth: depth + 1 });
            }
          }
        }

        return paginate(resultNodes, resultEdges, maxDepth, limit, offset);
      }

      // Unreachable — noWalk branch handles the rest.
      return paginate([], [], 0, limit, offset);
    },
  );

  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readGraphSnapshot(kv);
    if (snap) {
      return {
        ...snap.stats,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) =>
      withKeyedLock("graph:persist", async () => {
        const started = Date.now();
        let rebuildResetAt: string | undefined;
        // #825: pre-flight refusal for legacy corpora. The old guard
        // checked node count AFTER kv.list, but the heartbeat dies at
        // ~0.35s on a 75K-node response — long before the wall-clock
        // budget can fire. We can't safely enumerate to discover size.
        //
        // Heuristic: if no snapshot exists, the corpus is either empty
        // or legacy. The empty case has nothing to rebuild; the legacy
        // case will crash. Refuse both unless `force: true` is passed
        // (operator opt-in to attempt rebuild on a corpus they know is
        // small enough — typically under 10K nodes on the default iii
        // state adapter).
        // Strict boolean check on force — accept only literal `true`,
        // never truthy strings/numbers, so a hand-crafted JSON payload
        // can't accidentally bypass the legacy-corpus safeguard.
        const forceRebuild = data?.force === true;
        try {
          const existing = await readGraphSnapshot(kv);
          rebuildResetAt = existing?.resetAt;
          if (!existing && !forceRebuild) {
            logger.warn("Graph snapshot rebuild refused: no prior snapshot", {
              hint: "legacy corpus or empty store",
            });
            return {
              success: false,
              legacyCorpus: true,
              error:
                "No prior snapshot found. Rebuild would call kv.list on " +
                "KV.graphNodes/Edges, which heartbeat-crashes the worker " +
                "on corpora past the iii state response budget (~25K nodes). " +
                "Either (a) call POST /agentmemory/graph/reset to drop into " +
                "incremental-only mode and rebuild from new extracts, or " +
                "(b) re-send with `force: true` if you're certain the " +
                "corpus is small.",
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Graph snapshot pre-flight read failed", { error: msg });
          // Fall through; the user passed force=true or the snapshot
          // read itself failed (separate problem).
        }

        try {
          const [nodes, edges] = await withTimeout(
            Promise.all([
              kv.list<GraphNode>(KV.graphNodes),
              kv.list<GraphEdge>(KV.graphEdges),
            ]),
            LIVE_ENUMERATION_BUDGET_MS,
            "graph-snapshot-rebuild enumeration",
          );

        if (nodes.length > REBUILD_SAFE_NODE_CEILING) {
          logger.warn("Graph snapshot rebuild aborted: corpus too large", {
            totalNodes: nodes.length,
            ceiling: REBUILD_SAFE_NODE_CEILING,
          });
          return {
            success: false,
            tooLarge: true,
            totalNodes: nodes.length,
            ceiling: REBUILD_SAFE_NODE_CEILING,
            error:
              `Corpus has ${nodes.length} graph nodes; safe-rebuild ceiling ` +
              `is ${REBUILD_SAFE_NODE_CEILING}. Run POST /agentmemory/graph/reset ` +
              `to wipe and let future extracts rebuild incrementally.`,
          };
        }

        // Backfill the targeted-lookup indexes so post-rebuild
        // graph-extract calls hit the O(1) path instead of falling
        // through to the (already-removed) full-scope scan. Batch
        // writes via Promise.all to avoid N sequential round-trips —
        // BATCH_SIZE bounds in-flight writes so we don't open thousands
        // of concurrent state channels on huge corpora.
        const liveNodes = nodes.filter((node) =>
          isLiveGraphRecord(node, rebuildResetAt)
        );
        const liveNodeIds = new Set(liveNodes.map((node) => node.id));
        const liveEdges = edges.filter(
          (edge) =>
            isLiveGraphRecord(edge, rebuildResetAt) &&
            liveNodeIds.has(edge.sourceNodeId) &&
            liveNodeIds.has(edge.targetNodeId),
        );
        const degree = new Map<string, number>();
        for (const e of liveEdges) {
          degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
          if (e.targetNodeId !== e.sourceNodeId) {
            degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
          }
        }
        const BATCH_SIZE = 100;
        for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
          const batch = liveNodes.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.flatMap((n) => [
              kv.set(KV.graphNameIndex, nameIndexKey(n.type, n.name), n.id),
              kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
            ]),
          );
        }
        for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
          const batch = liveEdges.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map((e) =>
              kv.set(
                KV.graphEdgeKey,
                edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
                e.id,
              ),
            ),
          );
        }

        await backfillGraphIndexes(kv, liveNodes, liveEdges);

        const snap = {
          ...buildSnapshotFromArrays(liveNodes, liveEdges),
          ...(rebuildResetAt ? { resetAt: rebuildResetAt } : {}),
        };
        await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
        const tookMs = Date.now() - started;
        logger.info("Graph snapshot rebuilt", {
          totalNodes: snap.stats.totalNodes,
          totalEdges: snap.stats.totalEdges,
          topNodes: snap.topNodes.length,
          topEdges: snap.topEdges.length,
          tookMs,
        });
        return {
          success: true,
          ...snap.stats,
          topNodes: snap.topNodes.length,
          topEdges: snap.topEdges.length,
          updatedAt: snap.updatedAt,
          tookMs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph snapshot rebuild failed", { error: msg });
        return { success: false, error: msg };
      }
      }),
  );

  // #814 v2 + #825: clean-restart escape hatch for corpora of any
  // size, including the legacy 75K+ case that crashes kv.list.
  //
  // Previous reset walked kv.list<GraphNode/Edge>(...) which is the
  // exact primitive that heartbeat-crashes the worker on the corpus
  // this reset was meant to recover (Allan's repro, 0.35s death).
  //
  // The new design is enumeration-free: write an empty snapshot and
  // return. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-compact", async (data?: GraphCompactOptions) => {
    const started = Date.now();
    try {
      const result = await compactGraphProvenance(kv, data ?? {});
      const tookMs = Date.now() - started;
      logger.info("Graph provenance compacted", { ...result, tookMs });
      if (result.idsRemoved > 0) {
        await safeAudit(kv, "graph_compact", "mem::graph-compact", [], {
          scope: data?.scope ?? "all",
          offset: data?.offset,
          limit: data?.limit,
          nodesTrimmed: result.nodesTrimmed,
          edgesTrimmed: result.edgesTrimmed,
          historyTrimmed: result.historyTrimmed,
          idsRemoved: result.idsRemoved,
          snapshotTrimmed: result.snapshotTrimmed,
        });
      }
      return { success: true, ...result, tookMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph provenance compaction failed", { error: msg });
      return { success: false, error: msg };
    }
  });

  sdk.registerFunction("mem::graph-reset", async () =>
    withKeyedLock("graph:persist", async () => {
      const started = Date.now();
      const previous = await readGraphSnapshot(kv, true);
      const now = new Date().toISOString();
      const resetAt = previous?.resetAt && now <= previous.resetAt
        ? new Date(Date.parse(previous.resetAt) + 1).toISOString()
        : now;
      // Stamp resetAt=now on the empty snapshot. Future
      // mem::graph-extract calls compare each name-index lookup's
      // existing node `createdAt` against this timestamp; anything
      // older counts as an orphan and is dropped from the merge path,
      // forcing extract to write a fresh row instead of reconnecting
      // to a pre-reset entry.
      const resetSnapshot: GraphSnapshot = {
        ...emptySnapshot(),
        resetAt,
      };
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
      // The name shards are the only side-index with a bounded, known
      // key set, so they can be wiped outright. Adjacency / obs-node
      // hints for pre-reset rows stay on disk; index readers verify
      // every hit against `resetAt`, so those orphans are never served.
      // Marking the indexes ready flips retrieval onto the index path,
      // which (unlike the enumeration fallback) applies the resetAt
      // filter and therefore stops surfacing pre-reset rows.
      await clearNameShards(kv);
      await markGraphIndexesReady(kv);
      const counts: Record<string, number> = {
        [KV.graphSnapshot]: 1,
      };
      const tookMs = Date.now() - started;
      logger.info("Graph state reset", { counts, tookMs });
      return { success: true, cleared: counts, tookMs };
    }),
  );
}
