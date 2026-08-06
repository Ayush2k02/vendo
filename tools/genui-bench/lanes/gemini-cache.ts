/**
 * Gemini context caching for the openui lane's static system prefix (captain
 * follow-up). The openui system prompt is dominated by the vendo-kit component
 * schemas + grounding contract — identical on every call for a given
 * (host, edit-mode) pair — so re-billing its ~7-10k input tokens on each of
 * the bench's ~100 model calls is pure waste.
 *
 * This stores each distinct system string as an explicit Gemini
 * `CachedContent` (its `systemInstruction`), memoized in-process by content
 * hash, and hands the lane the cache resource name. The lane then sends the
 * request with NO `system` and `providerOptions.google.cachedContent` set —
 * semantically identical input (the cache SUPPLIES the system instruction),
 * so the generated program is unchanged; only the billing differs
 * (`cachedContentTokenCount` is served at a discount, reported separately).
 *
 * Bench-scoped: nothing here touches vendo product code, and it is a pure
 * cost optimization. Any failure (unsupported model, below the cache minimum,
 * network) returns null and the lane falls back to sending the system inline
 * — correctness never depends on the cache existing.
 */
import { createHash } from "node:crypto";

/** Env kill-switch for the caching sanity check: `GENUI_BENCH_NO_CACHE=1`
 *  sends the system inline so a cached run can be diffed against an uncached
 *  one and proven output-identical. */
export const CACHING_DISABLED = (): boolean => process.env.GENUI_BENCH_NO_CACHE === "1";

/** How long a cache lives — comfortably longer than one full bench sweep, so a
 *  name minted at the start is still valid at the last record. */
const TTL_SECONDS = 3600;

/** Gemini's explicit cache has a minimum billable size; a system below it is
 *  not worth a cache round-trip (and the API rejects it). ~1k tokens ≈ 4k
 *  chars is the documented floor for flash; stay above it. */
const MIN_SYSTEM_CHARS = 4096;

const BASE = "https://generativelanguage.googleapis.com/v1beta/cachedContents";

interface CacheEntry {
  /** Resolved cache resource name (`cachedContents/…`), or null when caching
   *  is unavailable for this system — memoized either way so a failed create
   *  is not retried on every call. */
  name: string | null;
}

/** In-process memo: content hash → the create promise. One create per distinct
 *  (model, system), reused for every call that shares it. */
const cache = new Map<string, Promise<CacheEntry>>();

const keyFor = (modelId: string, system: string): string =>
  createHash("sha256").update(modelId).update("\0").update(system).digest("hex");

async function createCachedContent(modelId: string, system: string): Promise<CacheEntry> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey === "") return { name: null };
  try {
    const response = await fetch(`${BASE}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${modelId}`,
        systemInstruction: { parts: [{ text: system }] },
        ttl: `${TTL_SECONDS}s`,
      }),
    });
    if (!response.ok) return { name: null };
    const body = (await response.json()) as { name?: unknown };
    return { name: typeof body.name === "string" && body.name !== "" ? body.name : null };
  } catch {
    return { name: null };
  }
}

/**
 * The cache resource name for this system prompt, creating it once and reusing
 * it thereafter. Returns null when caching is disabled, the system is too
 * small to cache, or creation failed — the caller then sends the system inline.
 */
export function cachedSystemName(modelId: string, system: string): Promise<string | null> {
  if (CACHING_DISABLED() || system.length < MIN_SYSTEM_CHARS) return Promise.resolve(null);
  const key = keyFor(modelId, system);
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = createCachedContent(modelId, system);
    cache.set(key, pending);
  }
  return pending.then((entry) => entry.name);
}
