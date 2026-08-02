import { VendoError, type KnowledgeEmbedder } from "@vendoai/core";
import {
  aiEmbedder,
  DOCUMENT_TASK_TYPE,
  EMBEDDING_DIMENSIONS,
  QUERY_TASK_TYPE,
} from "@vendoai/knowledge";
import type { EmbeddingModel } from "ai";
import type { ModelsConfig } from "../models-config.js";
import { importHostModule } from "#dev-creds/model";

/** The slice of the ai-SDK v3 embedding model this resolver constructs (a lazy
    wrapper) and delegates to (the provider's real model). Kept local so the
    resolver depends only on `ai`'s public `EmbeddingModel` union, not on
    `@ai-sdk/provider` internals. */
interface EmbeddingModelV3Like {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  maxEmbeddingsPerCall: number;
  supportsParallelCalls: boolean;
  doEmbed(options: unknown): Promise<unknown>;
}

/**
 * The knowledge EMBEDDER slot's credential resolver — the embedding sibling of
 * `vendoModel` (dev-creds/model.ts), and the composition half of the optional
 * hybrid-semantic local engine (scout report §5.2, §7 decision D1 = option b).
 *
 * It mirrors the `knowledgeVerifier` slot exactly (server.ts): an OPTIONAL,
 * model-backed upgrade to local retrieval that is OFF without an opt-in, rides
 * the dev credential ladder, and FAILS OPEN (no embedder ⇒ the local engine
 * stays lexical, today's behavior). One difference is forced by the domain:
 * embeddings need a provider's `textEmbeddingModel()`, which the Cloud model
 * gateway (Anthropic-compatible CHAT) does not serve — so `VENDO_API_KEY` alone
 * never unlocks this, and only OpenAI/Google keys resolve. This is precisely
 * why the frozen contract says "Anthropic-only hosts never invoke it".
 *
 * Enablement (either turns it on): `models.knowledgeEmbedder` is set, or
 * `VENDO_KNOWLEDGE_EMBED=on`. Key PRESENCE alone never enables it — a host that
 * merely has `OPENAI_API_KEY` set for some other feature (the demo's voice flow)
 * keeps the byte-identical lexical engine until it opts in. When enabled but no
 * embedding-capable key resolves, the resolver returns nothing (fail-open) and
 * says so on the operator log, never breaking knowledge.
 */

type EmbeddingProvider = "openai" | "google";

interface EmbeddingProviderSpec {
  module: string;
  factory: string;
  /** `providerOptions` namespace. */
  providerId: EmbeddingProvider;
  /** Default embedding model id when none is pinned/configured. */
  model: string;
  /** The provider's option key for the requested output width. */
  dimensionParam: string;
  /** Asymmetric task types, when the provider honors them (Google does). */
  documentTaskType?: string;
  queryTaskType?: string;
  install: string;
}

/** The wired embedding providers. Anthropic is deliberately absent — it serves
    no embedding model, so neither a raw `ANTHROPIC_API_KEY` nor the Cloud
    gateway can back this slot. */
const EMBEDDING_PROVIDERS: Record<EmbeddingProvider, EmbeddingProviderSpec> = {
  openai: {
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
    providerId: "openai",
    model: "text-embedding-3-small",
    dimensionParam: "dimensions",
    install: "npm install ai@^6 @ai-sdk/openai@^3",
  },
  google: {
    module: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    providerId: "google",
    model: "gemini-embedding-001",
    dimensionParam: "outputDimensionality",
    documentTaskType: DOCUMENT_TASK_TYPE,
    queryTaskType: QUERY_TASK_TYPE,
    install: "npm install ai@^6 @ai-sdk/google@^3",
  },
};

/** Embedding-capable provider keys, in precedence order. `GEMINI_API_KEY` is
    accepted as a common alias for the Google key. */
const EMBEDDING_ENV_KEYS: ReadonlyArray<{ envVar: string; provider: EmbeddingProvider }> = [
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", provider: "google" },
  { envVar: "GEMINI_API_KEY", provider: "google" },
];

/** Per-slot model-id pin (precedence: pin → configured string → provider
    default), the embedding analogue of VENDO_MODEL_<SLOT>. */
const PIN_ENV = "VENDO_MODEL_KNOWLEDGE_EMBEDDER";
/** The on/off toggle, mirroring VENDO_KNOWLEDGE_VERIFY. */
const TOGGLE_ENV = "VENDO_KNOWLEDGE_EMBED";
/** Batch cap sent to the provider per request; must exceed aiEmbedder's own
    batch size so the SDK never re-splits a batch. */
const MAX_EMBEDDINGS_PER_CALL = 2048;

const nonBlank = (value: string | undefined): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export interface ResolveKnowledgeEmbedderOptions {
  models?: ModelsConfig;
  env?: Record<string, string | undefined>;
  /** Host app root for provider resolution. Default cwd. */
  root?: string;
  /** Test seam for provider-module resolution. */
  importModule?: (root: string, specifier: string) => Promise<Record<string, unknown>>;
}

