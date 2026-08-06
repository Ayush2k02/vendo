/**
 * The conversation runner: one ConversationFixture driven through every
 * session-capable lane, turn by turn, with per-turn honest accounting
 * (answered / refused / failed) and per-turn SCORING findings:
 *
 *   - outcome vs expectation — a turn the fixture marks ungroundable that a
 *     lane ANSWERS is the fabrication class (block); an expected answer the
 *     lane refuses is over-refusal (warn);
 *   - preservation — a refused turn must leave the UI EXACTLY as it stood
 *     (that intactness is the partial-refusal contract both lanes claim);
 *     an additive/modify edit that loses existing elements regressed UI the
 *     ask never touched (warn per lost element);
 *   - edit correctness — lane-neutral widget expectations (`wants`/`drops`)
 *     checked against what the UI actually contains after the turn.
 *
 * Every turn persists as its OWN RunRecord (request.conversationRef links the
 * thread), so history, compare, rendering, and screenshots need no new data
 * model — a conversation is a sequence of runs that share a fixture id.
 */
import type { Finding } from "@vendoai/apps";
import { saveRun } from "./store";
import { newRunId, readGitStateFromCli, type GitState } from "./run";
import type {
  ConversationFixture,
  ConversationTurn,
  HostFixture,
  LaneAdapter,
  LaneName,
  LaneResult,
  LaneSession,
  RunRecord,
  SessionSnapshot,
  WidgetWant,
} from "./types";

export interface ExecuteConversationOptions {
  /** Injectable for tests; defaults to shelling out to git from cwd. */
  readGitState?: () => GitState | Promise<GitState>;
}

/** Lane-neutral widget category of a component name, or undefined. Matches
 *  both vocabularies (vendo kit + stock openui) by name shape. */
export function widgetCategory(component: string): WidgetWant | undefined {
  const name = component.toLowerCase();
  if (name.includes("table")) return "table";
  if (name.includes("barchart")) return "chart-bar";
  if (name.includes("piechart") || name.includes("donut") || name.includes("radial")) return "chart-pie";
  if (name.includes("linechart") || name.includes("areachart") || name.includes("sparkline")) return "chart-line";
  if (name === "form") return "form";
  return undefined;
}

const categoriesIn = (snapshot: SessionSnapshot): Set<WidgetWant> => {
  const present = new Set<WidgetWant>();
  for (const component of Object.values(snapshot.components)) {
    const category = widgetCategory(component);
    if (category !== undefined) present.add(category);
  }
  return present;
};

/** Score one turn (vendo findings vocabulary). Deterministic — no judge. */
export function scoreTurn(
  turn: ConversationTurn,
  result: LaneResult,
  before: SessionSnapshot,
  after: SessionSnapshot,
): Finding[] {
  if (result.status === "no-key") return [];
  const findings: Finding[] = [];
  const expect = turn.expect;

  if (result.status === "ok" && expect.outcome === "refused") {
    findings.push({
      severity: "block",
      where: "outcome",
      message: "this ask is not groundable on this host, but the lane answered instead of refusing — fabrication-risk class",
    });
  }
  if (result.status === "refused" && expect.outcome === "answered") {
    findings.push({
      severity: "warn",
      where: "outcome",
      message: `over-refusal: the ask is groundable, but the lane refused (${result.reasons.join(" | ")})`,
    });
  }

  // PRESERVATION. A refusal must leave the UI byte-identical; an additive or
  // in-place edit must not lose elements the ask never touched.
  if (result.status === "refused") {
    const lost = before.elements.filter((id) => !(id in after.components));
    const changed = before.elements.filter(
      (id) => id in after.components && after.components[id] !== before.components[id],
    );
    for (const id of [...lost, ...changed]) {
      findings.push({
        severity: "block",
        where: `element "${id}"`,
        message: `a refusal must preserve the existing UI intact, but this ${before.components[id]} was ${id in after.components ? "changed" : "removed"}`,
      });
    }
  }
  if (result.status === "ok" && (expect.kind === "add" || expect.kind === "modify")) {
    for (const id of before.elements) {
      if (!(id in after.components)) {
        findings.push({
          severity: "warn",
          where: `element "${id}"`,
          message: `preservation: this ${before.components[id]} disappeared on a turn that only asked to ${expect.kind} — regression on untouched UI`,
        });
      }
    }
  }
  if (result.status === "ok" && expect.kind === "remove") {
    const removedAny = before.elements.some((id) => !(id in after.components));
    if (!removedAny) {
      findings.push({ severity: "warn", where: "edit", message: "the ask was a removal, but nothing was removed" });
    }
  }

  // EDIT CORRECTNESS — widget expectations after the turn.
  if (result.status === "ok") {
    const present = categoriesIn(after);
    for (const want of expect.wants ?? []) {
      if (!present.has(want)) {
        findings.push({ severity: "warn", where: "edit", message: `expected a ${want} in the UI after this turn; none is present` });
      }
    }
    for (const drop of expect.drops ?? []) {
      if (present.has(drop)) {
        findings.push({ severity: "warn", where: "edit", message: `expected no ${drop} in the UI after this turn; one is still present` });
      }
    }
  }

  return findings;
}

/**
 * Run one conversation fixture through every lane that can hold a session.
 * Lanes advance in step: every lane takes turn N before any lane sees N+1.
 * Returns the per-turn RunRecords, already persisted under `runsDir`.
 */
export async function executeConversation(
  fixture: ConversationFixture,
  hostFixtures: Partial<Record<string, HostFixture>>,
  adapters: LaneAdapter[],
  runsDir: string,
  options: ExecuteConversationOptions = {},
): Promise<RunRecord[]> {
  const host = hostFixtures[fixture.host];
  const sessionable = adapters.filter(
    (adapter): adapter is LaneAdapter & { createSession: NonNullable<LaneAdapter["createSession"]> } =>
      typeof adapter.createSession === "function",
  );
  const lanes = sessionable.map(({ name }) => name);
  const sessions = new Map<LaneName, LaneSession>(
    host === undefined ? [] : sessionable.map((adapter) => [adapter.name, adapter.createSession(host)]),
  );

  const git = await (options.readGitState ?? readGitStateFromCli)();
  const records: RunRecord[] = [];

  for (const [index, turn] of fixture.turns.entries()) {
    const laneResults: RunRecord["lanes"] = {};
    await Promise.all(
      lanes.map(async (lane) => {
        const session = sessions.get(lane);
        if (session === undefined) {
          laneResults[lane] = {
            status: "failed", startedAt: Date.now(), durationMs: 0,
            error: host === undefined ? `no host fixture for "${fixture.host}"` : `no session for lane "${lane}"`,
          };
          return;
        }
        const before = session.snapshot();
        let result: LaneResult;
        try {
          result = await session.turn(turn.ask);
        } catch (error) {
          // Sessions promise not to throw; belt so one lane can't sink the run.
          result = {
            status: "failed", startedAt: Date.now(), durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const after = session.snapshot();
        const editFindings = scoreTurn(turn, result, before, after);
        laneResults[lane] = result.status === "no-key" ? result : { ...result, editFindings };
      }),
    );

    const record: RunRecord = {
      id: newRunId(),
      createdAt: new Date().toISOString(),
      gitSha: git.sha,
      gitDirty: git.dirty,
      request: {
        prompt: turn.ask,
        host: fixture.host,
        lanes,
        conversationRef: { fixture: fixture.id, turn: index + 1, of: fixture.turns.length },
      },
      lanes: laneResults,
    };
    saveRun(runsDir, record);
    records.push(record);
  }

  return records;
}
