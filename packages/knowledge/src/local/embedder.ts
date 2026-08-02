import { embedMany as sdkEmbedMany } from "ai";
import type { EmbeddingModel } from "ai";
import type { KnowledgeEmbedder } from "@vendoai/core";

/**
 * The local engine's embedding client — the concrete implementation of the
 * frozen `KnowledgeEmbedder` seam (`@vendoai/core` knowledge.ts:237-244), which
 * "exists solely because hybrid RRF needs a vector list to fuse". Built over the
 * Vercel AI SDK's `embedMany`, exactly as the verifier is built over
 * `generateObject` (verifier.ts) — a host-supplied model object, never an
 * environment read; composition (`server.ts`) decides which provider resolves.
 *
 * Mirrors Sift's embedding discipline (scout report §5.2):
 * - ASYMMETRIC task types where the provider honors them: `RETRIEVAL_DOCUMENT`
 *   for the chunk vectors written at upsert (`embed`), `RETRIEVAL_QUERY` /
 *   `QUESTION_ANSWERING` for the query vector at search time (`embedQuery`).
 *   The frozen interface carries only `embed`; `embedQuery` is an additive,
 *   feature-detected extension (see `HybridEmbedder`) so a bare
 *   `KnowledgeEmbedder` (a test mock, a symmetric provider) still works — the
 *   engine falls back to `embed` for the query when `embedQuery` is absent.
 *   OpenAI exposes no task types, so a provider that does not honor them simply
 *   receives no task-type provider option and embeds symmetrically.
 * - BATCHED with a small inter-batch delay and 429/5xx backoff: providers cap
 *   requests (Google ~100/req), so texts are chunked into conservative batches,
 *   each retried with exponential backoff on transient failures, with a pause
 *   between batches to stay under rate limits.
 * - A pinned `EMBEDDING_DIMENSIONS` and the model id on `.model`, so the engine
 *   can stamp each chunk row and detect a model/dimension change — the frozen
 *   contract already says "a changed `model` obliges re-embedding".
 */

/** The output dimensionality the local engine pins. Providers that support
    Matryoshka truncation (Google `gemini-embedding`, OpenAI `text-embedding-3-*`
    via `dimensions`) are asked for exactly this width; a provider whose native
    width differs is stored at its native width and the mismatch is harmless
    (cosine is computed per-vector). Kept as a constant so a change is a visible,
    reviewable edit — a changed width, like a changed model, obliges re-embed. */
export const EMBEDDING_DIMENSIONS = 768;

/** Google's asymmetric retrieval task types (the ones this engine uses). Passed
    only when `providerId` is set to the matching provider namespace; other
    providers ignore an unknown provider-option key, and OpenAI has no task
    types at all, so this is a no-op there. */
export const DOCUMENT_TASK_TYPE = "RETRIEVAL_DOCUMENT";
export const QUERY_TASK_TYPE = "RETRIEVAL_QUERY";

/** Conservative default batch size (Google caps 100/req; Sift batches 96-100). */
const DEFAULT_BATCH_SIZE = 96;
/** Inter-batch pause, Sift's 250ms spacing. */
const DEFAULT_BATCH_DELAY_MS = 250;
/** Transient-failure retries per batch, on top of the pause. */
const DEFAULT_MAX_RETRIES = 4;
/** Backoff base; attempt n waits BASE * 2^n (+ the batch delay). */
const BACKOFF_BASE_MS = 250;

/** The local extension of the frozen `KnowledgeEmbedder`: the same `embed`
    (document task type) plus an optional `embedQuery` (query task type) the
    engine feature-detects. Also carries the pinned dimensions so the engine can
    size its zero vector when a provider returns nothing. */
export interface HybridEmbedder extends KnowledgeEmbedder {
  /** RETRIEVAL_DOCUMENT — the chunk vectors written at upsert. */
  embed(texts: string[]): Promise<number[][]>;
  /** RETRIEVAL_QUERY — the query vector at search time. Present on providers
      that honor asymmetric task types; the engine falls back to `embed` when
      it is absent. */
  embedQuery(texts: string[]): Promise<number[][]>;
  /** The pinned output width. */
  dimensions: number;
}

