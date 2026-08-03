import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = resolve(__dirname, "..", "plugin");

async function runHook(options: {
  readonly script: string;
  readonly payload: Record<string, unknown>;
  readonly url: string;
}): Promise<{ readonly code: number | null; readonly elapsed: number }> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [resolve(PLUGIN_ROOT, "scripts", options.script)], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTMEMORY_URL: options.url },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(options.payload));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  return { code, elapsed: Date.now() - startedAt };
}

describe("built capture hooks", () => {
  it.each([
    ["prompt-submit.mjs", { prompt: "remember this" }],
    ["post-tool-use.mjs", { tool_name: "Read", tool_output: "done" }],
    ["post-tool-failure.mjs", { tool_name: "Read", error: "failed" }],
    ["session-start.mjs", {}],
  ])("waits for the observe response before exiting: %s", async (script, payload) => {
    const server = http.createServer((_request, response) => {
      setTimeout(() => response.end("ok"), 700);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");

    try {
      const result = await runHook({
        script,
        payload: { session_id: "delivery-test", cwd: process.cwd(), ...payload },
        url: `http://127.0.0.1:${address.port}`,
      });
      expect(result.code).toBe(0);
      expect(result.elapsed).toBeGreaterThanOrEqual(650);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("fails open after the capture timeout", async () => {
    const server = http.createServer(() => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");

    try {
      const result = await runHook({
        script: "prompt-submit.mjs",
        payload: { session_id: "timeout-test", cwd: process.cwd(), prompt: "timeout" },
        url: `http://127.0.0.1:${address.port}`,
      });
      expect(result.code).toBe(0);
      expect(result.elapsed).toBeGreaterThanOrEqual(2800);
      expect(result.elapsed).toBeLessThan(5000);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("sends Codex Stop only to summarize", async () => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "");
      response.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");

    try {
      const result = await runHook({
        script: "stop.mjs",
        payload: { session_id: "stop-test" },
        url: `http://127.0.0.1:${address.port}`,
      });
      expect(result.code).toBe(0);
      expect(paths).toEqual(["/agentmemory/summarize"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
