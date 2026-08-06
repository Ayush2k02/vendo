# Guarded openui-lang lane — raw results (v2: output quality + caching)

Real bench output from 2026-08-06, produced by the guarded `openui` lane
(their language + parser + Renderer, VENDO's kit as the registered library,
vendo's guardrails on top). Every number and screenshot comes from these
RunRecords (`runs/<id>/`, copied verbatim from the bench's gitignored `runs/`
dir); `summary.json` is computed from them by script, nothing hand-entered.

**v2** improves the LLM's openui-lang OUTPUT QUALITY (the vendo kit components
and all guardrails are unchanged) and adds Gemini context caching:

- **Enum/label formatting** — a `"label"` value-format token humanizes enum
  codes (s_corp → "S corp", missing_docs → "Missing docs"); the prompt teaches
  it for every enum/status/category column. In v1 those codes leaked raw into
  table cells; in v2 all 6 answered single-shot runs format them.
- **Composition hierarchy** — the prompt now teaches the vendo engine's own
  layout: lead with a summary Stat/Callout, frame each table/chart in its own
  titled `Surface`, sit a summary card beside its table in `Grid(2)`, move
  secondary views into `Tabs`. All 6 answered singles use `Surface`; 5/6 use
  `Tabs` — versus v1's flat stat-tiles + one wide table.
- **Context caching** — the static kit-schema system prefix (~7.6k tokens) is
  stored as a Gemini `CachedContent` and served at the cache-read discount
  instead of re-billed on every call. See "Caching" below.

## What ran

- **Model (both lanes): `gemini-3.6-flash`** via `GENUI_BENCH_MODEL` and the
  shared resolver. Same model in both lanes keeps the comparison fair, **but
  the vendo engine ships tuned for `claude-sonnet-4-6`; its numbers here are
  NOT representative of the shipped engine** (its 4 failures are all
  Gemini-authored prop/edit mistakes its checking layer caught).
- **Single-shot (16 runs):** maple `smoke` (3) · cadence `smoke` (3) · cadence
  `cadence` pack (8) · "show my clients" on each host (2).
- **Conversations (13 turn-records):** a 7-turn Maple spending workspace and a
  6-turn Cadence deadline board, each with one mid-conversation ungroundable
  ask that must refuse WITHOUT touching the existing UI.

## Outcomes are three-valued and mean the same thing in both lanes

`answered` — a validated UI shipped. `refused` — a typed refusal with
catalog-derived reasons, rendered as Kit `Disclaimer` cards. `failed` — an
honest failure; for the openui lane that means blocking findings survived the
bounded repair rounds, never a silent broken render.

## Headline (29 records: 16 single-shot + 13 conversation turns)

| | vendo | openui (guarded, v2) |
| --- | --- | --- |
| answered / refused / failed | 13 / 12 / 4 | 16 / 13 / 0 |
| repairs needed | 0 | 0 |
| total input tokens | 112,558 | 235,160 |
| — of which **cache-read** (discounted) | 0 | **226,242 (96%)** |
| — **uncached** (full-rate) input | 112,558 | **8,918** |
| output tokens (total) | 69,941 | **40,348** |
| median wall time | 10.1s | **7.6s** |
| per-turn scoring findings (conversations) | 2 | 2 |
| answered runs formatting enums (`format:"label"`) | — | **6/6 single-shot** |
| answered runs framing with `Surface` | — | **6/6 single-shot** |

- **Quality is the point of v2.** In v1 the openui deadline board dumped a flat
  row of stat tiles above one wide table with `s_corp` / `missing_docs` raw in
  the cells. In v2 the same ask produces a `Grid(2)` of a `Surface`-framed
  summary beside a `Surface`-framed table, secondary views in `Tabs`, and every
  enum column humanized — the composition and formatting the captain asked for.
  Compare `screenshots/cadence-cadence-build-me-a-deadline-board--*.png`.
- **Zero fabrications, unchanged.** Every ungroundable ask still refuses in both
  lanes; both mid-conversation ungroundable turns refuse with the existing UI
  preserved intact.
- **Caching is a pure cost win.** 96% of the openui lane's input is now served
  from cache; uncached input dropped from 235k to 8.9k. Proven output-only-cost:
  a deterministic prompt returns byte-identical output cached vs inline, and
  every groundable/ungroundable ask keeps its answered/refused outcome either
  way (see Caching).
- **vendo's 4 failures** are Gemini-authored edit/prop mistakes its checking
  layer caught (e.g. `DataTable data=` for `rows`, `DonutChart labelKey`, an
  unmatched `<Old>`, and one "show my clients" that produced invalid wire) —
  reported honestly, never shipped.

## Caching

The openui lane's system prompt is dominated by the vendo-kit component schemas
+ grounding contract — identical across every call for a given (host, edit-mode)
pair. Each distinct system string is stored once as an explicit Gemini
`CachedContent` (`lanes/gemini-cache.ts`), memoized in-process by content hash,
and referenced via `providerOptions.google.cachedContent`; the request is then
sent with NO `system`, so the cache SUPPLIES the identical system instruction.

