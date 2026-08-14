# Competitive analysis — FIRE calculators, August 2026

An audit of what this calculator does, what the rest of the field does, and where the two diverge.
Surveyed 15 tools across four tiers, from six-input Coast FIRE toys to $549/yr advisor platforms.

---

## TL;DR

**We are not competing with the tools we look like.** The Coast FIRE calculators we resemble
superficially (ungrindfi, coastfirecalculator.app, coastfirecalc.org) are 4–6 input toys. The tools
that actually solve our problem are $129–$549/yr platforms requiring an hour of data entry.

We occupy a real, empty gap: **accumulation-phase modelling with a liquidity constraint, free, with
zero setup.** Nobody else solves for *when* you can retire subject to *both* total wealth and
pre-59½ reachability, and nobody free models homes, kids, and two careers as first-class
time-phased objects.

Three things are worth acting on:

1. **Home equity is a correctness bug, not a missing feature.** Homes are modelled as pure expense
   with no resale value, so "rent forever" wins by construction. This is our own documented
   limitation and it actively misleads. Highest-priority fix.
2. **No sequence-of-returns risk.** Every serious tool — including the free ones — runs historical
   backtests or Monte Carlo. We emit a single deterministic date that reads as a promise.
3. **We front-load ~40 inputs with no on-ramp.** Competitors get a user to a number in 15 seconds
   with presets and sliders, then invite depth. We invert that.

---

## 1. What we have today

Read from `fire_model.jsx` (2,757 lines) and `README.md`.

### Model

