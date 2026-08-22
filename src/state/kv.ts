import type { ISdk } from "iii-sdk";
import { KV, graphShardKey } from "./schema.js";

const RECORD_SHARD_COUNT = 64;
const SHARDED_RECORD_SCOPES = new Set<string>([
  KV.graphNodes,
  KV.graphEdges,
  KV.graphEdgeHistory,
  KV.insights,
]);

type GraphShardEntry<T> =
  | {
      version: 1;
      key: string;
      deleted: false;
      value: T;
    }
  | {
      version: 1;
      key: string;
      deleted: true;
    };

function isShardedRecordScope(scope: string): boolean {
  return SHARDED_RECORD_SCOPES.has(scope);
}

function recordShardScope(scope: string, key: string): string {
  return `${scope}:v2:${graphShardKey(key, RECORD_SHARD_COUNT).padStart(2, "0")}`;
}

function recordId(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    return null;
  }
  return value.id;
}

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("key must be a non-empty string");
    }
    if (isShardedRecordScope(scope)) {
      const entry = await this.sdk.trigger<
        { scope: string; key: string },
        GraphShardEntry<T> | null
      >({
        function_id: "state::get",
        payload: { scope: recordShardScope(scope, key), key },
      });
      if (entry?.version === 1 && entry.key === key) {
        return entry.deleted ? null : entry.value;
      }
    }
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: "state::get",
      payload: { scope, key },
    });
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    if (isShardedRecordScope(scope)) {
      await this.sdk.trigger<
        { scope: string; key: string; value: GraphShardEntry<T> },
        unknown
      >({
        function_id: "state::set",
        payload: {
          scope: recordShardScope(scope, key),
          key,
          value: { version: 1, key, deleted: false, value },
        },
      });
      return value;
    }
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: "state::set",
      payload: { scope, key, value },
    });
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    if (isShardedRecordScope(scope)) {
      throw new Error("sharded record scopes require get followed by set");
    }
    return this.sdk.trigger<
      {
        scope: string;
        key: string;
        ops: Array<{ type: string; path: string; value?: unknown }>;
      },
      T
    >({
      function_id: "state::update",
      payload: { scope, key, ops },
    });
  }

  async delete(scope: string, key: string): Promise<void> {
    if (isShardedRecordScope(scope)) {
      await this.sdk.trigger<
        { scope: string; key: string; value: GraphShardEntry<never> },
        unknown
      >({
        function_id: "state::set",
        payload: {
          scope: recordShardScope(scope, key),
          key,
          value: { version: 1, key, deleted: true },
        },
      });
      return;
    }
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: "state::delete",
      payload: { scope, key },
    });
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    if (!isShardedRecordScope(scope)) {
      return this.sdk.trigger<{ scope: string }, T[]>({
        function_id: "state::list",
        payload: { scope },
      });
    }

    const [legacy, ...shards] = await Promise.all([
      this.sdk.trigger<{ scope: string }, T[]>({
        function_id: "state::list",
        payload: { scope },
      }),
      ...Array.from({ length: RECORD_SHARD_COUNT }, (_, shard) =>
        this.sdk.trigger<{ scope: string }, GraphShardEntry<T>[]>({
          function_id: "state::list",
          payload: {
            scope: `${scope}:v2:${String(shard).padStart(2, "0")}`,
          },
        }),
      ),
    ]);
    const overlays = new Map<string, GraphShardEntry<T>>();
    for (const entries of shards) {
      for (const entry of entries) {
        if (entry?.version === 1 && typeof entry.key === "string") {
          overlays.set(entry.key, entry);
        }
      }
    }
    const merged = legacy.filter((value) => {
      const id = recordId(value);
      return id === null || !overlays.has(id);
    });
    for (const entry of overlays.values()) {
      if (!entry.deleted) merged.push(entry.value);
    }
    return merged;
  }
}
