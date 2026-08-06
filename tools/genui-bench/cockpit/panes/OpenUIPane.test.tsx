// @vitest-environment jsdom
/**
 * Pane contract: OpenUIPane renders each LaneResult status, feeding the
 * lane's openui-lang program into their real Renderer over the VENDO-kit
 * library with a toolProvider on the bench's /api/tools transport; a refusal
 * renders the preserved program plus the Disclaimer-card refusal program;
 * the asymmetry footnote always rides along.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenUIPane from "./OpenUIPane";
import type { OpenUIRaw } from "../../lanes/openui";
import { refusalProgram } from "../../lanes/openui-guardrails";
import type { LaneResult } from "../../runner/types";

const MODEL = "gemini-3.6-flash";

const PROGRAM = [
  'clients = Query("host_listClients", {}, [])',
  'tbl = DataTable(clients, [{key: "businessName", label: "Business"}])',
  'root = Stack([title, tbl], 12)',
  'title = Text("Client Roster", "heading")',
].join("\n");

const raw: OpenUIRaw = {
  model: MODEL,
  responseText: PROGRAM,
  program: PROGRAM,
  toolsReferenced: ["host_listClients"],
  parseMeta: { statementCount: 4, unresolved: [], orphaned: [] },
  repairs: 0,
};

const okResult: LaneResult = { status: "ok", startedAt: 0, durationMs: 900, findings: [], raw };

describe("OpenUIPane", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; chart/table components measure with one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/theme")) {
          return { ok: true, status: 200, json: async () => ({ theme: null }) };
        }
        expect(url).toBe("/api/tools");
        const body = JSON.parse(String(init?.body)) as { host: string; tool: string };
        expect(body).toMatchObject({ host: "cadence", tool: "host_listClients" });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", output: [{ businessName: "Rivera Design Co" }] }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the program through their Renderer over the vendo kit, resolving Query() via /api/tools", async () => {
    const { container } = render(<OpenUIPane lane="openui" result={okResult} host="cadence" runId="run_test" />);
    expect(container.querySelector('[data-pane="openui"]')).toBeTruthy();
    // Their runtime parsed the program; the VENDO kit rendered it.
    await screen.findByText("Client Roster");
    await waitFor(() => expect(container.querySelector('[data-kit="DataTable"]')).toBeTruthy());
    // The Query resolved through the bench transport into rendered data.
    await waitFor(() => expect(screen.getByText("Rivera Design Co")).toBeTruthy());
    // The footnote names the paradigm and the model that produced the pane.
    expect(screen.getByText(new RegExp(`openui-lang · their parser.*${MODEL}`))).toBeTruthy();
  });

  it("humanizes an enum column with format \"label\" (missing_docs → Missing docs)", async () => {
    // Its own transport stub: a row whose status is a raw enum code.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/theme")) {
          return { ok: true, status: 200, json: async () => ({ theme: null }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", output: [{ businessName: "Rivera Design Co", status: "missing_docs" }] }),
        };
      }),
    );
    const program = [
      'clients = Query("host_listClients", {}, [])',
      'tbl = DataTable(clients, [{key: "businessName", label: "Business"}, {key: "status", label: "Status", format: "label"}])',
      'root = Stack([tbl])',
    ].join("\n");
    const labelRaw: OpenUIRaw = { ...raw, program, responseText: program };
    const result: LaneResult = { status: "ok", startedAt: 0, durationMs: 1, findings: [], raw: labelRaw };
    render(<OpenUIPane lane="openui" result={result} host="cadence" runId="run_test" />);
    // The humanized label renders; the raw code never reaches the DOM.
    await waitFor(() => expect(screen.getByText("Missing docs")).toBeTruthy());
    expect(screen.queryByText("missing_docs")).toBeNull();
  });

  it("a refusal renders the PRESERVED program plus the Disclaimer-card refusal", async () => {
    const reasons = ["Your host has no profitability data."];
    const refused: LaneResult = {
      status: "refused",
      startedAt: 0,
      durationMs: 700,
      reasons,
      raw: {
        ...raw,
        refusal: { reasons, program: refusalProgram(reasons) },
      } satisfies OpenUIRaw,
    };
    const { container } = render(<OpenUIPane lane="openui" result={refused} host="cadence" runId="run_test" />);
    // The previous turn's UI is still on screen…
    await screen.findByText("Client Roster");
    // …and the refusal renders as the Kit's own Disclaimer beside it.
    await screen.findByText("This host cannot do that");
    await screen.findByText(/no profitability data/);
    expect(container.querySelector("[data-openui-refusal]")).toBeTruthy();
  });

  it("renders the no-key state", () => {
    render(<OpenUIPane lane="openui" result={{ status: "no-key" }} host="cadence" runId="run_test" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state with the error", () => {
    render(
      <OpenUIPane
        lane="openui"
        result={{ status: "failed", startedAt: 0, durationMs: 10, error: "pre-render validation still blocking" }}
        host="cadence"
        runId="run_test"
      />,
    );
    expect(screen.getByText(/failed: pre-render validation still blocking/)).toBeTruthy();
  });
});
