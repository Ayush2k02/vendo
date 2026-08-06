/**
 * The Vendo lane: conductCreate driven directly against the HostFixture
 * surface — catalog + tools + shape cards + theme as GenerationDependencies,
 * the production defaults (no knobs overridden). NEVER throws, and neither
 * does the conductor: a refusal ("cannot") and an unreadable answer
 * ("failure") come back as VALUES, so the lane maps all three outcomes to a
 * LaneResult and only a genuine crash reaches the catch.
 *
 * The study signal on a successful app is the checking layer's `findings`
 * (severity · where · message) — what is still wrong with the app that
 * shipped.
 *
 * The model key comes from the repo-root .env (source-only: values are read
 * into process.env and never printed). The Anthropic provider resolves through
 * @vendoai/apps's own module space — genui-bench declares no model SDK.
 *
 * PER-RUN MODEL + SAMPLING (RunRequest.model). Three seams, only one of which
 * the engine owns:
 *
 *   - model id — a real GenerationDependencies seam: `deps.model` is whatever
 *     LanguageModel instance we hand it, so the id is just the provider call.
 *   - temperature / thinking — NOT a GenerationDependencies seam. The engine
 *     hardcodes `temperature: 0` at every call site and never sets
 *     providerOptions or maxOutputTokens, so per-run sampling rides the AI
 *     SDK's own model middleware (`wrapLanguageModel` + `transformParams`),
 *     which rewrites the outgoing provider call for every engine stage.
 *
 * The middleware is not a nicety: the Claude 5 line rejects `temperature`
 * outright (400), so without stripping the engine's hardcoded 0 those models
 * could not be selected at all. Absent RunRequest.model there is no wrapper —
 * an untouched run is byte-identical to what ships.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  conductCreate,
  conductEdit,
  type ConductedResult,
  type ConductorOptions,
  type GenerationDependencies,
  type HostToolInfo,
} from "@vendoai/apps";
import {
  printWire,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
  type Tree,
} from "@vendoai/core";
import {
  MAX_OUTPUT_TOKENS,
  defaultModelId,
  findModel,
  providerKeyFor,
  validateModelChoice,
  type BenchModel,
  type RunModel,
} from "../runner/models";
import type {
  HostFixture,
  LaneAdapter,
  LaneResult,
  LaneRunOptions,
  LaneSession,
  LaneUsage,
  SessionSnapshot,
} from "../runner/types";

export interface VendoAdapterOverrides {
  /** Test seam: a conductor-shaped fake (default: the real conductCreate). */
  conduct?: (
    input: { prompt: string },
    deps: GenerationDependencies,
    options?: ConductorOptions,
  ) => Promise<ConductedResult>;
  /** Test seam for edit turns (default: the real conductEdit). */
  conductEditTurn?: (
    input: { app: AppDocument; instruction: string; session?: ConductedResult["session"] },
    deps: GenerationDependencies,
    options?: ConductorOptions,
  ) => Promise<ConductedResult>;
  /** Test seam: an injected model instance (default: Anthropic from root .env). */
  model?: GenerationDependencies["model"];
  /** Test seam: build a provider model for an id (default: Anthropic from root .env). */
  createModel?: (id: string) => GenerationDependencies["model"];
}

/** Source-only root .env load (cli.ts pattern, duplicated because cli.ts runs
 *  its main on import): fills unset process.env keys, never prints values. */
