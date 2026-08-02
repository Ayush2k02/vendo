import type { KnowledgeAdapter, KnowledgeContext, KnowledgeEmbedder } from "@vendoai/core";
import { memoryKnowledgeAdapter, memoryStoreAdapter } from "@vendoai/core/conformance";
import { lexicalKnowledge } from "@vendoai/knowledge";
import { resolveKnowledgeEmbedder } from "@vendoai/vendo/server";

/** Embedding-capable provider keys the `semantic` engine will use for a REAL
    hosted run when one is present in the environment. */
const HOSTED_EMBED_KEYS = ["OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"] as const;

/**
 * The `semantic` engine's embedder.
 *
 * When a hosted embedding key is set, it is the SAME embedder createVendo would
 * compose for a keyed host (`resolveKnowledgeEmbedder` — real `aiEmbedder` over
 * OpenAI/Google `embedMany`, asymmetric task types, batching, backoff), so the
 * eval measures the exact shipped path. When NO key is set — the offline per-PR
 * environment — it falls back to a deterministic, dependency-free embedding
 * model: L2-normalized bag-of-words + char-trigram vectors (a classic
 * vector-space model). That offline model has NO synonym knowledge, so it
 * cannot rescue a pure-synonym query the way a hosted model does — but it does
 * fix the length-domination that sinks raw term-frequency lexical scoring, and
 * it exercises the full hybrid-RRF pipeline end-to-end. The committed
 * bars/semantic.json are the FLOORS from this offline model; a hosted model
 * only exceeds them (re-ratchet with a real key — the after-numbers the scout
 * report asked for land the moment GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY
 * is present, with zero code changes here).
 */
const OFFLINE_EMBED_DIM = 512;

function hashToken(token: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A bag-of-words + char-trigram vector: whole tokens dominate; trigrams add
    light morphological overlap ("dispute"≈"disputing"). No synonyms. */
function offlineVector(text: string): number[] {
  const vector = new Array<number>(OFFLINE_EMBED_DIM).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length <= 1) continue;
    vector[hashToken(token) % OFFLINE_EMBED_DIM]! += 1;
    for (let i = 0; i + 3 <= token.length; i += 1) {
      vector[hashToken(token.slice(i, i + 3)) % OFFLINE_EMBED_DIM]! += 0.5;
    }
  }
  return vector;
}

function offlineEmbedder(): KnowledgeEmbedder {
  return { model: "offline-bow-v1", embed: async (texts) => texts.map(offlineVector) };
}

/** The embedder for the `semantic` engine: hosted when a key is available,
    offline otherwise. Reads the env at call time so the same registry entry
    serves both the offline per-PR run and a keyed hosted run. */
function semanticEmbedder(): KnowledgeEmbedder {
  const keyed = HOSTED_EMBED_KEYS.some((key) => (process.env[key] ?? "").trim().length > 0);
  if (!keyed) return offlineEmbedder();
  // Force the slot on and let the shipped resolver build the real hosted
  // embedder; if resolution somehow yields nothing, stay reproducible offline.
  return resolveKnowledgeEmbedder({ env: { ...process.env, VENDO_KNOWLEDGE_EMBED: "on" } }) ?? offlineEmbedder();
}

/**
 * The engine registry. An engine joins the matrix with exactly two changes
 * (docs/eval/KNOWLEDGE.md §How an engine joins): a case here plus a
 * calibrated bars/<engine>.json. `memory` and `lexical` are the per-PR
 * offline engines (lexical over an in-memory store, the same wiring as K7's
 * own conformance tests); `semantic` is `lexical` with the knowledgeEmbedder
 * slot filled — hybrid RRF search, offline-embedder by default and hosted when
 * a key is present; `cloud` (lane K3) adds a case when it lands — live engines
 * must read their credentials from env and fail fast without them.
 */
export const KNOWLEDGE_ENGINES: Record<string, () => KnowledgeAdapter> = {
  memory: () => memoryKnowledgeAdapter(),
  lexical: () => lexicalKnowledge({ store: memoryStoreAdapter() }),
  semantic: () => lexicalKnowledge({ store: memoryStoreAdapter(), embedder: semanticEmbedder() }),
};

export function createEngine(name: string): KnowledgeAdapter {
  const factory = KNOWLEDGE_ENGINES[name];
  if (!factory) {
    throw new Error(
      `Unknown knowledge engine "${name}". Known engines: ${Object.keys(KNOWLEDGE_ENGINES).join(", ")}.`,
    );
  }
  return factory();
}

/** The eval's fixture principal. `includeInternal` is never set: the eval
    measures the public-only default posture (internal fixture docs must
    never surface). */
export const EVAL_CONTEXT: KnowledgeContext = {
  principal: { kind: "user", subject: "knowledge-eval" },
};
