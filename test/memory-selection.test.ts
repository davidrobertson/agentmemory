import { describe, expect, it } from "vitest";
import { selectDurableMemories } from "../src/state/memory-selection.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { Memory } from "../src/types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? "mem_default",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-02-01T00:00:00Z",
    type: "fact",
    title: overrides.title ?? "durable sentinel",
    content: overrides.content ?? "durable sentinel content",
    concepts: overrides.concepts ?? ["durable", "sentinel"],
    files: [],
    sessionIds: [],
    strength: overrides.strength ?? 5,
    version: 1,
    isLatest: true,
    agentId: overrides.agentId,
    project: overrides.project,
    imageRef: overrides.imageRef,
    imageData: overrides.imageData,
  };
}

describe("durable memory selection", () => {
  it("preserves scope and image metadata when converting", () => {
    const observation = memoryToObservation(makeMemory({
      agentId: "agent-a",
      project: "project-a",
      imageRef: "image://sentinel",
      imageData: "data:image/png;base64,c2VudGluZWw=",
    }));

    expect(observation).toMatchObject({
      agentId: "agent-a",
      project: "project-a",
      imageRef: "image://sentinel",
      imageData: "data:image/png;base64,c2VudGluZWw=",
    });
  });

  it("ranks by query match, exact project, strength, update time, then ID", () => {
    const memories = [
      makeMemory({ id: "mem_partial", title: "partial", content: "needle", concepts: [], project: "project-a", strength: 10 }),
      makeMemory({ id: "mem_global", content: "needle sentinel", strength: 10 }),
      makeMemory({ id: "mem_b", content: "needle sentinel", project: "project-a", strength: 8, updatedAt: "2026-03-01T00:00:00Z" }),
      makeMemory({ id: "mem_a", content: "needle sentinel", project: "project-a", strength: 8, updatedAt: "2026-03-01T00:00:00Z" }),
      makeMemory({ id: "mem_old", content: "needle sentinel", project: "project-a", strength: 8 }),
    ];

    expect(selectDurableMemories(memories, {
      query: "needle sentinel",
      project: "project-a",
      limit: memories.length,
    }).map((memory) => memory.id)).toEqual([
      "mem_a", "mem_b", "mem_old", "mem_global", "mem_partial",
    ]);
  });
});
