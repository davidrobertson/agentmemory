import { describe, expect, it } from "vitest";
import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function session(id: string, startedAt: string, project = "demo"): Session {
  return {
    id,
    project,
    cwd: `/projects/${project}`,
    startedAt,
    status: "completed",
    observationCount: 1,
  };
}

async function fileHistory(rows: unknown[], payload: { sessionId?: string; project?: string }) {
  const sdk = mockSdk();
  const kv = mockKV();
  for (const [index, row] of rows.entries()) {
    await kv.set(KV.sessions, String(index), row);
  }
  await kv.set(KV.observations("recent"), "matching-observation", {
    id: "matching-observation",
    sessionId: "recent",
    title: "Recent file change",
    narrative: "recent-file-history-marker",
    files: ["src/handler.ts"],
    importance: 5,
    type: "file_edit",
    timestamp: "2026-10-10T12:00:00.000Z",
  });
  registerFileIndexFunction(sdk as never, kv as never);
  return sdk.trigger({
    function_id: "mem::file-context",
    payload: { files: ["src/handler.ts"], ...payload },
  });
}

describe("file history session selection", () => {
  it.each([
    { id: "partial", status: "completed" },
    null,
    { id: "partial", startedAt: "2026-10-11T12:00:00.000Z" },
  ])("finds recent file history when legacy rows are malformed: %j", async (malformed) => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      session(`old-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
      malformed,
    ]).flat();
    rows.push(session("recent", "2026-10-10T12:00:00.000Z"));

    const result = await fileHistory(rows, {});

    expect(result).toEqual({ context: expect.stringContaining("recent-file-history-marker") });
  });

  it("applies project and current-session filters before the fifteen-session limit", async () => {
    const rows = [
      ...Array.from({ length: 16 }, (_, index) =>
        session(`foreign-${index}`, "2026-10-12T12:00:00.000Z", "other"),
      ),
      ...Array.from({ length: 14 }, (_, index) =>
        session(`newer-${index}`, "2026-10-11T12:00:00.000Z"),
      ),
      session("current", "2026-10-13T12:00:00.000Z"),
      session("recent", "2026-10-10T12:00:00.000Z"),
    ];

    const result = await fileHistory(rows, { project: "demo", sessionId: "current" });

    expect(result).toEqual({ context: expect.stringContaining("recent-file-history-marker") });
  });
});
