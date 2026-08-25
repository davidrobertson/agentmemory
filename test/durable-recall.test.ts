import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null | undefined> =>
      store.get(scope)?.get(key) as T | undefined,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      let entries = store.get(scope);
      if (!entries) {
        entries = new Map();
        store.set(scope, entries);
      }
      entries.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, (data: never) => unknown>();
  return {
    registerFunction: (
      id: string,
      handler: (data: never) => unknown,
    ): void => {
      functions.set(id, handler);
    },
    trigger: async (id: string, data: unknown): Promise<unknown> => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(data as never);
    },
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? "mem_default",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-02-01T00:00:00Z",
    type: overrides.type ?? "fact",
    title: overrides.title ?? "durable sentinel",
    content: overrides.content ?? "durable sentinel content",
    concepts: overrides.concepts ?? ["durable", "sentinel"],
    files: overrides.files ?? [],
    sessionIds: overrides.sessionIds ?? [],
    strength: overrides.strength ?? 5,
    version: overrides.version ?? 1,
    isLatest: overrides.isLatest ?? true,
    forgetAfter: overrides.forgetAfter,
    imageRef: overrides.imageRef,
    imageData: overrides.imageData,
    agentId: overrides.agentId,
    project: overrides.project,
  };
}

describe("durable memory recall", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
  });

  it("expands a durable memory before session scans", async () => {
    const memory = makeMemory({ id: "mem_expand", agentId: "agent-a" });
    await kv.set(KV.memories, memory.id, memory);
    const list = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.sessions) throw new Error("session scan should not run");
      return list<T>(scope);
    };
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);

    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: [memory.id],
      agentId: "agent-a",
    })) as {
      results: Array<{ observation: CompressedObservation }>;
    };

    expect(result.results[0]?.observation).toMatchObject({
      id: memory.id,
      agentId: "agent-a",
    });
  });

  it("keeps scanning a session batch after an undefined KV miss", async () => {
    const first: Session = {
      id: "ses_missing",
      project: "project-a",
      cwd: "/tmp/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 0,
    };
    const second = { ...first, id: "ses_found", observationCount: 1 };
    const observation: CompressedObservation = {
      id: "obs_later",
      sessionId: second.id,
      timestamp: "2026-02-01T00:00:00Z",
      type: "decision",
      title: "later observation",
      facts: [],
      narrative: "found after undefined",
      concepts: [],
      files: [],
      importance: 5,
    };
    await kv.set(KV.sessions, first.id, first);
    await kv.set(KV.sessions, second.id, second);
    await kv.set(KV.observations(second.id), observation.id, observation);
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);

    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: [observation.id],
    })) as { results: Array<{ observation: CompressedObservation }> };

    expect(result.results[0]?.observation.id).toBe(observation.id);
  });

  it("renders and records only the top 10 scoped durable memories in context", async () => {
    for (let index = 0; index < 12; index++) {
      const memory = makeMemory({
        id: `mem_context_${index}`,
        title: `context-sentinel-${index}`,
        content: `context-sentinel-${index}`,
        project: "project-a",
        agentId: "agent-a",
        strength: index,
      });
      await kv.set(KV.memories, memory.id, memory);
    }
    for (const memory of [
      makeMemory({ id: "mem_wrong_project", content: "wrong-project", project: "project-b", agentId: "agent-a", strength: 99 }),
      makeMemory({ id: "mem_wrong_agent", content: "wrong-agent", project: "project-a", agentId: "agent-b", strength: 99 }),
      makeMemory({ id: "mem_expired", content: "expired-memory", project: "project-a", agentId: "agent-a", strength: 99, forgetAfter: "2020-01-01T00:00:00Z" }),
      makeMemory({ id: "mem_superseded", content: "superseded-memory", project: "project-a", agentId: "agent-a", strength: 99, isLatest: false }),
    ]) {
      await kv.set(KV.memories, memory.id, memory);
    }
    registerContextFunction(sdk as never, kv as never, 20_000);

    const result = (await sdk.trigger("mem::context", {
      sessionId: "ses_current",
      project: "project-a",
      agentId: "agent-a",
    })) as { context: string };
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.context.match(/^- context-sentinel-/gm)).toHaveLength(10);
    expect(result.context).toContain("context-sentinel-11");
    expect(result.context).not.toMatch(/^- context-sentinel-1:/m);
    expect(result.context).not.toMatch(/wrong-project|wrong-agent|expired-memory|superseded-memory/);
    const accessRows = await kv.list<{ id: string }>(KV.accessLog);
    expect(accessRows).toHaveLength(10);
  });

  it("does not repeat a durable memory title derived from its content", async () => {
    const derivedContent =
      "Always pin lockfiles before dependency updates so installs stay reproducible across every supported agent runtime.";
    const memories = [
      makeMemory({
        id: "mem_derived_title",
        title: derivedContent.slice(0, 80),
        content: derivedContent,
        project: "project-a",
      }),
      makeMemory({
        id: "mem_independent_title",
        title: "Database migration",
        content: "Database migration requires downtime.",
        project: "project-a",
      }),
    ];
    for (const memory of memories) {
      await kv.set(KV.memories, memory.id, memory);
    }
    registerContextFunction(sdk as never, kv as never, 20_000);

    const result = (await sdk.trigger("mem::context", {
      sessionId: "ses_current",
      project: "project-a",
    })) as { context: string };

    expect(result.context).toContain(`- ${derivedContent}`);
    expect(result.context).not.toContain(
      `${derivedContent.slice(0, 80)}: ${derivedContent}`,
    );
    expect(result.context).toContain(
      "- Database migration: Database migration requires downtime.",
    );
  });

  it("returns capped, ranked, scoped durable memories when hybrid search is empty", async () => {
    const candidates = [
      makeMemory({ id: "mem_global", content: "needle sentinel global", agentId: "agent-a", strength: 10 }),
      makeMemory({ id: "mem_exact_low", content: "needle sentinel exact", project: "project-a", agentId: "agent-a", strength: 4 }),
      makeMemory({ id: "mem_exact_high", content: "needle sentinel exact high", project: "project-a", agentId: "agent-a", strength: 9 }),
      makeMemory({ id: "mem_wrong_project", content: "needle sentinel wrong project", project: "project-b", agentId: "agent-a", strength: 99 }),
      makeMemory({ id: "mem_wrong_agent", content: "needle sentinel wrong agent", project: "project-a", agentId: "agent-b", strength: 99 }),
      makeMemory({ id: "mem_expired", content: "needle sentinel expired", project: "project-a", agentId: "agent-a", strength: 99, forgetAfter: "2020-01-01T00:00:00Z" }),
      makeMemory({ id: "mem_superseded", content: "needle sentinel superseded", project: "project-a", agentId: "agent-a", strength: 99, isLatest: false }),
      makeMemory({ id: "mem_unmatched", content: "other words", project: "project-a", agentId: "agent-a", strength: 99 }),
    ];
    for (const memory of candidates) await kv.set(KV.memories, memory.id, memory);
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "needle sentinel",
      project: "project-a",
      agentId: "agent-a",
      limit: 3,
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((item) => item.obsId)).toEqual([
      "mem_exact_high",
      "mem_exact_low",
      "mem_global",
    ]);
  });

  it("deduplicates a durable memory already returned by hybrid search", async () => {
    const memory = makeMemory({
      id: "mem_duplicate",
      content: "needle duplicate",
      project: "project-a",
      agentId: "agent-a",
    });
    await kv.set(KV.memories, memory.id, memory);
    const observation = memoryToObservation(memory);
    registerSmartSearchFunction(sdk as never, kv as never, async () => [
      {
        observation,
        vectorScore: 0,
        bm25Score: 1,
        combinedScore: 1,
        sessionId: observation.sessionId,
      },
    ]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "needle",
      project: "project-a",
      agentId: "agent-a",
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((item) => item.obsId)).toEqual([memory.id]);
  });

  it("allows projectless session observations for a project-scoped search", async () => {
    const observation: CompressedObservation = {
      id: "obs_projectless",
      sessionId: "ses_projectless",
      timestamp: "2026-02-01T00:00:00Z",
      type: "decision",
      title: "projectless session result",
      facts: [],
      narrative: "projectless session result",
      concepts: [],
      files: [],
      importance: 5,
    };
    registerSmartSearchFunction(sdk as never, kv as never, async () => [
      {
        observation,
        vectorScore: 0,
        bm25Score: 1,
        combinedScore: 1,
        sessionId: observation.sessionId,
      },
    ]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "projectless",
      project: "project-a",
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((item) => item.obsId)).toEqual([observation.id]);
  });

  it("does not let weak substring durable matches crowd out a precise hybrid hit", async () => {
    const memory = makeMemory({
      id: "mem_weak_ip_match",
      content: "shipping server 4 release notes",
      strength: 10,
    });
    await kv.set(KV.memories, memory.id, memory);
    const observation: CompressedObservation = {
      id: "obs_unraid_ip",
      sessionId: "ses_unraid",
      timestamp: "2026-08-01T00:00:00Z",
      type: "decision",
      title: "Unraid server IP is 192.168.86.4",
      facts: ["The Unraid server IP address is 192.168.86.4."],
      narrative: "Recovered the exact Unraid server address.",
      concepts: ["Unraid", "192.168.86.4"],
      files: [],
      importance: 8,
    };
    registerSmartSearchFunction(sdk as never, kv as never, async () => [{
      observation,
      vectorScore: 0.9,
      bm25Score: 1,
      combinedScore: 0.9,
      sessionId: observation.sessionId,
    }]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "192.168.86.4 Unraid server IP",
      limit: 1,
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((item) => item.obsId)).toEqual([observation.id]);
  });
});