export interface AiEmbedderOptions {
  /** The AI SDK embedding model — host-supplied, like the verifier's
      `LanguageModel`. Composition resolves this from the provider credential;
      the embedder never reads the environment. */
  model: EmbeddingModel;
  /** The stable model id stamped on each chunk row so a model change is
      detectable. Defaults to `model.modelId`. Changing it obliges re-embedding
      (the engine excludes vectors written under a different id). */
  modelId?: string;
  /** Pinned output width; requested from providers that honor it. */
  dimensions?: number;
  /** Provider namespace for `providerOptions` (e.g. "google", "openai") — set it
      to pass the output dimensionality (and, on providers that honor them, the
      asymmetric task types) under that provider's option key. Absent ⇒ no
      provider options at all (a provider whose option shape is not wired here). */
  providerId?: string;
  /** The provider's option key for the requested output width — Google's
      `outputDimensionality`, OpenAI's `dimensions`. Only sent when `providerId`
      is set. Defaults to `outputDimensionality`. */
  dimensionParam?: string;
  /** Task type for document vectors (upsert). Passed under `providerId`. */
  documentTaskType?: string;
  /** Task type for the query vector (search). Passed under `providerId`. */
  queryTaskType?: string;
  /** Max texts per provider request. */
  batchSize?: number;
  /** Pause between batches, ms. */
  batchDelayMs?: number;
  /** Transient-failure retries per batch. */
  maxRetries?: number;
  /** Injectable for tests — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — defaults to the AI SDK `embedMany`. */
  embedMany?: typeof sdkEmbedMany;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient provider failure worth a backoff-and-retry: an HTTP 429 or any
    5xx, plus the network-level errors that carry no status. A 4xx that is not
    429 (a bad key, a bad model id) is permanent — retrying only wastes the
    turn, so it propagates immediately. */
function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // No status → network/abort-shaped. The AI SDK flags retryable call errors.
  if ((error as { isRetryable?: unknown }).isRetryable === true) return true;
  const name = (error as { name?: unknown }).name;
  return name === "APICallError" || name === "AI_APICallError";
}

function chunkInto<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
  return batches;
}

/**
 * The shipped local embedder: batched `embedMany` calls on a host-supplied
 * embedding model, asymmetric per call, with per-batch backoff and a pause
 * between batches. Never reads the environment.
 */
export function aiEmbedder(options: AiEmbedderOptions): HybridEmbedder {
  const model = options.model;
  // `EmbeddingModel` is `string | EmbeddingModelV*`; a bare string IS the id.
  const modelId = options.modelId ?? (typeof model === "string" ? model : model.modelId);
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const providerId = options.providerId;
  const dimensionParam = options.dimensionParam ?? "outputDimensionality";
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const sleep = options.sleep ?? defaultSleep;
  const embedMany = options.embedMany ?? sdkEmbedMany;

  /** The provider options for one call: asymmetric task type + dimensionality,
      but only when a provider namespace is set (the provider honors them). */
  function providerOptions(taskType: string | undefined): Record<string, Record<string, string | number>> | undefined {
    if (providerId === undefined) return undefined;
    const inner: Record<string, string | number> = { [dimensionParam]: dimensions };
    if (taskType !== undefined) inner["taskType"] = taskType;
    return { [providerId]: inner };
  }

  /** One batch with exponential backoff on transient failures. The SDK's own
      retry is disabled (`maxRetries: 0`) so this loop is the single source of
      truth for how many times a batch is tried and how long it waits. */
  async function embedBatch(values: string[], taskType: string | undefined): Promise<number[][]> {
    const opts = providerOptions(taskType);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await embedMany({
          model,
          values,
          maxRetries: 0,
          ...(opts === undefined ? {} : { providerOptions: opts }),
        });
        return result.embeddings as number[][];
      } catch (error) {
        if (attempt >= maxRetries || !isTransient(error)) throw error;
        await sleep(BACKOFF_BASE_MS * 2 ** attempt + batchDelayMs);
      }
    }
  }

  async function run(texts: string[], taskType: string | undefined): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = chunkInto(texts, batchSize);
    const out: number[][] = [];
    for (let index = 0; index < batches.length; index += 1) {
      if (index > 0) await sleep(batchDelayMs);
      out.push(...await embedBatch(batches[index]!, taskType));
    }
    return out;
  }

  return {
    model: modelId,
    dimensions,
    embed: (texts) => run(texts, options.documentTaskType),
    embedQuery: (texts) => run(texts, options.queryTaskType),
  };
}
