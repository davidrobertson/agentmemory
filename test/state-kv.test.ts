import { describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";

describe("StateKV", () => {
  it("rejects missing and blank get keys before serializing state::get", async () => {
    const trigger = vi.fn();
    const kv = new StateKV({ trigger } as never);

    await expect(kv.get("mem:sessions", undefined as never)).rejects.toThrow(
      "key must be a non-empty string",
    );
    await expect(kv.get("mem:sessions", "")).rejects.toThrow(
      "key must be a non-empty string",
    );
    await expect(kv.get("mem:sessions", " ")).rejects.toThrow(
      "key must be a non-empty string",
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("keeps graph record writes out of the unbounded legacy scope", async () => {
    const trigger = vi.fn(
      async (request: {
        function_id: string;
        payload: { scope: string; key: string; value?: unknown };
      }) => {
        if (
          request.function_id === "state::set" &&
          request.payload.scope === KV.graphNodes
        ) {
          throw new Error(
            "Invocation timeout after 180000ms: state::set",
          );
        }
        return request.payload.value;
      },
    );
    const kv = new StateKV({ trigger } as never);
    const node = { id: "gn_test", name: "bounded" };

    await expect(kv.set(KV.graphNodes, node.id, node)).resolves.toEqual(node);
    expect(trigger).toHaveBeenCalledWith({
      function_id: "state::set",
      payload: {
        scope: expect.stringMatching(/^mem:graph:nodes:v2:/),
        key: node.id,
        value: expect.objectContaining({ value: node }),
      },
    });
  });

  it("keeps insight writes out of the unbounded legacy scope", async () => {
    const trigger = vi.fn(
      async (request: {
        function_id: string;
        payload: { scope: string; key: string; value?: unknown };
      }) => {
        if (
          request.function_id === "state::set" &&
          request.payload.scope === KV.insights
        ) {
          throw new Error("Invocation timeout after 180000ms: state::set");
        }
        return request.payload.value;
      },
    );
    const kv = new StateKV({ trigger } as never);
    const insight = { id: "ins_test", title: "bounded" };

    await expect(kv.set(KV.insights, insight.id, insight)).resolves.toEqual(
      insight,
    );
    expect(trigger).toHaveBeenCalledWith({
      function_id: "state::set",
      payload: {
        scope: expect.stringMatching(/^mem:insights:v2:/),
        key: insight.id,
        value: expect.objectContaining({ value: insight }),
      },
    });
  });

  it("reads a graph record overlay before falling back to legacy data", async () => {
    const legacy = { id: "gn_legacy", name: "legacy" };
    const overlay = { id: legacy.id, name: "overlay" };
    const trigger = vi.fn(
      async (request: {
        function_id: string;
        payload: { scope: string; key: string };
      }) => {
        if (request.payload.scope.startsWith(`${KV.graphNodes}:v2:`)) {
          return {
            version: 1,
            key: legacy.id,
            deleted: false,
            value: overlay,
          };
        }
        return legacy;
      },
    );
    const kv = new StateKV({ trigger } as never);

    await expect(kv.get(KV.graphNodes, legacy.id)).resolves.toEqual(overlay);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unchanged legacy graph record", async () => {
    const legacy = { id: "gn_legacy", name: "legacy" };
    const trigger = vi.fn(
      async (request: {
        function_id: string;
        payload: { scope: string; key: string };
      }) =>
        request.payload.scope.startsWith(`${KV.graphNodes}:v2:`)
          ? null
          : legacy,
    );
    const kv = new StateKV({ trigger } as never);

    await expect(kv.get(KV.graphNodes, legacy.id)).resolves.toEqual(legacy);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("merges graph overlays with legacy records for bulk features", async () => {
    const trigger = vi.fn(
      async (request: {
        function_id: string;
        payload: { scope: string };
      }) => {
        if (request.function_id !== "state::list") return null;
        if (request.payload.scope === KV.graphNodes) {
          return [
            { id: "gn_updated", name: "old" },
            { id: "gn_deleted", name: "deleted" },
            { id: "gn_legacy", name: "legacy" },
          ];
        }
        return [
          {
            version: 1,
            key: "gn_updated",
            deleted: false,
            value: { id: "gn_updated", name: "new" },
          },
          {
            version: 1,
            key: "gn_new",
            deleted: false,
            value: { id: "gn_new", name: "new" },
          },
          {
            version: 1,
            key: "gn_deleted",
            deleted: true,
          },
        ];
      },
    );
    const kv = new StateKV({ trigger } as never);

    const records = await kv.list(KV.graphNodes);
    expect(records).toEqual(
      expect.arrayContaining([
        { id: "gn_updated", name: "new" },
        { id: "gn_new", name: "new" },
        { id: "gn_legacy", name: "legacy" },
      ]),
    );
    expect(records).not.toContainEqual({
      id: "gn_deleted",
      name: "deleted",
    });
  });
});
