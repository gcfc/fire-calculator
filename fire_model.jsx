import React, { useState, useMemo, useEffect } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceDot, ReferenceArea, ResponsiveContainer,
} from "recharts";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

// ---- palette (ledger / instrument) ----
const C = {
  bg: "#0E1A1F", panel: "#14252B", panel2: "#1B303733", ink: "#EAE6DD",
  brass: "#C9A24B", teal: "#5FB0A6", coral: "#D9695A", mute: "#7A8A8E",
  line: "#26424B", liquid: "#9AD5CB", coast: "#B48EAD", locked: "#7FA8D9",
};

// track a CSS media query so inline-styled layout can collapse on small screens
function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

const fmt = (n) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtM = (n) =>
  n == null ? "—" : "$" + (n / 1e6).toFixed(2) + "M";

// today's real calendar year, so an age field can show "≈ 2031" alongside it. Read once from the
// browser clock (not the simulation, which is age-indexed) — never hardcoded, so it's always live.
const CURRENT_YEAR = new Date().getFullYear();
// age N, anchored off a reference age that is "now": you (or your partner) are `refAge` this year, so
// age `age` lands in CURRENT_YEAR + (age - refAge). Returns null for a not-yet-meaningful age (<= 0,
// e.g. the "0 = single" sentinel, or the empty "until" field) so callers can skip the hint entirely.
const yearAt = (age, refAge) =>
  Number.isFinite(age) && age > 0 && Number.isFinite(refAge) ? CURRENT_YEAR + Math.round(age - refAge) : null;