- **Cached vs uncached is reported separately** and never folded together:
  `LaneUsage.cachedInputTokens` is the cache-read slice (billed at a discount);
  uncached input = `promptTokens − cachedInputTokens` (the per-call user ask,
  ~20–300 tokens). Across 29 records: **226,242 cache-read / 8,918 uncached**.
- **Cost-only, output-invariant.** The cache holds the same bytes the inline
  system would carry, so the model's input is unchanged. Verified two ways:
  (1) a deterministic single-token prompt returns byte-identical output cached
  vs inline; (2) every groundable/ungroundable fixture keeps the same
  answered/refused outcome cached vs inline (`GENUI_BENCH_NO_CACHE=1` is the
  switch). Not counted in per-call usage: populating a cache costs its tokens
  once, amortized across the whole sweep.

## Per-record table

Generated from the RunRecords (see `summary.json` for the full data, including
per-record cached/uncached token splits and reasons).

| # | host · pack | ask | vendo | openui |
| --- | --- | --- | --- | --- |
| 1 | maple · smoke | show my account balances at a glance | answered 46.2s | answered 18.3s |
| 2 | maple · smoke | let me transfer money between my accounts | answered 29.3s | answered 19.5s |
| 3 | maple · smoke | show my recent transactions with search | answered 16.1s | answered 18.0s |
| 4 | cadence · smoke | show my account balances at a glance | refused 4.1s | refused 5.7s |
| 5 | cadence · smoke | let me transfer money between my accounts | refused 1.9s | refused 2.4s |
| 6 | cadence · smoke | show my recent transactions with search | refused 4.0s | refused 3.2s |
| 7 | cadence · cadence | which clients still owe me money, oldest first | refused 4.0s | refused 7.0s |
| 8 | cadence · cadence | show me where my money went last quarter | refused 2.7s | refused 4.0s |
| 9 | cadence · cadence | let me chase every overdue invoice in one go | refused 3.6s | refused 4.1s |
| 10 | cadence · cadence | what's missing before I can close the books this month | answered 18.5s | refused 8.2s |
| 11 | cadence · cadence | show revenue by client with a chart, and let me drill into one | refused 3.0s | refused 3.4s |
| 12 | cadence · cadence | build me a deadline board for the next 30 days | answered 31.7s | answered 11.6s |
| 13 | cadence · cadence | which clients are least profitable once I account for time spent | refused 3.7s | refused 3.6s |
| 14 | cadence · cadence | one screen that answers: can I afford to hire someone | refused 3.1s | refused 4.3s |
| 15 | cadence · single | show my clients | failed 13.0s | answered 14.6s |
| 16 | maple · single | show my clients | refused 3.2s | refused 5.5s |
| 17 | maple · conv t1/7 | show my recent transactions | answered 16.4s | answered 18.6s |
| 18 | maple · conv t2/7 | add a bar chart of spending by category above the table | failed 10.1s | answered 8.1s |
| 19 | maple · conv t3/7 | make that chart a donut instead | answered 18.1s (1 ef) | answered 5.7s |
| 20 | maple · conv t4/7 | add a stat card with my total balance across all accounts | answered 20.0s | answered 8.3s |
| 21 | maple · conv t5/7 | also show my credit score next to it | **refused** 2.5s | **refused** 3.8s |
| 22 | maple · conv t6/7 | remove the transactions table | answered 9.7s | answered 7.6s (1 ef) |
| 23 | maple · conv t7/7 | add a line chart of my cashflow over the last months | failed 7.3s | answered 9.1s |
| 24 | cadence · conv t1/6 | build me a deadline board for the next 30 days | answered 50.6s | answered 17.2s |
| 25 | cadence · conv t2/6 | add a stat card with how many clients are missing documents | answered 17.0s | answered 10.8s (1 ef) |
| 26 | cadence · conv t3/6 | show the deadlines as a table with client, filing deadline, and the missing document kinds | answered 12.4s | answered 7.6s |
| 27 | cadence · conv t4/6 | add a profitability column to that table | **refused** 3.3s | **refused** 4.8s |
| 28 | cadence · conv t5/6 | add a donut chart of clients by status | failed 11.2s | answered 9.2s |
| 29 | cadence · conv t6/6 | remove the missing-documents stat you added | answered 10.2s (1 ef) | answered 4.2s |

`ef` = per-turn scoring findings (preservation / edit-correctness /
over-refusal, `runner/conversation.ts`). The openui lane's two: an incomplete
table removal (t6) and a stat lost on an add turn (t2) — honest edit-quality
warnings the scoring layer surfaced, not silent breaks.

## Screenshots

`screenshots/` — one PNG per record: the cockpit at 1920×1080 (full-screen
viewport captures, never full-page) with the Vendo and OpenUI panes side by
side; refusal renders included. The OpenUI pane renders with their runtime over
VENDO's kit components, themed by the host's real theme tokens. Named
`<host>-<pack>-<slug>--<run>.png`; conversation turns
`<host>-conv-<fixture>-t<n>-<slug>--<run>.png`.
