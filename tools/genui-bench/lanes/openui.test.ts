/**
 * Contract tests for the GUARDED OpenUI adapter. Canned model responses
 * (hand-authored openui-lang in the vendo-kit dialect, NOT live recordings)
 * play back through the real extract → parse → validate → repair path via the
 * generate seam; the parser is @openuidev/lang-core's real one over the
 * vendo-backed library (vendo-openui-library.ts). No live API calls, ever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenUIAdapter,
  extractProgram,
  shapeToJsonSchema,
  toToolSpecs,
  type OpenUIGenerate,
  type OpenUIRaw,
} from "./openui";
import { FIX_ROUNDS } from "./openui-guardrails";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const PROGRAM = [
  'clients = Query("host_listClients", {}, [])',
  'tbl = DataTable(clients, [{key: "businessName", label: "Business"}, {key: "status"}])',
  'root = Stack([title, tbl], 12)',
  'title = Text("Clients", "heading")',
].join("\n");

const answer = (text: string) => ({ text, usage: { promptTokens: 100, outputTokens: 50 } });

const host: HostFixture = stubHostFixture("cadence", {
  tools: [
    { name: "host_listClients", description: "List the firm's clients", risk: "read" },
    { name: "host_sendClientMessage", description: "Message a client", risk: "medium" },
  ],
  shapes: {
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

describe("guarded openui adapter", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns no-key without ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const adapter = createOpenUIAdapter({ generate: async () => answer(PROGRAM) });
    await expect(adapter.generate("hi", host)).resolves.toEqual({ status: "no-key" });
  });

  it("prompts with the vendo-kit library + grounding contract, and parses the program", async () => {
    const generate = vi.fn<OpenUIGenerate>(async () => answer(PROGRAM));
    const adapter = createOpenUIAdapter({ generate });
    const result = await adapter.generate("show my clients", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const call = generate.mock.calls[0]![0];
    expect(call.prompt).toContain("show my clients");
    // The system prompt derives from OUR components' schemas + their tools
    // section, then the vendo grounding contract overrides the mock-data rule.
    expect(call.system).toContain("DataTable(");
    expect(call.system).toContain("host_listClients");
    expect(call.system).toContain("Grounding contract");
    expect(call.system).toContain("<Cannot>");

    const raw = result.raw as OpenUIRaw;
    expect(raw.program).toBe(PROGRAM);
    expect(raw.toolsReferenced).toEqual(["host_listClients"]);
    expect(raw.repairs).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 100, outputTokens: 50, cachedInputTokens: 0 });
  });

  it("strips markdown fences from a chatty response", () => {
    expect(extractProgram("Here is the app:\n```openui-lang\n" + PROGRAM + "\n```\nEnjoy!")).toBe(PROGRAM);
    expect(extractProgram(PROGRAM)).toBe(PROGRAM);
  });

  it("a <Cannot> answer lands as a typed refusal with a disclaimer-card program", async () => {
    const adapter = createOpenUIAdapter({
      generate: async () => answer("<Cannot>Your host has no revenue data, so profitability cannot be computed.</Cannot>"),
    });
    const result = await adapter.generate("least profitable clients", host);
    if (result.status !== "refused") throw new Error(`expected refused, got ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["Your host has no revenue data, so profitability cannot be computed."]);
    const raw = result.raw as OpenUIRaw;
    expect(raw.refusal?.program).toContain("Disclaimer(");
    expect(raw.refusal?.program).toContain("no revenue data");
    expect(raw.program).toBeUndefined();
  });

  it("an unknown tool binding is a BLOCK that feeds one bounded repair round", async () => {
    const bad = [
      'spend = Query("host_getSpending", {}, [])',
      'root = Stack([Text("Spending", "heading"), DataTable(spend, [{key: "amount"}])])',
    ].join("\n");
    const patched = 'spend = Query("host_listClients", {}, [])';
    const generate = vi.fn<OpenUIGenerate>()
      .mockResolvedValueOnce(answer(bad))
      .mockResolvedValueOnce(answer(patched));
    const adapter = createOpenUIAdapter({ generate });

    const result = await adapter.generate("spending", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.repairs).toBe(1);
    const raw = result.raw as OpenUIRaw;
    expect(raw.toolsReferenced).toEqual(["host_listClients"]);
    // The repair instruction taught with the fact finding (the real tools listed).
    const repairCall = generate.mock.calls[1]![0];
    expect(repairCall.prompt).toContain('host_getSpending');
    expect(repairCall.prompt).toContain("the host tools are: host_listClients, host_sendClientMessage");
    // Usage summed across both calls.
    expect(result.usage).toEqual({ promptTokens: 200, outputTokens: 100, cachedInputTokens: 0 });
  });

  it("a block the repairs cannot fix is an honest failed, never a silent broken render", async () => {
    const bad = [
      'spend = Query("host_getSpending", {}, [])',
      'root = Stack([DataTable(spend, [{key: "amount"}])])',
    ].join("\n");
    const generate = vi.fn<OpenUIGenerate>(async () => answer(bad));
    const adapter = createOpenUIAdapter({ generate });

    const result = await adapter.generate("spending", host);
    if (result.status !== "failed") throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    expect(result.error).toContain(`still blocking after ${FIX_ROUNDS} repair rounds`);
    expect(result.error).toContain("host_getSpending");
    expect(result.findings?.some(({ severity }) => severity === "block")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1 + FIX_ROUNDS);
  });

  it("a repair round may honestly convert to a refusal; nothing ships", async () => {
    const bad = 'root = Stack([DataTable(Query("host_getRevenue", {}, []), [{key: "amount"}])])';
    const generate = vi.fn<OpenUIGenerate>()
      .mockResolvedValueOnce(answer(bad))
      .mockResolvedValueOnce(answer("<Cannot>No tool exposes revenue, so this cannot be shown.</Cannot>"));
    const adapter = createOpenUIAdapter({ generate });

    const result = await adapter.generate("revenue by client", host);
    if (result.status !== "refused") throw new Error(`expected refused, got ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["No tool exposes revenue, so this cannot be shown."]);
  });

  it("records a stock openui fallback component as a warn finding", async () => {
    const withFallback = [
      'clients = Query("host_listClients", {}, [])',
      'root = Stack([md, DataTable(clients, [{key: "businessName"}])])',
      'md = MarkDownRenderer("**Clients** as of today")',
    ].join("\n");
    const adapter = createOpenUIAdapter({ generate: async () => answer(withFallback) });
    const result = await adapter.generate("clients", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "warn", where: 'statement "md"' }),
    );
  });

  it("never throws: a generation crash becomes status failed", async () => {
    const adapter = createOpenUIAdapter({
      generate: async () => {
        throw new Error("529 overloaded");
      },
    });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("529 overloaded");
  });

  describe("session (multi-turn)", () => {
    it("edit turns patch by merge; untouched statements survive verbatim", async () => {
      const patch = [
        'chart = DonutChart(clients, "status", "businessName")',
        'root = Stack([title, tbl, chart], 12)',
      ].join("\n");
      const generate = vi.fn<OpenUIGenerate>()
        .mockResolvedValueOnce(answer(PROGRAM))
        .mockResolvedValueOnce(answer(patch));
      const adapter = createOpenUIAdapter({ generate });
      const session = adapter.createSession!(host);

      const first = await session.turn("show my clients");
      expect(first.status).toBe("ok");
      const before = session.snapshot();
      expect(before.components.tbl).toBe("DataTable");

      const second = await session.turn("add a donut of clients by status");
      expect(second.status).toBe("ok");
      if (second.status !== "ok") return;

      // Edit-mode system + the program as it stands in the message.
      const editCall = generate.mock.calls[1]![0];
      expect(editCall.system).toContain("Edit Mode");
      expect(editCall.prompt).toContain("THE PROGRAM AS IT STANDS");
      expect(editCall.prompt).toContain("THEY ARE ASKING NOW: add a donut of clients by status");

      const after = session.snapshot();
      expect(after.components.chart).toBe("DonutChart");
      expect(after.components.tbl).toBe("DataTable"); // preserved
      expect(after.components.title).toBe("Text");    // preserved
    });

    it("a mid-conversation refusal preserves the program byte-for-byte", async () => {
      const generate = vi.fn<OpenUIGenerate>()
        .mockResolvedValueOnce(answer(PROGRAM))
        .mockResolvedValueOnce(answer("<Cannot>Your host has no profitability data.</Cannot>"));
      const adapter = createOpenUIAdapter({ generate });
      const session = adapter.createSession!(host);

      await session.turn("show my clients");
      const before = session.snapshot();

      const refusedTurn = await session.turn("add a profitability column");
      if (refusedTurn.status !== "refused") throw new Error(`expected refused, got ${JSON.stringify(refusedTurn)}`);
      // The preserved program rides the refusal for rendering, and the
      // session state is untouched.
      expect((refusedTurn.raw as OpenUIRaw).program).toBe(PROGRAM);
      expect((refusedTurn.raw as OpenUIRaw).refusal?.program).toContain("Disclaimer(");
      expect(session.snapshot()).toEqual(before);
    });
  });

  it("translates shape cards to JSON Schema with optionality", () => {
    expect(
      shapeToJsonSchema({
        kind: "object",
        fields: { id: { kind: "string" }, note: { kind: "string" } },
        optional: ["note"],
      }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"],
    });
    const specs = toToolSpecs(host);
    expect(specs.map((spec) => spec.name)).toEqual(["host_listClients", "host_sendClientMessage"]);
    expect(specs[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(specs[1]?.annotations).toEqual({ readOnlyHint: false });
    expect(specs[1]?.outputSchema).toEqual({});
  });
});