// exported so the model can be exercised headlessly, without mounting the UI
export function simulate(p) {
  const ret = p.nominalReturn;

  // ---- continuous-time conventions ------------------------------------------
  // Defined up front because EVERY sub-model has to use them. The 529 sinking fund once used
  // year-end lumps while the portfolio compounded continuously, which quietly taxed each 529
  // contribution ~3.4% of a year's growth and made saving for college destroy wealth.
  const G = 1 + ret;                                    // one-year growth factor
  const delta = Math.log(G);                            // the equivalent continuous rate
  const grow = (dt) => Math.pow(G, dt);                 // what $1 becomes after dt years
  const fv = (dt) => (grow(dt) - 1) / delta;            // future value of $1/yr flowing for dt years
  const pvFlow = (dt) => (1 - Math.pow(G, -dt)) / delta; // present value of the same
  const inflAt = (age) => Math.pow(1 + p.inflation, age - p.currentAge);   // today's $ -> nominal at age

  // --- homes: any number of them, each with its own loan ---------------------
  // Every home is an independent stream of cash: a lump at closing, level P&I until its own
  // payoff, and carrying costs for as long as you own it. Nothing here assumes there is only one.
  const homes = (p.homes || []).filter((h) => h.price > 0).map((h) => {
    const loan = h.price * (1 - h.downPct);
    const i = h.rate / 12, n = Math.max(1, h.term) * 12;
    // level-payment amortisation; a 0% loan is just principal spread over the term
    const mPI = loan <= 0 ? 0
      : i > 0 ? (loan * i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1) * 12
              : loan / Math.max(1, h.term);
    return {
      ...h, loan, mPI,
      payoff: h.purchaseAge + h.term,                  // the year P&I stops
      down: (h.downPct + h.closingPct) * h.price,      // cash you must have at closing
    };
  });
  // property tax drifts ~2%/yr with assessments; insurance + upkeep track inflation
  const carryOf = (h, age) => {
    if (age < h.purchaseAge) return 0;
    const yrs = age - h.purchaseAge;
    return h.price * h.propTaxRate * Math.pow(1.02, yrs)
         + h.price * h.insMaintRate * Math.pow(1 + p.inflation, yrs);
  };
  // total housing cost in year `age`: carry + live P&I on every home you own by then, and rent
  // for as long as you own nothing to live in.
  const housingAt = (age) => {
    let owned = 0, cost = 0;
    for (const h of homes) {
      if (age < h.purchaseAge) continue;
      owned++;
      cost += carryOf(h, age);
      if (age < h.payoff) cost += h.mPI;
    }
    if (owned === 0) cost += p.rentAnnual * Math.pow(1 + p.inflation, age - p.currentAge);
    return cost;
  };
  const downAt = (age) => homes.reduce((s, h) => s + (age === h.purchaseAge ? h.down : 0), 0);
  const piAt = (age) =>
    homes.reduce((s, h) => s + (age >= h.purchaseAge && age < h.payoff ? h.mPI : 0), 0);
  const lastPayoff = homes.length ? Math.max(...homes.map((h) => h.payoff)) : null;

  // the naive 4%-rule number, for contrast — spending plus whatever housing costs in steady state
  const steadyHousing = homes.length
    ? homes.reduce((s, h) => s + h.price * (h.propTaxRate + h.insMaintRate), 0)
    : p.rentAnnual;
  const naiveNumber = (p.retirementSpendToday + steadyHousing) / p.swr;

  // --- household ages -------------------------------------------------------
  // The timeline is indexed by YOUR age, but every partner INPUT is given in the partner's own
  // age — "earns until 65" means until *they* are 65. `partnerAgeAt` is the only bridge between
  // the two frames; nothing else should be doing the arithmetic by hand.
  // A partner counts when they exist (age > 0) AND are enabled. The enable flag is the checkbox; the
  // legacy "age 0 = single" path still works, so an old link or a 0 age both mean no partner.
  const hasPartner = p.partnerAge > 0 && p.partnerEnabled !== false;
  const partnerOffset = hasPartner ? p.currentAge - p.partnerAge : 0;  // >0 when partner is younger
  const partnerAgeAt = (age) => age - partnerOffset;                   // your age -> their age
  const yourAgeWhenPartnerIs = (pa) => pa + partnerOffset;             // …and back again
  // The earning window has to be a real interval on the partner's own clock: it cannot start
  // before they exist today, and it cannot end before it starts. Clamped here as well as in the
  // UI — an inverted window would silently pay them nothing at all, which is exactly the kind of
  // quiet income-discarding that cost 2.5 years when partnerStart was in the wrong age frame.
  const earnFrom = Math.max(p.partnerStart, p.partnerAge);
  const earnTo = Math.max(p.partnerEnd, earnFrom);
  // the money must survive the LAST survivor: if the partner is younger by d, they reach the
  // target age when you are endAge + d, so the horizon stretches by d.
  const END = p.endAge + Math.max(0, partnerOffset);
  // each person's accounts open at their OWN 59.5; accessPartner is that instant on your clock
  const accessYou = p.accessAge;
  const accessPartner = yourAgeWhenPartnerIs(p.accessAge);

  // --- kids: any number of them, each born whenever ---------------------------
  const kids = (p.kids || []).filter((k) => k.birthAge > 0);
  const kidsCount = kids.length;
  const cap529 = kidsCount * 19000;                       // gift-tax-free annual max, single donor, today's $
  const lastCollegeAge = kidsCount
    ? Math.max(...kids.map((k) => k.birthAge)) + (p.collegeSpread ? 21 : 18) : 0;
  // college: one lump at 18, or spread over 18–21
  const collegeGrossToday = (age) => {
    let c = 0;
    for (const k of kids) {
      const ka = age - k.birthAge;
      if (p.collegeSpread) { if (ka >= 18 && ka <= 21) c += p.collegePerKid / 4; }
      else if (ka === 18) c += p.collegePerKid;
    }
    return c;
  };
  // daycare while they're little, then a lighter ongoing cost until they leave home
  const kidCostAt = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    let c = 0;
    for (const k of kids) {
      const ka = age - k.birthAge;
      if (ka >= 0 && ka <= 5) c += p.daycarePerKid * infl;
      else if (ka >= 6 && ka <= 17) c += p.ongoingPerKid * infl;
    }
    return c;
  };
  // gross college bill in year `age`, as a nominal RATE ($/yr) like every other flow
  const collegeGrossAt = (age) =>
    collegeGrossToday(age) * Math.pow(1 + p.inflation, age - p.currentAge);

  // value at the start of `age` of all the college still to come — the 529's funding target.
  // Same recursion as Need[], because the fund compounds on exactly the same terms as the portfolio.
  const pvCollege = {}; pvCollege[END + 1] = 0;
  for (let age = END; age >= p.currentAge; age--) {
    pvCollege[age] = (pvCollege[age + 1] + collegeGrossAt(age) * fv(1)) / G;
  }
  // pre-pass: the 529 is a side fund, independent of the main portfolio, so settle net-of-529
  // college up front. Contribute up to the annual cap, but never past what college still costs.
  // Everything here accrues continuously, exactly like the portfolio it is diverted from —
  // otherwise the diversion itself would leak value.
  const netCollege = {}, contrib529 = {};
  {
    let bal = 0;
    const annual = p.use529 ? Math.min(p.annual529, cap529) : 0;
    for (let age = p.currentAge; age <= END; age++) {
      const infl = Math.pow(1 + p.inflation, age - p.currentAge);
      const room = Math.max(0, pvCollege[age] - bal) / pvFlow(1);      // headroom, as a rate
      const c = (annual > 0 && age <= lastCollegeAge) ? Math.min(annual * infl, room) : 0;
      contrib529[age] = c;                                             // a rate, like every other flow

      const grossRate = collegeGrossAt(age);
      const endBal = bal * G + c * fv(1);                              // fund at year end
      const billFV = grossRate * fv(1);                                // tuition, valued at year end
      const paid = annual > 0 ? Math.min(endBal, billFV) : 0;
      bal = endBal - paid;
      netCollege[age] = (billFV - paid) / fv(1);                       // back to a rate for the portfolio
    }
  }

  // ---- one-off life expenses + debts ----------------------------------------
  // Expenses are lumps in today's $ (inflated to their year): +amount is a cost (wedding, medical, a
  // new roof), -amount is a windfall (inheritance, gift, a home sale). An optional `until` age turns
  // one into a yearly cost across a window. Debts are fixed-nominal loans — a balance, an APR, and the
  // monthly payment you actually make — amortised to a payoff age, then billed as a level annual P&I
  // stream (a mortgage without the house). Both are just extra outflows, so they net into the
  // requirement, the bridge, and the drawdown for free.
  const extraLump = {};
  for (const e of (p.expenses || [])) {
    const amt = (e && +e.amount) || 0;
    if (!amt) continue;
    const a0 = Math.round(e.age), a1 = e.until ? Math.max(a0, Math.round(e.until)) : a0;
    for (let y = a0; y <= a1; y++) extraLump[y] = (extraLump[y] || 0) + amt * inflAt(y);
  }
  const debts = (p.debts || []).map((d) => {
    const bal = Math.max(0, +d.balance || 0), pay = Math.max(0, +d.payment || 0), r = (+d.apr || 0) / 100 / 12;
    // `balance` is the balance TODAY, so a loan that began in the past is amortised from now, not from
    // its origination — otherwise the entered balance would be treated as an origination balance sitting
    // in the past and the payoff would land years too early (or before today, silently charging nothing).
    const start = Math.max(Math.round(d.startAge ?? p.currentAge), p.currentAge), annual = pay * 12;
    if (bal <= 0 || pay <= 0) return { start, payoff: start, annual: 0, neverPays: false };
    const neverPays = pay <= bal * r + 1e-9;   // the payment does not even cover the interest
    const months = neverPays ? Infinity : (r > 0 ? Math.log(pay / (pay - bal * r)) / Math.log(1 + r) : bal / pay);
    return { start, payoff: neverPays ? Infinity : start + months / 12, annual, neverPays };
  });
  const debtPaymentAt = (age) => debts.reduce((s, d) => {
    if (d.annual <= 0 || age < d.start) return s;
    if (d.payoff === Infinity) return s + d.annual;                          // never clears -> perpetual drag
    if (age >= d.payoff) return s;                                           // paid off
    if (age >= Math.floor(d.payoff)) return s + d.annual * (d.payoff - age); // partial final year
    return s + d.annual;
  }, 0);
  // total extra outflow in year `age` (nominal): one-off lumps + debt service. Windfalls go negative.
  const extraOutflowAt = (age) => (extraLump[age] || 0) + debtPaymentAt(age);

  // ---- guaranteed retirement income (pension / Social Security / annuity) ----
  // A pension is not a POT you draw down — it's a STREAM that offsets the bill every year it runs, so
  // it belongs on the same side of the ledger as a working partner's take-home: it lowers the
  // requirement and, because it's spendable cash, shrinks the pre-59.5 bridge. Each stream carries an
  // amount in today's $, a start age, whose clock it's on, and whether it has a COLA:
  //   • COLA on  → keeps constant REAL value, so nominal = amount·inflation(age) (like every other flow)
  //   • COLA off → fixed NOMINAL from the claim year on, so its real value erodes with inflation. This is
  //     the norm for state/corporate defined-benefit pensions and is the one thing a "negative recurring
  //     expense" could never express.
  // A stream is lifetime by default (runs to the horizon); an optional `until` age (in the owner's own
  // frame) ends it early. Partner streams are ignored when there is no partner, exactly like partner assets.
  const incomes = (p.incomes || []).filter((inc) => (+inc.amount) || 0);
  const incomeAt = (age) => {
    let sum = 0;
    for (const inc of incomes) {
      const onPartner = inc.whose === "partner";
      if (onPartner && !hasPartner) continue;
      const ageInFrame = onPartner ? partnerAgeAt(age) : age;                 // the recipient's own age
      if (ageInFrame < inc.startAge) continue;                                // not claimed yet
      if (inc.until != null && inc.until !== "" && ageInFrame > inc.until) continue;   // ended (non-lifetime)
      const startYourAge = onPartner ? yourAgeWhenPartnerIs(inc.startAge) : inc.startAge;
      // COLA'd tracks inflation forever; fixed-nominal freezes at the claim-year price level
      const factor = inc.cola === false ? inflAt(startYourAge) : inflAt(age);
      sum += (+inc.amount) * factor;
    }
    return sum;
  };
  // "This income is worth ≈$X of portfolio": the present value today of the whole stream, discounted on
  // the same terms as everything else (same backward recursion as Need[]). In today's $ since currentAge
  // is the base year. It's the honest way to compare a guaranteed pension against a pile of savings.
  let incomePV = 0;
  for (let age = END; age >= p.currentAge; age--) incomePV = (incomePV + incomeAt(age) * fv(1)) / G;
  // ages (your-frame) at which a stream switches on — for a marker on the chart
  const incomeStartMarks = incomes.map((inc) =>
    inc.whose === "partner" ? (hasPartner ? yourAgeWhenPartnerIs(inc.startAge) : null) : inc.startAge
  ).filter((a) => a != null);

  // Nominal spending in year `age` once retired. retirementSpendToday now EXCLUDES housing —
  // with several homes coming and going there is no single "housing cost" to bake into it, so
  // housing is priced from the homes themselves every year instead of being assumed away.
  const retireExpense = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    return p.retirementSpendToday * infl   // non-housing budget
         + housingAt(age)                  // rent, or carry + P&I on every home owned that year
         + downAt(age)                     // closing cash on anything bought this year
         + (netCollege[age] || 0)          // college the 529 didn't cover
         + (contrib529[age] || 0)          // …and the 529 you are still feeding. Retiring does not
                                           // stop the sinking fund: if these were left out, any
                                           // contribution scheduled after retirement would be free
                                           // money, and a slow 529 would buy you an earlier date.
         + extraOutflowAt(age)             // one-off life expenses + any debt service still running
         - incomeAt(age);                  // pension / Social Security / annuity — liquid, offsets the bill.
                                           // Subtracting it HERE threads it through every retirement
                                           // consumer at once (the Need curve, the bridge, and the forward
                                           // drawdown all read retireExpense), and touches nothing in the
                                           // working-year accumulation, which never calls it.
  };

  // ---- one partner still earning after you retire (opt-in) ------------------
  // Their earn-window [earnFrom, earnTo] is fixed in the partner's OWN age, so it is independent of
  // when YOU retire and nets cleanly into both the requirement and the forward drawdown. Off by
  // default → partnerEarnsInRetirement is always false and every wrapper below is exactly the plain
  // retireExpense() it stands in for, so nothing changes.
  const partnerStopAge = hasPartner ? yourAgeWhenPartnerIs(earnTo) : null;   // your age when they stop
  const partnerEarnsInRetirement = (age) =>
    p.partnerWorksAfterRetire && hasPartner &&
    partnerAgeAt(age) >= earnFrom && partnerAgeAt(age) <= earnTo;
  const interimLiving = p.interimLivingToday ?? p.nonHousingLiving;   // editable; defaults to working-years living
  // the household bill while they still work: the interim non-housing figure in place of the full
  // retirement budget; housing / college / 529 are untouched (reuse retireExpense and swap the term)
  const interimExpense = (age) => retireExpense(age) - (p.retirementSpendToday - interimLiving) * inflAt(age);
  const partnerTakeHomeAt = (age) => partnerEarnsInRetirement(age) ? p.partnerIncome * inflAt(age) : 0;   // liquid
  const partnerTaxAdvAt = (age) => partnerEarnsInRetirement(age) ? p.partnerTaxAdv * inflAt(age) : 0;     // locked
  // net bill a retired household must fund in year `age` — total (all partner income counts as wealth)
  // and liquid (only take-home is spendable pre-59.5; their 401k contribution is locked)
  const retireNet = (age) => partnerEarnsInRetirement(age)
    ? interimExpense(age) - partnerTakeHomeAt(age) - partnerTaxAdvAt(age) : retireExpense(age);
  const retireNetLiquid = (age) => partnerEarnsInRetirement(age)
    ? interimExpense(age) - partnerTakeHomeAt(age) : retireExpense(age);

  // ---- the retirement requirement -------------------------------------------
  // Salary, spending and saving accrue continuously (see the conventions at the top), which is what
  // lets retirement land on a real-valued instant. Retiring on the integer ceiling of the crossing
  // (the old behaviour) made the leftover at the horizon jump: nudge income up, the crossing slides
  // earlier, and the moment it tips past a whole year you retire 12 months sooner with barely
  // enough — so the terminal balance sawtoothed.
  //
  // Need[age] = nominal balance at the START of `age` that funds age..END and lands exactly on zero,
  // with the balance still compounding while it is being drawn down.
  const Need = {}; Need[END + 1] = 0;
  for (let age = END; age >= p.currentAge; age--) {
    Need[age] = (Need[age + 1] + retireNet(age) * fv(1)) / G;   // net of any partner income still coming in
  }
  // …and the same requirement evaluated at ANY instant, not just birthdays
  const needAt = (t) => {
    if (t >= END + 1) return 0;
    const A = Math.floor(t), rest = A + 1 - t;
    return (Need[A + 1] + retireNet(A) * fv(rest)) / grow(rest);
  };

  // --- the liquidity (age-59.5) machinery ----------------------------------
  // Need[] answers "is there enough money?". It does NOT answer "can you legally touch it?".
  // A 401k/IRA/HSA dollar cannot pay a bill before 59.5 without a 10% penalty, so a retirement
  // before then must be bridged out of the TAXABLE bucket alone.

  // present value, at instant `t`, of the SPENDABLE bill between `t` and `u` (net of a working
  // partner's take-home, which is liquid; their 401k contribution is handled separately, below)
  const pvSpend = (t, u) => {
    let acc = 0, disc = 1, s = t;
    const stop = Math.min(u, END + 1);
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      acc += disc * retireNetLiquid(yr) * pvFlow(dt);
      disc *= Math.pow(G, -dt);
      s = s1;
    }
    return acc;
  };

  // present value, at instant `t`, of a working partner's 401k contributions between `t` and `u` —
  // money that lands in their LOCKED bucket and is waiting there when it unlocks (zero when off)
  const pvPartnerContribs = (t, u) => {
    let acc = 0, disc = 1, s = t;
    const stop = Math.min(u, END + 1);
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      acc += disc * partnerTaxAdvAt(yr) * pvFlow(dt);
      disc *= Math.pow(G, -dt);
      s = s1;
    }
    return acc;
  };

  // The instant a bucket may legally start paying bills — a real number, not a rounded year.
  // A Roth conversion ladder seasons each conversion for 5 years, so retiring at T opens the pipe
  // at T+5 — but never later than 59.5, since you'd simply wait for the statutory age instead.
  const unlockAt = (access, T) =>
    !p.enforceAccess ? T : (p.rothLadder ? Math.min(access, T + p.ladderYears) : access);

  // Minimum TAXABLE balance at instant T to stay liquid through the locked years. Each bucket adds
  // a checkpoint: taxable (plus whatever unlocked earlier) must cover all spending up to its opening.
  const bridgeAt = (T, balYou, balPartner) => {
    if (!p.enforceAccess) return 0;
    const uPartner = unlockAt(accessPartner, T);
    // a partner still working past T keeps funding their 401k, so more is locked-and-waiting by the
    // time it unlocks — credit the PV of those contributions to the partner's checkpoint (0 when off)
    const buckets = [
      { u: unlockAt(accessYou, T), bal: balYou },
      { u: uPartner, bal: balPartner + pvPartnerContribs(T, uPartner) },
    ].filter((b) => b.bal > 0).sort((x, y) => x.u - y.u);
    let need = 0, unlocked = 0;
    for (const b of buckets) {
      need = Math.max(need, pvSpend(T, b.u) - unlocked);
      unlocked += b.bal;
    }
    return Math.max(0, need);
  };

  // --- coast FIRE ----------------------------------------------------------
  // "Coast" = stop SAVING but keep working, letting the pot compound untouched until you retire
  // at coastAge. So the coast bar is the retirement requirement at the coast target, discounted
  // back with no further contributions. It meets the Need curve exactly at coastAge.
  // NB: this assumes your income still covers everything on the way — including the college lumps.
  const coastTarget = Math.min(Math.max(p.coastAge, p.currentAge + 1), END);
  const coastAt = (t) => needAt(coastTarget) / grow(coastTarget - t);

  // --- annual flow RATES (nominal $/yr) during a working year ---------------
  const flows = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    // the working window is stated in the partner's own age, so translate before comparing
    const pAge = partnerAgeAt(age);
    const partnerOn = hasPartner && pAge >= earnFrom && pAge <= earnTo;
    const takeHome = p.annualTakeHome * infl + (partnerOn ? p.partnerIncome * infl : 0);
    const taxAdvYou = p.annualTaxAdv * infl;
    const taxAdvPartner = partnerOn ? p.partnerTaxAdv * infl : 0;
    const living = p.nonHousingLiving * infl;
    const housing = housingAt(age);
    const kidCost = kidCostAt(age);
    // every lump (down payments, college, 529, life expenses, debt service) comes out of taxable
    const lumps = downAt(age) + (netCollege[age] || 0) + (contrib529[age] || 0) + extraOutflowAt(age);
    const surplus = takeHome - (living + housing + kidCost);
    return { taxable: surplus - lumps, taxAdvYou, taxAdvPartner, save: surplus + taxAdvYou + taxAdvPartner };
  };

  // work for dt years: balances compound while the year's flows stream in
  const work = (st, age, dt) => {
    const f = flows(age), g = grow(dt), a = fv(dt);
    return {
      taxable: st.taxable * g + f.taxable * a,
      taxAdvYou: st.taxAdvYou * g + f.taxAdvYou * a,
      taxAdvPartner: st.taxAdvPartner * g + f.taxAdvPartner * a,
    };
  };

  // spend for dt years inside one calendar year, drawing taxable first and then each
  // tax-advantaged bucket that has already opened. `t0..t1` never straddles an unlock.
  const spend = (st, t0, t1, T) => {
    const age = Math.floor(t0), dt = t1 - t0, g = grow(dt);
    let taxable = st.taxable * g, ty = st.taxAdvYou * g, tp = st.taxAdvPartner * g;
    let owed = retireExpense(age) * fv(dt);
    const draw = (bal) => { const x = Math.min(bal, owed); owed -= x; return bal - x; };
    taxable = draw(taxable);
    if (t0 >= unlockAt(accessYou, T) - 1e-9) ty = draw(ty);
    if (t0 >= unlockAt(accessPartner, T) - 1e-9) tp = draw(tp);
    let short = false;
    if (owed > 1) { taxable -= owed; short = true; }          // illiquid: money exists, can't be reached
    return { st: { taxable, taxAdvYou: ty, taxAdvPartner: tp }, short };
  };

  // one retired sub-year. When the partner is still earning their take-home offsets the bill (a
  // surplus lands in taxable) and their 401k contribution grows the locked bucket; otherwise this is
  // exactly spend(). Same taxable-first, then-unlocked draw order, so the two stay consistent.
  const retireStep = (st, t0, t1, T) => {
    const age = Math.floor(t0);
    if (!partnerEarnsInRetirement(age)) return spend(st, t0, t1, T);
    const dt = t1 - t0, g = grow(dt);
    let taxable = st.taxable * g, ty = st.taxAdvYou * g, tp = st.taxAdvPartner * g;
    tp += partnerTaxAdvAt(age) * fv(dt);                                  // locked contribution keeps building
    let owed = (interimExpense(age) - partnerTakeHomeAt(age)) * fv(dt);   // net of take-home
    if (owed < 0) { taxable += -owed; owed = 0; }                         // partner out-earned the bill -> save it
    const draw = (bal) => { const x = Math.min(bal, owed); owed -= x; return bal - x; };
    taxable = draw(taxable);
    if (t0 >= unlockAt(accessYou, T) - 1e-9) ty = draw(ty);
    if (t0 >= unlockAt(accessPartner, T) - 1e-9) tp = draw(tp);
    let short = false;
    if (owed > 1) { taxable -= owed; short = true; }
    return { st: { taxable, taxAdvYou: ty, taxAdvPartner: tp }, short };
  };

  // spend from t0 to t1, splitting at any unlock instant that falls inside
  const spendSpan = (st, t0, t1, T) => {
    const cuts = [t0, t1];
    [unlockAt(accessYou, T), unlockAt(accessPartner, T)].forEach((u) => {
      if (u > t0 && u < t1) cuts.push(u);
    });
    cuts.sort((a, b) => a - b);
    let s = st, short = false;
    for (let i = 0; i < cuts.length - 1; i++) {
      const r = retireStep(s, cuts[i], cuts[i + 1], T);   // spend(), plus a working partner's income
      s = r.st; short = short || r.short;
    }
    return { st: s, short };
  };

  // From 59.5 on the retirement accounts are legally spendable, so a cash shortfall — a negative
  // TAXABLE balance — is covered out of whichever bucket has already unlocked, whether you have
  // retired or are still working. Net worth is unchanged; the dollars just move to the account the
  // bills are actually paid from, instead of the shortfall compounding forever as taxable "debt".
  // While still working the statutory 59.5 is the only key that turns; the Roth-ladder shortcut only
  // exists once you have retired and started converting, which spend()/spendSpan() already handle.
  const settle = (st, t) => {
    const openYou = !p.enforceAccess || t >= accessYou - 1e-9;
    const openPartner = !p.enforceAccess || t >= accessPartner - 1e-9;
    let { taxable, taxAdvYou, taxAdvPartner } = st;
    const pull = (bal, open) => {
      if (!open || taxable >= 0 || bal <= 0) return bal;
      const move = Math.min(bal, -taxable);       // only enough to bring the cash account back to $0
      taxable += move;
      return bal - move;
    };
    taxAdvYou = pull(taxAdvYou, openYou);
    taxAdvPartner = pull(taxAdvPartner, openPartner);
    return { taxable, taxAdvYou, taxAdvPartner };
  };
  // advance a working stretch, then sweep any now-reachable account against a cash shortfall
  const step = (st, age, dt) => settle(work(st, age, dt), age + dt);

  // --- three buckets, because "whose account is it" now changes the answer ---
  // The tax-advantaged slice can never exceed the portfolio it is a slice OF. Clamping here (not
  // just in the UI) keeps the buckets summing to the stated portfolio: without it, a tax-advantaged
  // figure larger than the total would invent money — taxable floors at 0 while the locked bucket
  // keeps the whole oversized number.
  const lockedYou = Math.min(p.startPortfolioTaxAdv, p.startPortfolio);
  // No partner ⇒ no partner assets. Their portfolio is ignored entirely, the same way their income
  // and their 59.5 unlock already are — otherwise a single filer keeps a phantom account that was
  // only ever meant to belong to someone who isn't in the plan.
  const partnerPortfolio = hasPartner ? p.partnerPortfolio : 0;
  const lockedPartner = hasPartner ? Math.min(p.partnerPortfolioTaxAdv, p.partnerPortfolio) : 0;
  let st = {
    taxable: (p.startPortfolio - lockedYou) + (partnerPortfolio - lockedPartner),
    taxAdvYou: lockedYou,
    taxAdvPartner: lockedPartner,
  };

  // You may retire only when BOTH hold: enough money in total, and enough of it reachable before
  // 59.5. The binding one is whichever gap is smaller — and it is zero exactly at retirement.
  const gapAt = (t, s) => Math.min(
    (s.taxable + s.taxAdvYou + s.taxAdvPartner) - needAt(t),
    s.taxable - bridgeAt(t, s.taxAdvYou, s.taxAdvPartner),
  );

  let T = null;                                   // the retirement instant, a real number
  let fireCrossValue = null, fireReq = null, fireTaxable = null, fireBridge = null;
  let coastCross = null, coastCrossValue = null, prevCoastGap = null, prevCoastReal = null;
  let minSave = Infinity, minSaveAge = null, illiquidAge = null;
  const rows = [];

  for (let age = p.currentAge; age <= END; age++) {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    const total = st.taxable + st.taxAdvYou + st.taxAdvPartner;
    const startReal = total / infl;
    const working = T === null;
    const coastReal = age <= coastTarget ? coastAt(age) / infl : null;

    // hitting the coast bar means you could stop saving today and still retire on time
    const coastGap = coastReal == null ? null : startReal - coastReal;
    if (coastCross === null && coastGap != null && coastGap >= 0) {
      if (prevCoastGap != null && prevCoastGap < 0) {
        const f = prevCoastGap / (prevCoastGap - coastGap);
        coastCross = (age - 1) + f;
        coastCrossValue = prevCoastReal + (startReal - prevCoastReal) * f;
      } else {
        coastCross = age;
        coastCrossValue = startReal;
      }
    }
    prevCoastGap = coastGap;
    prevCoastReal = startReal;

    const f0 = flows(age);
    const realSave = working ? f0.save / infl : 0;
    if (working && realSave < minSave) { minSave = realSave; minSaveAge = age; }

    const events = [];
    if (homes.some((h) => h.purchaseAge === age)) events.push("home");
    if (kids.some((k) => k.birthAge === age)) events.push("kid");
    if (collegeGrossToday(age) > 0) events.push("college");

    const reqReal = needAt(age) / infl;
    const bridgeReal = bridgeAt(age, st.taxAdvYou, st.taxAdvPartner) / infl;
    rows.push({
      age,
      portfolio: Math.round(startReal),
      taxable: Math.round(st.taxable / infl),
      retirement: Math.round((st.taxAdvYou + st.taxAdvPartner) / infl),   // 401k/IRA/HSA buckets
      required: Math.round(reqReal),
      bridge: Math.round(bridgeReal),
      // the slice of the number that may sit locked: everything past the taxable bridge (kept exactly
      // consistent with the rounded required/bridge so the three lines always sum on-screen)
      neededRetirement: Math.max(0, Math.round(reqReal) - Math.round(bridgeReal)),
      coast: coastReal == null ? null : Math.round(coastReal),
      save: Math.round(realSave),
      events,
    });

    if (working) {
      // Does the crossing fall inside this year? Solve for the exact instant rather than
      // rounding up to the next birthday.
      if (gapAt(age, st) >= 0) {
        T = age;
      } else if (gapAt(age + 1, step(st, age, 1)) >= 0) {
        let lo = 0, hi = 1;                                  // bisection: gap is increasing in dt
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (gapAt(age + mid, step(st, age, mid)) >= 0) hi = mid; else lo = mid;
        }
        T = age + hi;
      }

      if (T !== null) {
        const inflT = Math.pow(1 + p.inflation, T - p.currentAge);
        const sT = T === age ? st : step(st, age, T - age);   // balances at the retirement instant
        fireCrossValue = (sT.taxable + sT.taxAdvYou + sT.taxAdvPartner) / inflT;
        fireReq = needAt(T) / inflT;
        fireTaxable = sT.taxable / inflT;
        fireBridge = bridgeAt(T, sT.taxAdvYou, sT.taxAdvPartner) / inflT;
        if (T > age) {
          rows.push({
            age: T, portfolio: Math.round(fireCrossValue), required: Math.round(fireReq),
            taxable: Math.round(fireTaxable), retirement: Math.round((sT.taxAdvYou + sT.taxAdvPartner) / inflT),
            bridge: Math.round(fireBridge),
            neededRetirement: Math.max(0, Math.round(fireReq) - Math.round(fireBridge)),
            coast: T <= coastTarget ? Math.round(coastAt(T) / inflT) : null,
            save: 0, events: [],
          });
        }
        const r = spendSpan(sT, T, age + 1, T);               // retired for the rest of the year
        st = r.st;
        if (r.short && illiquidAge === null) illiquidAge = Math.floor(T);
      } else {
        st = step(st, age, 1);
        if (st.taxable < 0 && illiquidAge === null) illiquidAge = age;
      }
    } else {
      const r = spendSpan(st, age, age + 1, T);
      st = r.st;
      if (r.short && illiquidAge === null) illiquidAge = age;
    }
  }

  // terminal balance, AFTER the final year is spent — zero by construction when total wealth binds
  const inflEnd = Math.pow(1 + p.inflation, END + 1 - p.currentAge);
  const end = (st.taxable + st.taxAdvYou + st.taxAdvPartner) / inflEnd;
  const fireLocked = fireCrossValue == null ? null : fireCrossValue - fireTaxable;
  const lockedShare = fireCrossValue > 0 ? fireLocked / fireCrossValue : 0;
  return {
    naiveNumber, fireAge: T == null ? null : Math.ceil(T), fireCross: T,
    fireCrossValue, fireReq,
    // per-home derived numbers, so the UI can show what each one actually costs
    homes: homes.map((h) => ({
      price: h.price, purchaseAge: h.purchaseAge, payoff: h.payoff,
      mPI: h.mPI, down: h.down, carryAtBuy: carryOf(h, h.purchaseAge),
    })),
    lastPayoff,
    mortgageAtFire: T == null ? 0 : piAt(Math.floor(T)),   // P&I still running when you retire
    minSave: Math.round(minSave), minSaveAge, end, rows, END,
    accessYou, accessPartner, partnerOffset, hasPartner,
    // one-off expense/windfall markers for the chart, and each debt's derived payoff age for its card
    expenseMarks: (p.expenses || []).filter((e) => (+e.amount) || 0).map((e) => ({ age: Math.round(e.age), amount: +e.amount })),
    debtPayoffs: debts.map((d) => (d.neverPays || d.annual <= 0 ? null : d.payoff)),
    // guaranteed-income stream: its present value today (the "lump-sum equivalent") and where it starts
    incomePV, incomeStartMarks,
    incomeAtFire: T == null ? 0 : incomeAt(Math.floor(T)) / Math.pow(1 + p.inflation, Math.floor(T) - p.currentAge),
    // your age when a still-working partner stops earning — only meaningful when that's after you retire
    partnerStopsAtAge: p.partnerWorksAfterRetire && hasPartner && T != null && partnerStopAge > T ? partnerStopAge : null,
    // the age YOUR accounts actually become spendable given when you retire — with a Roth ladder this
    // is retire+5 (capped at 59.5), i.e. the real liquidity wall, which can sit well before 59.5
    unlockYouAtFire: T == null ? null : unlockAt(accessYou, T),
    fireTaxable, fireLocked, fireBridge, lockedShare, illiquidAge,
    coastTarget, coastCross, coastCrossValue, coastToday: coastAt(p.currentAge),
    // the partner's own age at the moments that matter, so the UI never has to do the offset math
    partnerAgeAtFire: hasPartner && T != null ? partnerAgeAt(T) : null,
    partnerAgeAtEnd: hasPartner ? partnerAgeAt(END) : null,
  };
}

