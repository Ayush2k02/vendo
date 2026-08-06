/**
 * Conversation runner contract: scripted sessions (no models) drive the real
 * turn loop, scoring, and persistence — one RunRecord per turn with
 * conversationRef, per-turn editFindings in the vendo vocabulary, and the
 * refusal-preservation check firing when a lane's UI changes on a refusal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeConversation, scoreTurn, widgetCategory } from "./conversation";
import { listRuns, loadRun } from "./store";
import { stubHostFixture } from "../fixtures/stub";
import type {
  ConversationFixture,
  ConversationTurn,
  LaneAdapter,
  LaneResult,
  SessionSnapshot,
} from "./types";

const git = () => ({ sha: "cafe0000", dirty: null });

/** A lane whose turns and snapshots are a script. */
function scriptedAdapter(
  name: LaneAdapter["name"],
  script: Array<{ result: LaneResult; snapshotAfter: SessionSnapshot }>,
): LaneAdapter {
  return {
    name,
    async generate() {
      return { status: "failed", startedAt: 0, durationMs: 0, error: "single-shot unused" };
    },
    createSession() {
      let index = -1;
      return {
        async turn() {
          index += 1;
          return script[index]!.result;
        },
        snapshot() {
          return index < 0 ? { elements: [], components: {} } : script[index]!.snapshotAfter;
        },
      };
    },
  };
}

const ok = (over: Partial<Extract<LaneResult, { status: "ok" }>> = {}): LaneResult =>
  ({ status: "ok", startedAt: 1, durationMs: 5, ...over });
const refused = (reasons: string[]): LaneResult =>
  ({ status: "refused", startedAt: 1, durationMs: 5, reasons });

describe("widgetCategory", () => {
  it("maps both vocabularies to lane-neutral categories", () => {
    expect(widgetCategory("DataTable")).toBe("table");
    expect(widgetCategory("BarChart")).toBe("chart-bar");
    expect(widgetCategory("DonutChart")).toBe("chart-pie");
    expect(widgetCategory("LineChart")).toBe("chart-line");
    expect(widgetCategory("Form")).toBe("form");
    expect(widgetCategory("Stat")).toBeUndefined();
  });
});

describe("scoreTurn", () => {
  const snap = (components: Record<string, string>): SessionSnapshot =>
    ({ elements: Object.keys(components).sort(), components });

  it("an answer where the fixture demands a refusal is the fabrication-risk block", () => {
    const turn: ConversationTurn = { ask: "profitability", expect: { outcome: "refused" } };
    const findings = scoreTurn(turn, ok(), snap({}), snap({ a: "Stat" }));
    expect(findings).toContainEqual(expect.objectContaining({ severity: "block", where: "outcome" }));
  });

  it("a refusal that mutated the UI is a preservation block; an intact one is clean", () => {
    const turn: ConversationTurn = { ask: "profitability", expect: { outcome: "refused" } };
    const before = snap({ tbl: "DataTable", title: "Text" });
    const mutated = scoreTurn(turn, refused(["no data"]), before, snap({ title: "Text" }));
    expect(mutated).toContainEqual(expect.objectContaining({ severity: "block", where: 'element "tbl"' }));
    expect(scoreTurn(turn, refused(["no data"]), before, before)).toEqual([]);
  });

  it("an additive edit that lost an element is a preservation warn; wants/drops check the result", () => {
    const turn: ConversationTurn = {
      ask: "add a donut",
      expect: { outcome: "answered", kind: "add", wants: ["chart-pie", "table"], drops: ["chart-bar"] },
    };
    const before = snap({ tbl: "DataTable", bar: "BarChart" });
    const after = snap({ tbl: "DataTable", donut: "DonutChart", bar: "BarChart" });
    const findings = scoreTurn(turn, ok(), before, after);
    expect(findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("no chart-bar") }));
    const lostTable = scoreTurn(turn, ok(), before, snap({ donut: "DonutChart" }));
    expect(lostTable).toContainEqual(expect.objectContaining({ severity: "warn", where: 'element "tbl"' }));
    expect(lostTable).toContainEqual(expect.objectContaining({ message: expect.stringContaining("expected a table") }));
  });
});

describe("executeConversation", () => {
  let runsDir: string;
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it("drives sessions turn-by-turn, persists one RunRecord per turn with the thread ref", async () => {
    runsDir = mkdtempSync(join(tmpdir(), "genui-conv-"));
    const fixture: ConversationFixture = {
      id: "maple-mini",
      title: "mini",
      host: "maple",
      turns: [
        { ask: "show transactions", expect: { outcome: "answered", wants: ["table"] } },
        { ask: "add my credit score", expect: { outcome: "refused" } },
      ],
    };
    const tableSnap: SessionSnapshot = { elements: ["tbl"], components: { tbl: "DataTable" } };
    const adapter = scriptedAdapter("openui", [
      { result: ok({ repairs: 1 }), snapshotAfter: tableSnap },
      { result: refused(["Maple has no credit score data."]), snapshotAfter: tableSnap },
    ]);
    const noSession: LaneAdapter = {
      name: "tambo",
      async generate() {
        return { status: "failed", startedAt: 0, durationMs: 0, error: "unused" };
      },
    };

    const records = await executeConversation(
      fixture,
      { maple: stubHostFixture("maple") },
      [adapter, noSession],
      runsDir,
      { readGitState: git },
    );

    expect(records).toHaveLength(2);
    // Session-less lanes are skipped, not failed.
    expect(records[0]!.request.lanes).toEqual(["openui"]);
    expect(records[0]!.request.conversationRef).toEqual({ fixture: "maple-mini", turn: 1, of: 2 });
    expect(records[1]!.request.conversationRef).toEqual({ fixture: "maple-mini", turn: 2, of: 2 });
    expect(records[1]!.request.prompt).toBe("add my credit score");

    // Persisted and rehydratable: the refused turn keeps reasons + clean score.
    expect(listRuns(runsDir)).toHaveLength(2);
    const second = loadRun(runsDir, records[1]!.id).lanes.openui;
    if (second?.status !== "refused") throw new Error(`expected refused, got ${JSON.stringify(second)}`);
    expect(second.reasons).toEqual(["Maple has no credit score data."]);
    expect(second.editFindings).toEqual([]);

    const first = loadRun(runsDir, records[0]!.id).lanes.openui;
    if (first?.status !== "ok") throw new Error("expected ok");
    expect(first.repairs).toBe(1);
    expect(first.editFindings).toEqual([]);
  });
});
