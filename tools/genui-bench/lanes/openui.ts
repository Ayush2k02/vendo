/**
 * OpenUI lane — pure openui-lang generation (their @openuidev parser, prompt
 * generator, and merge semantics) over VENDO's component kit registered as
 * the openui library (vendo-openui-library.ts, captain decision: their
 * language, our components — stock openui components only as recorded
 * fallbacks), HARDENED with vendo's guardrails (openui-guardrails.ts):
 *
 *   - grounding + typed refusal: the system prompt carries the vendo brain's
 *     honesty contract; an ungroundable ask comes back as `<Cannot>` lines and
 *     lands as `status:"refused"` with a catalog-derived reason, rendered as a
 *     first-class disclaimer card through their own components — never a
 *     program over fabricated data;
 *   - pre-render fact validation: every Query/Mutation binding is checked
 *     against the host catalog and every element against the library schema
 *     BEFORE render, producing vendo-vocabulary findings;
 *   - bounded repair: blocking findings go back to the model as a teaching
 *     instruction (at most FIX_ROUNDS times, the conductor's own constant);
 *     what survives is an honest `failed`, never a silently broken render.
 *
 * Multi-turn (conversation fixtures): edit turns ride THEIR edit mode — the
 * model answers with patch statements, `mergeStatements` merges them by name
 * into the program as it stands, so untouched statements survive verbatim
 * (that surviving-verbatim property is what the preservation score measures).
 * A mid-conversation ungroundable ask refuses ONLY the addition: the program
 * is left exactly as it was and the refusal renders beside it.
 *
 * Model: the same default resolver every lane uses (runner/models.ts
 * `defaultModelId` — `GENUI_BENCH_MODEL` override, Gemini fallback on a
 * keyless-Anthropic machine), so lane comparisons hold the model constant.
 */
import { createRequire } from "node:module";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createParser, mergeStatements, type ParseResult, type ToolSpec } from "@openuidev/lang-core";
import type { Finding } from "@vendoai/apps";
import type { ShapeType } from "@vendoai/core";
import { MAX_OUTPUT_TOKENS, defaultModelId, providerKeyFor } from "../runner/models";
import type {
  HostFixture,
  LaneAdapter,
  LaneResult,
  LaneSession,
  LaneUsage,
  SessionSnapshot,
} from "../runner/types";
import {
  FIX_ROUNDS,
  boundTools,
  fixInstruction,
  groundingContract,
  programSnapshot,
  readCannot,
  refusalProgram,
  rewriteInstruction,
  stripCannot,
  validateProgram,
} from "./openui-guardrails";
import {
  STOCK_FALLBACK_NAMES,
  benchComponentNames,
  benchLibrary,
  benchLibrarySchema,
  benchPromptOptions,
} from "./vendo-openui-library";
import { cachedSystemName } from "./gemini-cache";

interface HostToolLike {
  name: string;
  description: string;
  risk?: string;
  inputSchema?: Record<string, unknown>;
}

/** The fixture's shape cards, translated for the prompt: the same response
 *  shapes the Vendo engine receives as `toolShapes`, as plain JSON Schema. */
export function shapeToJsonSchema(shape: ShapeType): Record<string, unknown> {
  switch (shape.kind) {
    case "array":
      return { type: "array", items: shapeToJsonSchema(shape.items) };
    case "object": {
      const optional = new Set(shape.optional ?? []);
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape.fields).map(([key, field]) => [key, shapeToJsonSchema(field)]),
        ),
        required: Object.keys(shape.fields).filter((key) => !optional.has(key)),
      };
    }
    case "json":
      return {};
    default:
      return { type: shape.kind };
  }
}

/** The generation surface: fixture tools as OpenUI ToolSpecs (input schema,
 *  response shape, read-only hint from the fixture's `risk`). */
export function toToolSpecs(host: HostFixture): ToolSpec[] {
  const shapes = host.shapes as Readonly<Record<string, ShapeType>>;
  return (host.tools as HostToolLike[]).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    outputSchema: shapes[tool.name] === undefined ? {} : shapeToJsonSchema(shapes[tool.name] as ShapeType),
    annotations: { readOnlyHint: tool.risk === "read" },
  }));
}

/** The model sometimes fences the program despite the prompt asking for raw
 *  code; every fenced block is program text (statements merge line-wise). */
