# fire-calculator

An interactive FIRE (financial-independence / retire-early) model that answers a sharper question
than the usual "25× your spending" rule of thumb:

> **When can I stop working, such that the money lasts to the end — and such that I can actually
> *touch* it when I need it?**

Those are two different constraints, and most calculators only check the first. This one makes you
clear both.

![age 27 → 101, in today's dollars](#) <!-- screenshot goes here -->

---

## Why it exists

The naive FIRE number is `annual spending ÷ safe withdrawal rate`. It quietly assumes your
spending is flat forever, that you own your home outright, that children are free, and that every
dollar you have saved is available on the day you quit.

None of that is true. This model instead prices the actual life: a mortgage that outlives your
retirement date, daycare that ends, college that lands as a lump in your late forties, a partner
whose income starts and stops on *their* clock, and — the one almost nobody models — the fact that
**401k/IRA money is locked until 59½**.

The last one is decisive. A household can easily be a millionaire on paper and still be unable to
retire at 45, because the money is in the wrong *box*.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173 — hot-reloads on save
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. |
| `npm test` | Runs the model's test suite (98 tests, ~1s). |
| `npm run test:watch` | Same, in watch mode. |
| `npm run build` | Emits `dist/index.html` — a **single self-contained file** (React and Recharts inlined). Double-click it, email it, or drop it on any static host. |
| `npm run preview` | Serves the built `dist/` to sanity-check the bundle. |

### Repo layout

```
fire_model.jsx        the whole thing: the model (simulate) + the UI (FireModel)
fire_model.test.js    98 tests — every one pins a real bug or an invariant
index.html            page shell that Vite serves
src/main.jsx          mounts <FireModel/> into #root
vite.config.js        React plugin + single-file build
```

`simulate(params)` is a **pure function** and is exported, so you can drive the model without ever
mounting the UI:

```js
import { simulate, DEFAULTS } from "./fire_model.jsx";

const s = simulate({ ...DEFAULTS, annualTakeHome: 160000 });
console.log(s.fireCross);        // 42.97   <- retire at this age
console.log(s.fireCrossValue);   // 4265553 <- the number you need at that moment
console.log(s.fireBridge);       //  949904 <- how much of it must be in a taxable account
```

`fireCross` is `null` when the inputs never permit retirement — the model says "never" rather than
inventing an answer.

---

## How to use it

**Fill in the left column with your real figures.** Homes and kids are `+`-addable lists — each
home carries its own price, purchase age, down payment, rate, term, closing costs, property tax and
upkeep; each kid has their own birth year.

**Read the chart.** Everything is in *today's dollars*.

| Mark | Meaning |
| --- | --- |
| **Teal line** | Your portfolio, total. |
| **Brass dashed** | What you'd need *in total* at each age for the money to survive the horizon. It falls as your remaining life shortens and mortgages burn off. |
| **Coral dashed** | The **bridge** — the slice that must sit in a *taxable* account, because 401k dollars are unreachable before 59½. |
| **Pale line** | Your taxable (reachable) money. |
| **Purple dashed** | The **coast** bar — stop saving today, still retire on time. |
| **Brass dot** | Retirement: where teal clears brass **and** pale clears coral, whichever binds last. |

Every series is a clickable chip below the chart — the legend *is* the control.

**Then read "What moves the needle"** at the bottom. Each row is a full re-run of the model with one
input changed, reported in *years of retirement bought*. It is the honest answer to "so what should
I actually do?", and it will usually tell you something uncomfortable — like that a single point of
assumed investment return outweighs every decision you can actually make.

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

### 1. Homes

Each home is an independent stream of cash. For a home of price $P$, down payment fraction $d$,
annual rate $i$, term $n$ years, bought at age $a_0$:

$$L = P(1-d) \qquad
\text{P\&I}_{\text{yr}} = 12 \cdot \frac{L \cdot \tfrac{i}{12}\left(1+\tfrac{i}{12}\right)^{12n}}
{\left(1+\tfrac{i}{12}\right)^{12n} - 1}$$

the standard level-payment amortisation, and it runs from $a_0$ until $a_0 + n$. Cash needed at
closing is $(d + c)P$ for closing-cost fraction $c$. Carrying costs at age $a$:

$$\text{carry}(a) = P \cdot \tau \cdot 1.02^{\,a - a_0} \;+\; P \cdot m \cdot (1+\pi)^{\,a-a_0}$$

for property-tax rate $\tau$, upkeep+insurance rate $m$, inflation $\pi$. Property tax drifts at 2%
(Prop-13-style assessment growth); upkeep tracks inflation.

Total housing in a year is the sum of carry plus live P&I over every home owned by then — **plus
rent, for as long as you own nothing to live in**.

> ⚠️ **Known limitation.** Homes have **no equity and no resale value** — they are pure expense. So
> "rent forever" is the single strongest lever in the model *by construction*. Don't read that as
> advice; read it as a missing feature.

### 2. Kids

Each kid costs `daycarePerKid` from age 0–5, `ongoingPerKid` from 6–17, and `collegePerKid` at 18
(or spread over 18–21). All in today's dollars, inflated to the year they land.

### 3. The 529 (optional)

A side fund that compounds at the same $r$ and pays tuition first. It targets the present value of
remaining college,

$$\text{pv}_{\text{college}}(a) = \frac{\text{pv}_{\text{college}}(a{+}1) + \text{tuition}(a)\cdot \mathrm{fv}(1)}{G}$$

and contributes up to the annual cap but never past that target, so it cannot overfund.

> ⚠️ **In this model a 529 is a no-op.** It cannot help, because *no taxes are modelled* — and
> tax-free growth is the entire point of a 529. The tests pin it as exactly wealth-neutral, so that
> if it ever *does* start "helping", something has broken. (It used to: it compounded on year-end
> lumps while the portfolio compounded continuously, so it silently destroyed ~3.4% of every
> contribution.)

### 4. Retirement spending

`retirementSpendToday` **excludes housing** — housing is priced from the homes themselves every
year, so baking a paid-off house into it would double-count. Nominal spending in year $a$:

$$E(a) = \underbrace{S\,(1+\pi)^{a - a_{\text{now}}}}_{\text{non-housing}}
\;+\; \text{housing}(a)
\;+\; \text{downPayments}(a)
\;+\; \text{college}_{\text{net of 529}}(a)
\;+\; \text{529 contributions}(a)$$

### 5. The requirement curve — `Need`

`Need(a)` is the balance you must hold at the start of age $a$ for the money to fund $a$ through the
horizon and land **exactly on zero**. By backward induction from `Need(END+1) = 0`:

$$\text{Need}(a) = \frac{\text{Need}(a{+}1) + E(a)\cdot \mathrm{fv}(1)}{G}$$

The $\mathrm{fv}(1)$ factor is there because the balance keeps compounding *while* it is being spent
down. Evaluated at any real instant $t = a + f$:

$$\text{Need}(t) = \frac{\text{Need}(a{+}1) + E(a)\cdot \mathrm{fv}(1-f)}{G^{\,1-f}}$$

This is the **brass dashed curve**.

### 6. The bridge — the age-59½ constraint

`Need` answers *"is there enough money?"*. It does **not** answer *"can you legally touch it?"*.

The portfolio is split into three buckets: **taxable**, **your tax-advantaged**, and **your
partner's**. Each tax-advantaged bucket unlocks at *its own owner's* 59½. Retiring at instant $T$,
bucket unlock time is

$$u = \begin{cases}
\text{access age} & \text{hard gate} \\
\min(\text{access age},\; T + 5) & \text{Roth conversion ladder}
\end{cases}$$

(a conversion ladder seasons each conversion for 5 years — but you'd never wait past the statutory
age, hence the `min`.)

The **bridge** is what taxable alone must cover before the locked money opens. With buckets sorted
by unlock time, each contributes a checkpoint — taxable plus everything already unlocked must cover
all spending up to the next unlock:

$$\text{Bridge}(T) = \max_j \left[ \int_T^{u_j} E(s)\,e^{-\delta (s-T)}\,ds \;-\; \sum_{k:\,u_k < u_j} B_k \right]$$

evaluated piecewise per year. This is the **coral dashed curve**.

### 7. Solving for the retirement instant

You may retire only when **both** hold:

$$\underbrace{\text{total}(t) \;\ge\; \text{Need}(t)}_{\text{enough money}}
\qquad\text{and}\qquad
\underbrace{\text{taxable}(t) \;\ge\; \text{Bridge}(t)}_{\text{reachable in time}}$$

so the binding gap is $\;g(t) = \min\big(\text{total} - \text{Need},\ \text{taxable} - \text{Bridge}\big)$,
and **retirement $T$ is the root $g(T) = 0$** — found by bisection inside the year where $g$ changes
sign, to a real-valued instant.

Because `Need` is *defined* as the balance that lands on zero at the horizon, retiring exactly at
$T$ makes the terminal balance **zero by construction**. That is not a coincidence, it's the check:

- If **total wealth** binds → you end at exactly \$0.
- If **liquidity** binds → you end with a genuine surplus, because the gate *forced* you to
  over-save. That surplus is real, not an artifact.

> This replaced an earlier version that retired at `ceil(fireCross)`. Because the decision snapped to
> a whole year while the inputs moved smoothly, the terminal balance **sawtoothed** — climbing to
> \$3.92M and collapsing to \$0.30M between two adjacent salary inputs. The suite now sweeps inputs in
> \$250 steps and asserts the terminal balance never moves by more than \$1.

### 8. Coast FIRE

"Coast" = stop saving, keep working, let the pot compound untouched until you retire at `coastAge`.
So the coast bar is just the retirement requirement at the coast target, discounted back with **no
further contributions**:

$$\text{Coast}(t) = \frac{\text{Need}(\text{coastAge})}{G^{\,\text{coastAge} - t}}$$

It therefore **meets the `Need` curve exactly at `coastAge`** — which is both what makes the two
curves readable together, and how the tests verify it.

### 9. The partner

Every partner *input* is in the **partner's own age** ("earns until 60" means until *they* are 60).
The timeline is still your age, so exactly one function bridges the frames:

$$\text{partnerAge}(a) = a - \Delta, \qquad \Delta = \text{yourAge}_{\text{now}} - \text{partnerAge}_{\text{now}}$$

The partner enters through three channels:

1. **Income + their own 401k**, over their own working window.
2. **Their accounts unlock at their own 59½** — an older partner shortens your bridge; a younger one
   lengthens it.
3. **The horizon.** The money must outlive the *last survivor*, so
   $\text{END} = \text{endAge} + \max(0, \Delta)$. A partner 8 years younger stretches the horizon
   8 years past your own end age.

### 10. What moves the needle

`simulate` is pure and costs ~1ms, so instead of offering rules of thumb the app **re-runs the whole
model once per lever** and reports the change in retirement age. This is a one-at-a-time
finite-difference sensitivity analysis. Two honest caveats: the step sizes are *not* normalised
(a \$10k salary bump against a \$100k house price), so ranking across rows is a judgment call rather
than an elasticity; and it's strictly one-at-a-time, so interactions are invisible.

---

## Known limitations

These are all things the model *deliberately* does not do. Each one biases the answer in a known
direction:

| Limitation | Effect on the answer |
| --- | --- |
| **Homes have no equity or resale value** — pure expense | Makes "rent forever" look far better than it is. The biggest gap. |
| **No taxes anywhere** | Traditional 401k withdrawals are free, so the number is **too low**. Also makes the 529 pointless. |
| **No Social Security** | Pushes the number **too high**. |
| **Deterministic returns** — one fixed rate, no sequence risk | The single retirement age is a midpoint, not a promise. |
| **Negative taxable is allowed** and compounds at $r$ | Implicit borrowing. The UI flags the year loudly instead of charging a penalty. |
| **Lumps accrue continuously** across their year | Understates a point-in-time down payment by ~3%. Enough to flip a knife-edge buy-vs-finance call. |

---

## Tests

```bash
npm test     # 98 tests
```

Every test pins either a **real bug that was found** or an **invariant that must not break**.
Notable ones:

- The terminal-value **sawtooth** can never return (fine input sweeps, $\Delta \le \$1$).
- **Age-frame invariance**: shift the whole household 5 years forward and years-to-retirement is
  *identical*.
- The 529 is **exactly wealth-neutral**, and never buys an earlier retirement.
- The tax-advantaged slice **can never exceed the portfolio it slices** (it used to invent money).
- An **inverted partner earning window** can never silently pay them nothing.
- Mortgage P&I matches the **closed-form amortisation**; homes stack independently.
- On the default inputs a lone earner **never affords the house** — and the model must *say* "never"
  rather than invent an answer.