// The one number box everything uses. Two things it gets right that a raw <input type=number> does not:
// clicking in SELECTS the current value, so typing replaces it instead of landing after the leading 0;
// and the box is allowed to sit empty while you type, instead of a 0 snapping back in behind the cursor.
const NumberInput = ({ value, onCommit, step = 1, min = 0, max = Infinity, small = false }) => {
  const [draft, setDraft] = useState(null);            // the raw string while editing; null when idle
  const clamp = (n) => Math.min(max, Math.max(min, n));
  return (
    <input
      type="number"
      // iOS only shows the numeric keypad for type=number when an inputMode is set — without this it
      // falls back to the full alphanumeric keyboard (Android already shows the keypad from type alone).
      // "decimal" covers every field here (ages, rates, dollars) and keeps the decimal point available.
      inputMode="decimal"
      step={step}
      min={min}
      max={Number.isFinite(max) ? max : undefined}   // let the spinner + native validity know the ceiling too
      value={draft ?? value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);                                  // keep exactly what was typed, empty included
        if (raw === "") return;                         // …and don't force a 0 back into the box
        const n = Number(raw);
        if (!Number.isNaN(n)) onCommit(clamp(n));
      }}
      onBlur={() => {
        // left empty: settle on 0 when the field allows it, otherwise the floor. Fields that permit
        // negatives (e.g. an expense that can be a windfall) have min far below 0, and settling a blank
        // box on that huge negative floor instead of 0 was surfacing as a nonsense default.
        if (draft === "") onCommit(Math.max(0, min));
        setDraft(null);
      }}
      style={{
        background: C.bg, border: `1px solid ${C.line}`, color: C.ink,
        padding: small ? "6px 8px" : "8px 10px", borderRadius: small ? 5 : 6,
        fontFamily: "'JetBrains Mono', monospace", fontSize: small ? 13 : 14,
        width: "100%", boxSizing: "border-box",
      }}
    />
  );
};

// compact numeric input for the repeatable home/kid cards. `pct` stores a fraction but shows a %.
// `yearRef`, when given, marks this value as an age and shows the calendar year it lands in.
const Num = ({ label, value, onChange, step = 1, pct = false, min = 0, yearRef }) => {
  const yr = yearRef != null ? yearAt(value, yearRef) : null;
  return (
    // In the card grids these sit side by side; labels of different lengths wrap to different heights,
    // which (with the grid stretching each cell to the same height) would leave the input boxes at
    // different vertical offsets. justify-content:space-between pins the input to the bottom of the
    // cell so the row of boxes always lines up, whether or not the age/year hint is present.
    <label style={{ display: "flex", flexDirection: "column", gap: 3, height: "100%", justifyContent: "space-between" }}>
      <span style={{ fontSize: 10, letterSpacing: ".03em", color: C.mute, textTransform: "uppercase" }}>
        {label}{yr != null && <span style={{ opacity: 0.65 }}> · ≈{yr}</span>}
      </span>
      <NumberInput
        small
        step={step}
        min={min}
        value={pct ? Number((value * 100).toFixed(4)) : value}
        onCommit={(v) => onChange(pct ? v / 100 : v)}
      />
    </label>
  );
};