export function extractProgram(text: string): string {
  const fenced = [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((match) => (match[1] as string).trim());
  return fenced.length > 0 ? fenced.join("\n") : text.trim();
}

/** Shape of `LaneResult.raw` for this lane (what OpenUIPane renders). */
export interface OpenUIRaw {
  model: string;
  /** The LAST assistant text of the turn (fences included), for the drawer. */
  responseText: string;
  /** The current openui-lang program: the newly valid one on ok; the
   *  PRESERVED previous one on refused (absent when nothing exists yet); the
   *  still-broken candidate on failed (evidence, never rendered as ok). */
  program?: string;
  /** Tool names `program` binds via Query()/Mutation(). */
  toolsReferenced: string[];
  /** Their parser's metadata over `program`, for the internals drawer. */
  parseMeta?: { statementCount: number; unresolved: string[]; orphaned: string[] };
  /** The typed refusal: catalog-derived reasons plus the deterministic
   *  disclaimer-card program their Renderer draws them with. Present on
   *  `refused`, and on `ok` when a mixed edit refused part of the ask. */
  refusal?: { reasons: string[]; program: string };
  /** Bounded-repair model calls this turn took. */
  repairs: number;
}

export type OpenUIGenerate = (args: {
  modelId: string;
  system: string;
  prompt: string;
}) => Promise<{ text: string; usage?: LaneUsage }>;

/** Default generation: generateText from @vendoai/apps's module space (the
 *  same "ai" instance the engine runs on), provider routed by id prefix
 *  (`gemini*` through this app's own @ai-sdk/google, anything else through
 *  the Anthropic provider in apps's module space — vendo lane pattern).
 *
 *  On the Gemini path the static system prefix is served from a context cache
 *  (gemini-cache.ts): when a cache name resolves, the request is sent with NO
 *  `system` and `providerOptions.google.cachedContent` set — the cache
 *  supplies the identical system instruction, so output is unchanged and the
 *  cached input is billed at a discount. `cachedInputTokens` is reported
 *  separately from the total. */
const runGeneration: OpenUIGenerate = async ({ modelId, system, prompt }) => {
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  const appsRequire = createRequire(appsEntry);
  const { generateText } = appsRequire("ai") as {
    generateText: (options: {
      model: unknown;
      system?: string;
      prompt: string;
      maxOutputTokens: number;
      providerOptions?: Record<string, Record<string, unknown>>;
    }) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }>;
  };
  const isGemini = providerKeyFor(modelId) === "GEMINI_API_KEY";
  let model: unknown;
  if (isGemini) {
    model = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY as string })(modelId);
  } else {
    const { createAnthropic } = appsRequire("@ai-sdk/anthropic") as {
      createAnthropic: (options: { apiKey: string }) => (id: string) => unknown;
    };
    model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY as string })(modelId);
  }

  // Gemini: try to serve the static system prefix from a context cache. Any
  // miss falls back to sending it inline (correctness never needs the cache).
  const cacheName = isGemini ? await cachedSystemName(modelId, system) : null;
  const call = cacheName === null
    ? { model, system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS }
    : { model, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS, providerOptions: { google: { cachedContent: cacheName } } };

  const { text, usage } = await generateText(call);
  return {
    text,
    usage: {
      promptTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
    },
  };
};

export interface OpenUIDeps {
  /** Test seam: canned model responses play back through the real extract →
   *  parse → validate → repair path; no live API calls in tests. */
  generate?: OpenUIGenerate;
}

interface TranscriptEntry {
  role: "user" | "lane";
  text: string;
}

/** A session's whole memory: the program as it stands, and what was said. */
interface TurnState {
  program?: string;
  transcript: TranscriptEntry[];
}

/** What one guarded turn produced: the result, and the program the session
 *  should carry forward (unchanged on refused/failed turns). */
interface TurnOutput {
  result: LaneResult;
  nextProgram?: string;
}

const parseProgram = (program: string): ParseResult => createParser(benchLibrarySchema).parse(program);

const validate = (program: string, hostToolNames: readonly string[]) =>
  validateProgram(program, hostToolNames, benchLibrarySchema, benchComponentNames, STOCK_FALLBACK_NAMES);

const transcriptText = (transcript: readonly TranscriptEntry[]): string =>
  transcript.map(({ role, text }) => `${role === "user" ? "THEY SAID" : "YOU SAID"}: ${text}`).join("\n\n");

