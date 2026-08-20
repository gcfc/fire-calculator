# fire-calculator

An interactive FIRE (financial-independence / retire-early) model that answers a sharper question
than the usual "25× your spending" rule of thumb:

> **When can I stop working, such that the money lasts to the end — and such that I can actually
> *touch* it when I need it?**

Those are two different constraints, and most calculators only check the first. This one makes you
clear both.

---

## Contents

- [Why it exists](#why-it-exists)
- [Quick start](#quick-start)
- [A guide for people, not programmers](#a-guide-for-people-not-programmers) ← start here if you just want to use it
- [Software architecture](#software-architecture)
- [The math](#the-math)
- [Known limitations](#known-limitations)
- [Tests](#tests)

---

## Why it exists

The naive FIRE number is `annual spending ÷ safe withdrawal rate`. It quietly assumes your spending
is flat forever, that you own your home outright, that children are free, and that every dollar you
have saved is available on the day you quit.

None of that is true. This model prices the actual life: a mortgage that outlives your retirement
date, daycare that ends, college that lands as a lump in your late forties, a partner whose income
starts and stops on *their* clock, a house you might sell, and — the one almost nobody models — the
fact that **401k/IRA money is locked until 59½**.

The last one is decisive. A household can easily be a millionaire on paper and still be unable to
retire at 45, because the money is in the wrong *box*.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173 — hot-reloads on save
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. |
| `npm test` | The model's test suite (345 tests, ~25s). |
| `npm run test:watch` | Same, in watch mode. |
| `npm run build` | Emits `dist/index.html` — a **single self-contained file** (React and Recharts inlined). Double-click it, email it, or drop it on any static host. |
| `npm run preview` | Serves the built `dist/` to sanity-check the bundle. |

> **Deploying:** GitHub Pages must be set to **GitHub Actions**, not "deploy from a branch". The repo
> root `index.html` points at raw JSX that no browser can execute, so serving the source directly
> gives a blank page. The workflow builds and publishes `dist/`.

---

## A guide for people, not programmers

### It opens empty on purpose

Every box is blank, and the chart says *"Nothing to plot yet"* rather than showing a stranger's
projection you would have to overwrite field by field. Press **Load demo** for a fully worked
household to poke at.

Three figures make the question answerable, and the empty panel ticks them off as you fill them in:

1. **Your age** (and the horizon, which keeps a default)
2. **Retirement spending** — what a year costs once you stop
3. **Income, or savings to live on** — either will do; someone already retired has no income

Nothing is shown until all three exist. That is not fussiness: with no retirement budget the
requirement is *zero*, so any balance at all clears it and the model would cheerfully tell an empty
form "you could stop working today".

### What goes where

| Section | What it is for |
| --- | --- |
| **You / Partner** | Age, cash, taxable investments, tax-advantaged accounts, take-home pay, contributions, living costs, rent. The two investment balances are **independent** — enter each as it appears on its own statement. Every partner field is in **their** age, not yours. |
| **Retirement** | What a year costs once you stop (excluding housing — homes price themselves), the age the money must reach, and optional coast FIRE. |
| **Homes** | Any number. Each carries its own price, purchase age, down payment, rate, term, closing costs, property tax and upkeep — and an optional **sale age**. |
| **Kids** | Any number, each on their own clock. Click a child's name in its label to rename them. Cost fields appear only for phases a child has not already aged out of. |
| **Major expenses / income** | One-offs and windows. Datable at an age, or **relative to retirement**. |
| **Retirement income** | Pensions, Social Security, annuities. Streams, not pots. |
| **Debts** | Balance, rate and the payment you actually make; the payoff age is derived. |
| **Advanced** | The 59½ rule, Roth ladder, borrowing, college funding, and every rate assumption. |

Money fields take a figure per year, per month, or as a percentage of income — pick whichever unit
you actually know it in; the stored value is the same either way.

### Reading the chart

Everything is in **today's dollars**.

| Mark | Meaning |
| --- | --- |
| **Teal line** | Your portfolio, total. |
| **Brass dashed** | What you'd need *in total* at each age for the money to survive the horizon. It falls as your remaining life shortens and mortgages burn off. |
| **Coral dashed** | The **bridge** — the slice that must be reachable *now*, because 401k dollars are sealed before 59½. |
| **Pale line** | Your spendable money: cash plus taxable investments. |
| **Brass dotted** | Home equity. Deliberately *not* part of the portfolio — you cannot spend a house. |
| **Purple dashed** | The **coast** bar — stop saving today, still retire on time. |
| **Brass dot** | Retirement: where teal clears brass **and** pale clears coral, whichever binds last. |

Every series is a clickable chip below the chart — the legend *is* the control.

### The four panels underneath

- **Where the money goes** — one year's cash flow as a Sankey, with a slider to drag across the whole
  plan. Watch daycare appear and vanish, college arrive and double while two children overlap, the
  mortgage clear, and the retirement accounts sit sealed while your savings carry the bills alone.
- **Will it survive history?** — your plan replayed against real sequences of returns since 1928.
  Historical cycles update live as you drag the equity weight; the sampled modes wait for a click,
  because their run-to-run wobble is the same size as the effect you would be watching.
- **Trace the numbers** — the year-by-year arithmetic behind every line on the chart.
- **What moves the needle** — each row is a full re-run of the model, ranked in years of retirement
  bought.

### Sharing

Two kinds of link, both encoded into the URL — there is no backend and nothing is stored anywhere:

- **Plot only** — the chart, without your numbers.
- **Full details** — the whole calculator, pre-filled and editable.

---

## Software architecture

```
fire_model.jsx        the model (simulate) and the UI (FireModel) — ~4,000 lines
history.js            annual US market returns since 1928, bundled not fetched
fire_model.test.js    345 tests — every one pins a real bug or an invariant
legal.js              privacy/terms copy
scripts/build-legal.mjs  renders legal.js to dist/<slug>/index.html
index.html            page shell Vite serves
src/main.jsx          mounts <FireModel/> into #root
vite.config.js        React plugin + single-file build
```

### The shape of it

`simulate(params)` is a **pure function**, exported, and costs about a millisecond. Everything else
is built on that fact:

```js
import { simulate, DEFAULTS } from "./fire_model.jsx";

const s = simulate({ ...DEFAULTS, annualTakeHome: 160000 });
s.fireCross;        // 43.37   <- retire at this age
s.fireCrossValue;   // 4645396 <- the number you need at that moment
s.fireBridge;       // 2763979 <- how much of it must be reachable before 59.5
```

Because it is pure and cheap, features that would otherwise need bespoke maths are just *more calls*:

| Feature | How it works |
| --- | --- |
| **What moves the needle** | Re-runs the whole model once per lever and reports the change in retirement age. Not a rule of thumb — a one-at-a-time finite-difference sensitivity analysis. |
| **Allocation advice** | Binary-searches the smallest shift from 401k to taxable that captures the gain. |
| **Phase-relative expenses** | Iterates to a fixed point (see [§10](#10-phase-relative-expenses)). |
| **Backtesting** | Replays the forward path once per historical sequence. |

### Three layers, and the boundary between them

1. **`normalizeParams` / `isRunnable` / `planReadiness`** — input hygiene. The app opens with blank
   boxes, so `simulate` is called with `""` in most fields on the first render, and `"" + 5` is the
   string `"5"`. Coercing once, up front, is what keeps a blank form from producing string arithmetic
   deep inside the model.
2. **`simulateOnce`** — the model proper. Deterministic, pure, no React.
3. **`simulate`** — wraps `simulateOnce` in the fixed-point iteration that phase-relative expenses
   need, and short-circuits to a single call when there aren't any.

### One flow list, two phases

Working years and retired years used to build their cash flow in two independent places, each
deciding for itself what a year contained. **They drifted, twice** — a pension was subtracted in one
and never added in the other, and kid costs were charged in one and silently free in the other.

There is now one list. Each entry says what it costs in a given year and which phase it belongs to;
`household` is the only genuinely phase-dependent line (working budget before you retire, retirement
budget after) and everything else is charged in both. A cost cannot be added to half the model,
because there is no longer a half to add it to.

### Replay hooks

Backtesting does **not** re-solve the plan. You make a plan on an assumption and then test it against
what happened, so the planning rate keeps driving `Need[]`, the bridge and the date, while a sampled
sequence drives only the forward path. That split is the whole of it: two optional inputs
(`__returns`, `__fixedRetireAt`) and no duplicated drawdown accounting — which matters, because a
second copy of that accounting is exactly how the two bugs above happened.

### State and rendering

- One `useState` holding the entire parameter object; every input is a controlled edit into it.
- `useMemo` on `simulate(p)` — one model run per keystroke, plus one for the gate-off comparison.
- The chart is Recharts; the Sankey is hand-rolled SVG (Recharts' Sankey cannot express a severed
  channel, and the chart panel already contains a lot of bespoke SVG).
- Backtesting is **on demand**. A few hundred trials is most of a second, and a success rate that
  flickers while you type reads as noise rather than as a result. Results clear on any input change,
  so a stale figure can never sit under new numbers.
- No backend, no account, no analytics, no network calls. The market data is bundled for the same
  reason.
- **Theming.** Two palettes, `DARK` and `LIGHT`, with an identical key set, handed down through a
  React context; every component that paints starts with `const C = usePalette()`. There is
  deliberately no module-level `C`, so a component that forgets the hook fails loudly instead of
  silently freezing one theme in place. Nearly all the colour lives in inline styles and hand-rolled
  SVG attributes, where CSS custom properties do not reach — hence a context rather than `var(--x)`.
  The light theme is not an inversion: the pale accents carry no contrast on white, so they are
  separated by hue rather than lightness, and translucent fills get an alpha multiplier (`wash`)
  because a wash gains contrast over a dark ground and loses it over a light one. First visit follows
  the OS; after that the choice is remembered, and `index.html` replays it before first paint so
  there is no flash of the wrong theme.

---

## The math

All quantities are **nominal** internally (dollars of the year in question) and divided by inflation
only for display. The timeline is indexed by **your age**; the partner enters through an offset.

### 0. Continuous-time conventions

Money compounds continuously, and every flow — salary, spending, saving, mortgage payments — accrues
continuously rather than landing as a lump on your birthday. With nominal return $r$:

$$G = 1 + r \qquad \delta = \ln G$$

$$\mathrm{grow}(t) = G^{t} \qquad
\mathrm{fv}(t) = \frac{G^{t} - 1}{\delta} \qquad
\mathrm{pv}(t) = \frac{1 - G^{-t}}{\delta}$$

`fv(t)` is the future value of \$1/yr flowing continuously for `t` years; `pv(t)` is its present
value. A balance $B$ earning $r$ while $c$ per year flows in becomes $B\,G^{t} + c \cdot \mathrm{fv}(t)$.

**This matters.** It is what allows retirement to happen at a real-valued instant like age 43.93
rather than snapping to a birthday — see [§7](#7-solving-for-the-retirement-instant).

### 1. Four buckets

| Bucket | Rate | Reachable before 59½? |
| --- | --- | --- |
| **Cash** | `cashReturn` (4% default) | yes |
| **Taxable investments** | `nominalReturn` | yes |
| **Your 401k / IRA** | `nominalReturn` | no |
| **Partner's 401k / IRA** | `nominalReturn` | no |

Each is entered as its own balance. They used to be a total with the tax-advantaged share carved out
of it, which forced people to do arithmetic to enter figures they already had off separate
statements — and made "my 401k is bigger than my brokerage", which is most households, a state the
model had to clamp and warn about.

**Spendable** = cash + taxable investments. That is the quantity the bridge is measured against.
Cash is drawn down first — spending savings before selling assets is what actually happens.

### 2. Homes

For a home of price $P$, down payment fraction $d$, annual rate $i$, term $n$ years, bought at age $a_0$:

$$L = P(1-d) \qquad
\text{P\&I}_{\text{yr}} = 12 \cdot \frac{L \cdot \tfrac{i}{12}\left(1+\tfrac{i}{12}\right)^{12n}}
{\left(1+\tfrac{i}{12}\right)^{12n} - 1}$$

the standard level-payment amortisation. Cash needed at closing is $(d + c)P$. Carrying costs at age $a$:

$$\text{carry}(a) = P \tau \cdot 1.02^{\,a - a_0} \;+\; P m (1+\pi)^{\,a-a_0}$$

Property tax drifts at 2% (Prop-13-style assessment growth); upkeep tracks inflation.

**Value and sale.** A home appreciates at `homeGrowth`, and principal outstanding follows the
standard remaining-balance formula. Selling at age $a_s$ pays

$$\text{net} = V(a_s)\,(1 - \text{sellCost}) - \text{owed}(a_s)$$

into the taxable account, stops carry and P&I, and — if it was your only home — puts you back on
rent. The net can be negative; the model lets a sale underwater stand rather than pretending a sale
always pays.

Equity ($V - \text{owed}$) rides on every row as its own chart series and is deliberately **not**
part of the portfolio. You cannot spend a house.

### 3. Kids

Each kid costs `daycarePerKid` from age 0–5, `ongoingPerKid` from 6–17, and `collegePerKid` at 18
(or spread over 18–21). All in today's dollars, inflated to the year they land — and charged in
**both** phases. A child at home costs the same whether or not you have a job.

### 4. The 529 (optional)

A side fund compounding at the same $r$, paying tuition first. It targets the present value of
remaining college and contributes up to the annual cap but never past that target, so it cannot
overfund.

> ⚠️ **In this model a 529 is a no-op.** It cannot help, because *no taxes are modelled* — and
> tax-free growth is the entire point of a 529. The tests pin it as exactly wealth-neutral, so that
> if it ever *does* start "helping", something has broken.

### 4b. Required minimum distributions (optional)

From `rmdAge` (73, or 75 for those born 1960+) the IRS makes you take prior-year-end balance ÷ a
divisor from the Uniform Lifetime Table out of tax-deferred accounts each year.

> ⚠️ **In this model an RMD is a strict no-op**, and the tests pin it that way. It moves money from a
> sealed account to a spendable one; the cost of that move is the tax bill, and no taxes are
> modelled. It cannot help liquidity either — RMDs begin at 73, long after the 59½ unlock. It is
> implemented so the structure is right when taxes arrive, and so the trace can show the size of the
> one withdrawal you do not choose.
>
> Roth accounts have no RMD, and the model keeps a single undifferentiated tax-advantaged bucket, so
> the figure overstates the forced amount for anyone holding Roth money.

### 5. The requirement curve — `Need`

`Need(a)` is the balance you must hold at the start of age $a$ for the money to fund $a$ through the
horizon and land **exactly on zero**. By backward induction from `Need(END+1) = 0`:

$$\text{Need}(a) = \frac{\text{Need}(a{+}1) + E(a)\cdot \mathrm{fv}(1)}{G}$$

The $\mathrm{fv}(1)$ factor is there because the balance keeps compounding *while* it is being spent
down. This is the **brass dashed curve**.

### 6. Two rates, one requirement

`Need` above is a *single-rate* present value: it assumes every dollar compounds at $r$. Once cash
earns $r_c \ne r$, that is no longer the requirement — and the error is not symmetric. A cash-heavy
household would be handed a date on a pot that then ran dry.

The fix is exact rather than approximate, and it falls out of the draw order. Cash alone carries the
bill from $t$ until it runs dry at $\tau$, investments compound untouched over that stretch, and from
$\tau$ on it is an ordinary single-rate problem again:

$$\text{Need}_{\text{total}}(t, C) = C + \frac{\text{Need}(\tau) - \Phi(t,\tau)}{G^{\,\tau - t}}$$

where $\Phi(t,\tau)$ is the future value of everything flowing *into* the non-cash buckets meanwhile
— a still-working partner's surplus, and their 401k contributions. With $C = 0$ we get $\tau = t$,
$\Phi = 0$, and this collapses back to $\text{Need}(t)$ exactly.

Three details make it exact rather than close:

- The bill is valued at the **portfolio** rate inside the cash recursion, because that is what
  `spend()` charges over the same stretch. The forward drawdown is this model's ground truth.
- `spendSpan()` **cuts the year at the instant cash runs dry**, exactly as it already cuts at each
  unlock. A slice that is part cash-funded and part investment-funded charges one bill against two
  growth rates, and no closed form decomposes that.
- $\Phi$ is not zero whenever income still arrives after you retire. Omitting it left \$1.46M on the
  table in the partner-keeps-working case.

### 7. The bridge — the age-59½ constraint

`Need` answers *"is there enough money?"*. It does **not** answer *"can you legally touch it?"*.

Each tax-advantaged bucket unlocks at *its own owner's* 59½. Retiring at instant $T$, bucket unlock
time is $u = \text{access age}$, or $\min(\text{access age},\, T + 5)$ with a Roth conversion ladder.

The **bridge** is what spendable money alone must cover before the locked money opens. With buckets
sorted by unlock time, each contributes a checkpoint:

$$\text{Bridge}(T) = \max_j \left[\;\Pi\big(T, u_j\big) \;-\; \sum_{k:\,u_k < u_j} B_k \right]$$

where $\Pi$ is the **running maximum** of the partial present value of spending — not the plain
present value of the whole window.

That distinction is load-bearing. A plain present value nets a late inflow against early spending,
which is right for the wealth constraint (over the whole horizon a dollar is a dollar, whenever it
lands) and **wrong** for the liquidity one, because you cannot pay this year's bills out of next
decade's house sale. Before this, selling a home before 59½ cut the computed bridge so far that the
model retired you years early, ran the cash account underwater waiting for the proceeds, and reported
"you never retire" for a plan a later date funds comfortably. It is unchanged whenever spending is
positive throughout, which is the ordinary case.

This is the **coral dashed curve**.

### 8. Solving for the retirement instant

You may retire only when **both** hold:

$$\underbrace{\text{total}(t) \ge \text{Need}_{\text{total}}(t, C)}_{\text{enough money}}
\qquad\text{and}\qquad
\underbrace{\text{spendable}(t) \ge \text{Bridge}(t)}_{\text{reachable in time}}$$

so the binding gap is $g(t) = \min(\text{total} - \text{Need},\ \text{spendable} - \text{Bridge})$,
and **retirement $T$ is the root $g(T) = 0$** — found by bisection inside the year where $g$ changes
sign, to a real-valued instant.

Because `Need` is *defined* as the balance that lands on zero at the horizon, retiring exactly at $T$
makes the terminal balance **zero by construction**. That is the check, not a coincidence:

- If **total wealth** binds → you end at exactly \$0.
- If **liquidity** binds → you end with a genuine surplus, because the gate *forced* you to
  over-save.

### 9. Borrowing

The model has always permitted the spendable account to go negative, with the deficit compounding at
$r$ — an implicit loan. That is now an explicit toggle, **off by default**.

- **Off** — a path that goes underwater is not a fundable plan, so `fireCross` is `null`. The full
  simulated path is still returned, so the chart can show exactly where it broke, and
  `fireCrossIfBorrowed` carries the date it would have found.
- **On** — the date is reported, with a banner naming the age the borrowing starts.

This is a *feasibility* rule, not a penalty: with borrowing on, the debt still compounds at the
portfolio rate rather than a realistic borrowing rate.

### 10. Phase-relative expenses

An expense may be dated at an absolute age, or as an **offset from retirement** — 0 is the year you
stop, 5 is five years later, −2 is two years before. That makes the schedule depend on the answer
while the answer depends on the schedule, so `simulate` resolves it as a fixed point: run with
nothing anchored, feed the date back in, run again, stop when it settles.

It converges quickly because an expense pushed later has less present value and so pushes the date
back less. A plan with no retirement-dated expense runs `simulateOnce` exactly once.

### 11. Coast FIRE

"Coast" = stop saving, keep working, let the pot compound untouched until you retire at `coastAge`:

$$\text{Coast}(t) = \frac{\text{Need}(\text{coastAge})}{G^{\,\text{coastAge} - t}}$$

It therefore **meets the `Need` curve exactly at `coastAge`**. Ticking the box without giving an age
draws nothing — a blank age would otherwise clamp to "coast to next year", a target nobody chose.

### 12. The partner

Every partner *input* is in the **partner's own age**. The timeline is still your age, so exactly one
function bridges the frames:

$$\text{partnerAge}(a) = a - \Delta, \qquad \Delta = \text{yourAge}_{\text{now}} - \text{partnerAge}_{\text{now}}$$

The partner enters through three channels: their income and their own 401k over their own working
window; their accounts unlocking at *their* 59½ (an older partner shortens your bridge); and the
horizon, since the money must outlive the last survivor, so
$\text{END} = \text{endAge} + \max(0, \Delta)$.

### 13. Backtesting

Bundled annual US data since 1928 — S&P total return, 10-year Treasury total return, CPI. Returns are
converted to **real** and re-expressed at the model's own inflation assumption, so spending keeps
inflating the way the rest of the model believes while the portfolio earns the sequence's real
return.

Two methods:

- **Historical cycles** — replay each contiguous run of years in the order it occurred, keeping 1929
  followed by 1930. Few independent samples: a 76-year plan leaves ~20 complete windows in a century
  of data, and neighbouring windows share all but one year.
- **Random start year** — begin anywhere and run forward in real order, wrapping past the end of the
  record. As many distinct sequences as you ask for, every year still followed by the year that
  actually followed it, for one artificial seam per trial where 2024 meets 1928.
- **Block bootstrap** — stitch random blocks together, block length adjustable. Unlimited samples, at
  the cost of a seam every block and sequences that never happened.

The three order themselves by seam count, as you would hope: on the demo, 95.5% / 86.5% / ~76%.

A trial fails if it ends below zero *or* could only continue by borrowing.

> **The number that explains the others.** The demo's assumed return is 3.9% real; an 80/20 mix
> actually returned about 7.2% real across 1928–2024. Three points compounded over a seventy-year
> horizon is a hundredfold difference in the terminal balance, which is why the runs finish so far
> above zero. That gap is a finding about your assumptions, not a bug, and the panel says so.

---

## Known limitations

Each biases the answer in a known direction:

| Limitation | Effect on the answer |
| --- | --- |
| **No taxes anywhere** | Traditional 401k withdrawals are free, so the number is **too low**. It is also what makes the 529 and RMDs no-ops — both exist to be correct when taxes land. |
| **No Social Security estimate** | You must enter a figure yourself. Nobody knows theirs. |
| **No healthcare / ACA modelling** | Often the largest single early-retirement expense line. |
| **Deterministic planning rate** | The single retirement age is a midpoint, not a promise. Backtesting is a separate panel, not the headline. |
| **Borrowing is opt-in and off by default** | A plan that only balances on an implicit loan gets *no* date. Turning it on reports one, with the debt compounding at $r$ rather than a real borrowing rate. |
| **One flat rate per bucket** | No asset-allocation glide path, no rate tiering. |
| **Home appreciation is one flat rate** | No regional variation, no cycles — and it does not vary across backtest trials either, so a plan that funds itself by selling the house is leaning on `homeGrowth` being right in *every* run. |
| **Backtesting reaches only the invested buckets** | A sampled sequence drives the invested return. Cash keeps earning `cashReturn` and a home keeps appreciating at `homeGrowth` in every trial, so there is no run in which savings lost purchasing power — which flatters a cash-heavy plan. Fixing it properly needs a short-rate (T-bill) series the bundle does not carry, so instead the panel reports what share of your wealth at retirement is in that unsampled bucket. |
| **Lumps accrue continuously** across their year | Understates a point-in-time down payment by ~3%. |
| **US-shaped** | 59½, 401k, 529, Roth ladders. No other tax regime. |

Historical data caveats: index funds did not exist before 1972, so pre-1972 returns were not actually
attainable at these costs; and this is US data over the century in which the US won, which
survivorship bias cannot see.

---

## Tests

```bash
npm test     # 345 tests
```

Every test pins either a **real bug that was found** or an **invariant that must not break**. Notable
ones:

- The terminal-value **sawtooth** can never return (fine input sweeps, $\Delta \le \$1$).
- **Age-frame invariance**: shift the whole household 5 years forward and years-to-retirement is
  *identical*.
- The horizon lands on **exactly zero** at every cash weighting, and with a still-working partner.
- Cash at exactly the portfolio rate is a **no-op** — the split cannot change the date.
- The 529 is **exactly wealth-neutral**, and never buys an earlier retirement.
- Kid costs are charged in **both** phases; a pension is received in **both** phases.
- An earlier home sale retires you earlier; one past the unlock changes the requirement but not the
  date.
- A mid-bridge windfall **cannot** fund the years before it arrives.
- The Sankey's two sides **balance to the dollar**, every year — with a home sale, a 529 and a debt in
  the plan.
- An RMD is **exactly wealth-neutral**, and cannot rescue a plan gated by the 59½ bridge.
- Backtesting is **deterministic** for a given plan, and leaves plain `simulate()` untouched.
- The empty state returns **the same keys** as a real run, so no consumer can hit `undefined` — and
  the retirement-instant row carries every field the yearly rows do.
