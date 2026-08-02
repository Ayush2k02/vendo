import {
  VendoError,
  type KnowledgeAdapter,
  type KnowledgeChunk,
  type KnowledgeContext,
  type KnowledgeDoc,
  type KnowledgeEmbedder,
  type KnowledgeHit,
  type KnowledgeKind,
  type KnowledgeQuery,
  type KnowledgeStatus,
  type RecordStore,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "../collections.js";
import { structuralChunker } from "../ingest/chunker.js";

/** A stored chunk row: the chunk plus doc fields denormalized at upsert time
    (upsert replaces every chunk of a doc, so they can never go stale) —
    search filters visibility and boosts titles without a per-row doc join.

    Knowledge design v2 R3 semantic upgrade: when an embedder is configured the
    row also carries the chunk's L2-normalized embedding (`vector`) and the id
    of the model that produced it (`embModel`). Both are ABSENT on a lexical-only
    row — additive JSON, so no store migration and an old row simply has no
    semantic signal. A vector written under a different `embModel` than the
    engine's current embedder is stale (a different vector space) and is ignored
    at search time until the doc is re-upserted (which re-embeds it), mirroring
    how a bumped chunker version re-chunks on the next upsert. */
interface ChunkRow extends KnowledgeChunk {
  kind: KnowledgeDoc["kind"];
  visibility: KnowledgeDoc["visibility"];
  title: string;
  /** L2-normalized embedding; cosine similarity is then a plain dot product. */
  vector?: number[];
  /** The embedder model id this `vector` was produced under (staleness key). */
  embModel?: string;
}

/** Reciprocal Rank Fusion constant (scout report §5.4; the standard k≈60). RRF
    fuses the lexical and semantic RANKINGS, not their scores, so no cross-signal
    normalization is needed — lexical scores are unbounded term counts and cosine
    is [-1,1], and RRF is indifferent to both scales. */
const RRF_K = 60;

/** A query embedder the engine can use asymmetrically: the frozen
    `KnowledgeEmbedder` only promises `embed`, but the shipped `aiEmbedder` adds
    `embedQuery` (RETRIEVAL_QUERY) which the engine feature-detects. A bare
    embedder (a test double, a symmetric provider) is used through `embed` for
    both documents and the query. */
type MaybeQueryEmbedder = KnowledgeEmbedder & { embedQuery?(texts: string[]): Promise<number[][]> };

const l2normalize = (vector: number[]): number[] => {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector.slice();
  return vector.map((value) => value / norm);
};

/** Dot product of two equal-length vectors (cosine, since both are
    L2-normalized). A length mismatch — a stale vector from another dimension —
    yields no similarity, so the caller drops it from the semantic ranking. */
const dot = (a: number[], b: number[]): number | undefined => {
  if (a.length !== b.length) return undefined;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
};

/** LIST PAGINATION ruling: every corpus scan pages with the keyset cursor
    (page cap 1000); status()-style counts via paginated scan are the
    accepted R1 answer. */
async function listAll(store: RecordStore, refs?: Record<string, string>): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ ...(refs === undefined ? {} : { refs }), limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.records);
    if (page.records.length === 0) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);

const SNIPPET_RADIUS = 100;

function snippetAround(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  const at = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  return text.slice(start, at + SNIPPET_RADIUS * 2).trim();
}

/** Exact-lookup normalization for schema intent: a term matches on its title
    case-insensitively, whitespace-insensitively, or via its slug form. */
