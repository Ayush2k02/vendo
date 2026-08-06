/**
 * Spec lane — the native "Custom Views" candidate: one model call produces
 * either a JSON VIEW SPEC (components + tool bindings + params + section
 * headings, ZERO layout — see lanes/spec/format.ts) or a typed REFUSAL when
 * the host's tool surface cannot ground the ask. Specs are validated against
 * the chrome registry (lanes/spec/registry.ts — the REAL @vendoai/core kit
 * specs) and the host fixture's tool surface, repaired at most ONCE by
 * re-prompting with the validator's errors, then compiled deterministically
 * onto the production tree format and rendered by the production renderer in
 * `/embed/<host>` (SpecPane frames it exactly like the Vendo pane frames its
 * document). A refusal compiles onto the Kit's Disclaimer — vendo's own
 * "no tool backs the ask" chrome — and is marked in `raw.refusal` so the
 * bench's honesty accounting counts it as refused, never as answered.
 *
 * The hypothesis under test: constrain generation to bindings-over-a-registry
 * and the failure modes shift — no free layout to get wrong, no code to
 * escape into, data grounding structural (a data prop CANNOT be hand-typed;
 * the validator rejects it and the compiler only binds tool results).
 *
 * Honesty vocabulary, mirroring the other lanes: `ok` means at least one
 * piece survived validation and the compiled document renders; every piece
 * that failed after the repair round is a warn Finding AND renders in-app as
 * a failure Callout (per-piece honest failure, never silent). All pieces
 * failing, or unusable JSON after repair, is status `failed`; every finding
 * counts in the CLI summary the way every other lane's findings do.
 *
 * Model: the same default resolver every generating lane uses
 * (runner/models.ts `defaultModelId`) so the comparison holds the model
 * constant; no sampling params set.
 */
import { createRequire } from "node:module";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Finding } from "@vendoai/apps";
import type { ShapeType } from "@vendoai/core";
import { MAX_OUTPUT_TOKENS, defaultModelId, providerKeyFor } from "../runner/models";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";
import { extractJson } from "./spec/format";
import { registryPrompt } from "./spec/registry";
import { allErrors, validateSpec, type HostToolLike, type PieceVerdict, type SpecVerdict } from "./spec/validate";
import { compileRefusal, compileSpec } from "./spec/compile";

/** Shape of `LaneResult.raw` for this lane (what the internals drawer shows;
 *  the render itself is the compiled document in the embed frame). */
export interface SpecRaw {
  model: string;
  /** Full assistant text of the first call (fences included). */
  responseText: string;
  /** Full assistant text of the repair call, when one ran. */
  repairResponseText?: string;
  repaired: boolean;
  /** The final parsed spec (post-repair), when the top level parsed. */
  spec?: unknown;
  /** The typed abstention, when the model refused instead of answering —
   *  the honesty accounting's "refused" marker for this lane. */
  refusal?: { reason: string; missing?: string[] };
  /** Per-piece validator verdicts on the final spec. */
  pieces: PieceVerdict[];
  /** Top-level validator errors on the final spec. */
  specErrors: string[];
  /** Tools the surviving pieces bind (queries + actions), sorted unique. */
  toolsBound: string[];
  queryCount?: number;
  nodeCount?: number;
}

export type SpecGenerate = (args: {
  modelId: string;
  system: string;
  prompt: string;
}) => Promise<string>;

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

/** The authoring context: the spec format, the chrome registry (generated
 *  from the real component specs), and the host's tool surface with input
 *  schemas and output shapes — everything the validator will hold it to. */
