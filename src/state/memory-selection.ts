import type { Memory } from "../types.js";

export type DurableMemorySelection = {
  readonly query?: string;
  readonly project?: string;
  readonly agentId?: string;
  readonly limit: number;
  readonly now?: number;
};

export function selectDurableMemories(
  memories: readonly Memory[],
  selection: DurableMemorySelection,
): Memory[] {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = Array.from(new Set(tokenize(selection.query ?? "")));
  const minimumMatches = Math.max(1, Math.ceil(terms.length / 2));
  const now = selection.now ?? Date.now();
  const matchCount = (memory: Memory): number => {
    if (terms.length === 0) return 0;
    const memoryTerms = new Set(
      tokenize([
        memory.title,
        memory.content,
        ...memory.concepts,
        ...memory.files,
      ].join(" ")),
    );
    return terms.reduce(
      (count, term) => count + Number(memoryTerms.has(term)),
      0,
    );
  };

  return memories
    .map((memory) => ({ memory, matches: matchCount(memory) }))
    .filter(({ memory, matches }) => {
      const expiresAt = memory.forgetAfter
        ? new Date(memory.forgetAfter).getTime()
        : Number.POSITIVE_INFINITY;
      return (
        memory.isLatest !== false &&
        expiresAt > now &&
        (selection.agentId === undefined || memory.agentId === selection.agentId) &&
        (selection.project === undefined ||
          memory.project === undefined ||
          memory.project === selection.project) &&
        (terms.length === 0 || matches >= minimumMatches)
      );
    })
    .sort((a, b) => {
      const queryDiff = b.matches - a.matches;
      if (queryDiff !== 0) return queryDiff;
      const projectDiff =
        Number(b.memory.project === selection.project) -
        Number(a.memory.project === selection.project);
      if (projectDiff !== 0) return projectDiff;
      const strengthDiff = b.memory.strength - a.memory.strength;
      if (strengthDiff !== 0) return strengthDiff;
      const updatedDiff =
        new Date(b.memory.updatedAt).getTime() -
        new Date(a.memory.updatedAt).getTime();
      if (updatedDiff !== 0) return updatedDiff;
      return a.memory.id.localeCompare(b.memory.id);
    })
    .slice(0, selection.limit)
    .map(({ memory }) => memory);
}
