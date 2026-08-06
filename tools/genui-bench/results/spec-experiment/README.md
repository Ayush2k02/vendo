# spec-lane (native view-spec) experiment — raw two-lane results

Real bench output from 2026-08-06, produced by the `spec` lane PR. Every
number and screenshot here comes from these RunRecords (`runs/<id>/`, copied
verbatim from the bench's gitignored `runs/` dir); `summary.json` is computed
from them, nothing hand-entered. Both lanes ran in the SAME 16 runs, so every
row compares one prompt on one generation each.

## What ran

- **Model (both lanes): `gemini-3.6-flash`** — the newest flash model this
  environment's key reaches, verified against the live ListModels catalog
  before the run; every run's `spec.raw.json` stamps it. Set via
  `GENUI_BENCH_MODEL` (no `ANTHROPIC_API_KEY` exists in this environment).
  **The Vendo engine ships tuned for `claude-sonnet-4-6`; its numbers here
  are NOT representative of the shipped engine on its shipped model.**
- Hosts and prompts: `smoke` pack on maple and cadence, the bench's `cadence`
  pack on cadence, plus two singles ("show my clients" on cadence, "spending
  by category with budgets, and where I can cut back" on maple) — 16 runs.
- Command per sweep, from `tools/genui-bench` with keys in the repo-root
  `.env` and `GENUI_BENCH_MODEL=gemini-3.6-flash`:
  `pnpm bench run --host <maple|cadence> --pack <smoke|cadence> --lanes vendo,spec`

An earlier iteration of this experiment also carried an **openui-lang lane**;
it was evaluated and rejected — its fabricated-data renders (parses clean,
zero tool bindings, invented numbers) rose from 4/16 to 7/16 moving from
gemini-2.5-flash to the newer flash — so this branch carries no openui code
and the comparison is vendo vs spec.

## What "ok" means per lane (they are NOT the same claim)

- **vendo ok** — the conductor shipped a checked AppDocument; `findings` is
  what the checking layer still reported. A refusal ("the host has no way to
  …") or invalid generation is `failed`.
- **spec ok** — at least one spec piece survived validation against the
  chrome registry + the host's tool surface (one repair round allowed), and
  the compiled document renders on the production tree renderer.
  **Fabricated data is structurally impossible in this lane**: a data prop
  cannot be hand-typed (the validator rejects it as a law-1 violation), so
  every rendered value traces to a real fixture tool call. The honest caveat
  is different: on off-surface asks the lane binds the *closest real* tool,
  so it can be grounded-but-off-ask where vendo refuses.

## Headline numbers (16 runs)

| | vendo | spec |
| --- | --- | --- |
| ok | 5/16 | **16/16** |
| failed | 11/16 (9 conductor refusals, 2 generation failures) | 0/16 |
| ok runs with ≥1 real tool binding | 5/5 | **16/16** |
| ok runs with fabricated data | 0 | **0 — impossible by construction** |
| needed the repair round | n/a (full production pipeline) | 7/16 |
| findings on ok runs | 2 | 0 |
| median ok duration | 41.1s | 14.7s |
| generated-code islands in output | possible (0 here) | 0 by construction (no code vocabulary exists) |

## Per-run table

Generated from the RunRecords; `s` = seconds, `f` = checking-layer findings
on an ok run, `rep` = the spec lane needed its one repair round.

| host | pack | prompt | vendo | spec | spec tools bound |
| --- | --- | --- | --- | --- | --- |
| maple | smoke | show my account balances at a glance | ok 56.5s 1f | ok 10.5s | host_getProfile, host_listAccounts |
| maple | smoke | let me transfer money between my accounts | ok 70.6s 1f | ok 21.3s | host_listAccounts, host_listScheduledPayments, host_transferMoney |
| maple | smoke | show my recent transactions with search | failed 12.8s (gen) | ok 6.1s | host_listTransactions |
| cadence | smoke | show my account balances at a glance | refused 4.2s | ok 19.9s rep | host_getDashboard, host_listClients |
| cadence | smoke | let me transfer money between my accounts | refused 3.8s | ok 8.6s | host_getDashboard, host_listClients |
| cadence | smoke | show my recent transactions with search | refused 3.3s | ok 8.9s | host_listActivity |
| cadence | cadence | which clients still owe me money, oldest first | refused 3.9s | ok 10.9s | host_listDeadlines |
| cadence | cadence | show me where my money went last quarter | refused 4.1s | ok 16.6s rep | host_getDashboard, host_listActivity |
| cadence | cadence | let me chase every overdue invoice in one go | refused 3.7s | ok 28.1s rep | host_getDashboard, host_listClients, host_sendClientMessage |
| cadence | cadence | what's missing before I can close the books this month | ok 16.9s 0f | ok 23.1s rep | host_getDashboard, host_listActivity, host_listDeadlines |
| cadence | cadence | show revenue by client with a chart, drill into one | refused 4.5s | ok 32.2s rep | host_getClient, host_getDashboard, host_listClients |
| cadence | cadence | build me a deadline board for the next 30 days | ok 41.1s 0f | ok 17.3s rep | host_getDashboard, host_listDeadlines |
| cadence | cadence | which clients are least profitable (time spent) | refused 4.4s | ok 18.5s rep | host_getDashboard, host_listClients |
| cadence | cadence | one screen: can I afford to hire someone | refused 4.0s | ok 12.9s | host_getDashboard, host_listClients, host_listDeadlines |
| cadence | (single) | show my clients | failed 8.6s (gen) | ok 12.5s | host_getDashboard, host_listClients |
| maple | (single) | spending by category with budgets, where to cut back | ok 31.7s 0f | ok 8.4s | host_getBudgets, host_getRecurringInsights, host_getSpendingInsights |

The two vendo "(gen)" failures are generation failures on Gemini (unknown
props on prewired components, rejected by the checking layer — each run.json
carries the full error string); the 9 "refused" rows carry the conductor's
written reasons. The off-surface asks (bank prompts on the accounting host)
show the two designs' different honesty moves: vendo refuses with a reason;
spec binds the closest REAL tools and labels them as what they are — e.g.
the "balances" ask rendered the firm's real client/document stats under the
model-authored caption "Financial account balances are unavailable.
Displaying active tax clients and filing deadline progress."
(`screenshots/cadence-smoke-balances--123731.png`). Grounded, honestly
labeled, off-ask — and never invented.

## Island-escape metrics (`measure/`)

The committed measurement (`measure/metrics.ts`) reads the vendo lane's
AppDocument, so it was not run cross-lane. The spec lane's structural facts
don't need it: **island count is 0 and island ratio is 0.00 for every spec
run by construction** — the lane cannot emit generated-component source at
all; its documents are declared queries + prewired/Kit nodes only
(`spec.document.json` in every run dir shows this).

## Screenshots

`screenshots/` — one PNG per run: a full-screen 1920×1080 desktop-viewport
capture of the cockpit with the Vendo and Spec panes side by side (the run's
own two lanes; every PNG's dimensions were verified after capture). Both
panes are iframes onto `/embed/<host>` — the host's real theme and CSS; the
spec pane adds `&lane=spec`. Named `<host>-<pack>-<slug>--<hhmmss>.png`.
(This dir carries a negating `.gitignore` — the ROOT `.gitignore` ignores
`*.png` repo-wide and would otherwise silently drop these at `git add`.)
