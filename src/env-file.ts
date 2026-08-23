import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENTMEMORY_DATA_DIR =
  process.env["AGENTMEMORY_DATA_DIR"]?.trim() || join(homedir(), ".agentmemory");

const ENV_FILE = join(AGENTMEMORY_DATA_DIR, ".env");
let envFileCache: Record<string, string> | undefined;

function loadEnvFile(): Record<string, string> {
  if (envFileCache) return envFileCache;
  if (!existsSync(ENV_FILE)) {
    envFileCache = {};
    return envFileCache;
  }

  const vars: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    const quoteChar = val[0] === '"' || val[0] === "'" ? val[0] : "";
    if (quoteChar) {
      const closeIdx = val.indexOf(quoteChar, 1);
      if (closeIdx !== -1) val = val.slice(1, closeIdx);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    vars[key] = val;
  }
  envFileCache = vars;
  return envFileCache;
}

export function __resetEnvFileCache(): void {
  envFileCache = undefined;
}

export function hydrateProcessEnvFromFile(): void {
  for (const [key, value] of Object.entries(loadEnvFile())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getMergedEnv(
  overrides?: Record<string, string>,
): Record<string, string> {
  return { ...loadEnvFile(), ...process.env, ...overrides } as Record<
    string,
    string
  >;
}
