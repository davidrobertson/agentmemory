import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = resolve(__dirname, "..", "plugin");

async function runHook(options: {
  readonly script: string;
  readonly payload: Record<string, unknown>;
  readonly url: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{
  readonly code: number | null;
  readonly elapsed: number;
  readonly stdout: string;
}> {
  const startedAt = Date.now();
  const env = { ...process.env };
  delete env.AGENTMEMORY_INJECT_CONTEXT;
  Object.assign(env, options.env, { AGENTMEMORY_URL: options.url });
  const child = spawn(process.execPath, [resolve(PLUGIN_ROOT, "scripts", options.script)], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stdin.end(JSON.stringify(options.payload));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  return { code, elapsed: Date.now() - startedAt, stdout };
}

describe("built capture hooks", () => {
  it("loads context injection from the AgentMemory env file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agentmemory-hook-env-"));
    writeFileSync(join(dataDir, ".env"), "AGENTMEMORY_INJECT_CONTEXT=true\n");
    const requests: unknown[] = [];
    const context = '<agentmemory-context project="demo">prior work</agentmemory-context>';
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ context }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");

    try {
      const result = await runHook({
        script: "session-start.mjs",
        payload: { session_id: "env-file-test", cwd: process.cwd() },
        url: `http://127.0.0.1:${address.port}`,
        env: { AGENTMEMORY_DATA_DIR: dataDir },
      });
      expect(result.code).toBe(0);
      expect(requests).toEqual([
        expect.objectContaining({
          sessionId: "env-file-test",
          includeContext: true,
        }),
      ]);
      expect(result.stdout).toBe(context);
    } finally {
      server.close();
      await once(server, "close");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["prompt-submit.mjs", { prompt: "remember this" }],
    ["post-tool-use.mjs", { tool_name: "Read", tool_output: "done" }],
    ["post-tool-failure.mjs", { tool_name: "Read", error: "failed" }],
    ["session-start.mjs", {}],
  ])("dispatches telemetry without waiting for the response: %s", async (script, payload) => {
    const paths: string[] = [];
    const server = http.createServer((_request, response) => {
      paths.push(_request.url ?? "");
      setTimeout(() => response.end("ok"), 1200);
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
      expect(result.elapsed).toBeLessThan(1100);
      expect(paths).toHaveLength(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("does not wait for a stalled telemetry response", async () => {
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
      expect(result.elapsed).toBeLessThan(1100);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("sends Codex Stop only to session end", async () => {
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
      expect(paths).toEqual(["/agentmemory/session/end"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