function loadRootEnv(): void {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key as string] !== undefined) continue;
    process.env[key as string] = (raw as string).replace(/^(["'])(.*)\1$/, "$2");
  }
}

/** @vendoai/apps's own module space (the engine's provider deps) so this app
 *  declares no model SDK. import.meta.resolve is absent when tsx runs this
 *  file as CJS (the CLI path); createRequire is the everywhere-safe way. */
function requireFromApps(specifier: string): unknown {
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  return createRequire(appsEntry)(specifier);
}

/** The real model for the given id, provider routed by prefix (see
 *  runner/models.ts defaultModelId): `gemini*` rides @ai-sdk/google (this
 *  app's own dependency — the Gemini fallback is bench plumbing, not an
 *  engine seam), everything else the Anthropic provider from @vendoai/apps's
 *  module space. */
function resolveProviderModel(id: string): GenerationDependencies["model"] {
  loadRootEnv();
  if (providerKeyFor(id) === "GEMINI_API_KEY") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("GEMINI_API_KEY missing — set it in the repo-root .env");
    }
    return createGoogleGenerativeAI({ apiKey })(id) as unknown as GenerationDependencies["model"];
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY missing — set it in the repo-root .env");
  }
  const { createAnthropic } = requireFromApps("@ai-sdk/anthropic") as {
    createAnthropic: (options: { apiKey: string }) => (id: string) => GenerationDependencies["model"];
  };
  return createAnthropic({ apiKey })(id);
}

/** The slice of the AI SDK's provider call options this lane rewrites. */
export interface ModelCallParams {
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Rewrite one outgoing provider call for the run's model choice. Pure, and
 * exported as the assertion point for lanes/vendo.test.ts.
 *
 * `temperature` is deleted rather than left alone when the model rejects it:
 * the engine hardcodes 0 and the Claude 5 line 400s on any temperature.
 */
export function transformModelParams<T extends ModelCallParams>(
  params: T,
  choice: RunModel,
  spec: BenchModel,
): T {
  const next: T = { ...params, maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS };

  if (!spec.temperature) delete next.temperature;
  else if (choice.temperature !== undefined) next.temperature = choice.temperature;

  const anthropic: Record<string, unknown> = { ...next.providerOptions?.anthropic };
  if (choice.thinkingBudget !== undefined) {
    anthropic.thinking = { type: "enabled", budgetTokens: choice.thinkingBudget };
    // Anthropic forbids temperature alongside extended thinking.
    delete next.temperature;
  }
  if (choice.effort !== undefined) anthropic.effort = choice.effort;
  if (Object.keys(anthropic).length > 0) {
    next.providerOptions = { ...next.providerOptions, anthropic };
  }
  return next;
}

/** Wrap a provider model so every engine stage inherits the run's settings. */
function withRunSettings(
  base: GenerationDependencies["model"],
  choice: RunModel,
  spec: BenchModel,
): GenerationDependencies["model"] {
  const { wrapLanguageModel } = requireFromApps("ai") as {
    wrapLanguageModel: (options: { model: unknown; middleware: unknown }) => GenerationDependencies["model"];
  };
  return wrapLanguageModel({
    model: base,
    middleware: {
      specificationVersion: "v3",
      transformParams: ({ params }: { params: ModelCallParams }) =>
        Promise.resolve(transformModelParams(params, choice, spec)),
    },
  });
}

/** The model the engine will run on, honoring the per-run choice. */
function modelFor(
  choice: RunModel | undefined,
  overrides: VendoAdapterOverrides,
): GenerationDependencies["model"] {
  const create = overrides.createModel ?? resolveProviderModel;
  if (!choice) {
    // No per-run choice: the shared default resolver (GENUI_BENCH_MODEL stays
    // the headless override; a keyless-Anthropic machine falls back to the
    // root .env's Gemini model), and no middleware in the path. Root .env is
    // loaded first so the resolver sees GEMINI_MODEL outside the CLI path.
    loadRootEnv();
    return overrides.model ?? create(defaultModelId());
  }
  const invalid = validateModelChoice(choice);
  if (invalid) throw new Error(invalid);
  const spec = findModel(choice.id) as BenchModel;
  return withRunSettings(overrides.model ?? create(spec.id), choice, spec);
}

/** The canonical printed wire of the final document (the conductor exposes no
 *  raw-stream tap; this is the same print the checking layer reads). */
function renderWire(document: AppDocument): string | undefined {
  if (document.tree?.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  try {
    return printWire(
      { tree: document.tree as unknown as Tree, components: document.components ?? {}, name: document.name },
      { includeIds: true },
    );
  } catch {
    return undefined;
  }
}

/**
 * A self-explanatory failure string. A validation VendoError's message is the
 * generic "model could not produce a valid app" — the reason lives in its
 * `detail`, a string[] of validation issues. Duck-typed rather than
 * `instanceof`: the engine's @vendoai/core instance need not be ours.
 */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { detail?: unknown } | null)?.detail;
  const issues = Array.isArray(detail) ? detail.filter((issue): issue is string => typeof issue === "string") : [];
  return issues.length === 0 ? message : `${message}: ${issues.join(" | ")}`;
}

