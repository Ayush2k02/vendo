import type { AppDocument, VendoTheme } from "@vendoai/core";
import type { Finding } from "@vendoai/apps";
import type { RunModel } from "./models";

export type { RunModel };

export type LaneName = "vendo" | "thesys-c1" | "copilotkit" | "tambo" | "openui";
export type HostName = "maple" | "cadence";

export interface RunRequest {
  prompt: string;
  host: HostName;
  lanes: LaneName[];
  /** Set when the prompt came from a pack (evidence labeling only). */
  packRef?: { pack: string; index: number };
  /** Set when the prompt is one turn of a conversation fixture: which
   *  fixture, which turn (1-based), how many turns the fixture has. Each turn
   *  persists as its own RunRecord so history/compare/screenshots work
   *  unchanged; the shared fixture id is the thread that links them. */
  conversationRef?: { fixture: string; turn: number; of: number };
  /**
   * Per-run model + sampling for the Vendo lane (the engine under study).
   * ABSENT = the engine's production default, so an untouched run measures
   * what ships. Competitor lanes keep their own model defaults. RunRecord
   * embeds RunRequest, so history stamps this automatically.
   */
  model?: RunModel;
}

/** Model-call accounting for one lane result, summed across every model call
 *  the result took (initial generation plus repair rounds).
 *
 *  `promptTokens` is the TOTAL input (cached + uncached); `cachedInputTokens`
 *  is the slice served from a Gemini context cache and billed at a discount
 *  (the openui lane caches its static kit-schema system prefix). Kept as a
 *  separate field, never folded into `promptTokens`, so the cost picture is
 *  honest: uncached input = promptTokens − cachedInputTokens. */
export interface LaneUsage {
  promptTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** Fields every substantive result carries: wall time, token accounting, how
 *  many bounded-repair model calls ran, and the per-turn scoring findings a
 *  conversation run attaches (edit-correctness + preservation). */
interface LaneResultBase {
  startedAt: number;
  durationMs: number;
  usage?: LaneUsage;
  /** Bounded-repair model calls this result took (absent = 0). */
  repairs?: number;
  /** Conversation scoring: edit-correctness and preservation findings the
   *  runner attached to this TURN (vendo findings vocabulary). */
  editFindings?: Finding[];
}

export type LaneResult =
  | (LaneResultBase & { status: "ok"; costUsd?: number;
      /** Vendo lane: the document to render live. */
      document?: AppDocument;
      /** Vendo lane: raw wire text as streamed. */
      wire?: string;
      /** What is still wrong with the app that shipped: the Vendo lane's
       *  checking-layer report; the OpenUI lane's pre-render validation report. */
      findings?: Finding[];
      /** Competitor lanes: their raw response payload, renderable by their SDK. */
      raw?: unknown })
  | (LaneResultBase & { status: "refused";
      /** Why the host cannot do it — user-facing sentences (the vendo engine's
       *  abstention vocabulary; the openui lane derives them the same way). */
      reasons: string[];
      /** On a mid-conversation refusal: the PRESERVED document from the
       *  previous turn (vendo lane), rendered intact beside the refusal. */
      document?: AppDocument;
      wire?: string;
      findings?: Finding[];
      raw?: unknown })
  | (LaneResultBase & { status: "failed"; error: string;
      wire?: string; findings?: Finding[]; raw?: unknown })
  | { status: "no-key" };

/** The three-valued honest accounting each substantive result maps to. */
export type LaneOutcome = "answered" | "refused" | "failed";

export function outcomeOf(result: LaneResult): LaneOutcome | undefined {
  if (result.status === "ok") return "answered";
  if (result.status === "refused") return "refused";
  if (result.status === "failed") return "failed";
  return undefined;
}

export interface RunRecord {
  id: string;                      // `${yyyymmdd-hhmmss}-${4 hex}`
  createdAt: string;               // ISO
  gitSha: string;
  gitDirty: string | null;         // sha256 of `git diff` when tree dirty, else null
  request: RunRequest;
  lanes: Partial<Record<LaneName, LaneResult>>;
  pin?: string;                    // label; absence = unpinned
}

/** Per-run knobs the runner hands every lane; lanes ignore what they don't use. */
export interface LaneRunOptions {
  /** The Vendo lane's per-run model choice (see RunRequest.model). */
  model?: RunModel;
}

/**
 * What a lane's UI "is" after a turn, in lane-neutral terms, so the
 * conversation runner can score preservation without knowing either lane's
 * document format. `elements` are the lane's stable identifiers (openui:
 * statement ids; vendo: tree node ids); `components` maps each element to the
 * component name it shows.
 */
export interface SessionSnapshot {
  elements: string[];
  components: Record<string, string>;
}

/** One lane's side of a conversation: turns run in order, state carries. */
export interface LaneSession {
  /** One turn. NEVER throws — a crash lands as status:"failed" and the
   *  session keeps its pre-turn state. */
  turn(ask: string): Promise<LaneResult>;
  /** The UI as it stands after the last turn (empty before the first). */
  snapshot(): SessionSnapshot;
}

export interface LaneAdapter {
  name: LaneName;
  /** Resolve to a LaneResult; NEVER throw — catch and return status:"failed". */
  generate(prompt: string, host: HostFixture, options?: LaneRunOptions): Promise<LaneResult>;
  /** Multi-turn support (conversation fixtures). Absent = single-shot lane;
   *  the conversation runner skips lanes that cannot hold a session. */
  createSession?(host: HostFixture, options?: LaneRunOptions): LaneSession;
}

// ---------------------------------------------------------------------------
// Conversation fixtures — multi-turn editing + mid-conversation refusals.
// ---------------------------------------------------------------------------

/** What an answered edit turn does to the UI, for preservation scoring:
 *  `add`/`modify` turns must not lose existing elements; `remove` turns are
 *  expected to; `mixed` turns waive the removal check. */
export type TurnKind = "add" | "modify" | "remove" | "mixed";

/** Lane-neutral widget categories a turn can expect present/absent, matched
 *  against component names per lane (see runner/conversation.ts). */
export type WidgetWant = "table" | "chart-bar" | "chart-pie" | "chart-line" | "form";

export interface ConversationTurn {
  ask: string;
  expect: {
    /** The honest outcome this turn should produce. */
    outcome: "answered" | "refused";
    kind?: TurnKind;
    /** Categories that should exist in the UI AFTER this turn. */
    wants?: WidgetWant[];
    /** Categories that should NOT exist after this turn. */
    drops?: WidgetWant[];
  };
}

export interface ConversationFixture {
  id: string;
  title: string;
  host: HostName;
  turns: ConversationTurn[];
}

/** Executable host fixture — catalog/tools/shapes for generation, executors for interaction. */
export interface HostFixture {
  name: HostName;
  catalog: unknown;                // NormalizedCatalog (from @vendoai/core)
  tools: unknown[];                // HostToolInfo[] (from @vendoai/apps)
  shapes: unknown;                 // shape cards, bench demo-bank-surface pattern
  /** The host's real .vendo/theme.json, schema-parsed: the engine stamps it
   *  into generation and /embed/<host> hands it to VendoProvider. */
  theme: VendoTheme;
  /** Canned-data executor: same names as `tools`; throws VendoError for unknown tool. */
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>;
}
