import { describe, expect, it } from "vitest";
import type { KnowledgeContext, KnowledgeDoc, KnowledgeEmbedder } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { lexicalKnowledge } from "./lexical.js";

/**
 * Hybrid (RRF) search over the local engine, and the report's B1 failure case.
 *
 * The embedder here is a deterministic CONCEPT embedder — a test double in the
 * spirit of verifier.test.ts's scripted model. It maps each token to a small
 * set of concept dimensions (login/credentials/password all land on the same
 * "auth" axis), so it simulates exactly what a real hosted model gives the
 * engine: synonym-aware vectors. It is NOT a quality claim about any provider;
 * it isolates and proves the engine's fusion logic — GIVEN an embedder that
 * knows login≈password, does hybrid RRF surface the right doc where lexical
 * returns a confidently wrong one? The real recall@5/MRR quality of a hosted
 * model is measured separately by the eval harness (docs/eval/knowledge).
 */

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "semantic-test" } };

/** token → concept axes. Synonyms share an axis; that is the whole point. */
const CONCEPTS: Record<string, string[]> = {
  // auth / sign-in
  login: ["auth"], credentials: ["auth"], password: ["auth"], passwords: ["auth"],
  signin: ["auth"], "sign": ["auth"], forgotten: ["auth"], secure: ["auth"],
  reset: ["auth"], change: ["auth"],
  // card disputes
  dispute: ["dispute"], contest: ["dispute"], charge: ["dispute"], chargeback: ["dispute"],
  unrecognized: ["dispute"], card: ["dispute"], transaction: ["dispute"], regret: ["dispute"],
  // international wires
  wire: ["wire"], wires: ["wire"], overseas: ["wire"], international: ["wire"],
  send: ["wire"], swift: ["wire"], transfer: ["wire"], abroad: ["wire"],
  // mobile deposit
  deposit: ["deposit"], cheque: ["deposit"], check: ["deposit"], photograph: ["deposit"],
  snap: ["deposit"], picture: ["deposit"], mobile: ["deposit"],
  // closing an account
  close: ["close"], cancel: ["close"], closing: ["close"], delete: ["close"],
};

const AXES = ["auth", "dispute", "wire", "deposit", "close"];

/** A concept embedder with a settable model id (for the re-embed-on-change
    test). Vector = summed one-hot over the concept axes each token touches. */
function conceptEmbedder(model = "concept-v1"): KnowledgeEmbedder {
  return {
    model,
    async embed(texts) {
      return texts.map((text) => {
        const vector = AXES.map(() => 0);
        for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
          for (const axis of CONCEPTS[token] ?? []) vector[AXES.indexOf(axis)]! += 1;
        }
        return vector;
      });
    },
  };
}

const doc = (overrides: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "id" | "title" | "text">): KnowledgeDoc => ({
  kind: "docs",
  visibility: "public",
  source: `${overrides.id}.md`,
  ...overrides,
});

/** The Maple-style corpus from scout report §4.2, including the password doc
    that shares ZERO content tokens with a "login credentials" query. */
const CORPUS: KnowledgeDoc[] = [
  doc({
    id: "docs-password-reset",
    title: "Resetting your password",
    text: "# Resetting your password\nForgotten your password? On the sign in screen choose the reset option to change it, and we email you a secure link to pick a new one.",
  }),
  doc({
    id: "docs-card-disputes",
    title: "Disputing a card charge",
    text: "# Disputing a card charge\nContest a charge you do not recognize on your card. Purchases you simply regret do not qualify for a chargeback.",
  }),
  doc({
    id: "docs-wire-transfers",
    title: "International wires",
    text: "# International wires\nRoute an international wire abroad up to the daily cap. It travels over SWIFT to the beneficiary bank.",
  }),
  doc({
    id: "docs-mobile-deposit",
    title: "Mobile cheque deposit",
    text: "# Mobile cheque deposit\nPhotograph a cheque to deposit it from your phone. Snap the front and back to pay it in.",
  }),
  doc({
    id: "docs-close-account",
    title: "Closing your account",
    text: "# Closing your account\nCancel your account and close it for good. Move any remaining balance out before you delete it.",
  }),
];

async function engine(embedder?: KnowledgeEmbedder) {
  const store = memoryStoreAdapter();
  const adapter = lexicalKnowledge(embedder === undefined ? { store } : { store, embedder });
  await adapter.upsert!(CORPUS);
  return adapter;
}

const rank = (hits: { ref: { docId: string } }[], docId: string): number =>
  hits.findIndex((hit) => hit.ref.docId === docId);

