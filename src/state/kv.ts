import type { IIIClient } from 'iii-sdk'
import { withKeyedLock } from './keyed-mutex.js'
import { KV, graphShardKey } from "./schema.js";

export type StateBackend = 'file' | 'redis'

export interface StateKVOptions {
  backend?: StateBackend
}

type UpdateOp = { type: string; path: string; value?: unknown }

type UpdateResult = { old_value: unknown; new_value: unknown; errors: unknown[] }

const LOCAL_UPDATE_OPS = new Set(['set', 'remove', 'merge'])
const UNSAFE_PATHS = new Set(['__proto__', 'constructor', 'prototype'])
const ORDER_FIELDS = ['createdAt', 'timestamp', 'startedAt', 'updatedAt'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canApplyLocally(ops: UpdateOp[]): boolean {
  return ops.every(
    (op) =>
      LOCAL_UPDATE_OPS.has(op.type) &&
      typeof (op.path ?? '') === 'string' &&
      !UNSAFE_PATHS.has(op.path ?? '') &&
      (op.type !== 'merge' || isPlainObject(op.value)),
  )
}

export function applyUpdateOps(oldValue: unknown, ops: UpdateOp[]): unknown {
  let current: unknown =
    oldValue === null || oldValue === undefined ? {} : structuredClone(oldValue)
  for (const op of ops) {
    const path = op.path ?? ''
    if (op.type === 'set') {
      if (path === '') current = op.value ?? null
      else if (isPlainObject(current)) current[path] = op.value ?? null
    } else if (op.type === 'remove') {
      if (path === '') current = null
      else if (isPlainObject(current)) delete current[path]
    } else if (op.type === 'merge' && isPlainObject(op.value)) {
      if (path === '') {
        if (isPlainObject(current)) Object.assign(current, op.value)
      } else {
        const root: Record<string, unknown> = isPlainObject(current) ? current : {}
        const existing = root[path]
        const target = isPlainObject(existing) ? existing : {}
        Object.assign(target, op.value)
        root[path] = target
        current = root
      }
    }
  }
  return current
}

const MIN_ID_TIME = Date.UTC(2020, 0, 1)
const MAX_ID_TIME = Date.UTC(2100, 0, 1)

export function generatedIdTime(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const parts = id.split('_')
  if (parts.length < 3) return null
  const segment = parts[parts.length - 2]!
  if (!/^[0-9a-z]{6,10}$/.test(segment)) return null
  const ms = parseInt(segment, 36)
  return ms >= MIN_ID_TIME && ms < MAX_ID_TIME ? ms : null
}

function orderKey(value: unknown): number {
  if (!isPlainObject(value)) return Number.POSITIVE_INFINITY
  const fromId = generatedIdTime(value.id)
  if (fromId !== null) return fromId
  for (const field of ORDER_FIELDS) {
    const raw = value[field]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return Number.POSITIVE_INFINITY
}

function idKey(value: unknown): string {
  if (!isPlainObject(value)) return ''
  const id = value.id ?? value.key
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

export function orderLikeInsertion<T>(values: T[]): T[] {
  return values
    .map((value) => ({ value, at: orderKey(value), id: idKey(value) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1
      if (a.id === b.id) return 0
      return a.id < b.id ? -1 : 1
    })
    .map((entry) => entry.value)
}

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
  readonly backend: StateBackend

  constructor(
    private sdk: IIIClient,
    options: StateKVOptions = {},
  ) {
    this.backend = options.backend ?? 'file'
  }

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

  async update<T = unknown>(scope: string, key: string, ops: UpdateOp[]): Promise<T> {
    if (isShardedRecordScope(scope)) {
      throw new Error("sharded record scopes require get followed by set");
    }
    if (this.backend === 'redis' && canApplyLocally(ops)) {
      return withKeyedLock(`state-update:${scope}\u0000${key}`, async () => {
        const oldValue = await this.get<unknown>(scope, key)
        const newValue = applyUpdateOps(oldValue, ops)
        await this.set(scope, key, newValue)
        const result: UpdateResult = { old_value: oldValue, new_value: newValue, errors: [] }
        return result as T
      })
    }
    return this.sdk.trigger<{ scope: string; key: string; ops: UpdateOp[] }, T>({
      function_id: 'state::update',
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
      const values = await this.sdk.trigger<{ scope: string }, T[]>({
        function_id: "state::list",
        payload: { scope },
      });
      return this.backend === "redis" && Array.isArray(values) ? orderLikeInsertion(values) : values;
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
    return this.backend === "redis" ? orderLikeInsertion(merged) : merged;
  }
}
