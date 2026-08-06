# spec-lane v2 (refusal + vendo-grade composition) — raw two-lane results

Real bench output from 2026-08-06, produced by the spec lane v2 commit.
Every number and screenshot here comes from these RunRecords (`runs/<id>/`,
copied verbatim from the bench's gitignored `runs/` dir); `summary.json` is
computed from them, nothing hand-entered. Both lanes ran in the SAME 16
runs.

## What ran

- **Model (both lanes): `gemini-3.6-flash`** via `GENUI_BENCH_MODEL` (no
  `ANTHROPIC_API_KEY` exists in this environment; the engine ships tuned for
  `claude-sonnet-4-6`, so vendo's numbers are not the shipped engine's).
- Same 16 prompts as the v1 sweep: `smoke` on maple + cadence, the `cadence`
  pack, and two singles.
- Command: `pnpm bench run --host <maple|cadence> --pack <smoke|cadence> --lanes vendo,spec`

## Outcomes are three-valued (v2 accounting)

"ok" alone overstated the spec lane in v1 (a grounded-but-off-ask render
counted the same as a real answer). v2 counts **answered / refused /
failed** per lane: vendo's refusal is its conductor abstention (`failed` +
"the host refused this ask"); spec's is the typed `{refusal}` output
(marked in `spec.raw.json`), compiled onto the Kit's Disclaimer — vendo's
own abstention chrome — so it renders brand-native in the host document.

| | vendo | spec |
| --- | --- | --- |
| answered | 7/16 | 6/16 |
| refused | 9/16 | **10/16** |
| failed | 0/16 | 0/16 |
| answered with ≥1 real tool binding | 7/7 | 6/6 |
| answered with fabricated data | 0 | **0 — impossible by construction** |
| needed the repair round | n/a | 2/16 (was 7/16 in v1 — the refusal path drains repair pressure) |
| findings on answered runs | 2 | 0 |
| median answered duration | 26.5s | 13.2s |

## The 9-prompt refusal test set (the asks vendo refused in v1)

Captain's bar: for each, spec either refuses with a correct reason or
grounds the answer in tools that genuinely carry the data. Result: **spec
refused all 9, each with a catalog-derived reason** (full reasons in each
run's `spec.raw.json`):

| prompt (cadence host) | spec v2 | why the refusal is correct |
| --- | --- | --- |
| show my account balances at a glance | refused | no banking/balance tool exists; v1's dashboard-stats stand-in is gone |
| let me transfer money between my accounts | refused | no money-movement tool of any kind on this host |
| show my recent transactions with search | refused | `host_listActivity` is a workflow event feed — its output shape carries no amounts/merchants; v1 bound it anyway |
| which clients still owe me money, oldest first | refused | no invoice/billing/receivables tool; v1 bound `host_listDeadlines` (filing dates ≠ money owed) |
| show me where my money went last quarter | refused | no expense or spend data on the surface |
| let me chase every overdue invoice in one go | refused | no invoice records to chase; messaging exists but nothing to ground "overdue" |
| show revenue by client with a chart | refused | no revenue fields in any tool's output shape |
| which clients are least profitable (time spent) | refused | no time-tracking or profitability data |
| one screen: can I afford to hire someone | refused | no cash flow / payroll / financials |

**One divergence the other way:** on maple, "let me transfer money between
my accounts" — vendo answered (42s app on `host_transferMoney`), spec v2
**refused**, reasoning the host supports sending money to a recipient but
not account-to-account transfers. Reading `host_transferMoney`'s input
schema (`amount`, `recipient_name`, `memo` — no source/destination account
params), spec's strict read is defensible: the tool genuinely cannot
express "between my accounts". Judged against the catalog, this is the
grounding bar applied consistently, not an over-refusal bug — but it is a
real behavioral difference worth knowing.

## What "answered" now looks like (the UI-parity changes)

The 6 spec answers use the v2 composition vocabulary: `section` headings
compile into the engine's own group pattern (Surface → heading → body), so
pages read as framed, titled sections like vendo's output; `bind` fills
multi-prop data components (Progress value/max); Callout carries caveats.
Examples: "spending by category" ships *Spending Overview* (donut) +
*Category Budgets* (captioned table) sections in 16.2s vs vendo's tabbed
42s app; "deadline board" ships *Overview* stat tiles + *Upcoming Filing
Deadlines* table. Every rendered value still traces to a declared query —
zero freeform layout, zero code, zero fabricated data.

## Screenshots

`screenshots/` — one PNG per run: full-screen **1920×1080** desktop-viewport
captures (viewport pinned via DevTools emulation; every PNG's dimensions
verified after capture), the cockpit with the Vendo and Spec panes side by
side. Refusal renders included — e.g.
`cadence-cadence-owed-oldest--141156.png` shows vendo's refusal text beside
spec's Disclaimer card. Named `<host>-<pack>-<slug>--<hhmmss>.png`. (This
dir carries a negating `.gitignore` — the ROOT `.gitignore` ignores `*.png`
repo-wide and would otherwise silently drop these at `git add`.)