| Capability | Detail |
| --- | --- |
| **Dynamic requirement curve** | `Need(a)` by backward induction, landing exactly on $0 at the horizon. Falls as the horizon shortens and mortgages burn off. Not a static 25×. |
| **Pre-59½ bridge constraint** | Three buckets (taxable, your tax-advantaged, partner's), each unlocking at *its owner's* 59½. `Bridge(T)` = max over unlock checkpoints of discounted spending less already-unlocked balances. |
| **Two-constraint solve** | Retirement is the root of `min(total − Need, taxable − Bridge)`, found by bisection to a real-valued instant (e.g. age 43.93), not a snapped birthday. |
| **Continuous-time compounding** | Every flow accrues continuously; `fv`/`pv` closed forms. Eliminated a terminal-value sawtooth of $3.6M between adjacent salary inputs. |
| **Roth conversion ladder** | 5-year seasoning, `min(accessAge, T+5)`. |
| **Multiple homes** | Each with own price, purchase age, down %, rate, term, closing %, property tax (drifting at 2%, Prop-13 style), insurance/upkeep (at inflation). "Already own it" mode takes monthly P&I + years left. |
| **Multiple kids** | Per-kid birth age; daycare 0–5, ongoing 6–17, college at 18 or spread 18–21. Optional 529 with PV-targeted contributions and a gift-tax cap. |
| **Debts** | Balance + APR + monthly payment → derived payoff age, with a warning when the payment doesn't cover interest. |
| **Guaranteed income streams** | Pension / Social Security / annuity. Per-owner, COLA toggle, start/until ages. Lowers `Need` *and* shrinks the bridge. |
| **Arbitrary events** | Labelled one-off or windowed expenses and windfalls. |
| **Couples** | Partner has own age, income, two portfolios, own earning window, own 59½ date. Horizon extends to the last survivor. Optional "partner keeps working after you retire" with a separate interim budget. |
| **Coast FIRE** | Optional. Coast curve meets `Need` exactly at the coast age. |
| **Gross/net income** | Flat effective-rate conversion, applied to both partners. |

### UI

- Chart with 16 toggleable series — **the legend is the control surface**.
- Event markers on the timeline (home purchase, child born, major expense, windfall), underwater
  shading, 59½ access line, partner-stops line.
- **Share links with two privacy levels**: plot-only (chart, no numbers) and full-details
  (pre-filled editable calculator). LZ-compressed into the URL hash — no backend, nothing stored.
- **"What moves the needle"** — 8 counterfactuals, each a full model re-run, ranked in years of
  retirement bought.
- **Allocation advice** grounded in re-simulation, not rules of thumb.
- **Year-by-year trace table** — full auditability of every number on the chart.
- Diagnostic banners distinguishing **three distinct failure causes** (bridge never funded /
  spendable cash underwater / total wealth never sufficient), plus retire-on-loan refusal,
  retire-today explanation, coast shortfall, and the cost in years of the 59½ rule.
- Inline unit pickers ($/yr · $/mo · % of income), % vs $ carry modes, contextual `?` tooltips,
  validation warnings rendered next to the offending field.
- Single self-contained HTML file. No account, no tracking, no data leaves the browser.

### Known limitations (self-documented)

Homes have no equity or resale value · no taxes anywhere · no Social Security estimate ·
deterministic returns only · negative taxable balances permitted · lumps accrue continuously.

---

## 2. The landscape

### Tier 1 — Coast FIRE micro-calculators

*[ungrindfi.com](https://ungrindfi.com/tools/coast-fire-calculator/scenario/dual-income),
[coastfirecalculator.app](https://coastfirecalculator.app/for-couples),
[coastfirecalc.org](https://www.coastfirecalc.org/coast-fire-calculator-for-couples),
[walletburst](https://walletburst.com/tools/coast-fire-calc/)*

Four to eight inputs, all sliders, instant results. coastfirecalc.org for couples takes exactly
seven: two ages, two balances, two contributions, one household spend.

**Model depth:** near zero. No housing, no kids as time-phased costs, no debts, no liquidity gate,
no falling requirement curve. coastfirecalc.org's couples logic is literally "grow each partner's
balance to a shared retirement age and add them."

**But their packaging is excellent**, and that's where they beat us.

### Tier 2 — Free historical / Monte Carlo simulators

*[cFIREsim](https://www.cfiresim.com/), [FI Calc](https://ficalc.app/),
[FIRECalc](https://firecalc.com/),
[Engaging Data "Rich, Broke or Dead"](https://engaging-data.com/will-money-last-retire-early/)*

Serious statistical machinery, but **all of them are post-retirement tools**. They start from "you
have $X and retire in year Y" and ask whether it survives. They cannot answer "when can I retire?"
from an accumulation path with a mortgage, two careers and daycare.

- **cFIREsim** — historical cycles back to 1871; spending plans incl. VPW, Guyton-Klinger,
  Hebeler Autopilot, Variable CAPE; floors and ceilings; asset allocation across equities/bonds/
  gold/cash with glide paths and fees; unlimited income/expense adjustments; **up to 49 simulation
  tabs** side by side.
- **FI Calc** — 13+ withdrawal strategies in three families (longevity / spend-maximising / basic);
  extra-withdrawal scheduling (e.g. "4 years of college starting in 10 years"); CSV export; saved
  and shareable calculations.
- **Engaging Data** — the best visualisation in the entire field (see §4).

### Tier 3 — Paid comprehensive planners

*[ProjectionLab](https://projectionlab.com/) $129/yr · [Boldin](https://www.boldin.com/) $144/yr ·
[Pralana](https://pralanaretirementcalculator.com/) ~$100 · [MaxiFi](https://www.maxifi.com/)*

These are the real competition on functionality.

- **ProjectionLab** — Sankey cash-flow diagrams, Compare/What-If mode, multi-condition milestones,
  federal+state tax engine with IRMAA cliffs and ACA thresholds, Roth conversion and 72(t)
  modelling, 10,000-trial Monte Carlo with user-defined success categories, historical backtesting,
  progress journalling, PDF reports, international account types (CA/UK/AU/DE/NL).
- **Boldin** — Medicare and long-term-care costs, home purchase *and sale*, state taxes, plain-
  language AI what-ifs, plus coaching and classes.
- **Pralana** — three simultaneous scenarios; full federal/state/FICA tax calculation with **no tax
  rate input required**; RMDs; optimised Roth conversions, withdrawal order, and Social Security
  start age; consumption smoothing at a chosen confidence level.
- **MaxiFi** — inverts the question entirely: don't state desired spending, let the tool **discover
  the affordable smooth living standard**, adjusted for economies of shared living and the relative
  cost of children. Also sizes the life insurance needed to hold survivors' living standard.

### Tier 4 — Early-retirement specialists

*[BridgeToFI](https://bridgetofi.com/compare), [FireChart](https://firechart.app/roth-conversion-ladder-calculator), Richify*

The only tools attacking our exact problem. BridgeToFI has a P1/P2/P3 withdrawal-priority system
across account types, progressive brackets, IRMAA, Rule of 55, SEPP/72(t) and RMDs.

Notably, **BridgeToFI's own comparison table admits that none of cFIREsim, FI Calc, FIRECalc or
Boldin address dependent or education costs at all.**

---

## 3. What they do better

### UI / UX

| Gap | Who does it | Why it matters |
| --- | --- | --- |
| **Time-to-first-number** | All of Tier 1 | They deliver a result in ~15 seconds from 4 sliders. We open with ~40 fields in one long column. Most visitors never see our chart. |
| **Presets / sample scenarios** | coastfirecalculator.app, ungrindfi | One-click loadable personas. We have exactly one default household (27yo, $600k, $2M house, 2 kids) that fits almost nobody. |
| **Scenario-specific landing pages** | ungrindfi, coastfirecalculator.app | Dozens of pages — dual-income, with-kids, with-pension, by-age, Canada/UK/India — each pre-filled with prose for that situation. Enormous SEO surface. We have one page. |
| **Progress indicator** | coastfirecalculator.app | "You're 62% of the way to Coast FIRE" with a status message. We give a date but no sense of progress along it. |
| **Sliders on primary inputs** | Tier 1 universally, cFIREsim | We use sliders only in Advanced settings. Sliders invite exploration; number fields invite precision. Different jobs — we should offer both on key inputs. |
| **Scenario comparison** | ProjectionLab (Compare mode), Pralana (3 scenarios), cFIREsim (49 tabs) | The single most-requested capability in every review we read. We can't hold two plans at once. |
| **Per-partner breakdown** | coastfirecalculator.app, coastfirecalc.org | Shows each partner's % share of investments and contributions, plus separate projections beside the combined one. We pool everything invisibly. |
| **Save / load plans** | ProjectionLab, Boldin, FI Calc | Our share links are elegant but there's no named-plan concept and no local persistence — a refresh loses everything. |
| **Export** | FI Calc, cFIREsim, Engaging Data (CSV); ProjectionLab (PDF) | We have a full trace table you can't take with you. |
| **Theme toggle** | coastfirecalc.org, ProjectionLab | We're dark-only. |
| **Guided onboarding** | ProjectionLab's 4 steps | Accounts → milestones → income/expenses → results. Structure makes depth survivable. |

### Functionality

| Gap | Who does it | Impact on us |
| --- | --- | --- |
| **Home equity and resale** | Boldin, ProjectionLab, Pralana | **Critical.** Our own README: "makes 'rent forever' look far better than it is. The biggest gap." A house is an asset; we model it as a hole. |
| **Sequence-of-returns risk** | Every Tier 2 and 3 tool | We emit one number with no confidence band. Historical backtesting is the cheapest credible fix. |
| **Real tax engine** | ProjectionLab, Pralana, Boldin, BridgeToFI | We model no taxes, so traditional 401k withdrawals are free — our number is systematically **too low**. It also makes our own 529 feature a documented no-op. |
| **Withdrawal strategies** | FI Calc (13+), cFIREsim | We assume fixed real spending forever. Guardrails (Guyton-Klinger) alone would change conclusions materially. |
| **Healthcare / ACA before Medicare** | Boldin, ProjectionLab, Pralana | Often the largest single early-retirement expense line, and entirely absent from our model. |
| **Social Security estimation** | Everyone | We accept a manual figure. Nobody knows theirs. A bend-point estimate from earnings history would be a big usability win. |
| **RMDs** | Pralana, Boldin, BridgeToFI | Forced withdrawals at 73+ affect the drawdown shape and taxes. |
| **Asset allocation / glide path** | cFIREsim, ProjectionLab, Pralana | We take one blended return for everything. |
| **Spending phases** | Boldin, MaxiFi | Go-go / slow-go / no-go. We inflate one flat number forever. |
| **72(t) / SEPP, Rule of 55** | BridgeToFI, ProjectionLab | We model the Roth ladder but not its two main alternatives — a natural extension of machinery we already have. |
| **Account-level modelling** | ProjectionLab, Pralana | 401k/403b/457b/Roth/HSA/529 each with own treatment. We have three coarse buckets. |
| **Consumption smoothing** | MaxiFi, Pralana | Solve for affordable spending instead of requiring a target. A genuinely different framing. |

---

## 4. The one visualisation worth stealing outright

**Engaging Data's "Rich, Broke or Dead"** overlays *mortality probability* on the outcome
distribution. As you age, the "wedge of death" grows and visibly dwarfs the "ran out of money"
wedge. The reframing is brutal and correct: you are far more likely to run out of time than money.

This fits our philosophy exactly — we already refuse to show a FIRE number for a plan funded by
borrowing, and we already have `endAge` and a full year-by-year trace. Adding a mortality overlay
is a modest change with an outsized honesty payoff, and no other calculator in the accumulation
space does it.

**ProjectionLab's Sankey** is the other one. Universally praised in reviews — "the best I've seen
in any financial software." For a given year, where every dollar went: income → taxes, housing,
childcare, savings by bucket. We have all this data in `sim.trace` already and render it as a
table.

---

## 5. What we do better

### Model — things nobody else does at all

1. **The bridge as a binding constraint on the retirement *date*.** ProjectionLab and Boldin let
   you *model* a Roth ladder and observe whether you run dry. BridgeToFI has withdrawal
   sequencing. But **nobody solves for the earliest instant at which both the wealth constraint and
   the liquidity constraint clear, and then tells you which one bound.** Our "the 59½ rule costs you
   3.2 years" banner has no equivalent anywhere.

2. **Per-owner 59½ dates in a couple.** An older partner shortens your bridge; a younger one
   lengthens it. Every couples calculator we found either averages ages or ignores access entirely.

3. **A falling requirement curve.** Essentially the whole field uses a static 25×/33× number. Our
   `Need(a)` declines as the horizon shortens and mortgages retire — and we *draw* it, so the user
   sees why the target moves.

4. **Kids and homes as first-class time-phased objects.** Per-kid birth years driving daycare →
   school → college; per-home amortisation with independent property-tax drift. BridgeToFI's own
   comparison confirms **none** of cFIREsim/FI Calc/FIRECalc/Boldin do dependent costs.

5. **Horizon runs to the last survivor.** A partner 8 years younger stretches the plan 8 years.

6. **Retirement solved to a real-valued instant.** Everyone else snaps to a year. Ours is smooth
   in the inputs — pinned by tests that sweep in $250 steps and assert the terminal balance never
   moves by more than $1.

### UX — things we do better than tools charging $129/yr

7. **Zero setup.** ProjectionLab needs 20–60 minutes of account entry before it says anything.
   We're useful in 30 seconds, and useful *with a house and two kids in it*.

8. **Automated sensitivity analysis.** "What moves the needle" runs 8 counterfactual simulations
   and ranks them in years of retirement bought. ProjectionLab's Compare mode is more flexible but
   you must build every scenario by hand. Ours is free and automatic.

9. **Diagnostics that explain rather than report.** Three distinct never-retire causes with
   different prescriptions; the cash ledger; "why the portfolio keeps climbing after you retire."
   Competitors print a number or a red bar.

10. **We refuse to show a FIRE number funded by borrowing.** An integrity feature with no
    counterpart in the field — every other tool happily reports a date its own model reached by
    running the cash account negative.

11. **Plot-only share links.** Share the shape of your situation without the numbers. Genuinely
    thoughtful; nobody else offers a privacy gradient on sharing.

12. **True zero-trust privacy.** Single self-contained HTML file, no account, no backend, no
    analytics. ProjectionLab *markets* privacy and still requires an account.

13. **Full auditability.** The trace table shows every year's arithmetic. Most tools are black
    boxes; the paid ones need a support article to explain a number.

14. **Honest documentation of limitations.** Our README states each bias and its direction. No
    competitor does this.

---

## 6. Recommendations, ranked

### Do first — correctness and credibility

1. **Home equity and resale.** Track home value, appreciation, principal paid, and a sale event.
   Removes a known-misleading result and unlocks downsize/relocate modelling. *Largest single
   improvement available to us.*
2. **Historical backtesting.** Replay `simulate()` across return sequences from 1871. Report a
   success rate and percentile bands around the FIRE date. Reuses the existing pure function and
   directly answers "is this a promise or a midpoint?"
3. **A basic tax layer.** Even a bracket approximation on traditional withdrawals fixes a
   systematic downward bias and makes the 529 feature real.

### Do next — reach and retention

4. **Presets and an on-ramp.** 5–6 loadable personas (single, DINK, one-income family, late
   starter, coasting) and a "quick mode" of 6 inputs that expands into the full model.
5. **Scenario comparison.** Two named plans overlaid on one chart, with a delta table. `simulate()`
   is pure and ~1 ms — this is cheap for us and it's the field's most-wanted feature.
6. **Local persistence + named plans.** localStorage, no backend, consistent with our privacy stance.
7. **CSV export of the trace table.** Nearly free; the data is already assembled.

### Do when convenient — differentiation

8. **Mortality overlay** (§4). High honesty-per-line-of-code.
9. **Sankey for a selected year** (§4). Data already exists in `sim.trace`.
10. **72(t)/SEPP and Rule of 55** alongside the existing Roth ladder — same machinery, three
    strategies, and it would make us unambiguously the best tool in the field for the pre-59½
    problem.
11. **Healthcare/ACA line** for the pre-Medicare stretch.
12. **Social Security estimator** from an earnings figure rather than requiring a known benefit.

### Explicitly don't

- **Don't chase Tier 1 on simplicity.** Our depth is the product. Add an on-ramp, don't dilute.
- **Don't build account linking.** Zero-trust privacy is a real differentiator against every paid tool.
- **Don't build an advisor portal.** That's ProjectionLab Pro's $549/yr market, not ours.

---

## Appendix — tools surveyed

| Tool | Tier | Price | Notable |
| --- | --- | --- | --- |
| ungrindfi | 1 | Free | Scenario landing pages, dual-income framing |
| coastfirecalculator.app | 1 | Free | Per-partner ownership %, regional versions, presets |
| coastfirecalc.org | 1 | Free | All-slider UI, per-partner projections, theme toggle |
| walletburst | 1 | Free | Clean two-line coast chart |
| dinkytown two-spouse planner | 1 | Free | Dual Social Security claiming ages; dated UI |
| cFIREsim | 2 | Free | 49 tabs, glide paths, VPW/Guyton-Klinger |
| FI Calc | 2 | Free | 13+ withdrawal strategies, CSV export |
| FIRECalc | 2 | Free | The original historical backtester |
| Engaging Data | 2 | Free | **Mortality-adjusted outcome visualisation** |
| ProjectionLab | 3 | $129/yr | **Sankey, Compare mode, tax analytics, milestones** |
| Boldin | 3 | $144/yr | Healthcare/LTC, home sale, AI what-ifs, coaching |
| Pralana | 3 | ~$100 | Full tax engine with no rate input; 3 scenarios |
| MaxiFi | 3 | ~$149/yr | **Consumption smoothing**; life insurance sizing |
| BridgeToFI | 4 | Free/paid | P1/P2/P3 withdrawal priority, 72(t), Rule of 55 |
| FireChart / Richify | 4 | Free | Single-purpose Roth ladder calculators |