/** A value that is neither on nor off is a TYPO (same rule as
    VENDO_KNOWLEDGE_VERIFY): a typo that silently means "off" is how a host
    thinks it has semantics it does not. */
function toggleEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[TOGGLE_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  if (["on", "true", "1"].includes(raw)) return true;
  if (["off", "false", "0"].includes(raw)) return false;
  throw new VendoError("validation", `${TOGGLE_ENV} must be on or off, got ${JSON.stringify(raw)}`);
}

/** The lazy embedding model: like `lazyModel` for chat, composition stays
    synchronous while the provider module import + `textEmbeddingModel()` happen
    on the first embed call (cached thereafter). A missing provider install
    surfaces its exact install command on first use, not at composition. */
function lazyEmbeddingModel(
  spec: EmbeddingProviderSpec,
  modelId: string,
  apiKey: string,
  root: string | undefined,
  importModule: (root: string, specifier: string) => Promise<Record<string, unknown>>,
): EmbeddingModel {
  let resolved: Promise<EmbeddingModelV3Like> | null = null;
  const resolve = async (): Promise<EmbeddingModelV3Like> => {
    // process.cwd() only here (the Node host path), never at composition, so
    // an edge/worker bundle that never reaches a keyed provider stays clean.
    const from = root ?? (typeof process !== "undefined" && process.cwd ? process.cwd() : ".");
    let loaded: Record<string, unknown>;
    try {
      loaded = await importModule(from, spec.module);
    } catch {
      throw new VendoError(
        "validation",
        `an embedding key is set but ${spec.module} is not installed in this app; install it (\`${spec.install}\`).`,
      );
    }
    const factory = loaded[spec.factory] as (config: { apiKey: string }) => {
      textEmbeddingModel(id: string): EmbeddingModelV3Like;
    };
    return factory({ apiKey }).textEmbeddingModel(modelId);
  };
  const model: EmbeddingModelV3Like = {
    specificationVersion: "v3",
    provider: `vendo.${spec.providerId}`,
    modelId,
    maxEmbeddingsPerCall: MAX_EMBEDDINGS_PER_CALL,
    supportsParallelCalls: false,
    async doEmbed(options) {
      resolved ??= resolve();
      return (await resolved).doEmbed(options);
    },
  };
  return model as unknown as EmbeddingModel;
}

/** Resolve the knowledge embedder for the composed local engine, or `undefined`
    when the slot is off or no embedding-capable key is available. Composition
    hands the result to `bindKnowledgeStore`, which applies it ONLY to the local
    lexical engine (a cloud/BYO/custom adapter passes through untouched). */
export function resolveKnowledgeEmbedder(options: ResolveKnowledgeEmbedderOptions = {}): KnowledgeEmbedder | undefined {
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const importModule = options.importModule ?? importHostModule;
  const configured = options.models?.knowledgeEmbedder;

  if (typeof configured === "string" && nonBlank(configured) === undefined) {
    throw new VendoError("validation", "models.knowledgeEmbedder must be a non-blank model name or an ai-SDK EmbeddingModel");
  }

  // Enabled by explicit config OR the toggle — never by key presence alone.
  if (configured === undefined && !toggleEnabled(env)) return undefined;

  // An explicit EmbeddingModel object wins as-is (BYO), embedded symmetrically —
  // its provider's task-type/dimension shape is the host's to have chosen.
  if (configured !== undefined && typeof configured !== "string") {
    return aiEmbedder({ model: configured, dimensions: EMBEDDING_DIMENSIONS });
  }

  const found = EMBEDDING_ENV_KEYS.find((entry) => nonBlank(env[entry.envVar]) !== undefined);
  if (found === undefined) {
    console.warn(
      `[vendo] knowledge embedder is enabled (${configured !== undefined ? "models.knowledgeEmbedder" : `${TOGGLE_ENV}=on`}) `
      + "but no embedding provider key was found — set OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY (the Vendo Cloud "
      + "gateway serves chat, not embeddings). Knowledge search stays lexical until one is set.",
    );
    return undefined;
  }

  const spec = EMBEDDING_PROVIDERS[found.provider];
  const modelId = nonBlank(env[PIN_ENV]) ?? nonBlank(configured) ?? spec.model;
  const model = lazyEmbeddingModel(spec, modelId, env[found.envVar]!, options.root, importModule);
  return aiEmbedder({
    model,
    modelId,
    providerId: spec.providerId,
    dimensionParam: spec.dimensionParam,
    ...(spec.documentTaskType === undefined ? {} : { documentTaskType: spec.documentTaskType }),
    ...(spec.queryTaskType === undefined ? {} : { queryTaskType: spec.queryTaskType }),
    dimensions: EMBEDDING_DIMENSIONS,
  });
}