const exactKey = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The built-in local lexical engine (free tier — knowledge design v2 R1/R3):
 * keyword retrieval over the host's own store, in the knowledge-owned
 * collections. Honestly keyword-grade — deterministic term-frequency ranking
 * with title/heading boosts, no embeddings, no fuzziness.
 *
 * Intents (LEXICAL INTENTS ruling): `chat` ranks token matches over chunks;
 * `deep` is an honest no-op escalation for a lexical engine (same retrieval —
 * engines behind the wire do real agentic deep search); `schema` is exact
 * term/title lookup over glossary/api docs where empty means not-found.
 * Scores are engine-relative and zero-match queries return zero hits.
 *
 * Zero-config: `knowledge: lexicalKnowledge()` — createVendo injects the
 * composed store (server wiring, ENG-360). Pass `{ store }` to keep the
 * knowledge tables in a different database (BYO rule); until a store is
 * bound, operations fail loudly rather than pretending to be an empty corpus.
 *
 * Optional semantic upgrade (knowledge design v2 R3): pass `{ embedder }` and
 * the engine becomes HYBRID — at upsert it embeds each chunk and stores the
 * L2-normalized vector on the row; at search it embeds the query, computes
 * cosine against those vectors in the same scan the term-frequency scoring
 * already does, and fuses the two rankings with Reciprocal Rank Fusion. With NO
 * embedder the engine is byte-for-byte the lexical engine it has always been —
 * the semantic path is purely additive and gated on the embedder's presence,
 * exactly as the verifier pass is gated on its model slot. `schema` intent
 * (exact title/slug lookup) is untouched either way. The embedder is an
 * optional slot mirroring `knowledgeVerifier`: a keyless host stays lexical
 * (BYO rule), a host with an embedding provider upgrades.
 */