// a compact free-text input for card labels (wedding, medical, student loan, …); display only
const TextField = ({ label, value, onChange, placeholder }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
    <span style={{ fontSize: 10, letterSpacing: ".03em", color: C.mute, textTransform: "uppercase" }}>{label}</span>
    <input
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: C.bg, border: `1px solid ${C.line}`, color: C.ink, padding: "6px 8px", borderRadius: 5,
        fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box",
      }}
    />
  </label>
);

const AddButton = ({ onClick, label }) => (
  <button
    onClick={onClick}
    style={{
      background: "transparent", border: `1px dashed ${C.teal}`, color: C.teal, borderRadius: 999,
      padding: "3px 10px", cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif",
      fontSize: 11, letterSpacing: ".03em",
    }}
  >
    + {label}
  </button>
);

const DropButton = ({ onClick }) => (
  <button
    onClick={onClick} title="remove"
    style={{
      background: "transparent", border: `1px solid ${C.line}`, color: C.mute, borderRadius: 5,
      width: 26, height: 26, cursor: "pointer", fontSize: 13, lineHeight: 1, flexShrink: 0,
    }}
  >
    ×
  </button>
);

// `opts.yearRef`, when given, marks this field as an age and shows the calendar year it lands in.
const field = (label, key, val, set, opts = {}) => {
  const yr = opts.yearRef != null ? yearAt(val, opts.yearRef) : null;
  return (
    <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
        {label}{yr != null && <span style={{ opacity: 0.65 }}> · ≈{yr}</span>}
      </span>
      <NumberInput
        value={val}
        step={opts.step || 1}
        min={opts.min ?? 0}
        max={opts.max ?? Infinity}
        onCommit={(v) => set(key, v)}
      />
    </label>
  );
};

// inline caution, for when the inputs contradict each other
const Warn = ({ children }) => (
  <div style={{
    marginTop: 8, padding: "7px 9px", borderRadius: 6, fontSize: 10, lineHeight: 1.6,
    color: C.ink, background: `${C.coral}14`, border: `1px solid ${C.coral}66`,
  }}>
    ⚠ {children}
  </div>
);

export const DEFAULTS = {
  currentAge: 27, startPortfolio: 400000, startPortfolioTaxAdv: 200000,
  annualTakeHome: 144000, annualTaxAdv: 40000,
  nonHousingLiving: 36000, rentAnnual: 36000, inflation: 0.03, nominalReturn: 0.07,
  // add or drop as many as you like; each home carries its own loan and each kid its own clock
  homes: [{
    price: 2000000, purchaseAge: 31, downPct: 0.20, rate: 0.065, term: 30,
    closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013,
  }],
  kids: [{ birthAge: 30 }, { birthAge: 32 }],
  daycarePerKid: 26000, ongoingPerKid: 8000, collegePerKid: 200000,
  expenses: [], debts: [], incomes: [],

  partnerAge: 26, partnerIncome: 120000, partnerTaxAdv: 23000,
  partnerPortfolio: 150000, partnerPortfolioTaxAdv: 100000,
  partnerStart: 26, partnerEnd: 60, partnerEnabled: true,
  partnerWorksAfterRetire: false, interimLivingToday: null,
  // EXCLUDES housing — every home now prices its own carry, mortgage and closing costs, so
  // baking a paid-off house into this number would double-count it. (Was 110k incl. ~36k carry.)
  retirementSpendToday: 100000, swr: 0.035, endAge: 100, coastAge: 48,
  collegeSpread: true, use529: false, annual529: 0,
  enforceAccess: true, rothLadder: false, ladderYears: 5, accessAge: 59.5,
};

// every mark on the chart, switchable. `on` is the default visibility: start with the
// headline story (portfolio vs. the total it must clear, and where they meet) and let the
// liquidity detail be opted into.
const SERIES = [
  { key: "portfolio", label: "portfolio, total", color: C.teal, on: true },
  { key: "required", label: "needed in total", color: C.brass, dash: true, on: true },
  { key: "retire", label: "retirement point", color: C.brass, mark: "◆", on: true },
  { key: "coast", label: "coast FIRE bar", color: C.coast, dash: true, on: true },
  { key: "taxable", label: "taxable (spendable before 59.5)", color: C.liquid },
  { key: "retirement", label: "retirement accounts (401k/IRA)", color: C.locked, on: true },
  { key: "bridge", label: "needed in taxable (the bridge)", color: C.coral, dash: true },
  { key: "neededRetirement", label: "needed in retirement accounts", color: C.locked, dash: true, on: true },
  { key: "underwater", label: "taxable underwater (< $0)", color: C.coral, mark: "▨", on: true },
  { key: "access", label: "401k unlock (liquidity wall)", color: C.mute, dash: true, on: true },
  { key: "partnerStops", label: "partner stops working", color: C.brass, dash: true, on: true },
  { key: "home", label: "home purchase", color: C.brass, mark: "●", on: true },
  { key: "kids", label: "child born", color: C.ink, mark: "●", on: true },
  { key: "expense", label: "major expense / windfall", color: C.coral, mark: "●", on: true },
];

const defaultShow = () => Object.fromEntries(SERIES.map((s) => [s.key, !!s.on]));

// ---- share links -----------------------------------------------------------
// The site is static (no backend), so all shared state rides in the URL hash. Two shapes:
//   full — the sharer's inputs, so the recipient gets the whole calculator, pre-filled and editable
//   plot — ONLY the already-computed chart data, so the raw inputs never leave the sharer's browser
const SHARE_VERSION = 1;

// lz-string's URL-safe codec keeps links short (it compresses the JSON) and needs no base64 step
export const encodeShare = (obj) => compressToEncodedURIComponent(JSON.stringify(obj));
// accepts a bare token, a "#s=…"/"#…" hash, or a whole URL; returns the payload or null
export const decodeShare = (raw) => {
  if (!raw) return null;
  try {
    let token = String(raw);
    if (token.includes("#")) token = token.slice(token.indexOf("#") + 1);
    if (token.startsWith("s=")) token = token.slice(2);
    if (!token) return null;
    const json = decompressFromEncodedURIComponent(token);
    if (!json) return null;
    const obj = JSON.parse(json);
    if (!obj || obj.v !== SHARE_VERSION) return null;
    if (obj.mode !== "full" && obj.mode !== "plot") return null;
    return obj;
  } catch {
    return null;
  }
};

// only the keys that differ from a reference object (shallow; arrays compared structurally)
const diffFrom = (obj, ref) => {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (JSON.stringify(obj[k]) !== JSON.stringify(ref[k])) out[k] = obj[k];
  }
  return out;
};

// the compact, columnar snapshot of everything the chart draws — carries NO inputs
export const snapshotFromSim = (sim, show, enforceAccess) => {
  const rows = sim.rows;
  const col = (k) => rows.map((r) => (r[k] == null ? null : r[k]));
  const evtAges = (evt) => rows.filter((r) => r.events && r.events.includes(evt)).map((r) => r.age);
  return {
    ages: rows.map((r) => r.age),
    portfolio: col("portfolio"), taxable: col("taxable"), retirement: col("retirement"),
    required: col("required"), bridge: col("bridge"), neededRetirement: col("neededRetirement"), coast: col("coast"),
    homeAges: evtAges("home"), kidAges: evtAges("kid"),
    END: sim.END, accessYou: sim.accessYou, enforceAccess: !!enforceAccess, coastTarget: sim.coastTarget,
    unlockAtFire: sim.unlockYouAtFire, partnerStopsAtAge: sim.partnerStopsAtAge, expenseMarks: sim.expenseMarks,
    fireCross: sim.fireCross, fireCrossValue: sim.fireCrossValue,
    coastCross: sim.coastCross, coastCrossValue: sim.coastCrossValue,
    show,
  };
};

// rebuild the array-of-objects the chart consumes from a columnar snapshot
export const rehydrateRows = (snap) => {
  const homeSet = new Set(snap.homeAges || []);
  const kidSet = new Set(snap.kidAges || []);
  return snap.ages.map((age, i) => ({
    age,
    portfolio: snap.portfolio[i], taxable: snap.taxable[i], retirement: snap.retirement[i],
    required: snap.required[i], bridge: snap.bridge[i],
    neededRetirement: snap.neededRetirement ? snap.neededRetirement[i] : null, coast: snap.coast[i],
    events: [...(homeSet.has(age) ? ["home"] : []), ...(kidSet.has(age) ? ["kid"] : [])],
  }));
};

// contiguous age windows where taxable (spendable) cash is underwater — same rule the live app uses
export const underwaterOf = (rows, END) => {
  const spans = [];
  let start = null;
  for (const r of rows) {
    if (r.taxable < 0 && start == null) start = r.age;
    else if (r.taxable >= 0 && start != null) { spans.push([start, r.age]); start = null; }
  }
  if (start != null) spans.push([start, END]);
  return spans;
};

// build the object to encode for a given share kind
export const sharePayload = (kind, { p, show, sim }) =>
  kind === "plot"
    ? { v: SHARE_VERSION, mode: "plot", snap: snapshotFromSim(sim, show, p.enforceAccess) }
    : { v: SHARE_VERSION, mode: "full", p: diffFrom(p, DEFAULTS), show: diffFrom(show, defaultShow()) };

// --- tax-advantaged vs. taxable allocation advice ---------------------------
// In this model the two buckets grow identically; their ONLY difference is the 59.5 lock. So moving
// saving from tax-advantaged → taxable never changes total wealth — it just adds liquidity, which
// pulls a bridge-bound retirement earlier and does nothing once liquidity is already ample. We detect
// the skew by re-running the model. Returns null, or one of:
//   { dir:"toTaxable", amount, years, newAge, unlocks }  — over-weighted to LOCKED accounts
//   { dir:"toTaxAdv",  slack }                           — over-weighted to TAXABLE, room to spare
export const allocationAdvice = (p) => {
  const sim = simulate(p);
  const partnerEarns = p.partnerAge > 0 && p.partnerEnabled !== false;
  const totalTaxAdv = p.annualTaxAdv + (partnerEarns ? p.partnerTaxAdv : 0);
  // move a fraction `f` of every tax-advantaged contribution into take-home (i.e. into taxable)
  const shift = (f) => ({
    annualTaxAdv: p.annualTaxAdv * (1 - f),
    annualTakeHome: p.annualTakeHome + p.annualTaxAdv * f,
    ...(partnerEarns ? {
      partnerTaxAdv: p.partnerTaxAdv * (1 - f),
      partnerIncome: p.partnerIncome + p.partnerTaxAdv * f,
    } : {}),
  });
  const cur = sim.fireCross;                                  // may be null (never retire)
  const alt = simulate({ ...p, ...shift(1) }).fireCross;      // everything redirected to taxable

  // Direction A — over-weighted to LOCKED accounts: shifting toward taxable retires you earlier, or
  // makes retirement possible at all when the pre-59.5 bridge is currently never funded.
  if (totalTaxAdv > 0 && alt != null && (cur == null || cur - alt > 0.25)) {
    let lo = 0, hi = 1;                                       // smallest shift that captures the gain
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const f = simulate({ ...p, ...shift(mid) }).fireCross;
      if (f != null && f <= alt + 0.1) hi = mid; else lo = mid;
    }
    return {
      dir: "toTaxable",
      amount: Math.max(500, Math.round((totalTaxAdv * hi) / 500) * 500),
      years: cur == null ? null : cur - alt,
      newAge: alt,
      unlocks: cur == null,
    };
  }

  // Direction B — over-weighted to TAXABLE: you retire before 59.5 with liquid to spare, so routing
  // more saving into tax-advantaged accounts wouldn't push the date back (and those accounts carry tax
  // benefits this model does not price in). Only fires when the spare liquidity is clearly meaningful.
  if (cur != null && cur <= sim.accessYou && p.annualTakeHome > 10000) {
    const toAdv = simulate({ ...p, annualTaxAdv: p.annualTaxAdv + 10000, annualTakeHome: p.annualTakeHome - 10000 });
    const liquidSlack = (sim.fireTaxable ?? 0) - (sim.fireBridge ?? 0);
    if (toAdv.fireCross != null && toAdv.fireCross <= cur + 0.02 && liquidSlack > Math.max(250000, 2 * p.retirementSpendToday)) {
      return { dir: "toTaxAdv", slack: liquidSlack };
    }
  }
  return null;
};

