# Guarded openui-lang lane — raw results

Real bench output from 2026-08-06, produced by the guarded `openui` lane (their
language + parser + Renderer, VENDO's kit as the registered library, vendo's
guardrails on top). Every number and screenshot comes from these RunRecords
(`runs/<id>/`, copied verbatim from the bench's gitignored `runs/` dir);
`summary.json` is computed from them by script, nothing hand-entered.

## What ran

- **Model (both lanes): `gemini-3.6-flash`** via `GENUI_BENCH_MODEL` and the
  bench's shared resolver (`runner/models.ts defaultModelId`) — no
  `ANTHROPIC_API_KEY` existed in this environment. Same model in both lanes
  keeps the comparison fair, **but the vendo engine ships tuned for
  `claude-sonnet-4-6`; its numbers here are NOT representative of the shipped
  engine on its shipped model** (its 3 failures below are all
  Gemini-authored prop/edit mistakes its checking layer caught).
- **Single-shot (16 runs):** maple `smoke` (3) · cadence `smoke` (3, the
  off-surface bank asks) · cadence `cadence` pack (8) · "show my clients" on
  each host (2). Same sweep as the pre-guardrail experiment, plus the maple
  single.
- **Conversations (13 turn-records):** `packs/conversations.json` — a 7-turn
  Maple spending workspace and a 6-turn Cadence deadline board, each with one
  mid-conversation ungroundable ask (credit score / profitability) that must
  refuse WITHOUT touching the existing UI.
- Command per sweep, from `tools/genui-bench` with the Gemini key in the root
  `.env`:
  `GENUI_BENCH_MODEL=gemini-3.6-flash pnpm bench run --host <h> (--pack <p> | --prompt "…") --lanes vendo,openui`
  `GENUI_BENCH_MODEL=gemini-3.6-flash pnpm bench run --conversations conversations --lanes vendo,openui`

## Outcomes are three-valued and mean the same thing in both lanes

`answered` — a validated UI shipped (vendo: checked AppDocument; openui: a
program that passed pre-render fact validation). `refused` — a typed refusal
with catalog-derived reasons (vendo: conductor `cannot`; openui: the
grounding contract's `<Cannot>` protocol, rendered as Kit `Disclaimer`
cards). `failed` — an honest failure; for the openui lane that means blocking
findings survived the bounded repair rounds, never a silent broken render.

## Headline (29 records: 16 single-shot + 13 conversation turns)

| | vendo | openui (guarded) |
| --- | --- | --- |
| answered / refused / failed | 14 / 12 / 3 | 16 / 13 / 0 |
| repairs needed | 0 | 0 |
| prompt tokens (total) | 105,391 | 203,659 |
| output tokens (total) | 69,417 | **36,516** |
| median wall time | 8.5s | **4.5s** |
| per-turn scoring findings (conversations) | 5 | **0** |

- **Zero fabrications.** Every ask the fixtures mark ungroundable refused in
  BOTH lanes — including all 6 asks the pre-guardrail openui lane answered
  with invented data (fake bank balances on the accounting host, fake
  profitability). The two lanes disagreed on exactly one borderline ask
  ("what's missing before I can close the books" — vendo answered from the
  document checklist, openui read it as bookkeeping and refused).
- **Partial refusal proven.** Both mid-conversation ungroundable turns
  refused with the existing UI preserved intact in both lanes (openui:
  program byte-identical, disclaimer rendered beside it; vendo: previous
  document carried and re-rendered under a refusal banner). Zero
  refusal-preservation findings.
- **The token trade.** The openui lane pays ~2× prompt tokens (the full
  derived kit library prompt rides every call) but produces ~half the output
  tokens (compact programs; edit turns emit only patch statements) and is
  ~2× faster at the median.
- **Vendo's 3 failures** are all conversation edit turns on Gemini
  (`DataTable data=` instead of `rows`, `DonutChart labelKey/title`, one
  unmatched `<Old>` edit) — the exact class its checking layer exists to
  block, reported honestly instead of shipped.
- **openui edit quality:** 13/13 conversation turns matched the fixture
  expectation with zero preservation/edit-correctness findings and zero
  repair rounds across all 29 records.

## Per-record table

Generated from the RunRecords (see `summary.json` for the full data,
including per-record tokens and reasons).

| # | host · pack | ask | vendo | openui |
| --- | --- | --- | --- | --- |
| 1 | maple · smoke | show my account balances at a glance | answered 60.6s | answered 9.9s |
| 2 | maple · smoke | let me transfer money between my accounts | answered 39.7s | answered 16.1s |
| 3 | maple · smoke | show my recent transactions with search | answered 24.1s | answered 13.8s |
| 4 | cadence · smoke | show my account balances at a glance | refused 2.8s | refused 3.0s |
| 5 | cadence · smoke | let me transfer money between my accounts | refused 2.2s | refused 2.5s |
| 6 | cadence · smoke | show my recent transactions with search | refused 2.9s | refused 3.0s |
| 7 | cadence · cadence | which clients still owe me money, oldest first | refused 4.0s | refused 3.5s |
| 8 | cadence · cadence | show me where my money went last quarter | refused 3.0s | refused 3.7s |
| 9 | cadence · cadence | let me chase every overdue invoice in one go | refused 3.1s | refused 3.6s |
| 10 | cadence · cadence | what's missing before I can close the books this month | answered 21.5s | refused 4.5s |
| 11 | cadence · cadence | show revenue by client with a chart, and let me drill into one | refused 3.9s | refused 3.7s |
| 12 | cadence · cadence | build me a deadline board for the next 30 days | answered 20.8s | answered 15.8s |
| 13 | cadence · cadence | which clients are least profitable once I account for time spent | refused 3.2s | refused 3.5s |
| 14 | cadence · cadence | one screen that answers: can I afford to hire someone | refused 3.3s | refused 3.8s |
| 15 | cadence · single | show my clients | answered 16.1s | answered 11.9s |
| 16 | maple · single | show my clients | refused 4.0s | refused 4.9s |
| 17 | maple · conv t1/7 | show my recent transactions | answered 18.8s | answered 9.1s |
| 18 | maple · conv t2/7 | add a bar chart of spending by category above the table | failed 10.7s | answered 7.9s |
| 19 | maple · conv t3/7 | make that chart a donut instead | answered 18.0s (1 ef) | answered 3.2s |
| 20 | maple · conv t4/7 | add a stat card with my total balance across all accounts | answered 16.8s | answered 5.9s |
| 21 | maple · conv t5/7 | also show my credit score next to it | **refused** 3.2s | **refused** 3.2s |
| 22 | maple · conv t6/7 | remove the transactions table | answered 10.2s | answered 3.6s |
| 23 | maple · conv t7/7 | add a line chart of my cashflow over the last months | failed 7.7s | answered 6.1s |
| 24 | cadence · conv t1/6 | build me a deadline board for the next 30 days | answered 29.7s | answered 18.6s |
| 25 | cadence · conv t2/6 | add a stat card with how many clients are missing documents | answered 11.1s (3 ef) | answered 4.7s |
| 26 | cadence · conv t3/6 | show the deadlines as a table with client, filing deadline, and the missing document kinds | answered 10.3s | answered 5.7s |
| 27 | cadence · conv t4/6 | add a profitability column to that table | **refused** 3.3s | **refused** 3.1s |
| 28 | cadence · conv t5/6 | add a donut chart of clients by status | failed 8.5s | answered 14.6s |
| 29 | cadence · conv t6/6 | remove the missing-documents stat you added | answered 7.3s (1 ef) | answered 2.6s |

`ef` = per-turn scoring findings (preservation / edit-correctness /
over-refusal, `runner/conversation.ts`). Vendo's five: two node-identity
losses on additive amends, and three cascade warnings ("expected a chart-pie;
none present") downstream of its failed donut turns.

## Screenshots

`screenshots/` — one PNG per record: the cockpit at 1920×1080 (full-screen
viewport captures, never full-page) with the Vendo and OpenUI panes side by
side; refusal renders included. The OpenUI pane renders with their runtime
over VENDO's kit components, themed by the host's real theme tokens. Named
`<host>-<pack>-<slug>--<run>.png`; conversation turns
`<host>-conv-<fixture>-t<n>-<slug>--<run>.png`.