describe("hybrid semantic search — the B1 failure case", () => {
  const B1 = "how do I change my login credentials";

  it("LEXICAL baseline reproduces B1: raw term-frequency ranks the WRONG doc first", async () => {
    const lexical = await engine();
    const hits = (await lexical.search({ text: B1 }, ctx)).hits;
    // The report's failure: the card-dispute doc leads on the incidental
    // stopword "do" (counted twice by raw TF), ahead of the password doc — so
    // the tool answers "answered" over a card-dispute snippet. Whether the
    // password doc trails or is absent, the confidently-wrong doc is #1.
    expect(hits[0]?.ref.docId).toBe("docs-card-disputes");
    expect(rank(hits, "docs-password-reset")).not.toBe(0);
  });

  it("HYBRID fixes B1: the password doc surfaces at rank 1, ahead of the lexical red herring", async () => {
    const hybrid = await engine(conceptEmbedder());
    const hits = (await hybrid.search({ text: B1 }, ctx)).hits;
    expect(hits[0]?.ref.docId).toBe("docs-password-reset");
    // The confidently-wrong card-dispute doc no longer leads the answer.
    expect(rank(hits, "docs-password-reset")).toBeLessThan(rank(hits, "docs-card-disputes"));
  });

  it("does NOT discard the lexical signal — an exact-keyword query still wins lexically", async () => {
    const hybrid = await engine(conceptEmbedder());
    // "SWIFT international wire" is a strong lexical AND semantic match for the
    // wire doc; fusing must keep it on top, never bury it under a synonym rescue.
    const hits = (await hybrid.search({ text: "international wire over SWIFT" }, ctx)).hits;
    expect(hits[0]?.ref.docId).toBe("docs-wire-transfers");
  });

  it("rescues a pure-synonym query with ZERO lexical overlap (report B3: overseas → international)", async () => {
    const lexical = await engine();
    const hybrid = await engine(conceptEmbedder());
    const q = "how much money can I send overseas";
    // Lexical misses the wire doc (no shared "overseas"/"send" tokens there).
    expect(rank((await lexical.search({ text: q }, ctx)).hits, "docs-wire-transfers")).toBe(-1);
    // Semantic maps overseas/send → the wire axis and recovers it.
    expect(rank((await hybrid.search({ text: q }, ctx)).hits, "docs-wire-transfers")).toBeGreaterThanOrEqual(0);
  });
});

describe("hybrid semantic search — mechanics", () => {
  it("with an embedder configured, chunk rows carry a normalized vector + model id", async () => {
    const store = memoryStoreAdapter();
    const adapter = lexicalKnowledge({ store, embedder: conceptEmbedder() });
    await adapter.upsert!([CORPUS[0]!]);
    const rows = (await store.records("vendo_knowledge_chunks").list({ limit: 100 })).records;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const data = row.data as { vector?: number[]; embModel?: string };
      expect(data.embModel).toBe("concept-v1");
      expect(Array.isArray(data.vector)).toBe(true);
      // L2-normalized: unit length (the password chunk touches the auth axis).
      const norm = Math.sqrt(data.vector!.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  it("re-embeds on a model-id change: a stale-model vector is ignored until re-upsert", async () => {
    const store = memoryStoreAdapter();
    // Seed under the OLD model.
    const old = lexicalKnowledge({ store, embedder: conceptEmbedder("concept-v1") });
    await old.upsert!(CORPUS);
    // A NEW engine with a DIFFERENT model id: the stored vectors are stale (a
    // different vector space), so search must fall back to lexical for them —
    // the B1 synonym rescue is gone until a re-upsert re-embeds.
    const bumped = lexicalKnowledge({ store, embedder: conceptEmbedder("concept-v2") });
    const staleHits = (await bumped.search({ text: "how do I change my login credentials" }, ctx)).hits;
    // No usable (same-model) vectors → the semantic rescue is gone and search is
    // pure lexical again: the wrong doc leads, exactly as the lexical baseline.
    expect(staleHits[0]?.ref.docId).toBe("docs-card-disputes");
    expect(rank(staleHits, "docs-password-reset")).not.toBe(0);
    // Re-upsert under the new model re-embeds; the rescue returns.
    await bumped.upsert!(CORPUS);
    const freshHits = (await bumped.search({ text: "how do I change my login credentials" }, ctx)).hits;
    expect(freshHits[0]?.ref.docId).toBe("docs-password-reset");
  });

  it("falls open to lexical when the embedder throws at search time", async () => {
    const store = memoryStoreAdapter();
    const throwing: KnowledgeEmbedder = {
      model: "boom",
      async embed(texts) {
        // Succeeds at upsert (so vectors exist) but we simulate a query-time
        // outage by throwing only for the single-item query embed.
        if (texts.length === 1) throw Object.assign(new Error("provider down"), { statusCode: 503 });
        return texts.map(() => AXES.map(() => 0));
      },
    };
    const adapter = lexicalKnowledge({ store, embedder: throwing });
    await adapter.upsert!(CORPUS);
    // Query embed throws → lexical-only result, no crash.
    const hits = (await adapter.search({ text: "dispute a card charge" }, ctx)).hits;
    expect(hits[0]?.ref.docId).toBe("docs-card-disputes");
  });

  it("schema intent is untouched by the embedder (exact lookup, no fusion)", async () => {
    const store = memoryStoreAdapter();
    const adapter = lexicalKnowledge({ store, embedder: conceptEmbedder() });
    await adapter.upsert!([
      doc({ id: "glossary-apy", title: "APY", kind: "glossary", text: "Annual percentage yield on savings." }),
    ]);
    const exact = await adapter.search({ text: "APY", intent: "schema" }, ctx);
    expect(exact.hits).toHaveLength(1);
    expect(exact.hits[0]!.ref.docId).toBe("glossary-apy");
    // A synonym never fuzzes into a schema lookup even with semantics on.
    expect((await adapter.search({ text: "annual yield", intent: "schema" }, ctx)).hits).toEqual([]);
  });
});
