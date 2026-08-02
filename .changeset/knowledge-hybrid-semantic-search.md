---
"@vendoai/knowledge": minor
---

Local hybrid semantic search behind the frozen `KnowledgeEmbedder` seam. The
built-in local engine stays byte-for-byte lexical by default; fill the optional
`models.knowledgeEmbedder` slot (or set `VENDO_KNOWLEDGE_EMBED=on` on a keyed
host) and it embeds each chunk at upsert (an L2-normalized `vector` plus the
embedding model id on the existing `vendo_knowledge_chunks` row — no new table,
dependency, or infra), embeds the query at search, and fuses the semantic
ranking with the existing keyword ranking via Reciprocal Rank Fusion (k=60).

- OFF by default and additive: no embedder ⇒ the free tier is the keyword engine
  it has always been. Key presence alone never enables it — enablement is
  explicit config/toggle only.
- Embeddings resolve to OpenAI/Google `textEmbeddingModel` only (the Cloud
  gateway serves chat, not embeddings, so `VENDO_API_KEY` does not unlock it);
  enabled-but-no-key fails open to lexical. `schema` intent (exact title/slug
  lookup) is untouched — only `chat`/`deep` fuses in semantics. A chunk stamped
  with a different embedding model is treated as stale and skipped until its
  doc's next upsert re-embeds it.

New root exports from `@vendoai/knowledge`: `aiEmbedder`, `DOCUMENT_TASK_TYPE`,
`QUERY_TASK_TYPE`, `EMBEDDING_DIMENSIONS`, and the `AiEmbedderOptions` /
`HybridEmbedder` types. `@vendoai/vendo/server` adds `resolveKnowledgeEmbedder`
(+ `ResolveKnowledgeEmbedderOptions`) and the `models.knowledgeEmbedder` config
slot. See `docs/knowledge.md` (Local hybrid semantic) for the full contract.