/** One usage slot across SDK dialects: a plain number (generate results),
 *  or the v3 stream-finish shape `{ total, ... }`. */
function tokenCount(value: unknown): number {
  if (typeof value === "number") return value;
  const total = (value as { total?: unknown } | undefined)?.total;
  return typeof total === "number" ? total : 0;
}

/** Provider-call usage read defensively across SDK dialects. The vendo lane
 *  sets no explicit cache, but Gemini may implicitly cache a repeated prefix
 *  across the engine's many internal calls, so cache-read tokens are recorded
 *  too — the same honest cached-vs-uncached split the openui lane reports. */
function addUsage(sink: LaneUsage, usage: unknown): void {
  const u = usage as {
    inputTokens?: unknown; outputTokens?: unknown; promptTokens?: unknown; completionTokens?: unknown;
    cachedInputTokens?: unknown;
  } | undefined;
  sink.promptTokens += tokenCount(u?.inputTokens ?? u?.promptTokens);
  sink.outputTokens += tokenCount(u?.outputTokens ?? u?.completionTokens);
  sink.cachedInputTokens = (sink.cachedInputTokens ?? 0) + tokenCount(u?.cachedInputTokens);
}

/**
 * Count every provider call's tokens into `sink`, across all engine stages
 * (brain, workers, reviewer, repair). The engine streams, so usage rides the
 * stream's finish part; wrapGenerate covers the non-streaming calls. Pure
 * bench accounting — the call itself is forwarded untouched.
 */
