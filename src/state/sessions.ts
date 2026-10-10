import type { Session } from "../types.js";

export const MAX_SESSION_LIST_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

export function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  const status = value["status"];
  return (
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["project"]) &&
    isNonEmptyString(value["cwd"]) &&
    isNonEmptyString(value["startedAt"]) &&
    (status === "active" || status === "completed" || status === "abandoned") &&
    typeof value["observationCount"] === "number" &&
    Number.isFinite(value["observationCount"]) &&
    isOptionalString(value["endedAt"]) &&
    isOptionalString(value["model"]) &&
    isOptionalStringArray(value["tags"]) &&
    isOptionalString(value["firstPrompt"]) &&
    isOptionalString(value["summary"]) &&
    isOptionalStringArray(value["commitShas"]) &&
    isOptionalString(value["agentId"])
  );
}

export function selectSessions(rows: readonly unknown[], limit?: number): Session[] {
  const sessions = rows
    .filter(isSession)
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
  if (limit === undefined) return sessions;
  return sessions.slice(0, Math.max(0, Math.min(MAX_SESSION_LIST_LIMIT, Math.floor(limit))));
}
