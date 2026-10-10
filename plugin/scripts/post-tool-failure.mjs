#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { captureObservation, isDrainChild, runDrainChild, withEventId } from "./_capture.mjs";
const ENV_FILE = join(process.env["AGENTMEMORY_DATA_DIR"]?.trim() || join(homedir(), ".agentmemory"), ".env");
let envFileCache;
function loadEnvFile() {
	if (envFileCache) return envFileCache;
	if (!existsSync(ENV_FILE)) {
		envFileCache = {};
		return envFileCache;
	}
	const vars = {};
	for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		const quoteChar = val[0] === "\"" || val[0] === "'" ? val[0] : "";
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
function hydrateProcessEnvFromFile(excludedKeys = []) {
	for (const [key, value] of Object.entries(loadEnvFile())) if (!excludedKeys.includes(key) && process.env[key] === void 0) process.env[key] = value;
}
//#endregion
//#region src/hooks/_env.ts
hydrateProcessEnvFromFile(["AGENTMEMORY_SECRET"]);
//#endregion
//#region src/hooks/_capture-filter.ts
const DEFAULT_DENY_PATTERNS = [
	"memory_*",
	"toolsearch",
	"listmcpresources",
	"fetchmcpresource"
];
function parseEnvList(raw) {
	if (!raw?.trim()) return void 0;
	return raw.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
}
function bareToolName(toolName) {
	const trimmed = toolName.trim();
	if (/^mcp__/i.test(trimmed)) {
		const parts = trimmed.split("__");
		if (parts.length >= 3) return parts[parts.length - 1];
	}
	return trimmed;
}
function normalizePattern(pattern) {
	return pattern.trim().toLowerCase();
}
function matchesPattern(toolName, pattern) {
	const bare = bareToolName(toolName).toLowerCase();
	const full = toolName.trim().toLowerCase();
	const pat = normalizePattern(pattern);
	if (!pat.includes("*")) return bare === pat || full === pat;
	const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
	return re.test(bare) || re.test(full);
}
function matchesAny(toolName, patterns) {
	return patterns.some((pattern) => matchesPattern(toolName, pattern));
}
function shouldCaptureTool(toolName) {
	if (typeof toolName !== "string" || !toolName.trim()) return true;
	const allow = parseEnvList(process.env["AGENTMEMORY_CAPTURE_ALLOW"]);
	if (allow) return matchesAny(toolName, allow);
	return !matchesAny(toolName, [...DEFAULT_DENY_PATTERNS, ...parseEnvList(process.env["AGENTMEMORY_CAPTURE_DENY"]) ?? []]);
}
//#endregion
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/post-tool-failure.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const OBSERVE_TIMEOUT_MS = 3e3;
const EXIT_CAP_MS = 3500;
async function main() {
	if (isDrainChild()) return runDrainChild();
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	if (data.is_interrupt || data.isInterrupt) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	const toolName = data.tool_name ?? data.toolName;
	if (!shouldCaptureTool(toolName)) return;
	const toolInput = data.tool_input ?? data.toolArgs;
	const error = data.error ?? data.errorMessage;
	const cwd = hookCwd(data) || process.cwd();
	captureObservation(withEventId({
		hookType: "post_tool_failure",
		sessionId,
		project: resolveProject(cwd),
		cwd,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		data: {
			tool_name: toolName,
			tool_input: typeof toolInput === "string" ? toolInput.slice(0, 4e3) : JSON.stringify(toolInput ?? "").slice(0, 4e3),
			error: typeof error === "string" ? error.slice(0, 4e3) : JSON.stringify(error ?? "").slice(0, 4e3)
		}
	}, data), OBSERVE_TIMEOUT_MS);
	setTimeout(() => process.exit(0), EXIT_CAP_MS).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=post-tool-failure.mjs.map