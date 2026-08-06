/**
 * Contract test for the spec adapter. Canned model responses (hand-authored
 * view-spec JSON, NOT live recordings) play back through the real extract →
 * validate → repair → compile path via the generate seam; the prop schemas
 * under test are @vendoai/core's real kit specs and the compiled tree is
 * re-checked by core's real validateTree. No live API calls, ever.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PREWIRED_COMPONENT_NAMES, type Tree, type TreeNode } from "@vendoai/core";
import { KIT_COMPONENTS } from "@vendoai/ui/kit";
import { createSpecAdapter, buildSystemPrompt, type SpecGenerate, type SpecRaw } from "./spec";
import { CHROME_REGISTRY } from "./spec/registry";
import { extractJson } from "./spec/format";
import { checkParams, validateSpec } from "./spec/validate";
import { compileSpec, selectPointer } from "./spec/compile";
import type { HostFixture, LaneResult } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const host: HostFixture = stubHostFixture("cadence", {
  tools: [
    {
      name: "host_getDashboard",
      description: "The firm dashboard numbers",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "host_listClients",
      description: "List the firm's clients",
      risk: "read",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
    },
    {
      name: "host_sendClientMessage",
      description: "Message a client",
      risk: "medium",
      inputSchema: {
        type: "object",
        properties: { client_id: { type: "string" }, message: { type: "string" } },
        required: ["client_id", "message"],
      },
    },
  ],
  shapes: {
    host_getDashboard: {
      kind: "object",
      fields: { clientsTotal: { kind: "number" }, clientsMissingDocs: { kind: "number" } },
    },
    host_listClients: {
      kind: "array",
      items: {
        kind: "object",
        fields: { businessName: { kind: "string" }, status: { kind: "string" } },
      },
    },
  },
  execute: vi.fn(async () => []),
});

const VALID_SPEC = {
  title: "Clients overview",
  components: [
    {
      use: "Stat",
      tool: "host_getDashboard",
      select: "clientsTotal",
      props: { label: "Clients", format: "number" },
    },
    {
      use: "DataTable",
      tool: "host_listClients",
      props: { columns: [{ key: "businessName", label: "Client" }] },
      actions: [
        { label: "Send reminder", tool: "host_sendClientMessage", params: { client_id: "c1", message: "hi" } },
      ],
    },
  ],
};

const nodesOf = (result: LaneResult): TreeNode[] => {
  if (result.status !== "ok" || result.document === undefined) throw new Error("no document");
  return (result.document.tree as unknown as Tree).nodes;
};

describe("spec adapter", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns no-key without a provider key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const adapter = createSpecAdapter({ generate: async () => JSON.stringify(VALID_SPEC) });
    await expect(adapter.generate("hi", host)).resolves.toEqual({ status: "no-key" });
  });

  it("authors against the registry + tool surface, and compiles a valid spec onto the production tree", async () => {
    const generate = vi.fn<SpecGenerate>(async () => JSON.stringify(VALID_SPEC));
    const adapter = createSpecAdapter({ generate });
    const result = await adapter.generate("show my clients", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    // The authoring context carries the registry and the whole tool surface.
    const call = generate.mock.calls[0]![0];
    expect(call.prompt).toBe("show my clients");
    for (const entry of CHROME_REGISTRY) expect(call.system).toContain(`## ${entry.use}`);
    expect(call.system).toContain("host_listClients");
    expect(call.system).toContain("host_sendClientMessage");

    // Single-shot (no repair needed), no findings.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([]);
    const raw = result.raw as SpecRaw;
    expect(raw.repaired).toBe(false);
    expect(raw.toolsBound).toEqual(["host_getDashboard", "host_listClients", "host_sendClientMessage"]);

    // The compiled document: one query per unique tool, $path bindings into
    // the query results, the action as a real $action-bound Button.
    const tree = (result.document?.tree ?? {}) as unknown as Tree;
    expect(tree.formatVersion).toBe("vendo-genui/v2");
    expect(tree.queries).toEqual([
      { name: "q0", tool: "host_getDashboard" },
      { name: "q1", tool: "host_listClients" },
    ]);
    const stat = tree.nodes.find((node) => node.component === "Stat");
    expect(stat?.props?.value).toEqual({ $path: "/q0/clientsTotal" });
    expect(stat?.props?.label).toBe("Clients");
    const table = tree.nodes.find((node) => node.component === "DataTable");
    expect(table?.props?.rows).toEqual({ $path: "/q1" });
    const button = tree.nodes.find((node) => node.component === "Button");
    expect(button?.props?.onClick).toEqual({
      $action: "host_sendClientMessage",
      payload: { client_id: "c1", message: "hi" },
    });
  });

  it("strips markdown fences from a chatty response", () => {
    const json = JSON.stringify(VALID_SPEC);
    expect(extractJson("Here you go:\n```json\n" + json + "\n```\nEnjoy!")).toBe(json);
    expect(extractJson(json)).toBe(json);
  });

  it("law 1 is structural: a hand-typed data prop fails validation, and the repair round fixes it", async () => {
    const handTyped = {
      title: "Clients",
      components: [
        {
          use: "DataTable",
          tool: "host_listClients",
          props: { rows: [{ businessName: "Fabricated LLC" }] },
        },
      ],
    };
    const generate = vi.fn<SpecGenerate>()
      .mockResolvedValueOnce(JSON.stringify(handTyped))
      .mockResolvedValueOnce(JSON.stringify(VALID_SPEC));
    const adapter = createSpecAdapter({ generate });
    const result = await adapter.generate("clients", host);

    expect(generate).toHaveBeenCalledTimes(2);
    const repairCall = generate.mock.calls[1]![0];
    expect(repairCall.prompt).toContain("failed validation");
    expect(repairCall.prompt).toContain("law 1");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect((result.raw as SpecRaw).repaired).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("a piece still invalid after the one repair round ships as a warn finding + an in-app failure Callout", async () => {
    const halfBroken = {
      title: "Clients",
      components: [
        { use: "DataTable", tool: "host_listClients" },
        { use: "Timeline", tool: "host_listClients" },
      ],
    };
    const generate = vi.fn<SpecGenerate>(async () => JSON.stringify(halfBroken));
    const adapter = createSpecAdapter({ generate });
    const result = await adapter.generate("clients", host);

    expect(generate).toHaveBeenCalledTimes(2); // one repair round, no more
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]).toMatchObject({ severity: "warn", where: "piece 2 (Timeline)" });

    const callout = nodesOf(result).find((node) => node.component === "Callout");
    expect(callout?.props?.title).toContain("Timeline");
  });

  it("fails when every piece is invalid after the repair round", async () => {
    const broken = { title: "x", components: [{ use: "Widget" }] };
    const adapter = createSpecAdapter({ generate: async () => JSON.stringify(broken) });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("every piece failed validation");
    expect(result.error).toContain("Widget");
  });

  it("fails when the output is not usable JSON after the repair round", async () => {
    const adapter = createSpecAdapter({ generate: async () => "I would love to help but…" });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("no usable view spec");
  });

  it("never throws: a generation crash becomes status failed", async () => {
    const adapter = createSpecAdapter({
      generate: async () => {
        throw new Error("529 overloaded");
      },
    });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("529 overloaded");
  });

  it("teaches the tool surface with output shapes in the system prompt", () => {
    const system = buildSystemPrompt(host);
    expect(system).toContain('"clientsTotal"');
    expect(system).toContain("(mutation)");
    expect(system).toContain("(read)");
  });
});

describe("spec validator", () => {
  const tools = host.tools as Parameters<typeof validateSpec>[1];

  it("rejects an unknown tool and an unknown component per piece, not per spec", () => {
    const verdict = validateSpec(
      JSON.stringify({
        title: "x",
        components: [
          { use: "DataTable", tool: "host_listInvoices" },
          { use: "DataTable", tool: "host_listClients" },
        ],
      }),
      tools,
    );
    expect(verdict.pieces[0]?.errors[0]).toContain('does not expose tool "host_listInvoices"');
    expect(verdict.pieces[1]?.errors).toEqual([]);
  });

  it("rejects params that miss the tool's input schema", () => {
    expect(checkParams({ client_id: "c1" }, {
      type: "object",
      properties: { client_id: { type: "string" }, message: { type: "string" } },
      required: ["client_id", "message"],
    }, "t")).toEqual(['t is missing required param "message"']);
    expect(checkParams({ nope: 1 }, { type: "object", properties: { status: { type: "string" } } }, "t"))
      .toEqual(['t has unknown param "nope" (accepted: status)']);
    expect(checkParams({ status: 4 }, { type: "object", properties: { status: { type: "string" } } }, "t"))
      .toEqual(['t param "status" should be string, got number']);
  });

  it("rejects a required copy prop that is missing (the real kit schema, not a copy)", () => {
    const verdict = validateSpec(
      JSON.stringify({ title: "x", components: [{ use: "Stat", tool: "host_getDashboard", select: "clientsTotal" }] }),
      tools,
    );
    expect(verdict.pieces[0]?.errors).toEqual(['required prop "label" is missing']);
  });

  it("requires at least one action on a Button piece, and rejects actions elsewhere", () => {
    const verdict = validateSpec(
      JSON.stringify({
        title: "x",
        components: [
          { use: "Button" },
          { use: "Stat", tool: "host_getDashboard", props: { label: "n" }, actions: [{ label: "go", tool: "host_sendClientMessage", params: { client_id: "c", message: "m" } }] },
        ],
      }),
      tools,
    );
    expect(verdict.pieces[0]?.errors[0]).toContain("at least one entry in `actions`");
    expect(verdict.pieces[1]?.errors[0]).toContain("no action slots");
  });
});

describe("spec compiler", () => {
  const compile = (spec: Parameters<typeof compileSpec>[0]) => {
    const verdicts = spec.components.map((piece, index) => ({ index, use: piece.use, errors: [] as string[] }));
    return compileSpec(spec, verdicts);
  };

  it("groups consecutive tiles into a Grid and dedupes identical queries", () => {
    const { document, queryCount } = compile({
      title: "Two stats",
      components: [
        { use: "Stat", tool: "host_getDashboard", select: "clientsTotal", props: { label: "Total" } },
        { use: "Stat", tool: "host_getDashboard", select: "clientsMissingDocs", props: { label: "Missing docs" } },
      ],
    });
    const tree = document.tree as unknown as Tree;
    expect(queryCount).toBe(1);
    expect(tree.queries).toEqual([{ name: "q0", tool: "host_getDashboard" }]);
    const grid = tree.nodes.find((node) => node.component === "Grid");
    expect(grid?.props?.columns).toBe(2);
    expect(grid?.children).toHaveLength(2);
  });

  it("select paths become JSON Pointers under the piece's query", () => {
    expect(selectPointer("q0", undefined)).toBe("/q0");
    expect(selectPointer("q0", "data")).toBe("/q0/data");
    expect(selectPointer("q2", "0.sparkline")).toBe("/q2/0/sparkline");
  });
});

describe("chrome registry", () => {
  it("every entry corresponds to a component the production renderer draws", () => {
    const renderable = new Set<string>([...PREWIRED_COMPONENT_NAMES, ...Object.keys(KIT_COMPONENTS)]);
    for (const entry of CHROME_REGISTRY) {
      expect(renderable.has(entry.use), `${entry.use} is not renderable`).toBe(true);
    }
  });

  it("every data slot names a data-class prop of the REAL kit spec", () => {
    for (const entry of CHROME_REGISTRY) {
      if (entry.dataSlot === undefined) continue;
      const prop = entry.spec.props[entry.dataSlot.prop];
      expect(prop, `${entry.use}.${entry.dataSlot.prop} is not in the kit spec`).toBeDefined();
      expect(prop?.cls, `${entry.use}.${entry.dataSlot.prop} is not a data prop`).toBe("data");
    }
  });

  it("holds 5–8 components, as the prototype scopes it", () => {
    expect(CHROME_REGISTRY.length).toBeGreaterThanOrEqual(5);
    expect(CHROME_REGISTRY.length).toBeLessThanOrEqual(8);
  });
});
