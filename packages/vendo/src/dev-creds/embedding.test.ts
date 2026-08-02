import { MockEmbeddingModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { resolveKnowledgeEmbedder } from "./embedding.js";

/** A fake @ai-sdk provider module: records how it was constructed and what task
    types its embedding model was called with, so the resolver's ladder and the
    asymmetric-task-type wiring can be asserted without a real key. */
function fakeProvider(factory: string) {
  const seen: { apiKey?: string; modelId?: string; providerOptions: unknown[] } = { providerOptions: [] };
  const mod = {
    [factory]: (config: { apiKey: string }) => {
      seen.apiKey = config.apiKey;
      return {
        textEmbeddingModel: (modelId: string) => {
          seen.modelId = modelId;
          return new MockEmbeddingModelV3<string>({
            modelId,
            maxEmbeddingsPerCall: 10_000,
            doEmbed: async ({ values, providerOptions }) => {
              seen.providerOptions.push(providerOptions);
              return { embeddings: values.map(() => [0.1, 0.2, 0.3]), usage: { tokens: 0 }, warnings: [] };
            },
          });
        },
      };
    },
  } as Record<string, unknown>;
  return { seen, importModule: async () => mod };
}

describe("resolveKnowledgeEmbedder — the optional slot", () => {
  it("is OFF by default: no config, no toggle ⇒ no embedder (byte-identical lexical)", () => {
    expect(resolveKnowledgeEmbedder({ env: {} })).toBeUndefined();
    // A key ALONE never enables it — the demo's voice OPENAI_API_KEY must not
    // silently flip knowledge to semantic.
    expect(resolveKnowledgeEmbedder({ env: { OPENAI_API_KEY: "sk-voice" } })).toBeUndefined();
  });

  it("VENDO_KNOWLEDGE_EMBED=on with an OpenAI key resolves an openai embedder", async () => {
    const { seen, importModule } = fakeProvider("createOpenAI");
    const embedder = resolveKnowledgeEmbedder({
      env: { VENDO_KNOWLEDGE_EMBED: "on", OPENAI_API_KEY: "sk-abc" },
      importModule,
    });
    expect(embedder?.model).toBe("text-embedding-3-small");
    const [vector] = await embedder!.embed(["a chunk"]);
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(seen.apiKey).toBe("sk-abc");
    expect(seen.modelId).toBe("text-embedding-3-small");
    // OpenAI: dimensions requested, no task type.
    expect(seen.providerOptions[0]).toEqual({ openai: { dimensions: 768 } });
  });

  it("a Google key resolves gemini with ASYMMETRIC task types (document vs query)", async () => {
    const { seen, importModule } = fakeProvider("createGoogleGenerativeAI");
    const embedder = resolveKnowledgeEmbedder({
      env: { VENDO_KNOWLEDGE_EMBED: "on", GOOGLE_GENERATIVE_AI_API_KEY: "g-key" },
      importModule,
    }) as { model: string; embed(t: string[]): Promise<number[][]>; embedQuery(t: string[]): Promise<number[][]> };
    expect(embedder.model).toBe("gemini-embedding-001");
    await embedder.embed(["doc"]);
    await embedder.embedQuery(["question"]);
    expect(seen.providerOptions[0]).toEqual({ google: { outputDimensionality: 768, taskType: "RETRIEVAL_DOCUMENT" } });
    expect(seen.providerOptions[1]).toEqual({ google: { outputDimensionality: 768, taskType: "RETRIEVAL_QUERY" } });
  });

  it("GEMINI_API_KEY is accepted as a Google alias", async () => {
    const { seen, importModule } = fakeProvider("createGoogleGenerativeAI");
    const embedder = resolveKnowledgeEmbedder({
      env: { VENDO_KNOWLEDGE_EMBED: "on", GEMINI_API_KEY: "gem" },
      importModule,
    });
    await embedder!.embed(["x"]);
    expect(seen.apiKey).toBe("gem");
  });

  it("models.knowledgeEmbedder (a string) enables the slot and pins the model id", async () => {
    const { seen, importModule } = fakeProvider("createOpenAI");
    const embedder = resolveKnowledgeEmbedder({
      models: { knowledgeEmbedder: "text-embedding-3-large" },
      env: { OPENAI_API_KEY: "sk-x" }, // no toggle needed — config is the opt-in
      importModule,
    });
    expect(embedder?.model).toBe("text-embedding-3-large");
    await embedder!.embed(["x"]);
    expect(seen.modelId).toBe("text-embedding-3-large");
  });

  it("VENDO_MODEL_KNOWLEDGE_EMBEDDER pins the model id above the provider default", async () => {
    const { seen, importModule } = fakeProvider("createOpenAI");
    const embedder = resolveKnowledgeEmbedder({
      env: { VENDO_KNOWLEDGE_EMBED: "on", OPENAI_API_KEY: "sk-x", VENDO_MODEL_KNOWLEDGE_EMBEDDER: "pinned-embed" },
      importModule,
    });
    expect(embedder?.model).toBe("pinned-embed");
    await embedder!.embed(["x"]);
    expect(seen.modelId).toBe("pinned-embed");
  });

  it("an explicit EmbeddingModel object wins as-is (BYO), without touching the ladder", async () => {
    const explicit = new MockEmbeddingModelV3<string>({
      modelId: "byo-embed",
      maxEmbeddingsPerCall: 10_000,
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0]), usage: { tokens: 0 }, warnings: [] }),
    });
    const embedder = resolveKnowledgeEmbedder({ models: { knowledgeEmbedder: explicit }, env: {} });
    expect(embedder?.model).toBe("byo-embed");
    expect(await embedder!.embed(["x"])).toEqual([[1, 0]]);
  });

  it("enabled but NO embedding-capable key ⇒ fails open to lexical, warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // VENDO_API_KEY (Cloud) serves chat, not embeddings — it must NOT satisfy.
      expect(resolveKnowledgeEmbedder({ env: { VENDO_KNOWLEDGE_EMBED: "on", VENDO_API_KEY: "vendo-cloud" } })).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("no embedding provider key");
    } finally {
      warn.mockRestore();
    }
  });

  it("a typo'd toggle is loud, never a silent off", () => {
    expect(() => resolveKnowledgeEmbedder({ env: { VENDO_KNOWLEDGE_EMBED: "yes" } })).toThrow(/must be on or off/);
  });

  it("rejects a blank models.knowledgeEmbedder string", () => {
    expect(() => resolveKnowledgeEmbedder({ models: { knowledgeEmbedder: "  " }, env: {} })).toThrow(/non-blank/);
  });
});
