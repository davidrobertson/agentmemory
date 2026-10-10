#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
//#region src/hooks/antigravity-bridge.ts
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME_MAP = {
	view_file: "read",
	view_line_range: "read",
	view_code_item: "read",
	read_file: "read",
	read_url_content: "read",
	edit_file: "edit",
	replace_file_content: "edit",
	propose_code: "edit",
	write_to_file: "write",
	create_file: "write",
	grep_search: "grep",
	codebase_search: "grep",
	find_by_name: "glob",
	list_dir: "glob"
};
const ARG_KEY_MAP = {
	AbsolutePath: "file_path",
	TargetFile: "file_path",
	DirectoryPath: "path",
	SearchDirectory: "path",
	Pattern: "pattern",
	Query: "pattern",
	CommandLine: "command"
};
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function firstString(...values) {
	for (const v of values) if (typeof v === "string" && v.length > 0) return v;
}
function normalizeToolArgs(args) {
	if (!args) return {};
	const out = { ...args };
	for (const [from, to] of Object.entries(ARG_KEY_MAP)) if (out[to] === void 0 && args[from] !== void 0) out[to] = args[from];
	return out;
}
function normalizePayload(event, raw) {
	const toolCall = asObject(raw["toolCall"]);
	const workspacePaths = Array.isArray(raw["workspacePaths"]) ? raw["workspacePaths"] : [];
	const sessionId = firstString(raw["conversationId"], raw["session_id"], raw["sessionId"]) ?? "unknown";
	const cwd = firstString(raw["cwd"], workspacePaths[0]) ?? process.cwd();
	const out = {
		...raw,
		session_id: sessionId,
		cwd,
		hook_event_name: event
	};
	const transcriptPath = firstString(raw["transcript_path"], raw["transcriptPath"]);
	if (transcriptPath) out["transcript_path"] = transcriptPath;
	if (toolCall) {
		const args = normalizeToolArgs(asObject(toolCall["args"]) ?? asObject(toolCall["toolArgs"]));
		const rawName = firstString(toolCall["name"], toolCall["toolName"], args["ToolName"], args["toolName"]);
		if (rawName) {
			out["tool_name"] = TOOL_NAME_MAP[rawName] ?? rawName;
			out["native_tool_name"] = rawName;
		}
		out["tool_input"] = args;
		if (out["tool_use_id"] === void 0 && Number.isInteger(raw["stepIdx"]) && raw["stepIdx"] >= 0) out["tool_use_id"] = `step:${raw["stepIdx"]}`;
		const result = toolCall["result"] ?? raw["toolResult"] ?? raw["result"] ?? firstString(raw["error"]);
		if (result !== void 0) out["tool_result"] = result;
	}
	return out;
}
function targetsFor(event, raw) {
	switch (event) {
		case "PreInvocation": {
			const n = raw["invocationNum"];
			return typeof n !== "number" || n === 0 ? ["session-start.mjs"] : [];
		}
		case "PreToolUse": return ["pre-tool-use.mjs"];
		case "PostToolUse": return ["post-tool-use.mjs"];
		case "Stop": return raw["fullyIdle"] === false ? [] : ["session-end.mjs"];
		default: return [];
	}
}
function responseFor(event, context = "") {
	if (event === "PreInvocation" && context) return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
	return event === "PreToolUse" ? "{\"decision\":\"allow\"}" : "{}";
}
async function main() {
	const event = process.argv[2];
	if (!event) return;
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let raw;
	try {
		raw = JSON.parse(input);
	} catch {
		return;
	}
	if (!raw || typeof raw !== "object") return;
	const payload = JSON.stringify(normalizePayload(event, raw));
	let context = "";
	for (const script of targetsFor(event, raw)) {
		const child = spawnSync(process.execPath, [join(SCRIPTS_DIR, script)], {
			input: payload,
			encoding: "utf8",
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			]
		});
		if (event === "PreInvocation" && script === "session-start.mjs" && child.status === 0) context = child.stdout?.trim() ?? "";
	}
	return context;
}
if (process.argv[1] !== void 0 && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => void 0).then((context) => {
	process.stdout.write(responseFor(process.argv[2] ?? "", context));
	process.exit(0);
});
//#endregion
export { normalizePayload, responseFor, targetsFor };

//# sourceMappingURL=antigravity-bridge.mjs.map