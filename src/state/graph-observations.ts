import { KV, graphShardKey } from "./schema.js";
import type { StateKV } from "./kv.js";
import { withKeyedLock } from "./keyed-mutex.js";

type GraphObservationState = {
  version: 1;
  processed: boolean;
  processedResetAt?: string;
  nodeIds: string[];
};

const SNAPSHOT_KEY = "current";

export async function readGraphObservationResetAt(
  kv: StateKV,
): Promise<string | null> {
  const snapshot = await kv.get<{ resetAt?: string }>(
    KV.graphSnapshot,
    SNAPSHOT_KEY,
  );
  return typeof snapshot?.resetAt === "string" ? snapshot.resetAt : null;
}

function observationScope(observationId: string): string {
  return KV.graphObservationState(graphShardKey(observationId));
}

async function readState(
  kv: StateKV,
  observationId: string,
): Promise<GraphObservationState | null> {
  return kv.get<GraphObservationState>(
    observationScope(observationId),
    observationId,
  );
}

async function readLegacyNodeIds(
  kv: StateKV,
  observationId: string,
): Promise<string[] | null> {
  const nodeIds = await kv.get<string[]>(KV.graphObsNodes, observationId);
  return Array.isArray(nodeIds) ? nodeIds : null;
}

async function writeState(
  kv: StateKV,
  observationId: string,
  state: GraphObservationState,
): Promise<void> {
  await kv.set(observationScope(observationId), observationId, state);
}

export async function isGraphObservationProcessed(
  kv: StateKV,
  observationId: string,
  options?: { resetAt: string | null },
): Promise<boolean> {
  const resetAt = options
    ? options.resetAt
    : await readGraphObservationResetAt(kv);
  const current = await readState(kv, observationId);
  if (current) {
    return current.processed && (current.processedResetAt ?? null) === resetAt;
  }

  const legacyNodeIds = await readLegacyNodeIds(kv, observationId);
  if (legacyNodeIds === null) return false;

  return withKeyedLock(`gidx:obs:${observationId}`, async () => {
    const migrated = await readState(kv, observationId);
    if (migrated) {
      return migrated.processed &&
        (migrated.processedResetAt ?? null) === resetAt;
    }
    const processed = resetAt === null;
    await writeState(kv, observationId, {
      version: 1,
      processed,
      nodeIds: legacyNodeIds,
    });
    return processed;
  });
}

export async function linkObservationsToNode(
  kv: StateKV,
  nodeId: string,
  observationIds: string[] | undefined,
): Promise<void> {
  for (const observationId of observationIds ?? []) {
    await withKeyedLock(`gidx:obs:${observationId}`, async () => {
      const current = await readState(kv, observationId);
      const legacyNodeIds =
        current === null ? await readLegacyNodeIds(kv, observationId) : null;
      const nodeIds = current?.nodeIds ?? legacyNodeIds ?? [];
      if (nodeIds.includes(nodeId)) return;
      await writeState(kv, observationId, {
        version: 1,
        processed: current?.processed ?? legacyNodeIds !== null,
        ...(current?.processedResetAt
          ? { processedResetAt: current.processedResetAt }
          : {}),
        nodeIds: [...nodeIds, nodeId],
      });
    });
  }
}

export async function markGraphObservationsProcessed(
  kv: StateKV,
  observationIds: string[],
): Promise<void> {
  const resetAt = await readGraphObservationResetAt(kv);
  for (const observationId of observationIds) {
    await withKeyedLock(`gidx:obs:${observationId}`, async () => {
      const current = await readState(kv, observationId);
      if (
        current?.processed &&
        (current.processedResetAt ?? null) === resetAt
      ) {
        return;
      }
      const legacyNodeIds =
        current === null ? await readLegacyNodeIds(kv, observationId) : null;
      await writeState(kv, observationId, {
        version: 1,
        processed: true,
        ...(resetAt ? { processedResetAt: resetAt } : {}),
        nodeIds: current?.nodeIds ?? legacyNodeIds ?? [],
      });
    });
  }
}

export async function loadNodeIdsForObservations(
  kv: StateKV,
  observationIds: string[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const observationId of observationIds) {
    const current = await readState(kv, observationId);
    const nodeIds =
      current?.nodeIds ?? (await readLegacyNodeIds(kv, observationId)) ?? [];
    for (const id of nodeIds) ids.add(id);
  }
  return [...ids];
}

export async function backfillGraphObservationState(
  kv: StateKV,
  observationId: string,
  nodeIds: string[],
): Promise<void> {
  const resetAt = await readGraphObservationResetAt(kv);
  await withKeyedLock(`gidx:obs:${observationId}`, () =>
    writeState(kv, observationId, {
      version: 1,
      processed: true,
      ...(resetAt ? { processedResetAt: resetAt } : {}),
      nodeIds,
    }),
  );
}
