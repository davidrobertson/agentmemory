import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { VERSION } from "../src/version.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    snapshot: () => structuredClone(store),
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

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

const optionalImportSections = [
  ["profiles", KV.profiles, "project"],
  ["graphNodes", KV.graphNodes, "id"],
  ["graphEdges", KV.graphEdges, "id"],
  ["semanticMemories", KV.semantic, "id"],
  ["proceduralMemories", KV.procedural, "id"],
  ["actions", KV.actions, "id"],
  ["actionEdges", KV.actionEdges, "id"],
  ["routines", KV.routines, "id"],
  ["signals", KV.signals, "id"],
  ["checkpoints", KV.checkpoints, "id"],
  ["sentinels", KV.sentinels, "id"],
  ["sketches", KV.sketches, "id"],
  ["crystals", KV.crystals, "id"],
  ["facets", KV.facets, "id"],
  ["lessons", KV.lessons, "id"],
  ["insights", KV.insights, "id"],
  ["accessLogs", KV.accessLog, "memoryId"],
] as const;

const importRowKeys = [
  ["sessions", "id"],
  ["memories", "id"],
  ["summaries", "sessionId"],
  ...optionalImportSections.map(([section, , key]) => [section, key]),
  ["observations", "id"],
] as const;

const malformedSections = [
  ...optionalImportSections.map(([section]) => ({ section, shape: "null", value: null })),
  { section: "lessons", shape: "an object", value: {} },
  { section: "profiles", shape: "a string", value: "oops" },
  { section: "accessLogs", shape: "a string", value: "oops" },
  { section: "graphNodes", shape: "false", value: false },
];

const malformedRows = [
  ...importRowKeys.map(([section, key]) => ({ section, key, shape: "without its key", value: {} })),
  ...[
    ["lessons", "id"],
    ["summaries", "sessionId"],
    ["profiles", "project"],
    ["accessLogs", "memoryId"],
  ].flatMap(([section, key]) => [
    { section, key, shape: "null", value: null },
    { section, key, shape: "with an empty key", value: { [key]: "" } },
    { section, key, shape: "with a numeric key", value: { [key]: 1 } },
  ]),
  { section: "facets", key: "id", shape: "null", value: null },
  { section: "memories", key: "id", shape: "null", value: null },
];

const sectionPreflightCases = [
  ...malformedSections.map((testCase) => ({ ...testCase, strategy: "replace" })),
  ...["merge", "skip"].flatMap((strategy) => [
    { section: "lessons", shape: "null", value: null, strategy },
    { section: "accessLogs", shape: "a string", value: "oops", strategy },
  ]),
];

