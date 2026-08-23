#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
function hydrateProcessEnvFromFile() {
	for (const [key, value] of Object.entries(loadEnvFile())) if (process.env[key] === void 0) process.env[key] = value;
}
//#endregion
//#region src/hooks/_env.ts
hydrateProcessEnvFromFile();
//#endregion
//#region src/hooks/_project.ts
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
//#region src/hooks/post-commit.ts
const exec = promisify(execFile);
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEOUT_MS = 1500;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function git(args, cwd) {
	try {
		const { stdout } = await exec("git", args, {
			cwd,
			timeout: 1500
		});
		return stdout.trim();
	} catch {
		return null;
	}
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data = {};
	if (input.trim()) try {
		data = JSON.parse(input);
	} catch {}
	if (!data || typeof data !== "object") data = {};
	if (isSdkChildContext(data)) return;
	const cwd = hookCwd(data) || process.env["AGENTMEMORY_CWD"] || process.cwd();
	const sessionId = data.session_id || process.env["AGENTMEMORY_SESSION_ID"] || void 0;
	const sha = process.env["AGENTMEMORY_COMMIT_SHA"] || await git(["rev-parse", "HEAD"], cwd);
	if (!sha) return;
	const branch = await git([
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	], cwd);
	const repo = await git([
		"config",
		"--get",
		"remote.origin.url"
	], cwd);
	const message = await git([
		"log",
		"-1",
		"--pretty=%B",
		sha
	], cwd);
	const author = await git([
		"log",
		"-1",
		"--pretty=%an <%ae>",
		sha
	], cwd);
	const authoredAt = await git([
		"log",
		"-1",
		"--pretty=%aI",
		sha
	], cwd);
	const filesRaw = await git([
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		sha
	], cwd);
	const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : void 0;
	const body = {
		sessionId,
		sha,
		branch: branch || void 0,
		repo: repo || void 0,
		message: message || void 0,
		author: author || void 0,
		authoredAt: authoredAt || void 0,
		files
	};
	try {
		await fetch(`${REST_URL}/agentmemory/session/commit`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=post-commit.mjs.map