export function lexicalKnowledge(options: { store?: StoreAdapter; embedder?: KnowledgeEmbedder } = {}): KnowledgeAdapter {
  const store = (): StoreAdapter => {
    if (options.store === undefined) {
      throw new VendoError(
        "validation",
        "lexicalKnowledge() has no store bound — pass lexicalKnowledge({ store }) or wire it through createVendo, which injects the composed store",
      );
    }
    return options.store;
  };
  const docRows = (): RecordStore => store().records(KNOWLEDGE_DOCS_COLLECTION);
  const chunkRows = (): RecordStore => store().records(KNOWLEDGE_CHUNKS_COLLECTION);

  const embedder = options.embedder as MaybeQueryEmbedder | undefined;
  /** One log line per distinct cause when embedding fails, like the verifier's
      and agent-tools' warning dedup — a permanently misconfigured embedder must
      not spam the operator, and it must never break lexical retrieval. */
  const embedWarned = new Set<string>();
  const warnEmbed = (context: string, error: unknown): void => {
    const cause = `${context}: ${error instanceof Error ? error.message : String(error)}`;
    if (embedWarned.has(cause)) return;
    embedWarned.add(cause);
    console.warn(`[vendo] knowledge embedder failed — falling back to lexical for this operation: ${cause}`);
  };

  /** The text actually embedded for a chunk: the heading path prepended to the
      body (scout report §5.1's optional tweak) so a chunk under "## International
      wires" carries that context into its vector — a cheap recall win. The
      STORED text and snippet are unchanged. */
  const embedText = (chunk: KnowledgeChunk): string =>
    chunk.heading === undefined || chunk.heading.length === 0 ? chunk.text : `${chunk.heading}\n${chunk.text}`;

  /** The L2-normalized query vector, or undefined when there is no embedder or
      the embed call fails (fail-open: the search falls back to lexical). Uses
      the asymmetric query task type when the embedder exposes `embedQuery`. */
  async function embedQueryVector(text: string): Promise<number[] | undefined> {
    if (embedder === undefined) return undefined;
    try {
      const [vector] = embedder.embedQuery !== undefined
        ? await embedder.embedQuery([text])
        : await embedder.embed([text]);
      return vector === undefined ? undefined : l2normalize(vector);
    } catch (error) {
      warnEmbed("query embed", error);
      return undefined;
    }
  }

  const visible = (visibility: KnowledgeDoc["visibility"], ctx: KnowledgeContext): boolean =>
    visibility === "public" || ctx.includeInternal === true;

  const kindMatches = (kind: KnowledgeKind, kinds: KnowledgeKind[] | undefined): boolean =>
    kinds === undefined || kinds.includes(kind);

  /** schema intent: exact term/title match over glossary+api docs. */
  async function schemaSearch(query: KnowledgeQuery, ctx: KnowledgeContext, limit: number): Promise<KnowledgeHit[]> {
    const key = exactKey(query.text);
    if (key.length === 0) return [];
    const hits: KnowledgeHit[] = [];
    for (const row of await listAll(docRows())) {
      const doc = row.data as KnowledgeDoc;
      if (doc.kind !== "glossary" && doc.kind !== "api") continue;
      if (!kindMatches(doc.kind, query.kinds) || !visible(doc.visibility, ctx)) continue;
      if (exactKey(doc.title) !== key) continue;
      hits.push({
        ref: { docId: doc.id, title: doc.title, source: doc.source },
        snippet: doc.text.slice(0, SNIPPET_RADIUS * 2).trim(),
        kind: doc.kind,
        visibility: doc.visibility,
        score: 1,
      });
    }
    hits.sort((a, b) => (a.ref.docId < b.ref.docId ? -1 : 1));
    return hits.slice(0, limit);
  }

  const adapter: KnowledgeAdapter = {
    posture: { fetch: true, write: true, visibility: "enforced" },

    async search(query, ctx) {
      const limit = query.limit ?? 10;
      if (query.kinds !== undefined && query.kinds.length === 0) return { hits: [] };
      if (query.intent === "schema") return { hits: await schemaSearch(query, ctx, limit) };

      // chat and deep both take this path: deep is a documented no-op
      // escalation for the lexical engine (the wire does real deep search).
      const tokens = tokenize(query.text);
      const tokenSet = new Set(tokens);

      /** The lexical score for one candidate chunk — the exact, unchanged
          term-frequency formula (body count + 3·title + 2·heading). */
      const lexicalScore = (chunk: ChunkRow): number => {
        const counts = new Map<string, number>();
        for (const token of tokenize(chunk.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
        const title = new Set(tokenize(chunk.title));
        const heading = new Set(tokenize(chunk.heading ?? ""));
        let score = 0;
        for (const token of tokenSet) {
          score += counts.get(token) ?? 0;
          if (title.has(token)) score += 3;
          if (heading.has(token)) score += 2;
        }
        return score;
      };

      /** Rank order shared by every path: score desc, then docId, then chunk
          index — deterministic, so `limit` truncates without reordering (R3). */
      const byRank = <T extends { chunk: ChunkRow; sort: number }>(a: T, b: T): number =>
        b.sort - a.sort
        || (a.chunk.docId < b.chunk.docId ? -1 : a.chunk.docId > b.chunk.docId ? 1 : 0)
        || a.chunk.index - b.chunk.index;

      const toHits = (ranked: { chunk: ChunkRow; score: number }[]): KnowledgeHit[] =>
        ranked.slice(0, limit).map(({ chunk, score }) => ({
          ref: { docId: chunk.docId, chunkId: chunk.chunkId, title: chunk.title },
          snippet: snippetAround(chunk.text, tokens),
          kind: chunk.kind,
          visibility: chunk.visibility,
          score,
        }));

      const queryVector = await embedQueryVector(query.text);

      // ── Lexical-only path (no embedder, or the query embed failed): the
      //    engine behaves byte-for-byte as it always has. ──
      if (queryVector === undefined) {
        if (tokens.length === 0) return { hits: [] };
        const scored: { chunk: ChunkRow; score: number; sort: number }[] = [];
        // Visibility and kind filter BEFORE ranking (R5): invisible rows never
        // enter the candidate set, so they cannot influence scores or limits.
        for (const row of await listAll(chunkRows())) {
          const chunk = row.data as ChunkRow;
          if (!visible(chunk.visibility, ctx) || !kindMatches(chunk.kind, query.kinds)) continue;
          const score = lexicalScore(chunk);
          if (score > 0) scored.push({ chunk, score, sort: score });
        }
        scored.sort(byRank);
        return { hits: toHits(scored) };
      }

      // ── Hybrid path: score lexical AND cosine in the SAME scan, then fuse the
      //    two RANKINGS with RRF (no cross-signal score normalization). ──
      const lexical: { chunk: ChunkRow; sort: number }[] = [];
      const semantic: { chunk: ChunkRow; sort: number }[] = [];
      for (const row of await listAll(chunkRows())) {
        const chunk = row.data as ChunkRow;
        if (!visible(chunk.visibility, ctx) || !kindMatches(chunk.kind, query.kinds)) continue;
        const score = lexicalScore(chunk);
        if (score > 0) lexical.push({ chunk, sort: score });
        // Only a same-model vector of matching dimension is in the query's
        // vector space; a stale-model or wrong-width vector is skipped (it is
        // re-embedded on the doc's next upsert). A non-positive cosine is not a
        // semantic MATCH — the chunk is orthogonal to (or points away from) the
        // query, so it never enters the semantic ranking. This is what keeps RRF
        // fusing each retriever's real results rather than letting an unrelated
        // doc double-dip a spurious lexical rank with a zero-similarity vector.
        if (chunk.vector !== undefined && chunk.embModel === embedder!.model) {
          const cosine = dot(queryVector, chunk.vector);
          if (cosine !== undefined && cosine > 0) semantic.push({ chunk, sort: cosine });
        }
      }

      // No usable vectors (nothing embedded yet, or all stale): fall back to the
      // exact lexical ranking rather than relabel identical ranks with RRF.
      if (semantic.length === 0) {
        if (tokens.length === 0) return { hits: [] };
        lexical.sort(byRank);
        return { hits: toHits(lexical.map(({ chunk, sort }) => ({ chunk, score: sort }))) };
      }

      lexical.sort(byRank);
      semantic.sort(byRank);
      // RRF: score = Σ 1/(k + rank_i), 1-based rank, over the two rankings.
      const fused = new Map<string, { chunk: ChunkRow; score: number }>();
      const fuse = (ranked: { chunk: ChunkRow }[]): void => {
        ranked.forEach(({ chunk }, index) => {
          const contribution = 1 / (RRF_K + index + 1);
          const existing = fused.get(chunk.chunkId);
          if (existing === undefined) fused.set(chunk.chunkId, { chunk, score: contribution });
          else existing.score += contribution;
        });
      };
      fuse(lexical);
      fuse(semantic);
      const ranked = [...fused.values()]
        .map((entry) => ({ ...entry, sort: entry.score }))
        .sort(byRank);
      return { hits: toHits(ranked) };
    },

    async fetch(ref, ctx) {
      const row = await docRows().get(ref.docId);
      if (row === null) return null;
      const doc = row.data as KnowledgeDoc;
      // A ref is not a capability: internal docs read as unknown (R5).
      if (!visible(doc.visibility, ctx)) return null;
      if (ref.chunkId !== undefined) {
        const chunkRow = await chunkRows().get(ref.chunkId);
        const chunk = chunkRow?.data as ChunkRow | undefined;
        if (chunk !== undefined && chunk.docId === ref.docId) {
          // Read-more: the cited chunk joined with its structural neighbors.
          const siblings = (await listAll(chunkRows(), { doc_id: ref.docId }))
            .map((sibling) => sibling.data as ChunkRow)
            .sort((a, b) => a.index - b.index);
          const window = siblings.filter((sibling) => Math.abs(sibling.index - chunk.index) <= 1);
          return {
            ref: { docId: doc.id, chunkId: chunk.chunkId, title: doc.title, source: doc.source },
            text: window.map((sibling) => sibling.text).join("\n\n"),
            truncated: window.length < siblings.length,
          };
        }
      }
      return { ref: { docId: doc.id, title: doc.title, source: doc.source }, text: doc.text };
    },

    async upsert(docs) {
      for (const doc of docs) {
        const chunks = structuralChunker.chunk(doc);
        const keep = new Set(chunks.map((chunk) => chunk.chunkId));
        // When an embedder is configured, embed every chunk of this doc up
        // front (RETRIEVAL_DOCUMENT), so re-upsert always re-embeds — the same
        // shape as re-chunking on a chunker-version bump. A provider failure is
        // fail-open: the doc still lands (lexical-searchable), just without
        // vectors, so an embedding outage never breaks ingestion. `vectors`
        // stays undefined ⇒ rows carry no `vector`/`embModel`, exactly the
        // lexical-only row.
        let vectors: number[][] | undefined;
        if (embedder !== undefined && chunks.length > 0) {
          try {
            const raw = await embedder.embed(chunks.map(embedText));
            vectors = raw.map(l2normalize);
          } catch (error) {
            warnEmbed(`upsert ${doc.id}`, error);
          }
        }
        // Replace chunk rows: stale rows go first so a re-chunked doc never
        // leaves orphans, then the new rows land, then the doc row — by the
        // time upsert resolves the doc is searchable (frozen invariant).
        for (const stale of await listAll(chunkRows(), { doc_id: doc.id })) {
          if (!keep.has(stale.id)) await chunkRows().delete(stale.id);
        }
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]!;
          const vector = vectors?.[index];
          const data: ChunkRow = {
            ...chunk,
            kind: doc.kind,
            visibility: doc.visibility,
            title: doc.title,
            // Stamp the vector AND the model id together: the id is the
            // staleness key search checks, so a vector never outlives a
            // knowledge of which space it lives in.
            ...(vector === undefined ? {} : { vector, embModel: embedder!.model }),
          };
          // REFS ruling: chunks ref their doc; knowledge is host-level, so
          // rows deliberately carry no subject_id (subject-erase skips them).
          await chunkRows().put({ id: chunk.chunkId, data: { ...data }, refs: { doc_id: doc.id } });
        }
        await docRows().put({ id: doc.id, data: { ...doc }, refs: { source: doc.source } });
      }
    },

    async remove(docIds) {
      for (const docId of docIds) {
        for (const chunk of await listAll(chunkRows(), { doc_id: docId })) {
          await chunkRows().delete(chunk.id);
        }
        await docRows().delete(docId);
      }
    },

    async status(): Promise<KnowledgeStatus> {
      const byKind: Partial<Record<KnowledgeKind, number>> = {};
      let docs = 0;
      for (const row of await listAll(docRows())) {
        const doc = row.data as KnowledgeDoc;
        docs += 1;
        byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
      }
      return { docs, byKind };
    },
  };

  if (options.store === undefined) storeless.set(adapter, { embedder: options.embedder });
  return adapter;
}

