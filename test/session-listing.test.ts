import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { resetHandleForTests, setLivezProbe } from "../src/mcp/rest-proxy.js";
import { handleToolCall } from "../src/mcp/standalone.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";

type Handler = (request: {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly query_params?: Record<string, string>;
}) => Promise<unknown>;

function mockSdk(): {
  readonly registerFunction: (id: string, handler: Handler) => void;
  readonly registerTrigger: () => void;
  readonly functions: ReadonlyMap<string, Handler>;
} {
  const functions = new Map<string, Handler>();
  return {
    registerFunction: (id, handler) => functions.set(id, handler),
    registerTrigger: () => {},
    functions,
  };
}

const rows = [
  { id: "bad", project: "demo" },
  {
    id: "ses_old",
    project: "demo",
    cwd: "/demo",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  },
  {
    id: "ses_tie_b",
    project: "demo",
    cwd: "/demo",
    startedAt: "2026-02-01T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  },
  {
    id: "ses_latest",
    project: "demo",
    cwd: "/demo",
    startedAt: "2026-03-01T00:00:00.000Z",
    status: "active",
    observationCount: 1,
  },
  {
    id: "ses_tie_a",
    project: "demo",
    cwd: "/demo",
    startedAt: "2026-02-01T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  },
];

function ids(value: unknown): string[] {
  return (value as { readonly sessions: Array<{ readonly id: string }> }).sessions.map(
    (session) => session.id,
  );
}

describe("session listings", () => {
  beforeEach(() => {
    resetHandleForTests();
    setLivezProbe(vi.fn(async () => ({ ok: false })));
  });

  afterEach(() => {
    resetHandleForTests();
    setLivezProbe();
  });

  it("orders valid sessions newest first with an ID tie-break and skips malformed rows across all surfaces", async () => {
    const kv = {
      list: async () => rows,
      get: async () => null,
    };

    const apiSdk = mockSdk();
    registerApiTriggers(apiSdk as never, kv as never);
    const api = apiSdk.functions.get("api::sessions");
    expect(api).toBeDefined();
    const apiResponse = await api!({ headers: {}, query_params: { limit: "2" } });

    const mcpSdk = mockSdk();
    registerMcpEndpoints(mcpSdk as never, kv as never);
    const mcp = mcpSdk.functions.get("mcp::tools::call");
    expect(mcp).toBeDefined();
    const mcpResponse = await mcp!({
      body: { name: "memory_sessions", arguments: { limit: 2 } },
      headers: {},
    });

    const standaloneKv = new InMemoryKV();
    for (const row of rows) await standaloneKv.set("mem:sessions", row.id, row);
    const standaloneResponse = await handleToolCall(
      "memory_sessions",
      { limit: 2 },
      standaloneKv,
    );

    const expected = ["ses_latest", "ses_tie_a"];
    expect(ids((apiResponse as { readonly body: unknown }).body)).toEqual(expected);
    expect(
      ids(JSON.parse((mcpResponse as { readonly body: { readonly content: Array<{ readonly text: string }> } }).body.content[0].text)),
    ).toEqual(expected);
    expect(ids(JSON.parse(standaloneResponse.content[0].text))).toEqual(expected);
  });

  it("returns every valid REST session without a limit and defaults MCP to twenty", async () => {
    const kv = {
      list: async () => [
        ...rows,
        ...Array.from({ length: 17 }, (_, index) => ({
          id: `ses_${index}`,
          project: "demo",
          cwd: "/demo",
          startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          status: "completed",
          observationCount: 1,
        })),
      ],
      get: async () => null,
    };

    const apiSdk = mockSdk();
    registerApiTriggers(apiSdk as never, kv as never);
    const api = apiSdk.functions.get("api::sessions");
    const apiResponse = await api!({ headers: {}, query_params: {} });
    expect(ids((apiResponse as { readonly body: unknown }).body)).toHaveLength(21);

    const mcpSdk = mockSdk();
    registerMcpEndpoints(mcpSdk as never, kv as never);
    const mcp = mcpSdk.functions.get("mcp::tools::call");
    const mcpResponse = await mcp!({
      body: { name: "memory_sessions", arguments: {} },
      headers: {},
    });
    expect(
      ids(JSON.parse((mcpResponse as { readonly body: { readonly content: Array<{ readonly text: string }> } }).body.content[0].text)),
    ).toHaveLength(20);
  });
});
