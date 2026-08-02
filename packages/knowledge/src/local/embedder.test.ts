import { MockEmbeddingModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { aiEmbedder, DOCUMENT_TASK_TYPE, EMBEDDING_DIMENSIONS, QUERY_TASK_TYPE } from "./embedder.js";

/** A deterministic embedding model: each value → a fixed-width vector derived
    from its length and first char, so identical inputs embed identically and
    the batching/ordering can be asserted. Records the provider options and the
    batch sizes it was called with. */
function scriptedModel(width = 4): MockEmbeddingModelV3<string> & {
  batches: number[];
  providerOptionsSeen: unknown[];
} {
  const batches: number[] = [];
  const providerOptionsSeen: unknown[] = [];
  const model = new MockEmbeddingModelV3<string>({
    modelId: "mock-embed-v1",
    maxEmbeddingsPerCall: 10_000, // never split inside a single embedMany call
    doEmbed: async ({ values, providerOptions }) => {
      batches.push(values.length);
      providerOptionsSeen.push(providerOptions);
      return {
        embeddings: values.map((value) => {
          const seed = value.length + (value.codePointAt(0) ?? 0);
          return Array.from({ length: width }, (_unused, i) => (seed + i) / 100);
        }),
        usage: { tokens: 0 }, warnings: [],
      };
    },
  }) as MockEmbeddingModelV3<string> & { batches: number[]; providerOptionsSeen: unknown[] };
  Object.defineProperty(model, "batches", { get: () => batches });
  Object.defineProperty(model, "providerOptionsSeen", { get: () => providerOptionsSeen });
  return model;
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("aiEmbedder", () => {
  it("carries the model id and pinned dimensions", () => {
    const embedder = aiEmbedder({ model: scriptedModel(), sleep: noSleep });
    expect(embedder.model).toBe("mock-embed-v1");
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    const pinned = aiEmbedder({ model: scriptedModel(), modelId: "pinned", dimensions: 256, sleep: noSleep });
    expect(pinned.model).toBe("pinned");
    expect(pinned.dimensions).toBe(256);
  });

  it("embeds every text, in order, across conservative batches", async () => {
    const model = scriptedModel();
    const embedder = aiEmbedder({ model, batchSize: 3, sleep: noSleep });
    const texts = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    const vectors = await embedder.embed(texts);
    expect(vectors).toHaveLength(texts.length);
    // 7 texts / batch 3 → batches of 3, 3, 1.
    expect(model.batches).toEqual([3, 3, 1]);
    // Order preserved: re-embedding one text alone matches its slot in the run.
    const [solo] = await aiEmbedder({ model: scriptedModel(), sleep: noSleep }).embed(["charlie"]);
    expect(vectors[2]).toEqual(solo);
  });

  it("passes ASYMMETRIC task types when a provider namespace is set", async () => {
    const model = scriptedModel();
    const embedder = aiEmbedder({
      model,
      providerId: "google",
      documentTaskType: DOCUMENT_TASK_TYPE,
      queryTaskType: QUERY_TASK_TYPE,
      dimensions: 768,
      sleep: noSleep,
    });
    await embedder.embed(["a document chunk"]);
    await embedder.embedQuery(["a user question"]);
    expect(model.providerOptionsSeen[0]).toEqual({ google: { taskType: DOCUMENT_TASK_TYPE, outputDimensionality: 768 } });
    expect(model.providerOptionsSeen[1]).toEqual({ google: { taskType: QUERY_TASK_TYPE, outputDimensionality: 768 } });
  });

  it("sends NO provider options when no provider namespace is set (OpenAI-style symmetric)", async () => {
    const model = scriptedModel();
    const embedder = aiEmbedder({ model, sleep: noSleep });
    await embedder.embed(["x"]);
    await embedder.embedQuery(["y"]);
    expect(model.providerOptionsSeen).toEqual([undefined, undefined]);
  });

  it("retries a batch on a transient 429/5xx with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
    let calls = 0;
    const model = new MockEmbeddingModelV3<string>({
      modelId: "flaky",
      maxEmbeddingsPerCall: 10_000,
      doEmbed: async ({ values }) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
        if (calls === 2) throw Object.assign(new Error("upstream"), { statusCode: 503 });
        return { embeddings: values.map(() => [0.1, 0.2]), usage: { tokens: 0 }, warnings: [] };
      },
    });
    const embedder = aiEmbedder({ model, maxRetries: 4, sleep });
    const vectors = await embedder.embed(["only"]);
    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(calls).toBe(3);
    // Two backoff waits, each strictly increasing (exponential).
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("does NOT retry a permanent 4xx (bad key / bad model) — it propagates at once", async () => {
    let calls = 0;
    const model = new MockEmbeddingModelV3<string>({
      modelId: "bad",
      maxEmbeddingsPerCall: 10_000,
      doEmbed: async () => {
        calls += 1;
        throw Object.assign(new Error("invalid api key"), { statusCode: 401 });
      },
    });
    const embedder = aiEmbedder({ model, maxRetries: 4, sleep: noSleep });
    await expect(embedder.embed(["x"])).rejects.toThrow(/invalid api key/);
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries transient failures and throws", async () => {
    const model = new MockEmbeddingModelV3<string>({
      modelId: "always-429",
      maxEmbeddingsPerCall: 10_000,
      doEmbed: async () => { throw Object.assign(new Error("429"), { statusCode: 429 }); },
    });
    const embedder = aiEmbedder({ model, maxRetries: 2, sleep: noSleep });
    await expect(embedder.embed(["x"])).rejects.toThrow(/429/);
  });

  it("pauses between batches (rate-limit spacing), not before the first", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
    const embedder = aiEmbedder({ model: scriptedModel(), batchSize: 1, batchDelayMs: 250, sleep });
    await embedder.embed(["a", "b", "c"]);
    // 3 batches → 2 inter-batch pauses, no leading pause.
    expect(sleeps).toEqual([250, 250]);
  });

  it("returns nothing for an empty input without touching the model", async () => {
    const model = scriptedModel();
    expect(await aiEmbedder({ model, sleep: noSleep }).embed([])).toEqual([]);
    expect(model.batches).toEqual([]);
  });
});
