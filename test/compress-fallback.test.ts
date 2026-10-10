import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompressFunction } from "../src/functions/compress.js";
import {
  getSearchIndex,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type {
  CompressedObservation,
  MemoryProvider,
  RawObservation,
} from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const observationIds: string[] = [];

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      const entries = store.get(scope) ?? new Map<string, unknown>();
      entries.set(key, data);
      store.set(scope, entries);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function rawObservation(id: string, sentinel: string): RawObservation {
  observationIds.push(id);
  return {
    id,
    sessionId: `session-${id}`,
    timestamp: "2026-08-02T12:00:00.000Z",
    hookType: "post_tool_use",
    toolName: "Bash",
    toolOutput: sentinel,
    raw: {},
  };
}

async function runFailedCompression(
  raw: RawObservation,
  compress: MemoryProvider["compress"],
) {
  const kv = mockKV();
  await kv.set(KV.observations(raw.sessionId), raw.id, raw);

  let handler: ((data: {
    observationId: string;
    sessionId: string;
    raw: RawObservation;
  }) => Promise<unknown>) | undefined;
  const trigger = vi.fn().mockResolvedValue(undefined);
  const sdk = {
    registerFunction: (_id: string, callback: typeof handler) => {
      handler = callback;
    },
    trigger,
  };
  const metrics = { record: vi.fn().mockResolvedValue(undefined) };
  const provider: MemoryProvider = {
    name: "failing-test-provider",
    compress,
    summarize: async () => "",
  };
  const vectorIndex = new VectorIndex();
  const embed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
  setVectorIndex(vectorIndex);
  setEmbeddingProvider({
    name: "test-embedder",
    dimensions: 2,
    embed,
    embedBatch: async () => [],
  });
  const add = vi.spyOn(getSearchIndex(), "add");

  registerCompressFunction(sdk as never, kv as never, provider, metrics as never);
  if (!handler) throw new Error("mem::compress was not registered");
  const result = await handler({
    observationId: raw.id,
    sessionId: raw.sessionId,
    raw,
  });
  const stored = await kv.get<CompressedObservation>(
    KV.observations(raw.sessionId),
    raw.id,
  );

  return { add, embed, metrics, result, stored, trigger, vectorIndex };
}

afterEach(() => {
  for (const id of observationIds.splice(0)) getSearchIndex().remove(id);
  setVectorIndex(null);
  setEmbeddingProvider(null);
  vi.restoreAllMocks();
});

describe("mem::compress degraded fallback", () => {
  it("stores and indexes a synthetic observation once when the provider rejects", async () => {
    const sentinel = "providerfailurequartz";
    const raw = rawObservation("obs-provider-failure", sentinel);

    const outcome = await runFailedCompression(raw, async () => {
      throw new Error("provider rejected request");
    });

    expect(outcome.result).toMatchObject({
      success: false,
      error: "compression_failed",
    });
    expect(outcome.stored).toMatchObject({
      id: raw.id,
      title: "Bash",
      confidence: 0.3,
    });
    expect(getSearchIndex().search(sentinel)).toEqual([
      expect.objectContaining({ obsId: raw.id }),
    ]);
    expect(outcome.add).toHaveBeenCalledTimes(1);
    expect(outcome.embed).toHaveBeenCalledTimes(1);
    expect(outcome.vectorIndex.size).toBe(1);
    expect(outcome.metrics.record.mock.calls[0]?.[2]).toBe(false);
    expect(outcome.trigger).toHaveBeenCalledTimes(1);
    expect(outcome.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "stream::send",
        payload: expect.objectContaining({
          data: {
            type: "compressed",
            sessionId: raw.sessionId,
            observation: expect.objectContaining({ id: raw.id, confidence: 0.3 }),
          },
        }),
      }),
    );
  });

  it("stores and indexes a synthetic observation once after invalid XML retry", async () => {
    const sentinel = "invalidxmlzircon";
    const raw = rawObservation("obs-invalid-xml", sentinel);
    const compress = vi.fn().mockResolvedValue("not compression xml");

    const outcome = await runFailedCompression(raw, compress);

    expect(compress).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({
      success: false,
      error: "parse_failed",
    });
    expect(outcome.stored).toMatchObject({
      id: raw.id,
      title: "Bash",
      confidence: 0.3,
    });
    expect(getSearchIndex().search(sentinel)).toEqual([
      expect.objectContaining({ obsId: raw.id }),
    ]);
    expect(outcome.add).toHaveBeenCalledTimes(1);
    expect(outcome.embed).toHaveBeenCalledTimes(1);
    expect(outcome.vectorIndex.size).toBe(1);
    expect(outcome.metrics.record.mock.calls[0]?.[2]).toBe(false);
    expect(outcome.trigger).toHaveBeenCalledTimes(1);
  });
});