/** The variable tail of the call (brain.ts brainMessage ordering: the fresh
 *  program is the last thing before the ask, so it is the thing attended to). */
const turnMessage = (state: TurnState, ask: string): string => [
  ...(state.transcript.length === 0
    ? []
    : [`THE CONVERSATION SO FAR (what was said, not what the program says):\n${transcriptText(state.transcript)}`]),
  ...(state.program === undefined
    ? []
    : [`THE PROGRAM AS IT STANDS — the only true copy of it; your patch statements merge into it by name:\n${state.program}`]),
  `THEY ARE ASKING NOW: ${ask}`,
].join("\n\n");

/** One line for the conversation to remember (brain.ts summarize pattern —
 *  a summary, never program text). */
const summarize = (result: LaneResult): string => {
  if (result.status === "ok") {
    const raw = result.raw as OpenUIRaw | undefined;
    const count = raw?.parseMeta?.statementCount;
    return `updated the program${count === undefined ? "" : ` (${count} statements)`}.`;
  }
  if (result.status === "refused") return `said this host cannot: ${result.reasons.join(" ")}`;
  return "failed to produce a valid program; the previous program stands.";
};

/**
 * One guarded generation turn: model call → `<Cannot>`/program split →
 * merge (edit turns) → validate → bounded repair. Never throws.
 */