export function buildSystemPrompt(host: HostFixture): string {
  const shapes = host.shapes as Readonly<Record<string, ShapeType>>;
  const tools = (host.tools as HostToolLike[]).map((tool) => {
    const lines = [
      `### ${tool.name}${tool.risk === "read" ? " (read)" : " (mutation)"}`,
      tool.description,
      `Input schema: ${JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} })}`,
    ];
    const shape = shapes[tool.name];
    if (shape !== undefined) lines.push(`Output shape: ${JSON.stringify(shapeToJsonSchema(shape))}`);
    return lines.join("\n");
  });

  return [
    "You are composing a CUSTOM VIEW for a host application. Your entire output is ONE",
    "JSON object — no prose, no code, no markup — in exactly one of two forms. The host",
    "renders it with its own production components; you never control layout or markup.",
    "",
    "Form 1 — a view spec, when the host's tools can ground the ask:",
    "```",
    JSON.stringify(
      {
        title: "view heading",
        components: [
          {
            use: "<a registry component>",
            section: "<optional group heading — consecutive pieces sharing it render as one framed section>",
            tool: "<host tool whose result fills the data slot>",
            params: { "<tool input>": "…" },
            select: "<optional dot-path into the tool result, e.g. \"data\" when rows live under a data field>",
            bind: { "<extra data prop>": "<dot-path into the same tool result>" },
            props: { "<config/copy props from the registry>": "…" },
            actions: [{ label: "button text", tool: "<host mutation>", params: {} }],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "Form 2 — a refusal, when they cannot:",
    "```",
    JSON.stringify(
      { refusal: { reason: "<user-facing sentence: why this host can't ground the ask>", missing: ["<capability the host lacks>"] } },
      null,
      2,
    ),
    "```",
    "",
    "Laws:",
    "1. Data comes ONLY from tools. You never write business data — a component's data",
    "   slot is filled from its `tool` result. Props marked [copy] are yours to write;",
    "   [config] props tune behavior. There is no way to hand-type a data value.",
    "2. GROUNDING IS THE BAR. Before answering, check the tool catalog below: a tool",
    "   grounds the ask only if its documented OUTPUT SHAPE actually carries the fields",
    "   the answer needs. Data that merely resembles or is adjacent to the ask does",
    "   NOT ground it — if no tool's output carries those fields, refuse and name what",
    "   the host lacks. A partial answer is fine only when every piece you ship is",
    "   truly grounded and copy says what is not covered.",
    "3. ZERO layout. Order components by importance; group related pieces with",
    "   `section` headings; the host lays them out.",
    "4. `actions` name host mutations and render as action-gated buttons. Only attach",
    "   actions the ask needs.",
    "5. Match each tool's input schema exactly, and read its output shape before",
    "   binding: when the rows live under a field (e.g. `data`), set `select` to it;",
    "   fill a component's extra data props (e.g. Progress `max`) via `bind`.",
    "6. Money values are integer CENTS — use format \"money\" so the host formats them.",
    "",
    "# The chrome registry",
    "",
    registryPrompt(),
    "",
    "# The host's tools",
    "",
    tools.join("\n\n"),
    "",
    "Answer with the JSON only.",
  ].join("\n");
}

function repairPrompt(originalAsk: string, previousText: string, errors: string[]): string {
  return [
    `The ask: ${originalAsk}`,
    "",
    "Your previous answer failed validation:",
    "```",
    extractJson(previousText),
    "```",
    "",
    "Validator errors:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return the corrected COMPLETE view spec as JSON only — same format, every piece",
    "valid against the registry and the tool surface. No prose.",
  ].join("\n");
}

/** Default generation — the vendo lane's module-space convention: generateText
 *  from @vendoai/apps's module space, provider routed by id prefix. */
const runGeneration: SpecGenerate = async ({ modelId, system, prompt }) => {
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  const appsRequire = createRequire(appsEntry);
  const { generateText } = appsRequire("ai") as {
    generateText: (options: {
      model: unknown;
      system: string;
      prompt: string;
      maxOutputTokens: number;
    }) => Promise<{ text: string }>;
  };
  let model: unknown;
  if (providerKeyFor(modelId) === "GEMINI_API_KEY") {
    model = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY as string })(modelId);
  } else {
    const { createAnthropic } = appsRequire("@ai-sdk/anthropic") as {
      createAnthropic: (options: { apiKey: string }) => (id: string) => unknown;
    };
    model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY as string })(modelId);
  }
  const { text } = await generateText({ model, system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return text;
};

function toolsBoundBy(verdict: SpecVerdict): string[] {
  const spec = verdict.spec;
  if (spec === undefined) return [];
  const bound = new Set<string>();
  for (const piece of verdict.pieces) {
    if (piece.errors.length > 0) continue;
    const source = spec.components[piece.index];
    if (source?.tool !== undefined) bound.add(source.tool);
    for (const action of source?.actions ?? []) bound.add(action.tool);
  }
  return [...bound].sort();
}

export interface SpecDeps {
  /** Test seam: canned model responses play back through the real extract →
   *  validate → repair → compile path; no live API calls in tests. */
  generate?: SpecGenerate;
}

export function createSpecAdapter(deps: SpecDeps = {}): LaneAdapter {
  return {
    name: "spec",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      const modelId = defaultModelId();
      if (!process.env[providerKeyFor(modelId)]) return { status: "no-key" };
      const startedAt = Date.now();
      const gen = deps.generate ?? runGeneration;
      try {
        const system = buildSystemPrompt(host);
        const responseText = await gen({ modelId, system, prompt });
        const hostTools = host.tools as HostToolLike[];
        let verdict = validateSpec(extractJson(responseText), hostTools);

        // The one bounded repair round: re-prompt with the validator's
        // errors, then live with what comes back.
        let repairResponseText: string | undefined;
        const firstErrors = allErrors(verdict);
        if (firstErrors.length > 0) {
          repairResponseText = await gen({
            modelId,
            system,
            prompt: repairPrompt(prompt, responseText, firstErrors),
          });
          verdict = validateSpec(extractJson(repairResponseText), hostTools);
        }

        const raw: SpecRaw = {
          model: modelId,
          responseText,
          ...(repairResponseText === undefined ? {} : { repairResponseText }),
          repaired: repairResponseText !== undefined,
          ...(verdict.spec === undefined ? {} : { spec: verdict.spec }),
          ...(verdict.refusal === undefined ? {} : { refusal: verdict.refusal }),
          pieces: verdict.pieces,
          specErrors: verdict.specErrors,
          toolsBound: toolsBoundBy(verdict),
        };

        // The typed abstention: rendered through vendo's own refusal chrome
        // (the Kit Disclaimer), zero findings, zero tool bindings. Counted
        // as "refused" — not "answered" — by the bench's honesty accounting
        // (raw.refusal is the marker).
        if (verdict.refusal !== undefined) {
          const compiled = compileRefusal(verdict.refusal);
          raw.queryCount = compiled.queryCount;
          raw.nodeCount = compiled.nodeCount;
          return {
            status: "ok",
            startedAt,
            durationMs: Date.now() - startedAt,
            document: compiled.document,
            findings: [],
            raw,
          };
        }

        if (verdict.spec === undefined) {
          return {
            status: "failed",
            startedAt,
            durationMs: Date.now() - startedAt,
            error: `the model produced no usable view spec after one repair round: ${verdict.specErrors.join(" | ")}`,
            raw,
          };
        }

        const failedPieces = verdict.pieces.filter((piece) => piece.errors.length > 0);
        if (failedPieces.length === verdict.pieces.length) {
          return {
            status: "failed",
            startedAt,
            durationMs: Date.now() - startedAt,
            error: `every piece failed validation after one repair round: ${allErrors(verdict).join(" | ")}`,
            raw,
          };
        }

        const { document, queryCount, nodeCount } = compileSpec(verdict.spec, verdict.pieces);
        raw.queryCount = queryCount;
        raw.nodeCount = nodeCount;
        const findings: Finding[] = failedPieces.map((piece) => ({
          severity: "warn",
          where: `piece ${piece.index + 1} (${piece.use})`,
          message: `failed validation after the one repair round and renders as an in-app failure notice: ${piece.errors.join(" | ")}`,
        }));
        return { status: "ok", startedAt, durationMs: Date.now() - startedAt, document, findings, raw };
      } catch (error) {
        return {
          status: "failed",
          startedAt,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

const adapter = createSpecAdapter();
export default adapter;