// ---- the trajectory chart, driven entirely by props so it renders from a live sim OR a snapshot ----
function ChartPanel({ rows, xStart, END, ticks, underwaterSpans, accessYou, enforceAccess, unlockAtFire,
  partnerStopsAtAge, expenseMarks, coastTarget, homeRows, kidRows, coastCross, coastCrossValue, fireCross, fireCrossValue, show, setShow }) {
  // ONE unlock line marking the real liquidity wall: the statutory 59.5 normally, or the earlier
  // retire+5 when a Roth ladder is on (unlockYouAtFire already encodes both; fall back to 59.5 when
  // there's no retirement instant to shorten it).
  const wallAt = unlockAtFire ?? accessYou;
  const wallShifted = wallAt < accessYou - 0.05;   // a ladder pulled it in front of 59.5
  const showPartnerStops = partnerStopsAtAge != null;
  // a series earns a legend entry only when it actually appears on this chart — no point offering to
  // toggle "child born" with no kids, "the 59.5 line" with the gate off, or "retirement point" if you
  // never retire. The always-present curves stay; the conditional marks/lines come and go with the data.
  const applies = {
    portfolio: true, required: true, taxable: true, retirement: true, coast: true,
    retire: fireCross != null,
    bridge: !!enforceAccess,
    neededRetirement: !!enforceAccess,
    access: !!enforceAccess,
    partnerStops: showPartnerStops,
    underwater: underwaterSpans.length > 0,
    home: homeRows.length > 0,
    kids: kidRows.length > 0,
    expense: (expenseMarks && expenseMarks.length > 0),
  };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 14px 8px" }}>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
          <CartesianGrid stroke={C.line} vertical={false} />
          {/* shade every stretch where spendable cash is negative — drawn first so it sits behind the curves */}
          {show.underwater ? underwaterSpans.map(([a, b], i) => (
            <ReferenceArea key={`uw${i}`} x1={a} x2={b} fill={C.coral} fillOpacity={0.14} stroke="none"
              label={i === 0 ? { value: "taxable < $0", fill: C.coral, fontSize: 10, position: "insideTopLeft" } : undefined} />
          )) : null}
          {show.underwater && underwaterSpans.length ? (
            <ReferenceLine y={0} stroke={`${C.coral}99`} strokeDasharray="2 3" />
          ) : null}
          <XAxis dataKey="age" type="number" domain={[xStart, END]} ticks={ticks}
            stroke={C.mute} tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
          <YAxis stroke={C.mute} tickFormatter={(v) => "$" + (v / 1e6).toFixed(1) + "M"}
            tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
          <Tooltip
            contentStyle={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
            labelStyle={{ color: C.brass }}
            formatter={(v, name) => [fmt(v), {
              portfolio: "Portfolio (total)", taxable: "Taxable (spendable now)",
              retirement: "Retirement accounts (401k/IRA)",
              required: "Needed in total", bridge: "Needed in taxable",
              neededRetirement: "Needed in retirement accounts",
              coast: `Coast bar (stop saving, retire at ${coastTarget})`,
            }[name] || name]}
            labelFormatter={(a) => "Age " + a}
          />
          {show.access && enforceAccess ? (
            <ReferenceLine x={wallAt} stroke={C.mute} strokeDasharray="2 4"
              label={{ value: wallShifted ? `unlock ${wallAt.toFixed(0)}` : `${accessYou}`, fill: C.mute, fontSize: 10, position: "top" }} />
          ) : null}
          {show.partnerStops && showPartnerStops ? (
            <ReferenceLine x={partnerStopsAtAge} stroke={C.brass} strokeDasharray="4 3"
              label={{ value: `partner stops ${partnerStopsAtAge.toFixed(0)}`, fill: C.brass, fontSize: 10, position: "insideTopRight" }} />
          ) : null}
          {show.coast ? <Line type="monotone" dataKey="coast" stroke={C.coast} strokeWidth={1.5} strokeDasharray="6 3" dot={false} connectNulls={false} /> : null}
          {show.required ? <Line type="monotone" dataKey="required" stroke={C.brass} strokeWidth={1.5} strokeDasharray="5 4" dot={false} /> : null}
          {show.bridge && enforceAccess ? <Line type="monotone" dataKey="bridge" stroke={C.coral} strokeWidth={1.5} strokeDasharray="3 3" dot={false} /> : null}
          {show.neededRetirement && enforceAccess ? <Line type="monotone" dataKey="neededRetirement" stroke={C.locked} strokeWidth={1.5} strokeDasharray="5 4" dot={false} /> : null}
          {show.retirement ? <Line type="monotone" dataKey="retirement" stroke={C.locked} strokeWidth={1.5} dot={false} /> : null}
          {show.taxable ? <Line type="monotone" dataKey="taxable" stroke={C.liquid} strokeWidth={1.5} dot={false} /> : null}
          {show.portfolio ? <Line type="monotone" dataKey="portfolio" stroke={C.teal} strokeWidth={2.5} dot={false} /> : null}
          {show.home ? homeRows.map((h) => <ReferenceDot key={h.age} x={h.age} y={h.portfolio} r={5} fill={C.brass} stroke={C.bg} />) : null}
          {show.kids ? kidRows.map((k) => <ReferenceDot key={k.age} x={k.age} y={k.portfolio} r={4} fill={C.ink} stroke={C.bg} />) : null}
          {show.expense && expenseMarks ? expenseMarks.map((m, i) => {
            const row = rows.find((r) => r.age === m.age);
            return row ? <ReferenceDot key={`x${i}`} x={m.age} y={row.portfolio} r={5} fill={m.amount < 0 ? C.liquid : C.coral} stroke={C.bg} strokeWidth={1.5} /> : null;
          }) : null}
          {show.coast && coastCross ? <ReferenceDot x={coastCross} y={coastCrossValue} r={5} fill={C.coast} stroke={C.bg} strokeWidth={2} /> : null}
          {show.retire && fireCross ? <ReferenceDot x={fireCross} y={fireCrossValue} r={7} fill={C.brass} stroke={C.ink} strokeWidth={2} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
      {/* the legend IS the control: click a series to show or hide it (only series that apply appear) */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "6px 6px 12px" }}>
        {SERIES.filter((s) => applies[s.key]).map((s) => {
          const on = show[s.key];
          return (
            <button
              key={s.key}
              onClick={() => setShow((v) => ({ ...v, [s.key]: !v[s.key] }))}
              title={on ? "hide" : "show"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                background: on ? `${s.color}1A` : "transparent",
                border: `1px solid ${on ? s.color : C.line}`,
                color: on ? C.ink : C.mute, borderRadius: 999, padding: "4px 10px",
                fontFamily: "'Space Grotesk', sans-serif", fontSize: 11, letterSpacing: ".02em",
                opacity: on ? 1 : 0.6,
              }}
            >
              <span style={{ color: s.color, fontSize: 13, lineHeight: 1 }}>
                {s.mark || (s.dash ? "┄" : "━")}
              </span>
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// the copy-to-clipboard Share control: one button, a popover with the two link kinds
function ShareMenu({ p, show, sim }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null);      // which kind was just copied
  const [manual, setManual] = useState(null);      // fallback URL to copy by hand, if the API fails
  const ref = React.useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const linkFor = (kind) => {
    const token = encodeShare(sharePayload(kind, { p, show, sim }));
    return window.location.origin + window.location.pathname + "#s=" + token;
  };
  const copy = async (kind) => {
    const url = linkFor(kind);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand failed");
      }
      setManual(null); setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1600);
    } catch {
      setManual(url);   // last resort: show the URL so it can be selected and copied manually
    }
  };

  const item = (kind, label, sub) => (
    <button onClick={() => copy(kind)} style={{
      display: "block", width: "100%", textAlign: "left", cursor: "pointer",
      background: "transparent", border: "none", color: C.ink, padding: "9px 12px",
      fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, borderRadius: 6,
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = `${C.teal}1A`)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      {copied === kind ? "✓ Copied!" : label}
      <span style={{ display: "block", fontSize: 11, color: C.mute, marginTop: 2 }}>{sub}</span>
    </button>
  );

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        background: C.teal, color: C.bg, border: "none", borderRadius: 8, cursor: "pointer",
        padding: "8px 14px", fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 500,
      }}>
        ⇪ Share
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 20, width: 260,
          background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 6,
          boxShadow: "0 10px 30px rgba(0,0,0,.45)",
        }}>
          {item("plot", "Copy plot-only link", "Just the chart — your numbers stay private")}
          {item("full", "Copy full-details link", "The whole calculator, pre-filled and editable")}
          {manual && (
            <div style={{ padding: "6px 8px" }}>
              <div style={{ fontSize: 11, color: C.mute, marginBottom: 4 }}>Copy this link manually:</div>
              <input readOnly value={manual} onFocus={(e) => e.target.select()} style={{
                width: "100%", boxSizing: "border-box", background: C.bg, color: C.ink,
                border: `1px solid ${C.line}`, borderRadius: 5, padding: "6px 8px",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// the read-only view a "plot only" link opens: just the chart, rebuilt from the snapshot, no inputs
function SharedPlot({ snap, isMobile }) {
  const [show, setShow] = useState({ ...defaultShow(), ...(snap.show || {}) });
  const rows = useMemo(() => rehydrateRows(snap), [snap]);
  const underwaterSpans = useMemo(() => underwaterOf(rows, snap.END), [rows, snap.END]);
  const homeRows = rows.filter((r) => r.events.includes("home"));
  const kidRows = rows.filter((r) => r.events.includes("kid"));
  const ticks = []; for (let a = 30; a <= snap.END; a += 10) ticks.push(a);
  const xStart = snap.ages[0];

  return (
    <div style={{ background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: isMobile ? 12 : 24, borderRadius: 12 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');`}</style>
      <div style={{ borderBottom: `1px solid ${C.line}`, paddingBottom: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: ".2em", color: C.brass, textTransform: "uppercase", marginBottom: 6 }}>
          Shared projection · read-only
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>
          A FIRE trajectory someone shared with you
        </h1>
        <p style={{ margin: "8px 0 0", color: C.mute, fontSize: 14, maxWidth: 680 }}>
          This is the chart only — the underlying inputs were kept private and are not part of this link.
          Toggle any series in the legend below.
        </p>
      </div>
      <ChartPanel
        rows={rows} xStart={xStart} END={snap.END} ticks={ticks} underwaterSpans={underwaterSpans}
        accessYou={snap.accessYou} enforceAccess={snap.enforceAccess} unlockAtFire={snap.unlockAtFire}
        partnerStopsAtAge={snap.partnerStopsAtAge} expenseMarks={snap.expenseMarks} coastTarget={snap.coastTarget}
        homeRows={homeRows} kidRows={kidRows}
        coastCross={snap.coastCross} coastCrossValue={snap.coastCrossValue}
        fireCross={snap.fireCross} fireCrossValue={snap.fireCrossValue}
        show={show} setShow={setShow}
      />
      <div style={{ marginTop: 22, display: "flex", justifyContent: "center" }}>
        <button
          onClick={() => window.location.assign(window.location.pathname)}
          onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
          style={{
            background: C.teal, color: C.bg, border: "none", borderRadius: 10, cursor: "pointer",
            padding: "14px 28px", fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 600,
            letterSpacing: ".02em", boxShadow: "0 6px 22px rgba(95,176,166,.28)",
          }}
        >
          Build your own projection →
        </button>
      </div>
    </div>
  );
}

export default function FireModel() {
  const isMobile = useMediaQuery("(max-width: 720px)");
  // read any shared state from the URL once. A "plot only" link opens straight into the read-only
  // snapshot view (no inputs, no simulate()); everything else renders the full calculator.
  const shared = useMemo(() => decodeShare(typeof window !== "undefined" ? window.location.hash : ""), []);
  return shared && shared.mode === "plot" && shared.snap
    ? <SharedPlot snap={shared.snap} isMobile={isMobile} />
    : <Calculator shared={shared} isMobile={isMobile} />;
}

function Calculator({ shared, isMobile }) {
  // a "full details" link pre-fills the whole calculator; anything not in the link falls back to defaults
  const [p, setP] = useState(() => (shared && shared.mode === "full" ? { ...DEFAULTS, ...shared.p } : DEFAULTS));
  const [show, setShow] = useState(() => ({ ...defaultShow(), ...(shared && shared.mode === "full" ? shared.show : null) }));
  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));
  const setPct = (k, v) => setP((s) => ({ ...s, [k]: v / 100 }));

  // --- add / edit / drop homes and kids -------------------------------------
  const setHome = (i, k, v) =>
    setP((s) => ({ ...s, homes: s.homes.map((h, j) => (j === i ? { ...h, [k]: v } : h)) }));
  const addHome = () =>
    setP((s) => {
      const last = s.homes[s.homes.length - 1];
      return { ...s, homes: [...s.homes, {
        // a sensible next home: same terms, bought a few years after the previous one
        price: last ? last.price : 800000,
        purchaseAge: last ? last.purchaseAge + 5 : s.currentAge + 3,
        downPct: last ? last.downPct : 0.20,
        rate: last ? last.rate : 0.065,
        term: last ? last.term : 30,
        closingPct: last ? last.closingPct : 0.02,
        propTaxRate: last ? last.propTaxRate : 0.011,
        insMaintRate: last ? last.insMaintRate : 0.013,
      }] };
    });
  const dropHome = (i) => setP((s) => ({ ...s, homes: s.homes.filter((_, j) => j !== i) }));
  const setKid = (i, v) =>
    setP((s) => ({ ...s, kids: s.kids.map((k, j) => (j === i ? { birthAge: v } : k)) }));
  const addKid = () =>
    setP((s) => {
      const last = s.kids[s.kids.length - 1];
      return { ...s, kids: [...s.kids, { birthAge: last ? last.birthAge + 2 : s.currentAge + 2 }] };
    });
  const dropKid = (i) => setP((s) => ({ ...s, kids: s.kids.filter((_, j) => j !== i) }));

  // --- one-off expenses -----------------------------------------------------
  const setExpense = (i, k, v) =>
    setP((s) => ({ ...s, expenses: s.expenses.map((e, j) => (j === i ? { ...e, [k]: v } : e)) }));
  const addExpense = () =>
    setP((s) => ({ ...s, expenses: [...(s.expenses || []), { label: "", age: Math.min(s.currentAge + 3, s.endAge), amount: 30000, until: null }] }));
  const dropExpense = (i) => setP((s) => ({ ...s, expenses: s.expenses.filter((_, j) => j !== i) }));

  // --- debts ----------------------------------------------------------------
  const setDebt = (i, k, v) =>
    setP((s) => ({ ...s, debts: s.debts.map((d, j) => (j === i ? { ...d, [k]: v } : d)) }));
  const addDebt = () =>
    setP((s) => ({ ...s, debts: [...(s.debts || []), { label: "", balance: 25000, apr: 6, payment: 400, startAge: s.currentAge }] }));
  const dropDebt = (i) => setP((s) => ({ ...s, debts: s.debts.filter((_, j) => j !== i) }));

  // --- guaranteed retirement income (pension / Social Security / annuity) ---
  const setIncome = (i, k, v) =>
    setP((s) => ({ ...s, incomes: (s.incomes || []).map((inc, j) => (j === i ? { ...inc, [k]: v } : inc)) }));
  const addIncome = () =>
    setP((s) => ({ ...s, incomes: [...(s.incomes || []), { label: "", amount: 30000, startAge: 65, whose: "you", cola: true, until: null }] }));
  const dropIncome = (i) => setP((s) => ({ ...s, incomes: (s.incomes || []).filter((_, j) => j !== i) }));

  const sim = useMemo(() => simulate(p), [p]);
  // the same world with the 59.5 gate switched off — the difference IS the cost of the rule
  const simFree = useMemo(() => simulate({ ...p, enforceAccess: false }), [p]);
  const delay = sim.fireCross && simFree.fireCross ? sim.fireCross - simFree.fireCross : null;

  const homeRows = sim.rows.filter((r) => r.events.includes("home"));
  const kidRows = sim.rows.filter((r) => r.events.includes("kid"));

  // contiguous age windows where the taxable (spendable) account is underwater — bills are being
  // met with debt / an early-withdrawal penalty, not real cash. Drives the shaded band on the chart.
  const underwaterSpans = useMemo(() => {
    const spans = [];
    let start = null;
    for (const r of sim.rows) {
      if (r.taxable < 0 && start == null) start = r.age;
      else if (r.taxable >= 0 && start != null) { spans.push([start, r.age]); start = null; }
    }
    if (start != null) spans.push([start, sim.END]);
    return spans;
  }, [sim]);
  const neverRetire = sim.fireCross == null;
  // WHY you're stuck — three genuinely different failures, and the fix differs for each:
  //  • bridge     — enough in total AND enough liquid; only the 59.5 wall blocks you (gate-off retires)
  //  • insolvent  — total wealth does reach the requirement, but spendable cash is underwater, so you'd
  //                 be retiring on debt (gate-off still can't retire because taxable never clears $0)
  //  • tooPoor    — total wealth never reaches the requirement at any age
  const totalEverEnough = sim.rows.some((r) => r.portfolio >= r.required);
  const blockedByBridge = neverRetire && simFree.fireCross != null;
  const blockedByDebt = neverRetire && !blockedByBridge && totalEverEnough && underwaterSpans.length > 0;
  const kidsCount = p.kids.length;
  const cap529 = kidsCount * 19000;

  // The mirror image of "never retire": you're already there. The crossing is clamped at today because
  // the household is over-funded on day one, so the solver can't move it any earlier to bleed off the
  // slack — the pot just compounds instead of drawing down to $0 at the horizon. Worth an explicit
  // banner, because "retire at 26.0 / 0.0 years from now" over a pot that then balloons to millions
  // reads like a glitch otherwise.
  const retireToday = sim.fireCross != null && sim.fireCross <= p.currentAge + 1e-6;
  // Need<0 today means the discounted value of your FUTURE INCOME already exceeds your future spending —
  // i.e. income, not the pot, is what carries you. Almost always this is a partner still earning.
  const incomeCovers = (sim.rows[0]?.required ?? 0) < 0;
  const partnerCarrying = retireToday && incomeCovers && p.partnerWorksAfterRetire && sim.hasPartner;
  const interimLiving = p.interimLivingToday ?? p.nonHousingLiving;   // household living while a partner still works

  // tax-advantaged vs. taxable allocation advice — grounded by re-running the model (see the exported
  // allocationAdvice() for the full reasoning), so it's not a rule of thumb.
  const allocAdvice = useMemo(() => allocationAdvice(p), [p]);

  // --- what actually moves the needle -------------------------------------
  // simulate() is pure and cheap, so instead of guessing at advice we re-run the whole model
  // once per lever and report what each one is really worth, in years of retirement.
  const levers = useMemo(() => {
    if (sim.fireCross == null) return [];
    const defs = [
      { label: "Real return +1pt", assumption: true, over: { nominalReturn: p.nominalReturn + 0.01 } },
      { label: "Inflation +1pt", assumption: true, over: { inflation: p.inflation + 0.01 } },
      { label: "Retirement spend −$10k/yr", over: { retirementSpendToday: Math.max(0, p.retirementSpendToday - 10000) } },
      { label: "Your take-home +$10k/yr", over: { annualTakeHome: p.annualTakeHome + 10000 } },
      { label: "Living costs −$5k/yr", over: { nonHousingLiving: Math.max(0, p.nonHousingLiving - 5000) } },
      ...(p.partnerAge > 0 && p.partnerEnabled !== false
        ? [{ label: "Partner take-home +$10k/yr", over: { partnerIncome: p.partnerIncome + 10000 } }] : []),
      ...(p.homes.length
        ? [{ label: p.homes.length > 1 ? "Every home −$100k" : "Home price −$100k",
             over: { homes: p.homes.map((h) => ({ ...h, price: Math.max(0, h.price - 100000) })) } }] : []),
      ...(p.homes.length
        ? [{ label: "Mortgage rate −1pt",
             over: { homes: p.homes.map((h) => ({ ...h, rate: Math.max(0, h.rate - 0.01) })) } }] : []),
      ...(kidsCount
        ? [{ label: "College −$50k/kid", over: { collegePerKid: Math.max(0, p.collegePerKid - 50000) } }] : []),
      { label: "Move $10k/yr from 401k → taxable",
        over: { annualTaxAdv: Math.max(0, p.annualTaxAdv - 10000), annualTakeHome: p.annualTakeHome + 10000 } },
    ];
    return defs
      .map((d) => {
        const alt = simulate({ ...p, ...d.over });
        return { ...d, delta: alt.fireCross == null ? null : alt.fireCross - sim.fireCross };
      })
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  }, [p, sim.fireCross]);

  const maxLever = Math.max(...levers.map((l) => Math.abs(l.delta ?? 0)), 0.01);
  const bestBehaviour = Math.max(...levers.filter((l) => !l.assumption).map((l) => Math.abs(l.delta ?? 0)), 0);
  const topLever = levers[0];
  // if the biggest mover is a market assumption rather than anything you decide, say so plainly
  const assumptionRules = topLever?.assumption && Math.abs(topLever.delta) > bestBehaviour;
  const ticks = []; for (let a = 30; a <= sim.END; a += 10) ticks.push(a);

  const Stat = ({ label, value, accent }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: C.mute, letterSpacing: ".05em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, color: accent || C.ink }}>{value}</span>
    </div>
  );

  const Toggle = ({ on, onClick, label, sub }) => (
    <button
      onClick={onClick}
      style={{
        background: on ? C.teal : C.bg, color: on ? C.bg : C.mute,
        border: `1px solid ${on ? C.teal : C.line}`, borderRadius: 6, padding: "8px 10px",
        cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", fontSize: 12,
        letterSpacing: ".03em", textAlign: "left", width: "100%",
      }}
    >
      {on ? "◉" : "○"} {label}
      {sub && <span style={{ display: "block", fontSize: 10, opacity: 0.75, marginTop: 2 }}>{sub}</span>}
    </button>
  );

  return (
    <div style={{ background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: isMobile ? 12 : 24, borderRadius: 12 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');`}</style>

      <div style={{ borderBottom: `1px solid ${C.line}`, paddingBottom: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div style={{ fontSize: 11, letterSpacing: ".2em", color: C.brass, textTransform: "uppercase", marginBottom: 6 }}>
              Financial independence · trajectory model
            </div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, lineHeight: 1.15 }}>
              The number that actually lasts — and that you can actually touch
            </h1>
          </div>
          <ShareMenu p={p} show={show} sim={sim} />
        </div>
        <p style={{ margin: "8px 0 0", color: C.mute, fontSize: 14, maxWidth: 680 }}>
          Age {p.currentAge} to {sim.END}, all in <em>today's dollars</em>. Retiring takes <b>two</b> things, and the
          model makes you clear both. The dashed brass curve is the total you'd need for the money to survive the
          horizon. The dashed coral curve is the <em>bridge</em>: the slice that must sit in a taxable account, because
          401k/IRA dollars are locked until 59.5. You retire where the pale line clears coral <em>and</em> teal clears
          brass — whichever binds last.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(240px, 300px) 1fr", gap: isMobile ? 18 : 24, alignItems: "start" }}>
        {/* INPUTS */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {[
            ["You", [
              ["Current age", "currentAge", { yearRef: p.currentAge }],
              ["Current portfolio ← your real #", "startPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "startPortfolioTaxAdv", { step: 10000, max: p.startPortfolio }],
              ["Take-home / yr (after contrib.)", "annualTakeHome", { step: 1000 }],
              ["Tax-advantaged / yr (401k+HSA+IRA)", "annualTaxAdv", { step: 500 }],
              ["Non-housing living / yr", "nonHousingLiving", { step: 1000 }],
              ["Current rent / yr", "rentAnnual", { step: 1000 }],
            ]],
            ["Partner", [
              ["Partner's age now (0 = single)", "partnerAge", { yearRef: p.partnerAge }],
              ["Partner portfolio", "partnerPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "partnerPortfolioTaxAdv", { step: 10000, max: p.partnerPortfolio }],
              ["Partner take-home / yr", "partnerIncome", { step: 5000 }],
              ["Partner tax-advantaged / yr", "partnerTaxAdv", { step: 500 }],
              ["Partner earns from their age", "partnerStart", { min: p.partnerAge, yearRef: p.partnerAge }],
              ["…until their age", "partnerEnd", { min: p.partnerStart, yearRef: p.partnerAge }],
            ]],
            ["Retirement", [
              ["Retirement spend / yr — excl. housing", "retirementSpendToday", { step: 5000 }],
              ["Money must last to age", "endAge", { yearRef: p.currentAge }],
              ["Coast FIRE: retire at age", "coastAge", { yearRef: p.currentAge }],
            ]],
          ].map(([group, fields]) => (
            <div key={group} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>{group}</span>
                {group === "Partner" && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, color: C.mute, letterSpacing: ".03em" }}>
                    <input type="checkbox" checked={p.partnerEnabled !== false}
                      onChange={(e) => set("partnerEnabled", e.target.checked)}
                      style={{ accentColor: C.teal, cursor: "pointer", width: 15, height: 15 }} />
                    {p.partnerEnabled !== false ? "included" : "no partner"}
                  </label>
                )}
              </div>
              {!(group === "Partner" && p.partnerEnabled === false) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fields.map(([l, k, o]) => field(l, k, p[k], set, o))}
              </div>
              )}

              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.line}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!p.partnerWorksAfterRetire}
                      onChange={(e) => set("partnerWorksAfterRetire", e.target.checked)}
                      style={{ accentColor: C.teal, cursor: "pointer", width: 15, height: 15, marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: C.ink, lineHeight: 1.4 }}>
                      Partner keeps working after you retire
                      <span style={{ display: "block", fontSize: 10, color: C.mute, marginTop: 2 }}>
                        Their income (to their age {p.partnerEnd}) funds the household, so you can retire sooner.
                      </span>
                    </span>
                  </label>
                  {p.partnerWorksAfterRetire &&
                    field("Non-housing living / yr while they work", "interimLivingToday", p.interimLivingToday ?? p.nonHousingLiving, set, { step: 1000 })}
                </div>
              )}

              {/* the locked slice cannot exceed the pot it is a slice of — this fires if the
                  portfolio is later lowered beneath a 401k figure that was already valid */}
              {group === "You" && p.startPortfolioTaxAdv > p.startPortfolio && (
                <Warn>
                  Your 401k/IRA (<b>{fmt(p.startPortfolioTaxAdv)}</b>) is more than your whole portfolio
                  (<b>{fmt(p.startPortfolio)}</b>). The model caps it at the portfolio, so all of it counts as
                  locked and <b>nothing is taxable</b> — which will strand your bridge. Raise the portfolio or
                  lower the 401k figure.
                </Warn>
              )}
              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && p.partnerPortfolioTaxAdv > p.partnerPortfolio && (
                <Warn>
                  Your partner's 401k/IRA (<b>{fmt(p.partnerPortfolioTaxAdv)}</b>) is more than their whole
                  portfolio (<b>{fmt(p.partnerPortfolio)}</b>). The model caps it at the portfolio — all locked,
                  none taxable.
                </Warn>
              )}
              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && p.partnerStart < p.partnerAge && (
                <Warn>
                  Your partner can't start earning at <b>{p.partnerStart}</b> — they're already{" "}
                  <b>{p.partnerAge}</b>. The model starts their income now, at <b>{p.partnerAge}</b>.
                </Warn>
              )}
              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && p.partnerEnd < p.partnerStart && (
                <Warn>
                  Their earning window ends (<b>{p.partnerEnd}</b>) before it starts (<b>{p.partnerStart}</b>).
                  Left alone that would pay them <b>nothing at all</b>; the model instead holds the end at{" "}
                  <b>{Math.max(p.partnerStart, p.partnerAge)}</b>. Raise the end age.
                </Warn>
              )}

              {group.startsWith("Partner") && p.partnerEnabled !== false && p.partnerAge > 0 && (
                <div style={{ fontSize: 10, color: C.mute, marginTop: 8, lineHeight: 1.6 }}>
                  <b style={{ color: C.ink }}>Every field above is in your partner's own age.</b>{" "}
                  {sim.partnerOffset === 0
                    ? "They're the same age as you, so the two clocks agree."
                    : `They're ${Math.abs(sim.partnerOffset)}y ${sim.partnerOffset > 0 ? "younger" : "older"} than you, so their clock runs ${Math.abs(sim.partnerOffset)}y ${sim.partnerOffset > 0 ? "behind" : "ahead"} of yours.`}
                  <br />
                  Their 401k opens at their {p.accessAge} — when you are{" "}
                  <span style={{ color: C.brass }}>{sim.accessPartner.toFixed(1)}</span>.
                  {sim.partnerStopsAtAge != null ? (
                    <> You retire first; they keep earning until they're <b>{p.partnerEnd}</b> — your age{" "}
                      <span style={{ color: C.brass }}>{sim.partnerStopsAtAge.toFixed(1)}</span>.</>
                  ) : sim.partnerAgeAtFire != null ? (
                    <> You retire together when they are{" "}
                      <span style={{ color: C.brass }}>{sim.partnerAgeAtFire.toFixed(1)}</span>.</>
                  ) : null}
                  {sim.partnerOffset > 0 && (
                    <> The money must last until they reach {p.endAge} — your age{" "}
                      <span style={{ color: C.brass }}>{sim.END}</span>.</>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* HOMES — any number, each with its own loan */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Homes {p.homes.length > 0 && <span style={{ color: C.mute }}>· {p.homes.length}</span>}
              </div>
              <AddButton onClick={addHome} label="add home" />
            </div>
            {p.homes.length === 0 && (
              <div style={{ fontSize: 11, color: C.mute }}>
                Renting forever at {fmt(p.rentAnnual)}/yr. Add a home to take on a mortgage.
              </div>
            )}
            {p.homes.map((h, i) => {
              const m = sim.homes[i];
              return (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: C.brass, letterSpacing: ".06em", textTransform: "uppercase" }}>
                      Home {i + 1}
                    </span>
                    <DropButton onClick={() => dropHome(i)} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Num label="Price" value={h.price} step={25000} onChange={(v) => setHome(i, "price", v)} />
                    <Num label="Buy at your age" value={h.purchaseAge} yearRef={p.currentAge} onChange={(v) => setHome(i, "purchaseAge", v)} />
                    <Num label="Down %" value={h.downPct} pct step={1} onChange={(v) => setHome(i, "downPct", v)} />
                    <Num label="Rate %" value={h.rate} pct step={0.125} onChange={(v) => setHome(i, "rate", v)} />
                    <Num label="Term (yrs)" value={h.term} onChange={(v) => setHome(i, "term", v)} />
                    <Num label="Closing %" value={h.closingPct} pct step={0.5} onChange={(v) => setHome(i, "closingPct", v)} />
                    <Num label="Prop tax %" value={h.propTaxRate} pct step={0.1} onChange={(v) => setHome(i, "propTaxRate", v)} />
                    <Num label="Ins + maint %" value={h.insMaintRate} pct step={0.1} onChange={(v) => setHome(i, "insMaintRate", v)} />
                  </div>
                  {m && (
                    <div style={{ fontSize: 10, color: C.mute, marginTop: 8, lineHeight: 1.6 }}>
                      cash at closing <b style={{ color: C.ink }}>{fmt(m.down)}</b> ·
                      P&I <b style={{ color: C.ink }}>{fmt(m.mPI)}</b>/yr ·
                      carry <b style={{ color: C.ink }}>{fmt(m.carryAtBuy)}</b>/yr ·
                      clear at <b style={{ color: C.brass }}>age {m.payoff}</b>
                      {h.purchaseAge < p.currentAge && (
                        <> · <span style={{ color: C.brass }}>bought before today</span> — the {fmt(m.down)} closing cash
                        is assumed already paid; only the remaining carry and mortgage are modeled.</>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* KIDS — any number, each with their own birth year */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Kids {kidsCount > 0 && <span style={{ color: C.mute }}>· {kidsCount}</span>}
              </div>
              <AddButton onClick={addKid} label="add kid" />
            </div>
            {kidsCount === 0 && <div style={{ fontSize: 11, color: C.mute }}>No kids — no daycare, no college.</div>}
            {p.kids.map((k, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <Num label={`Kid ${i + 1} — your age at birth`} value={k.birthAge} yearRef={p.currentAge} onChange={(v) => setKid(i, v)} />
                </div>
                <DropButton onClick={() => dropKid(i)} />
              </div>
            ))}
            {kidsCount > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 2 }}>
                {field("Daycare / kid / yr (ages 0–5)", "daycarePerKid", p.daycarePerKid, set, { step: 1000 })}
                {field("Ongoing / kid / yr (ages 6–17)", "ongoingPerKid", p.ongoingPerKid, set, { step: 1000 })}
                {field("College / kid (today's $)", "collegePerKid", p.collegePerKid, set, { step: 10000 })}
              </div>
            )}
          </div>

          {/* MAJOR EXPENSES — one-off lumps in today's $; +cost / −windfall; optional window */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Major expenses {p.expenses.length > 0 && <span style={{ color: C.mute }}>· {p.expenses.length}</span>}
              </div>
              <AddButton onClick={addExpense} label="add expense" />
            </div>
            {p.expenses.length === 0 && (
              <div style={{ fontSize: 11, color: C.mute }}>
                Weddings, medical, a car, a windfall. <b>+</b> is a cost, <b>−</b> is money in (inheritance, gift, home sale).
              </div>
            )}
            {p.expenses.map((e, i) => (
              <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <TextField label="what" value={e.label} placeholder="wedding, medical…" onChange={(v) => setExpense(i, "label", v)} />
                  </div>
                  <DropButton onClick={() => dropExpense(i)} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <Num label="at your age" value={e.age} step={1} yearRef={p.currentAge} onChange={(v) => setExpense(i, "age", v)} />
                  <Num label="amount (today's $)" value={e.amount} step={1000} min={-1e12} onChange={(v) => setExpense(i, "amount", v)} />
                  <Num label="until age (blank=one-off)" value={e.until ?? ""} step={1} yearRef={p.currentAge} onChange={(v) => setExpense(i, "until", v || null)} />
                </div>
                {(() => {
                  const a0 = Math.round(e.age), a1 = e.until ? Math.round(e.until) : a0;
                  const win = e.until && a1 > a0;
                  const pastStart = a0 < p.currentAge;
                  // fully before today: already reflected in your current portfolio, so it changes nothing
                  if (a1 < p.currentAge) return (
                    <div style={{ fontSize: 10, color: C.mute }}>
                      Before today — assumed already reflected in your current portfolio, so it won't change the projection.
                    </div>
                  );
                  if (win) return (
                    <div style={{ fontSize: 10, color: C.mute }}>
                      {fmt(Math.abs(e.amount))}/yr {e.amount < 0 ? "in" : "out"} from age {a0} to {a1}.
                      {pastStart && <> Only age {p.currentAge}+ is counted — earlier years are already in your current portfolio.</>}
                    </div>
                  );
                  return null;
                })()}
              </div>
            ))}
          </div>

          {/* RETIREMENT INCOME — pensions / Social Security / annuities: streams, not pots. They lower the
              requirement and shrink the pre-59.5 bridge (spendable cash), rather than adding to the pot. */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Retirement income {p.incomes?.length > 0 && <span style={{ color: C.mute }}>· {p.incomes.length}</span>}
              </div>
              <AddButton onClick={addIncome} label="add income" />
            </div>
            {(p.incomes?.length ?? 0) === 0 && (
              <div style={{ fontSize: 11, color: C.mute }}>
                Pension, Social Security, an annuity — guaranteed income you'll draw <em>in</em> retirement. It lowers the
                number you need and, being spendable cash, shrinks the 59.5 bridge. A pot (a lump-sum payout, a rollover)
                is not this — add that to your portfolio instead.
              </div>
            )}
            {(p.incomes || []).map((inc, i) => {
              const onPartner = inc.whose === "partner";
              const refAge = onPartner ? p.partnerAge : p.currentAge;
              return (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <TextField label="what" value={inc.label} placeholder="pension, Social Security…" onChange={(v) => setIncome(i, "label", v)} />
                    </div>
                    <DropButton onClick={() => dropIncome(i)} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <Num label="annual (today's $)" value={inc.amount} step={1000} onChange={(v) => setIncome(i, "amount", v)} />
                    <Num label={onPartner ? "starts at their age" : "starts at your age"} value={inc.startAge} step={1} yearRef={refAge} onChange={(v) => setIncome(i, "startAge", v)} />
                    <Num label="until age (blank=life)" value={inc.until ?? ""} step={1} yearRef={refAge} onChange={(v) => setIncome(i, "until", v || null)} />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: C.ink, cursor: "pointer" }}>
                      <input type="checkbox" checked={inc.cola !== false} onChange={(e) => setIncome(i, "cola", e.target.checked)} />
                      adjusts with inflation (COLA)
                    </label>
                    {sim.hasPartner && (
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: C.ink, cursor: "pointer" }}>
                        <input type="checkbox" checked={onPartner} onChange={(e) => setIncome(i, "whose", e.target.checked ? "partner" : "you")} />
                        partner's
                      </label>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: C.mute }}>
                    {(+inc.amount || 0) === 0
                      ? "Enter an annual amount."
                      : <>{fmt(Math.abs(+inc.amount))}/yr {inc.cola === false ? "fixed in nominal $ (real value erodes)" : "in today's $ (keeps pace with inflation)"},
                          from {onPartner ? "their" : "your"} age {Math.round(inc.startAge)}{inc.until ? ` to ${Math.round(inc.until)}` : " for life"}.</>}
                  </div>
                </div>
              );
            })}
            {sim.incomePV > 0 && (
              <div style={{ fontSize: 11, color: C.mute, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
                Together this guaranteed income is worth about <b style={{ color: C.teal }}>{fmtM(sim.incomePV)}</b> of portfolio
                today — that's how much of "the number" it replaces.
              </div>
            )}
          </div>

          {/* DEBTS — fixed-nominal loans: balance + APR + the monthly payment you make → payoff age */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Debts {p.debts.length > 0 && <span style={{ color: C.mute }}>· {p.debts.length}</span>}
              </div>
              <AddButton onClick={addDebt} label="add debt" />
            </div>
            {p.debts.length === 0 && (
              <div style={{ fontSize: 11, color: C.mute }}>
                Student, car, personal loans. Enter the balance, rate, and what you pay each month — the payoff age is derived.
              </div>
            )}
            {p.debts.map((d, i) => {
              const payoff = sim.debtPayoffs[i];
              return (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <TextField label="what" value={d.label} placeholder="student loan, car…" onChange={(v) => setDebt(i, "label", v)} />
                    </div>
                    <DropButton onClick={() => dropDebt(i)} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <Num label="balance now ($)" value={d.balance} step={1000} onChange={(v) => setDebt(i, "balance", v)} />
                    <Num label="APR %" value={d.apr} step={0.25} onChange={(v) => setDebt(i, "apr", v)} />
                    <Num label="payment / mo ($)" value={d.payment} step={50} onChange={(v) => setDebt(i, "payment", v)} />
                  </div>
                  {d.balance > 0 && d.payment > 0 && (
                    payoff != null
                      ? <div style={{ fontSize: 10, color: C.mute }}>Clears at <b style={{ color: C.brass }}>age {payoff.toFixed(1)}</b> · {fmt(d.payment * 12)}/yr while it runs.</div>
                      : <Warn>Your <b>{fmt(d.payment)}/mo</b> doesn't cover the interest at {d.apr}% — this debt never clears. Raise the payment.</Warn>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>Access to retirement accounts</div>
            <Toggle on={p.enforceAccess} onClick={() => set("enforceAccess", !p.enforceAccess)}
              label="Enforce the 59.5 rule"
              sub={p.enforceAccess ? "on — 401k/IRA can't pay bills before 59.5" : "off — every dollar spendable at any age (optimistic)"} />
            <Toggle on={p.rothLadder} onClick={() => set("rothLadder", !p.rothLadder)}
              label="Roth conversion ladder"
              sub={p.rothLadder ? "on — converted funds free after 5 years, so you bridge 5y not to 59.5" : "off — hard gate at 59.5"} />
          </div>

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>College funding</div>
            <Toggle on={p.collegeSpread} onClick={() => set("collegeSpread", !p.collegeSpread)}
              label="Spread tuition over 4 years"
              sub={p.collegeSpread ? "on — quarter each at ages 18–21" : "off — single lump at 18"} />
            <Toggle on={p.use529} onClick={() => set("use529", !p.use529)}
              label="Pre-fund with a 529"
              sub={p.use529 ? "on — college paid from 529 first" : "off — paid from main portfolio"} />
            {p.use529 && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
                  529 set-aside / yr (today's $) · cap ${cap529.toLocaleString()}
                </span>
                <NumberInput
                  value={p.annual529} step={1000} max={cap529}
                  onCommit={(v) => set("annual529", v)}
                />
                <span style={{ fontSize: 10, color: C.mute }}>
                  gift-tax-free max ${cap529.toLocaleString()} ({kidsCount}× $19k single donor); married/superfunding allows more
                </span>
              </label>
            )}
          </div>

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>Assumptions</div>
            {[
              ["Real portfolio return (nominal %)", "nominalReturn"],
              ["Inflation %", "inflation"],
              ["Safe withdrawal rate %", "swr"],
            ].map(([l, k]) => (
              <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
                  {l} · <span style={{ color: C.brass }}>{(p[k] * 100).toFixed(1)}</span>
                </span>
                <input type="range" min={k === "swr" ? 2.5 : k === "inflation" ? 1 : 3}
                  max={k === "swr" ? 5 : k === "inflation" ? 6 : 10} step={0.1}
                  value={p[k] * 100} onChange={(e) => setPct(k, Number(e.target.value))}
                  style={{ accentColor: C.brass }} />
              </label>
            ))}
          </div>
        </div>

        {/* OUTPUT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 18 }}>
            <Stat label={`FIRE number · lasts to ${sim.END}`} value={sim.fireCrossValue ? fmtM(sim.fireCrossValue) : "—"} accent={neverRetire ? C.coral : C.brass} />
            <Stat label="Retire at age" value={sim.fireCross ? sim.fireCross.toFixed(1) : "never"} accent={neverRetire ? C.coral : sim.fireCross <= 47 ? C.teal : C.ink} />
            <Stat label="Years from now" value={sim.fireCross ? (sim.fireCross - p.currentAge).toFixed(1) : "—"} />
            <Stat label={`Coast bar today · retire at ${sim.coastTarget}`} value={fmtM(sim.coastToday)} accent={C.coast} />
            <Stat label="Coast reached at" value={sim.coastCross ? sim.coastCross.toFixed(1) : "not yet"} accent={C.coast} />
            <Stat label="Liquid (taxable) at that point" value={sim.fireTaxable != null ? fmtM(sim.fireTaxable) : "—"} accent={C.liquid} />
            <Stat label="Locked until 59.5" value={sim.lockedShare ? (sim.lockedShare * 100).toFixed(0) + "%" : "—"} accent={sim.lockedShare > 0.6 ? C.coral : C.ink} />
            <Stat
              label={sim.homes.length > 1 ? "Last mortgage clear at" : "Mortgage clear at"}
              value={sim.lastPayoff ? `age ${sim.lastPayoff}` : "—"}
            />
            <Stat
              label={`Tightest saving year · age ${sim.minSaveAge ?? "—"}`}
              value={sim.minSave === Infinity ? "—" : fmt(sim.minSave)}
              accent={sim.minSave < 0 ? C.coral : C.ink}
            />
            {sim.incomePV > 0 && (
              <Stat label="Guaranteed income · worth" value={fmtM(sim.incomePV)} accent={C.teal} />
            )}
          </div>

          {neverRetire && (
            <div style={{ background: `${C.coral}1A`, border: `2px solid ${C.coral}`, borderRadius: 10, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontSize: 22, lineHeight: 1.1 }} aria-hidden>🚫</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.coral, marginBottom: 4, letterSpacing: ".01em" }}>
                  You never reach retirement on these inputs
                </div>
                <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
                  {blockedByBridge ? (
                    <>Your <b>total</b> wealth would be enough by age <b>{simFree.fireCross.toFixed(1)}</b>, but too much of
                      it is locked until 59.5 — the <b>taxable “bridge” never gets funded</b>, so the pot just compounds
                      untouched instead of ever supporting you. Shift savings from the 401k into a taxable account, turn on
                      the <b>Roth conversion ladder</b>, or switch off <b>“Enforce the 59.5 rule”</b>.</>
                  ) : blockedByDebt ? (
                    <>Your <b>total</b> wealth is more than enough, but your <b>spendable (taxable) cash is underwater</b> —
                      you’d be retiring on debt, so the model won’t let you stop. The surplus is trapped in retirement
                      accounts while your cash account stays negative. Move savings from the 401k into a taxable account,
                      or lower the years of heavy spending (home, kids, college) that drain it.</>
                  ) : (
                    <>Spending outruns saving across the whole horizon — <b>total wealth never covers the requirement</b>.
                      Lower the retirement budget, add income, or trim the home price.</>
                  )}
                  {underwaterSpans.length > 0 && (
                    <> Your spendable (taxable) cash goes <b style={{ color: C.coral }}>underwater at age {underwaterSpans[0][0]}</b> —
                      shaded on the chart below.</>
                  )}
                </div>
              </div>
            </div>
          )}

          {retireToday && (
            <div style={{ background: `${C.teal}1A`, border: `2px solid ${C.teal}`, borderRadius: 10, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontSize: 22, lineHeight: 1.1 }} aria-hidden>✅</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.teal, marginBottom: 4, letterSpacing: ".01em" }}>
                  You could stop working today
                </div>
                <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
                  {partnerCarrying ? (
                    <>Your own income isn't what's funding this — <b>your partner's is</b>. They keep earning until
                      you're <b>{sim.partnerStopsAtAge ?? "later"}</b>, and while they do the household is modelled as
                      living on the interim budget of <b>{fmt(interimLiving)}/yr</b> (non-housing) rather than the full{" "}
                      <b>{fmt(p.retirementSpendToday)}/yr</b> retirement budget. Their take-home more than covers that bill,
                      so the household is a <b>net saver even after you quit</b> — the pot is never drawn down, it{" "}
                      <b>grows to {fmtM(sim.end)}</b> by age {sim.END}. That's also why the brass{" "}
                      <em>“needed in total”</em> line dips <b>below zero</b>: the model is saying your future income alone
                      already outweighs your future spending.</>
                  ) : incomeCovers ? (
                    <>Your future income already outweighs your future spending, so the requirement (the brass line)
                      starts <b>below zero</b> and your pot is never drawn down — it <b>grows to {fmtM(sim.end)}</b> by
                      age {sim.END} instead of landing on $0.</>
                  ) : (
                    <>Your savings already clear the requirement on day one, so the model retires you now. Because it
                      can't retire you any <em>earlier</em> than today to spend the surplus down, the pot keeps
                      compounding — it <b>ends at {fmtM(sim.end)}</b> rather than $0.</>
                  )}
                  {partnerCarrying && (
                    <span style={{ display: "block", marginTop: 6, color: C.mute, fontSize: 12 }}>
                      So the “retire at {p.currentAge}” answer leans entirely on two assumptions: the partner working{" "}
                      {sim.partnerStopsAtAge ? `${(sim.partnerStopsAtAge - p.currentAge).toFixed(0)} more years` : "for years"},
                      and the household living on {fmt(interimLiving)}/yr until they stop. Raise <b>“living while a partner
                      still works”</b> toward your full retirement budget, or switch off <b>“partner keeps working after
                      you retire”</b>, and the date moves out realistically.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* only worth a banner when the rule actually costs something; otherwise it's wallpaper */}
          {delay != null && delay > 0.05 && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              <b>The 59.5 rule costs you {delay.toFixed(1)} years.</b> Ignoring it, you'd have enough in total at{" "}
              <b>{simFree.fireCross.toFixed(1)}</b> — but only {fmtM(sim.fireTaxable)} of the pot would be taxable
              against a bridge of {fmtM(sim.fireBridge)}, so you keep working until <b>{sim.fireCross.toFixed(1)}</b>.
              {!p.rothLadder && " A Roth conversion ladder shortens the bridge to 5 years — try the toggle."}
            </div>
          )}

          {allocAdvice?.dir === "toTaxable" && (
            <div style={{ background: `${C.liquid}14`, border: `1px solid ${C.liquid}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
              <b style={{ color: C.liquid }}>💧 You're over-weighted to locked accounts.</b>{" "}
              {allocAdvice.unlocks ? (
                <>Redirecting about <b>{fmt(allocAdvice.amount)}/yr</b> from your 401k/IRA into a plain
                  taxable account would let you retire at <b>age {allocAdvice.newAge.toFixed(1)}</b> — right now the
                  pre-59.5 bridge is never funded, so you never retire on these inputs.</>
              ) : (
                <>Redirecting about <b>{fmt(allocAdvice.amount)}/yr</b> from your 401k/IRA into a plain taxable
                  account would let you retire about <b>{allocAdvice.years.toFixed(1)} years earlier</b> (age{" "}
                  <b>{allocAdvice.newAge.toFixed(1)}</b>). Your date is gated by pre-59.5 liquidity, not by total wealth.</>
              )}
              <span style={{ display: "block", marginTop: 6, color: C.mute, fontSize: 12 }}>
                Trade-off: this model doesn't price the tax breaks of retirement accounts, so weigh the earlier date
                against the tax you'd give up by saving less pre-tax.
              </span>
            </div>
          )}

          {allocAdvice?.dir === "toTaxAdv" && (
            <div style={{ background: `${C.locked}14`, border: `1px solid ${C.locked}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
              <b style={{ color: C.locked }}>You have liquidity to spare.</b> You retire before 59.5 with about{" "}
              <b>{fmtM(allocAdvice.slack)}</b> more spendable cash than the bridge needs, so routing more of your
              saving into tax-advantaged accounts (401k/IRA) wouldn't push your retirement back — and those accounts
              carry tax benefits this model doesn't show.
            </div>
          )}

          {sim.illiquidAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              ⚠ Taxable cash goes negative at age <b>{sim.illiquidAge}</b> — a lump (house, college) lands with the
              money stuck in retirement accounts. In reality that's a loan or a 10% early-withdrawal penalty.
            </div>
          )}

          {sim.fireCross && sim.mortgageAtFire > 0 && (
            <div style={{ background: C.panel2, border: `1px solid ${C.brass}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              You'd retire still owing <b>{fmt(sim.mortgageAtFire)}/yr</b> of principal and interest across{" "}
              {sim.homes.filter((h) => sim.fireCross < h.payoff && sim.fireCross >= h.purchaseAge).length} live
              mortgage{sim.homes.filter((h) => sim.fireCross < h.payoff && sim.fireCross >= h.purchaseAge).length === 1 ? "" : "s"},
              the last clearing at <b>{sim.lastPayoff}</b> — which is why the number (<b>{fmtM(sim.fireCrossValue)}</b>)
              sits above the naive {fmtM(sim.naiveNumber)}.
            </div>
          )}

          <ChartPanel
            rows={sim.rows} xStart={p.currentAge} END={sim.END} ticks={ticks} underwaterSpans={underwaterSpans}
            accessYou={sim.accessYou} enforceAccess={p.enforceAccess} unlockAtFire={sim.unlockYouAtFire}
            partnerStopsAtAge={sim.partnerStopsAtAge} expenseMarks={sim.expenseMarks} coastTarget={sim.coastTarget}
            homeRows={homeRows} kidRows={kidRows}
            coastCross={sim.coastCross} coastCrossValue={sim.coastCrossValue}
            fireCross={sim.fireCross} fireCrossValue={sim.fireCrossValue}
            show={show} setShow={setShow}
          />

          {/* WHAT MOVES THE NEEDLE — each row is a full re-run of the model, not a rule of thumb */}
          {levers.length > 0 && (
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18 }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>
                What moves the needle
              </div>
              <p style={{ margin: "0 0 14px", fontSize: 12, color: C.mute }}>
                Years of retirement bought by changing one thing, everything else held fixed.
                <span style={{ color: C.teal }}> Teal = retire earlier.</span>
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {levers.map((l) => {
                  const d = l.delta;
                  const earlier = d != null && d < 0;
                  const col = d == null ? C.mute : Math.abs(d) < 0.05 ? C.mute : earlier ? C.teal : C.coral;
                  return (
                    <div key={l.label} style={{ display: "grid", gridTemplateColumns: "1fr 90px 46px", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 12, color: l.assumption ? C.brass : C.ink }}>
                        {l.label}{l.assumption && <span style={{ color: C.mute }}> · not your choice</span>}
                      </span>
                      <div style={{ height: 6, background: `${C.line}80`, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          width: `${Math.min(100, (Math.abs(d ?? 0) / maxLever) * 100)}%`,
                          height: "100%", background: col, borderRadius: 3,
                        }} />
                      </div>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: col, textAlign: "right" }}>
                        {d == null ? "—" : (d > 0 ? "+" : "") + d.toFixed(1) + "y"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {assumptionRules && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}`, fontSize: 12, color: C.ink, lineHeight: 1.6 }}>
                  ⚠ <b>Your retirement date is dominated by an assumption you don't control.</b>{" "}
                  “{topLever.label}” moves it <b>{Math.abs(topLever.delta).toFixed(1)} years</b> — more than any decision
                  you can make, the best of which is worth {bestBehaviour.toFixed(1)}y. Treat the headline age as a
                  midpoint, not a date: drag the return slider to see the range you're really planning inside.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
