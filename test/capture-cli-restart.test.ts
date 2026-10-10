import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCaptureCommand } from "../src/cli/capture.js";
import { appendSpool, spoolSummary } from "../src/capture/spool.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps a CLI drain record on a missing worker route, then delivers it when ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-cli-restart-"));
  const base = "http://127.0.0.1:39111";
  vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL_DIR", dir);
  let status = 404;
  vi.stubGlobal("fetch", async (url: string) => new Response("{}", { status: url.endsWith("/observe") ? status : 200 }));
  try {
    expect(appendSpool(base, "evc_cli_restart_404", { sessionId: "restart-cli", data: { tool_output: "keep me" } }, "unreachable").spooled).toBe(true);
    const options = { base, args: ["--drain", "--json"], log: () => {} };
    expect(await runCaptureCommand(options)).toBe(0);
    expect(spoolSummary(base).records).toBe(1);
    status = 201;
    expect(await runCaptureCommand(options)).toBe(0);
    expect(spoolSummary(base).records).toBe(0);
    expect(spoolSummary(base).stats.delivered).toBe(1);
    expect(spoolSummary(base).stats.rejected).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