const rowPreflightCases = [
  ...malformedRows.map((testCase) => ({ ...testCase, strategy: "replace" })),
  ...["merge", "skip"].flatMap((strategy) => [
    { section: "profiles", key: "project", shape: "without its key", value: {}, strategy },
    { section: "observations", key: "id", shape: "null", value: null, strategy },
  ]),
];

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    // getSearchIndex() returns a module-level singleton shared across
    // tests. Clear it so index assertions here don't see rows added by
    // a prior test's import.
    getSearchIndex().clear();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe(VERSION);
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import adds imported records to the search index", async () => {
    // Regression: mem::import wrote rows to KV but never indexed them.
    // On an existing install the boot rebuild gate (bm25.size === 0) is
    // false, so imported data stayed invisible to mem::search forever.
    const importedObs: CompressedObservation = {
      id: "obs_imported",
      sessionId: "ses_imported",
      timestamp: "2026-03-01T10:00:00Z",
      type: "file_edit",
      title: "Kubernetes deployment rollout",
      facts: ["Scaled replicas"],
      narrative: "Adjusted the kubernetes deployment rollout strategy",
      concepts: ["k8s"],
      files: ["deploy.yaml"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_imported",
      title: "Postgres connection pooling",
      content: "Use pgbouncer for postgres connection pooling",
    };
    const exportData: ExportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [
        { ...testSession, id: "ses_imported", observationCount: 1 },
      ],
      observations: { ses_imported: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; observations: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);

    const idx = getSearchIndex();
    expect(idx.has("obs_imported")).toBe(true);
    expect(idx.has("mem_imported")).toBe(true);

    const obsHit = idx.search("kubernetes rollout");
    expect(obsHit.some((r) => r.obsId === "obs_imported")).toBe(true);

    const memHit = idx.search("postgres pooling");
    expect(memHit.some((r) => r.obsId === "mem_imported")).toBe(true);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  describe("import preflight", () => {
    let incoming: ExportData;

    beforeEach(async () => {
      for (const [section, scope, key] of optionalImportSections) {
        await kv.set(scope, `existing-${section}`, { [key]: `existing-${section}` });
      }
      incoming = {
        version: VERSION,
        exportedAt: "2026-11-01T00:00:00Z",
        sessions: [{ ...testSession, id: "ses_incoming" }],
        observations: {
          ses_incoming: [{ ...testObs, id: "obs_incoming", sessionId: "ses_incoming" }],
        },
        memories: [{ ...testMemory, id: "mem_incoming" }],
        summaries: [{ ...testSummary, sessionId: "ses_incoming" }],
      };
    });

    it.each(sectionPreflightCases)("$strategy rejects $section as $shape before any writes", async ({ section, value, strategy }) => {
      const before = kv.snapshot();
      const result = await sdk.trigger("mem::import", {
        exportData: { ...incoming, [section]: value },
        strategy,
      }).catch((error: unknown) => error);

      expect.soft(result).toMatchObject({ success: false, error: `${section} must be an array` });
      expect(kv.snapshot()).toEqual(before);
    });

    it.each(rowPreflightCases)("$strategy rejects a $section row $shape before any writes", async ({ section, key, value, strategy }) => {
      const before = kv.snapshot();
      const rows = [{ id: "valid", sessionId: "valid", project: "valid", memoryId: "valid" }, value];
      const result = await sdk.trigger("mem::import", {
        exportData: {
          ...incoming,
          [section]: section === "observations" ? { ses_incoming: rows } : rows,
        },
        strategy,
      }).catch((error: unknown) => error);

      const location = section === "observations" ? "observations.ses_incoming" : section;
      expect.soft(result).toMatchObject({
        success: false,
        error: `${location}[1] must be an object with a string ${key}`,
      });
      expect(kv.snapshot()).toEqual(before);
    });

    it.each(["replace", "merge", "skip"])("%s rejects access logs above the cap before any writes", async (strategy) => {
      const before = kv.snapshot();
      const result = await sdk.trigger("mem::import", {
        exportData: {
          ...incoming,
          accessLogs: Array.from({ length: 50_001 }, () => ({ memoryId: "mem_incoming" })),
        },
        strategy,
      });

      expect.soft(result).toMatchObject({ success: false, error: "Too many access logs (max 50000)" });
      expect(kv.snapshot()).toEqual(before);
    });
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });
});

const bloatedIds = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}_${String(i).padStart(3, "0")}`);

describe("import bounds graph provenance", () => {
  it("caps sourceObservationIds on imported graph nodes and edges", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);
    const exportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [
        {
          id: "gn_bloat",
          type: "file",
          name: "src/hot.ts",
          properties: {},
          sourceObservationIds: bloatedIds("obs", 400),
          createdAt: "2026-03-01T00:00:00Z",
        },
        {
          id: "gn_small",
          type: "file",
          name: "src/cold.ts",
          properties: {},
          sourceObservationIds: ["obs_x"],
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
      graphEdges: [
        {
          id: "ge_bloat",
          type: "related_to",
          sourceNodeId: "gn_bloat",
          targetNodeId: "gn_small",
          weight: 0.5,
          sourceObservationIds: bloatedIds("eobs", 100),
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
    } as unknown as ExportData;
    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    const n = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:nodes", "gn_bloat");
    const s = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:nodes", "gn_small");
    const e = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:edges", "ge_bloat");
    expect(n!.sourceObservationIds).toEqual(bloatedIds("obs", 400).slice(-32));
    expect(s!.sourceObservationIds).toEqual(["obs_x"]);
    expect(e!.sourceObservationIds).toEqual(bloatedIds("eobs", 100).slice(-32));
  });
});