function withUsageCounting(
  base: GenerationDependencies["model"],
  sink: LaneUsage,
): GenerationDependencies["model"] {
  const { wrapLanguageModel } = requireFromApps("ai") as {
    wrapLanguageModel: (options: { model: unknown; middleware: unknown }) => GenerationDependencies["model"];
  };
  return wrapLanguageModel({
    model: base,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }: { doGenerate: () => Promise<{ usage?: unknown }> }) => {
        const result = await doGenerate();
        addUsage(sink, result.usage);
        return result;
      },
      wrapStream: async ({ doStream }: { doStream: () => Promise<{ stream: ReadableStream<unknown> }> }) => {
        const result = await doStream();
        const stream = result.stream.pipeThrough(
          new TransformStream<unknown, unknown>({
            transform(part, controller) {
              const chunk = part as { type?: string; usage?: unknown };
              if (chunk?.type === "finish") addUsage(sink, chunk.usage);
              controller.enqueue(part);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
}

/** The conversation as the conductor wants it back (BrainTurn[], derived
 *  structurally — the type is not exported from @vendoai/apps). */
type SessionTurns = ConductedResult["session"];

/** Stable identity + component name per tree node, for preservation scoring
 *  (the engine's own claim: an edit keeps the ids of nodes it didn't touch). */
function documentSnapshot(document: AppDocument | undefined): SessionSnapshot {
  const nodes = (document?.tree as { nodes?: Array<{ id?: string; component?: string }> } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return { elements: [], components: {} };
  const components: Record<string, string> = {};
  for (const node of nodes) {
    if (typeof node.id === "string" && typeof node.component === "string") components[node.id] = node.component;
  }
  return { elements: Object.keys(components).sort(), components };
}

/** Map one ConductedResult to a LaneResult (create and edit turns share it). */
function laneResultOf(
  conducted: ConductedResult,
  startedAt: number,
  usage: LaneUsage,
  previousDocument: AppDocument | undefined,
): LaneResult {
  const durationMs = Date.now() - startedAt;
  // A refusal is an ANSWER, not a crash: the host cannot do the ask, and the
  // reasons are the sentences a person would read. On an edit turn the
  // previous document rides along PRESERVED — the partial-refusal contract.
  if (conducted.kind === "cannot") {
    return {
      status: "refused",
      startedAt,
      durationMs,
      usage,
      reasons: conducted.reasons,
      ...(previousDocument === undefined ? {} : { document: previousDocument }),
    };
  }
  if (conducted.kind === "failure") {
    return {
      status: "failed",
      startedAt,
      durationMs,
      usage,
      error: `generation failed: ${conducted.issues.join(" | ")}`,
    };
  }
  const document: AppDocument = { ...conducted.document, id: `app_bench_${startedAt.toString(36)}` };
  const wire = renderWire(document);
  return {
    status: "ok",
    startedAt,
    durationMs,
    usage,
    document,
    ...(wire === undefined ? {} : { wire }),
    findings: conducted.findings,
  };
}

export function createVendoAdapter(overrides: VendoAdapterOverrides = {}): LaneAdapter {
  const depsFor = (host: HostFixture, model: GenerationDependencies["model"]): GenerationDependencies => ({
    model,
    catalog: host.catalog as NormalizedCatalog,
    tools: host.tools as HostToolInfo[],
    toolShapes: host.shapes as Readonly<Record<string, ShapeType>>,
    theme: host.theme,
    // production defaults — deliberately no `pipeline` key
  });
  return {
    name: "vendo",
    async generate(prompt: string, host: HostFixture, options: LaneRunOptions = {}): Promise<LaneResult> {
      const startedAt = Date.now();
      const usage: LaneUsage = { promptTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      try {
        const conduct = overrides.conduct ?? conductCreate;
        const model = withUsageCounting(modelFor(options.model, overrides), usage);
        const conducted = await conduct({ prompt }, depsFor(host, model));
        return laneResultOf(conducted, startedAt, usage, undefined);
      } catch (error) {
        return { status: "failed", startedAt, durationMs: Date.now() - startedAt, usage, error: failureReason(error) };
      }
    },
    createSession(host: HostFixture, options: LaneRunOptions = {}): LaneSession {
      // One conversation: the document as it stands plus the brain's session
      // transcript, exactly what conductEdit wants back ("no, the other
      // chart" resolves because the conversation carries what was said).
      const state: { document?: AppDocument; session: SessionTurns } = { session: [] };
      return {
        async turn(ask: string): Promise<LaneResult> {
          const startedAt = Date.now();
          const usage: LaneUsage = { promptTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
          try {
            const model = withUsageCounting(modelFor(options.model, overrides), usage);
            const deps = depsFor(host, model);
            const conducted = state.document === undefined
              ? await (overrides.conduct ?? conductCreate)({ prompt: ask }, deps)
              : await (overrides.conductEditTurn ?? conductEdit)(
                { app: state.document, instruction: ask, session: state.session }, deps);
            const result = laneResultOf(conducted, startedAt, usage, state.document);
            state.session = conducted.session;
            if (result.status === "ok" && result.document !== undefined) state.document = result.document;
            return result;
          } catch (error) {
            return { status: "failed", startedAt, durationMs: Date.now() - startedAt, usage, error: failureReason(error) };
          }
        },
        snapshot(): SessionSnapshot {
          return documentSnapshot(state.document);
        },
      };
    },
  };
}

export const adapter: LaneAdapter = createVendoAdapter();
export default adapter;