/** Engines built with no store of their own — the zero-config
    `lexicalKnowledge()` form. A WeakMap (not a Set) so the rebind below can
    carry the store-less engine's own options (an embedder the host passed) onto
    the store-bound instance; what the host holds stays exactly a
    `KnowledgeAdapter`. */
const storeless = new WeakMap<KnowledgeAdapter, { embedder?: KnowledgeEmbedder }>();

/** The composition seam's half of zero-config local knowledge (server.ts
    `selectKnowledge`): hand a store-less `lexicalKnowledge()` the store
    createVendo composed, plus the embedder composition resolved for the
    knowledgeEmbedder slot (undefined ⇒ lexical-only, today's behavior).
    Everything else — an engine the host gave its own store, a cloud/BYO/custom
    adapter — passes through untouched, so this can sit unconditionally on the
    explicit-adapter rung. Hosts never call it; it is how `knowledge:
    lexicalKnowledge()` gets the store (and any composed embedder) the docs
    promise without any host plumbing. An embedder the host passed to a
    store-less `lexicalKnowledge({ embedder })` wins over the composed one. */
export function bindKnowledgeStore(
  adapter: KnowledgeAdapter,
  store: StoreAdapter,
  embedder?: KnowledgeEmbedder,
): KnowledgeAdapter {
  const own = storeless.get(adapter);
  if (own === undefined) return adapter;
  const resolved = own.embedder ?? embedder;
  return lexicalKnowledge({ store, ...(resolved === undefined ? {} : { embedder: resolved }) });
}
