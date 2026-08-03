import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

type Handler = (request: { readonly body?: unknown }) => Promise<unknown>;

function setup() {
  const functions = new Map<string, Handler>();
  const trigger = vi.fn();
  const set = vi.fn(async (_scope: string, _key: string, value: unknown) => value);
  const sdk = {
    registerFunction: (id: string, handler: Handler) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger,
  };
  const kv = { set };
  registerApiTriggers(sdk as never, kv as never);
  const sessionStart = functions.get("api::session::start");
  if (!sessionStart) throw new Error("api::session::start was not registered");
  return { sessionStart, set, trigger };
}

describe("api::session::start context selection", () => {
  it("registers capture-only sessions without triggering context", async () => {
    const { sessionStart, set, trigger } = setup();

    const response = (await sessionStart({
      body: {
        sessionId: "ses_capture",
        project: "demo",
        cwd: "/demo",
        includeContext: false,
      },
    })) as {
      readonly status_code: number;
      readonly body: {
        readonly session: { readonly id: string };
        readonly context?: string;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.session.id).toBe("ses_capture");
    expect(response.body.context).toBeUndefined();
    expect(set).toHaveBeenCalledOnce();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("preserves context injection for callers that omit includeContext", async () => {
    const { sessionStart, trigger } = setup();
    trigger.mockResolvedValue({ context: "prior work" });

    const response = (await sessionStart({
      body: { sessionId: "ses_inject", project: "demo", cwd: "/demo" },
    })) as { readonly body: { readonly context: string } };

    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::context",
      payload: { sessionId: "ses_inject", project: "demo" },
    });
    expect(response.body.context).toBe("prior work");
  });
});