async function guardedTurn(
  ask: string,
  state: TurnState,
  host: HostFixture,
  generate: OpenUIGenerate,
): Promise<TurnOutput> {
  const modelId = defaultModelId();
  if (!process.env[providerKeyFor(modelId)]) return { result: { status: "no-key" } };
  const startedAt = Date.now();
  const usage: LaneUsage = { promptTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let calls = 0;

  const hostToolNames = (host.tools as HostToolLike[]).map((tool) => tool.name);
  const toolSpecs = toToolSpecs(host);
  const createSystem = `${benchLibrary.prompt({ ...benchPromptOptions, tools: toolSpecs })}\n\n${groundingContract("create")}`;
  const editSystem = `${benchLibrary.prompt({ ...benchPromptOptions, tools: toolSpecs, editMode: true })}\n\n${groundingContract("edit")}`;
  const isEdit = state.program !== undefined;

  const call = async (system: string, prompt: string): Promise<string> => {
    const answer = await generate({ modelId, system, prompt });
    calls += 1;
    usage.promptTokens += answer.usage?.promptTokens ?? 0;
    usage.outputTokens += answer.usage?.outputTokens ?? 0;
    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (answer.usage?.cachedInputTokens ?? 0);
    return answer.text;
  };

  const finishRefused = (reasons: string[], responseText: string): TurnOutput => {
    const raw: OpenUIRaw = {
      model: modelId,
      responseText,
      toolsReferenced: state.program === undefined ? [] : [...new Set(boundTools(parseProgram(state.program)))].sort(),
      ...(state.program === undefined ? {} : { program: state.program }),
      refusal: { reasons, program: refusalProgram(reasons) },
      repairs: calls - 1,
    };
    return {
      result: {
        status: "refused",
        startedAt,
        durationMs: Date.now() - startedAt,
        reasons,
        usage,
        repairs: calls - 1,
        raw,
      },
      ...(state.program === undefined ? {} : { nextProgram: state.program }),
    };
  };

  try {
    let responseText = await call(isEdit ? editSystem : createSystem, turnMessage(state, ask));
    const reasons = readCannot(responseText);
    const patchText = extractProgram(stripCannot(responseText));

    // A pure refusal is an ANSWER: the program (if any) is left exactly as it
    // was — that intactness is the partial-refusal contract.
    if (patchText === "" && reasons.length > 0) return finishRefused(reasons, responseText);

    let candidate = isEdit && patchText !== ""
      ? mergeStatements(state.program as string, patchText, "root")
      : patchText;
    let partialReasons = reasons;

    for (let round = 0; ; round += 1) {
      const validation = validate(candidate, hostToolNames);
      const blocking = validation.findings.filter(({ severity }) => severity === "block");

      if (blocking.length === 0) {
        const parsed = validation.parsed;
        const refusal = partialReasons.length === 0
          ? undefined
          : { reasons: partialReasons, program: refusalProgram(partialReasons) };
        const findings: Finding[] = [
          ...validation.findings,
          ...partialReasons.map((reason): Finding => ({
            severity: "warn",
            where: "refused in part",
            message: reason,
          })),
        ];
        const raw: OpenUIRaw = {
          model: modelId,
          responseText,
          program: candidate,
          toolsReferenced: [...new Set(boundTools(parsed))].sort(),
          parseMeta: {
            statementCount: parsed.meta.statementCount,
            unresolved: parsed.meta.unresolved,
            orphaned: parsed.meta.orphaned,
          },
          ...(refusal === undefined ? {} : { refusal }),
          repairs: calls - 1,
        };
        return {
          result: {
            status: "ok",
            startedAt,
            durationMs: Date.now() - startedAt,
            usage,
            repairs: calls - 1,
            findings,
            raw,
          },
          nextProgram: candidate,
        };
      }

      if (round >= FIX_ROUNDS) {
        return {
          result: {
            status: "failed",
            startedAt,
            durationMs: Date.now() - startedAt,
            usage,
            repairs: calls - 1,
            error: `pre-render validation still blocking after ${FIX_ROUNDS} repair rounds: ${blocking
              .map(({ where, message }) => (where === undefined ? message : `${where} ${message}`))
              .join(" | ")}`,
            findings: validation.findings,
            raw: {
              model: modelId,
              responseText,
              program: candidate,
              toolsReferenced: [...new Set(boundTools(validation.parsed))].sort(),
              repairs: calls - 1,
            } satisfies OpenUIRaw,
          },
          // The session keeps its pre-turn program: a failed turn ships nothing.
          ...(state.program === undefined ? {} : { nextProgram: state.program }),
        };
      }

      // REPAIR — the findings are the instruction (conductor checkAndFix port).
      if (validation.unpatchable) {
        responseText = await call(
          createSystem,
          `${turnMessage(state, ask)}\n\nYOUR LAST ANSWER:\n${responseText}\n\n${rewriteInstruction(
            blocking.map(({ where, message }) => (where === undefined ? message : `${where} ${message}`)),
          )}`,
        );
      } else {
        responseText = await call(
          editSystem,
          `THE PROGRAM AS IT STANDS — your patch statements merge into it by name:\n${candidate}\n\n${fixInstruction(blocking)}`,
        );
      }

      const repairReasons = readCannot(responseText);
      const repairPatch = extractProgram(stripCannot(responseText));
      // The honest way out of an unfixable finding is a refusal — the model
      // realizing mid-repair that no tool grounds the ask converts the whole
      // turn, and the pre-turn program stays intact.
      if (repairPatch === "" && repairReasons.length > 0) {
        return finishRefused([...new Set([...partialReasons, ...repairReasons])], responseText);
      }
      if (repairReasons.length > 0) {
        partialReasons = [...new Set([...partialReasons, ...repairReasons])];
      }
      if (validation.unpatchable) {
        candidate = repairPatch;
      } else if (repairPatch !== "") {
        candidate = mergeStatements(candidate, repairPatch, "root");
      }
    }
  } catch (error) {
    return {
      result: {
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedAt,
        usage,
        repairs: Math.max(0, calls - 1),
        error: error instanceof Error ? error.message : String(error),
      },
      ...(state.program === undefined ? {} : { nextProgram: state.program }),
    };
  }
}

export function createOpenUIAdapter(deps: OpenUIDeps = {}): LaneAdapter {
  const generate = deps.generate ?? runGeneration;
  return {
    name: "openui",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      const { result } = await guardedTurn(prompt, { transcript: [] }, host, generate);
      return result;
    },
    createSession(host: HostFixture): LaneSession {
      const state: TurnState = { transcript: [] };
      return {
        async turn(ask: string): Promise<LaneResult> {
          const output = await guardedTurn(ask, state, host, generate);
          if (output.result.status !== "no-key") {
            state.transcript.push({ role: "user", text: ask }, { role: "lane", text: summarize(output.result) });
            if (output.nextProgram !== undefined) state.program = output.nextProgram;
            else delete state.program;
          }
          return output.result;
        },
        snapshot(): SessionSnapshot {
          if (state.program === undefined) return { elements: [], components: {} };
          return programSnapshot(parseProgram(state.program));
        },
      };
    },
  };
}

const adapter = createOpenUIAdapter();
export default adapter;
