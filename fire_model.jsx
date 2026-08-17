import React, { useState, useMemo, useEffect, useRef } from "react";
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
  // panel2 is deliberately translucent; popovers need a FULLY opaque surface or the page shows through
  tip: "#1B3037",
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

// ---- entry-unit conversions ------------------------------------------------
// People rarely know a figure in the exact shape the model stores (an annual, net, dollar amount).
// These pure helpers convert between how a value is SHOWN in a field and the ANNUAL value we store, so
// a field can offer /yr⇄/mo, $-of-income⇄%, or gross⇄net without the model ever knowing. Exported so
// the conversions can be unit-tested directly. `toAnnual` and `toShown` are exact inverses.
// A kid's display name: whatever was typed, else "Kid N". Exported so the model, the chart markers
// and the UI all label the same child the same way.
export const kidName = (kid, i) => {
  const n = (kid && typeof kid.name === "string" ? kid.name : "").trim();
  return n || `Kid ${i + 1}`;
};

export const toAnnual = (shown, unit) => (unit === "mo" ? shown * 12 : shown);      // /mo → /yr
export const toShown = (annual, unit) => (unit === "mo" ? annual / 12 : annual);    // /yr → /mo
// a contribution can be entered as "% of income" instead of dollars; base is the income it's a % of
export const dollarsFromPct = (pct, incomeAnnual) => (incomeAnnual * pct) / 100;
export const pctFromDollars = (dollars, incomeAnnual) => (incomeAnnual > 0 ? (dollars / incomeAnnual) * 100 : 0);
// gross salary → spendable take-home at a flat effective rate (clamped to a sane 0–100%)
export const netFromGross = (gross, effRatePct) => gross * (1 - Math.max(0, Math.min(100, effRatePct)) / 100);
export const grossFromNet = (net, effRatePct) => {
  const r = Math.max(0, Math.min(100, effRatePct)) / 100;
  return r >= 1 ? net : net / (1 - r);
};

// exported so the model can be exercised headlessly, without mounting the UI
// Every top-level numeric input, and the handful that are meaningfully "unset" rather than zero.
// The app now starts EMPTY — every box blank — so simulate() is called with "" in most of these on
// the very first render, and `"" + 5` is the string "5". Coercing once, up front, is what keeps a
// blank form from silently producing string arithmetic deep inside the model.
const NUMERIC_PARAMS = [
  "currentAge", "startPortfolio", "startPortfolioTaxAdv", "startCash",
  "annualTakeHome", "annualTaxAdv", "nonHousingLiving", "rentAnnual",
  "inflation", "nominalReturn", "cashReturn", "swr", "homeGrowth",
  "daycarePerKid", "ongoingPerKid", "collegePerKid", "annual529",
  "partnerAge", "partnerIncome", "partnerTaxAdv", "partnerPortfolio", "partnerPortfolioTaxAdv",
  "partnerCash", "partnerStart", "partnerEnd",
  "retirementSpendToday", "endAge", "coastAge", "effTaxRate", "ladderYears", "accessAge",
];
// these read through `??`, so a blank box has to stay null rather than collapsing to 0
const NULLABLE_PARAMS = ["interimLivingToday"];

export const normalizeParams = (p) => {
  const out = { ...p };
  for (const k of NUMERIC_PARAMS) {
    const v = out[k];
    if (v === null || v === undefined || v === "") { out[k] = 0; continue; }
    const n = +v;
    out[k] = Number.isFinite(n) ? n : 0;
  }
  for (const k of NULLABLE_PARAMS) {
    const v = out[k];
    out[k] = v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v;
  }
  return out;
};

// A plan needs, at minimum, an age to start from and a horizon past it. Below that there is no
// timeline to project along and every downstream number would be noise, so the model says so instead
// of inventing one. This is what lets the app open with an empty form and an empty chart.
export const isRunnable = (p) => {
  const q = normalizeParams(p);
  return q.currentAge > 0 && q.endAge > q.currentAge && q.nominalReturn > -1;
};

// isRunnable() is the guard against NaN. This is the stronger question: are there enough figures for
// the ANSWER to mean anything?
//
// The case that forced it: with no retirement budget, retireExpense() is zero every year, so Need[]
// is identically zero, so any portfolio at all clears the bar and the model reports "you could stop
// working today" — on a form where only the age has been typed. That is arithmetically correct and
// completely useless. Worse, it makes every working-year input inert: if you retire in year one you
// never work a year, so living costs and savings rate cannot move the answer, which reads as the
// inputs being broken.
//
// So: something going out, something to fund it with, and a timeline to put them on.
export const planReadiness = (p) => {
  const q = normalizeParams(p);
  const withPartner = q.partnerAge > 0 && p.partnerEnabled !== false;
  const savings = q.startCash + q.startPortfolio + (withPartner ? q.partnerCash + q.partnerPortfolio : 0);
  const income = q.annualTakeHome + (withPartner ? q.partnerIncome : 0)
    + (p.incomes || []).reduce((s, i) => s + Math.abs(+i.amount || 0), 0);
  const checks = [
    { key: "age", label: "Your age", ok: q.currentAge > 0 && q.endAge > q.currentAge },
    { key: "spend", label: "Retirement spending — what a year costs once you stop", ok: q.retirementSpendToday > 0 },
    { key: "resources", label: "Income, or savings to live on", ok: income > 0 || savings > 0 },
  ];
  return { ready: checks.every((c) => c.ok), checks };
};

// The same shape simulate() always returns, with nothing in it. Kept exhaustive on purpose — a test
// pins its key set against a real run, so a new output can't be added to one and forgotten in the other.
const emptyResult = (p) => ({
  naiveNumber: 0, fireAge: null, fireCross: null, fireCrossIfBorrowed: null,
  allowBorrowing: p.allowBorrowing === true, borrowingBlocked: false,
  fireCrossValue: null, fireReq: null,
  homes: [], lastPayoff: null, mortgageAtFire: 0,
  minSave: 0, minSaveAge: null, end: 0, rows: [], trace: [], END: 0,
  accessYou: p.accessAge || 59.5, accessPartner: p.accessAge || 59.5, partnerOffset: 0, hasPartner: false,
  expenseMarks: [], debtPayoffs: [], incomePV: 0, incomeStartMarks: [], incomeAtFire: 0,
  partnerStopsAtAge: null, unlockYouAtFire: null,
  fireTaxable: null, fireLocked: null, fireBridge: null, lockedShare: 0, illiquidAge: null,
  underwaterCause: null,
  useCoast: p.useCoast !== false, coastSpecified: false, coastTarget: null, coastCross: null, coastCrossValue: null,
  coastToday: null, coastShortfall: null,
  partnerAgeAtFire: null, partnerAgeAtEnd: null,
});

// One pass of the model. `retireAnchor` is the retirement instant that phase-relative expenses hang
// off; it is null on the first pass, because nothing knows the date yet. simulate() below turns this
// into a fixed point.
function simulateOnce(rawP, retireAnchor) {
  const p = normalizeParams(rawP);
  if (!isRunnable(p)) return emptyResult(p);
  const ret = p.nominalReturn;

  // Income can be entered as take-home (default) or as GROSS salary; if gross, net it down by a flat
  // effective rate. This is purely an entry convenience — it touches only spendable income, exactly as
  // typing a smaller take-home would — not a tax model (401k/HSA contributions stay pre-tax, untouched).
  const netRate = p.incomeMode === "gross" ? Math.max(0, Math.min(100, +p.effTaxRate || 0)) / 100 : 0;
  // In gross mode the figure entered is the full PRE-TAX salary, which already includes the pre-tax
  // 401k/HSA contribution. So the contribution comes out first — it is pre-tax by definition, and taxing
  // it would be wrong — and the flat effective rate then applies to what is actually left to be taxed:
  //   take-home = (gross − contributions) × (1 − rate)
  // In net mode the entered figure is already take-home after contributions, so nothing is deducted.
  const netOf = (gross, contrib) =>
    p.incomeMode === "gross" ? Math.max(0, gross - contrib) * (1 - netRate) : gross;
  const takeHomeNet = netOf(p.annualTakeHome, p.annualTaxAdv);
  const partnerIncomeNet = netOf(p.partnerIncome, p.partnerTaxAdv);

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

  // Cash is its own bucket earning its own (usually lower) rate, so it needs its own growth factor.
  // A 0% cash rate makes ln(Gc) = 0 and the closed forms above divide by zero; the limit of
  // (Gc^t − 1)/ln Gc as the rate goes to zero is simply t, which is exactly what an account earning
  // nothing does. Cash takes no inflow while you work — surplus is invested, not banked — so growC()
  // is the only cash convention anything needs.
  const cashRet = Math.max(0, +p.cashReturn || 0);
  const Gc = 1 + cashRet;
  const deltaC = Math.log(Gc);
  const growC = (dt) => Math.pow(Gc, dt);
  const fvC = (dt) => (deltaC === 0 ? dt : (growC(dt) - 1) / deltaC);
  const pvFlowC = (dt) => (deltaC === 0 ? dt : (1 - Math.pow(Gc, -dt)) / deltaC);

  // Borrowing is off by default: a plan that only balances by running the spendable account negative
  // is an implicit loan, not a plan. When off, the model still SIMULATES the negative path (so the
  // chart can show exactly where and why it breaks) but refuses to hand back a retirement date.
  const allowBorrowing = p.allowBorrowing === true;

  // --- homes: any number of them, each with its own loan ---------------------
  // Every home is an independent stream of cash: a lump at closing, level P&I until its own
  // payoff, and carrying costs for as long as you own it. Nothing here assumes there is only one.
  // A home comes in two shapes. "Planning to buy" gives clean parameters (price/down/rate/term) and we
  // DERIVE the payment, payoff and closing cash. "Already own it" is for people who only know the real
  // artifacts — the monthly P&I and how many years are left — so we take those directly and skip the
  // reverse-engineering. Carry (property tax + insurance/upkeep) is likewise either a % of price or, for
  // an owner reading it straight off the bills, a dollar figure.
  // A home appreciates at `homeGrowth` (nominal). Until this existed a home was pure expense with no
  // resale value, which made "rent forever" win by construction — the single biggest distortion the
  // README admitted to. A home may now be SOLD, which pays off whatever principal is left, deducts a
  // selling cost, and drops the net proceeds into the taxable account.
  const homeGrowth = Math.max(0, +p.homeGrowth || 0);
  const Gh = 1 + homeGrowth;
  const homes = (p.homes || []).filter((h) => (h.owned ? true : h.price > 0)).map((h) => {
    const carryMode = h.owned || h.carryMode === "dollar" ? "dollar" : "pct";
    const propTaxAnnual = Math.max(0, +h.propTaxAnnual || 0);
    const insMaintAnnual = Math.max(0, +h.insMaintAnnual || 0);
    // a sale age only counts once you own the place, and selling the year you buy is a no-op
    const rawSell = h.sellAge === "" || h.sellAge == null ? null : +h.sellAge;
    // test the RAW field for "unset" before coercing: `+undefined` is NaN, and NaN === undefined is
    // false, so coercing first meant the default was never reached and the whole sale went NaN.
    const rawPct = h.sellCostPct;
    const sellPct = Math.max(0, Math.min(100,
      rawPct == null || rawPct === "" || !Number.isFinite(+rawPct) ? 6 : +rawPct)) / 100;
    if (h.owned) {
      // you know the payment and the years remaining, not price/rate/term. Owned as of today, so there
      // is no closing cash and P&I simply runs for the years that are left.
      const mPI = Math.max(0, +h.monthlyPI || 0) * 12;
      const yearsLeft = Math.max(0, +h.yearsLeft || 0);
      // `price` is today's market value for a home you already own; `owedNow` is what's left on the loan
      const value0 = Math.max(0, +h.price || 0);
      const rate = Math.max(0, +h.rate || 0);
      // principal outstanding implied by the payment and the years left (level amortisation, run backwards)
      const i = rate / 12, n = yearsLeft * 12;
      const owed0 = mPI <= 0 || n <= 0 ? 0
        : i > 0 ? (mPI / 12) * (1 - Math.pow(1 + i, -n)) / i
                : (mPI / 12) * n;
      const sellAge = rawSell != null && rawSell > p.currentAge ? rawSell : null;
      return {
        ...h, owned: true, carryMode, propTaxAnnual, insMaintAnnual, loan: owed0, mPI,
        purchaseAge: p.currentAge, payoff: p.currentAge + yearsLeft, down: 0,
        value0, rate, term: yearsLeft, sellAge, sellPct,
      };
    }
    const loan = h.price * (1 - h.downPct);
    const i = h.rate / 12, n = Math.max(1, h.term) * 12;
    // level-payment amortisation; a 0% loan is just principal spread over the term
    const mPI = loan <= 0 ? 0
      : i > 0 ? (loan * i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1) * 12
              : loan / Math.max(1, h.term);
    const sellAge = rawSell != null && rawSell > h.purchaseAge ? rawSell : null;
    return {
      ...h, owned: false, carryMode, propTaxAnnual, insMaintAnnual, loan, mPI,
      payoff: h.purchaseAge + h.term,                  // the year P&I stops
      down: (h.downPct + h.closingPct) * h.price,      // cash you must have at closing
      value0: h.price, rate: h.rate, sellAge, sellPct,
    };
  });

  // Is this home still yours in year `age`? Owned from purchase until the year it is sold.
  const ownedIn = (h, age) => age >= h.purchaseAge && (h.sellAge == null || age < h.sellAge);

  // Market value at `age`: the value at acquisition, appreciating at homeGrowth. For a home bought in
  // the past the entered price is today's value, so it grows from today rather than from purchase.
  const valueAt = (h, age) => {
    const from = h.owned ? p.currentAge : Math.max(h.purchaseAge, p.currentAge);
    return h.value0 * Math.pow(Gh, Math.max(0, age - from));
  };

  // Principal still owed at `age`, from the standard remaining-balance formula. Zero once the loan is
  // paid off, and zero before the keys change hands.
  const owedAt = (h, age) => {
    if (age <= h.purchaseAge) return h.owned ? h.loan : h.loan;
    if (age >= h.payoff || h.mPI <= 0) return 0;
    const monthsLeft = (h.payoff - age) * 12, i = (h.rate || 0) / 12, m = h.mPI / 12;
    return i > 0 ? m * (1 - Math.pow(1 + i, -monthsLeft)) / i : m * monthsLeft;
  };

  // Net cash from selling in the year it happens: market value, less selling costs, less the loan
  // you must clear. Can be negative when a home is sold underwater — the model lets that stand rather
  // than pretending a sale always pays.
  const saleProceedsAt = (age) => homes.reduce((s, h) =>
    s + (h.sellAge != null && Math.round(h.sellAge) === age
      ? valueAt(h, age) * (1 - h.sellPct) - owedAt(h, age)
      : 0), 0);
  // property tax drifts ~2%/yr with assessments; insurance + upkeep track inflation. Dollar-mode figures
  // are today's $ and drift from the year you enter them (purchase year, or today for a home you own).
  const carryOf = (h, age) => {
    if (!ownedIn(h, age)) return 0;
    const yrs = age - h.purchaseAge;
    if (h.carryMode === "dollar")
      return h.propTaxAnnual * Math.pow(1.02, yrs)
           + h.insMaintAnnual * Math.pow(1 + p.inflation, yrs);
    return h.price * h.propTaxRate * Math.pow(1.02, yrs)
         + h.price * h.insMaintRate * Math.pow(1 + p.inflation, yrs);
  };
  // total housing cost in year `age`: carry + live P&I on every home you own by then, and rent
  // for as long as you own nothing to live in.
  const housingAt = (age) => {
    let owned = 0, cost = 0;
    for (const h of homes) {
      if (!ownedIn(h, age)) continue;
      owned++;
      cost += carryOf(h, age);
      if (age < h.payoff) cost += h.mPI;
    }
    // sell the only home you live in and you are a renter again, at today's rent inflated forward
    if (owned === 0) cost += p.rentAnnual * Math.pow(1 + p.inflation, age - p.currentAge);
    return cost;
  };
  const downAt = (age) => homes.reduce((s, h) => s + (age === h.purchaseAge ? h.down : 0), 0);
  const piAt = (age) =>
    homes.reduce((s, h) => s + (ownedIn(h, age) && age < h.payoff ? h.mPI : 0), 0);
  const held = homes.filter((h) => h.sellAge == null || h.sellAge > h.payoff);
  const lastPayoff = held.length ? Math.max(...held.map((h) => h.payoff)) : null;

  // the naive 4%-rule number, for contrast — spending plus whatever housing costs in steady state
  const steadyCarry = (h) => h.carryMode === "dollar"
    ? h.propTaxAnnual + h.insMaintAnnual
    : h.price * (h.propTaxRate + h.insMaintRate);
  const steadyHousing = homes.length
    ? homes.reduce((s, h) => s + steadyCarry(h), 0)
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
  // A kid is dated by `birthAge` — YOUR age the year they were born. Parents of existing kids think in
  // "my kid is 4 now", so accept `ageNow` too and convert (birthAge = your age − their age). birthAge
  // stays the one canonical field everything downstream reads.
  const kids = (p.kids || [])
    .map((k, idx) => ({ ...k, idx, birthAge: (k.ageNow != null && k.ageNow !== "") ? p.currentAge - (+k.ageNow) : (+k.birthAge) }))
    .filter((k) => k.birthAge > 0);
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
  // An expense may be dated in one of two frames. "At your age" is an absolute age, as before. "From
  // retirement" reads `age` and `until` as OFFSETS from the retirement instant — 0 is the year you
  // stop, 5 is five years later, -2 is two years before — which is how you express "travel hard for
  // the first decade" or "long-term care from 20 years in" without first knowing your own date.
  //
  // On the first pass there is no date to hang them off, so they are skipped; simulate() feeds the
  // resulting date back in and runs again.
  const relAnchor = (e) => (e && e.anchor === "retirement");
  const extraLump = {};
  for (const e of (p.expenses || [])) {
    const amt = (e && +e.amount) || 0;
    if (!amt) continue;
    let a0, a1;
    if (relAnchor(e)) {
      if (retireAnchor == null) continue;                       // no date yet — resolved on a later pass
      a0 = Math.round(retireAnchor + (+e.age || 0));
      a1 = e.until === "" || e.until == null ? a0 : Math.max(a0, Math.round(retireAnchor + (+e.until || 0)));
    } else {
      a0 = Math.round(e.age);
      a1 = e.until ? Math.max(a0, Math.round(e.until)) : a0;
    }
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
  // ---- one flow list, two phases -------------------------------------------
  // Working years and retired years used to build their cash flow in two independent places —
  // flows() and retireExpense() — each deciding for itself what a year contains. They drifted, twice:
  // a pension was subtracted in one and never added in the other, and kid costs were charged in one
  // and silently free in the other (retire at 40 with a two-year-old and daycare through high school
  // cost nothing). Both are the same defect: a flow present in one list and missing from the other.
  //
  // So there is now ONE list. Each entry says what it costs in a given year and which phases it
  // applies to, and both phases read it through the same evaluator. A new cost cannot be added to
  // half the model any more, because there is no longer a half to add it to.
  //
  // `household` is the one genuinely phase-dependent line: your working budget before you retire,
  // your retirement budget after. Everything else is charged in both.
  const HOUSEHOLD = "household", KIDS = "kids", HOUSING = "housing", LUMPS = "lumps", INCOME = "income";
  const flowList = (age, phase) => {
    const infl = inflAt(age);
    const retired = phase === "retired";
    return [
      { key: HOUSEHOLD, amount: (retired ? p.retirementSpendToday : p.nonHousingLiving) * infl },
      { key: HOUSING, amount: housingAt(age) },
      // charged in BOTH phases — a child at home costs the same whether or not you have a job
      { key: KIDS, amount: kidCostAt(age) },
      { key: LUMPS, amount: downAt(age) + (netCollege[age] || 0) + (contrib529[age] || 0) + extraOutflowAt(age)
                            - saleProceedsAt(age) },
      // pension / Social Security / annuity: negative because it offsets the bill rather than adding
      // to it. Liquid, so it also shrinks the pre-59.5 bridge.
      { key: INCOME, amount: -incomeAt(age) },
    ];
  };
  const flowTotal = (age, phase) => flowList(age, phase).reduce((s, f) => s + f.amount, 0);
  const flowOf = (age, phase, key) => flowList(age, phase).find((f) => f.key === key).amount;

  const retireExpense = (age) => flowTotal(age, "retired");

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
  const partnerTakeHomeAt = (age) => partnerEarnsInRetirement(age) ? partnerIncomeNet * inflAt(age) : 0;   // liquid
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

  // --- two rates, one requirement -------------------------------------------
  // Need[] above is a single-rate present value: it assumes every dollar compounds at the portfolio
  // rate. Cash doesn't — it earns `cashReturn` — so once there is a cash bucket, "the balance that
  // lands exactly on zero" is no longer one discounted sum. Getting this wrong is not a rounding
  // matter: a cash-heavy household would be told to retire on a pot that then runs dry early.
  //
  // The split is exact rather than approximate, because the drawdown spends cash FIRST. So cash
  // alone carries the bill from `t` until it runs dry at `tau`, investments compound untouched at
  // the portfolio rate over that whole stretch, and from `tau` on it is an ordinary single-rate
  // problem again:
  //
  //     required(t, C) = C + Need(tau) / G^(tau − t)
  //
  // With C = 0, tau = t and this collapses back to needAt(t) exactly — which is what keeps every
  // no-cash invariant (the terminal balance landing on zero) untouched.

  // The instant a cash balance C, compounding at the cash rate while paying `bill`, hits zero.
  //
  // The bill is valued with fv() — the PORTFOLIO rate — not fvC(), and that is deliberate: it is
  // exactly what spend() charges over the same stretch. The forward drawdown is this model's ground
  // truth, so the requirement has to be computed against the arithmetic the drawdown actually uses.
  // Valuing it at the cash rate here instead left ~$6k on the table at the horizon — the size of one
  // year's bill times the gap between the two rates.
  const cashDryAt = (t, C, bill, stop) => {
    if (!(C > 0)) return t;
    let bal = C, s = t;
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      const e = Math.max(0, bill(yr));          // a surplus year goes to INVESTMENTS, never to cash
      const endBal = bal * growC(dt) - e * fv(dt);
      if (endBal <= 0) {
        let lo = 0, hi = dt;                       // solve for the exact instant inside the year
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (bal * growC(mid) - e * fv(mid) <= 0) hi = mid; else lo = mid;
        }
        return s + hi;
      }
      bal = endBal; s = s1;
    }
    return stop;
  };

  // minimum CASH that covers `t..u` on its own, under the same arithmetic — cash compounding at the
  // cash rate against a bill valued at the portfolio rate
  const cashReqFor = (t, u, bill) => {
    const stop = Math.min(u, END + 1);
    if (stop <= t) return 0;
    const slices = [];
    for (let s = t; s < stop; ) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1);
      slices.push([s1 - s, yr]); s = s1;
    }
    let req = 0;
    for (let i = slices.length - 1; i >= 0; i--) {
      const [dt, yr] = slices[i];
      req = Math.max(0, (req + Math.max(0, bill(yr)) * fv(dt)) / growC(dt));
    }
    return req;
  };

  // Value at `tau` of everything that flows into the non-cash buckets between `t` and `tau`, while
  // cash is the one paying the liquid bill. It is NOT zero whenever the household still has income
  // arriving after you retire:
  //   • a still-working partner's surplus lands in investments, not in cash
  //   • their 401k contribution lands in the locked bucket even in a year cash covers the bills
  // Both mean the investments held at `t` can be smaller than the untouched-compounding view implies.
  // Omitting this left $1.46M on the table at the horizon in the partner-keeps-working case.
  const investFlowFV = (t, tau) => {
    let acc = 0, s = t;
    while (s < tau) {
      const yr = Math.floor(s), s1 = Math.min(tau, yr + 1), dt = s1 - s;
      const flow = Math.max(0, retireNetLiquid(yr)) - retireNet(yr);
      acc = acc * grow(dt) + flow * fv(dt);
      s = s1;
    }
    return acc;
  };

  // Total balance required at instant `t` when `C` of it is cash.
  //
  // The cash trajectory is driven by retireNetLiquid — the bill cash is actually asked to pay. That
  // differs from retireNet (which Need[] uses) by a still-working partner's 401k contribution, and
  // that contribution lands in the LOCKED bucket, never in cash.
  const needTotalAt = (t, C) => {
    if (!(C > 0)) return needAt(t);
    const tau = cashDryAt(t, C, retireNetLiquid, END + 1);
    // Cash was never exhausted — either income covers the bill outright, or the pile outlasts the
    // horizon. Either way cash never binds, so the requirement is the ordinary single-rate one and
    // whatever cash is left over is genuine surplus. Returning C here instead would report "you need
    // your own cash balance", which is both trivially true and not the constraint.
    if (tau >= END + 1 - 1e-9) return needAt(t);
    return C + (needAt(tau) - investFlowFV(t, tau)) / grow(tau - t);
  };

  // --- the liquidity (age-59.5) machinery ----------------------------------
  // Need[] answers "is there enough money?". It does NOT answer "can you legally touch it?".
  // A 401k/IRA/HSA dollar cannot pay a bill before 59.5 without a 10% penalty, so a retirement
  // before then must be bridged out of the TAXABLE bucket alone.

  // present value, at instant `t`, of the SPENDABLE bill between `t` and `u` (net of a working
  // partner's take-home, which is liquid; their 401k contribution is handled separately, below)
  // The bridge has to fund the WORST MOMENT of the window, not merely its endpoint.
  //
  // A plain present value nets a late inflow against early spending, which is right for the wealth
  // constraint — over the whole horizon a dollar is a dollar, whenever it lands — and wrong for the
  // liquidity one, because you cannot pay this year's bills out of next decade's house sale. Adding
  // home sales made this reachable: selling before 59.5 cut the computed bridge so far that the model
  // retired you years early, then ran the cash account underwater waiting for the proceeds, and (with
  // borrowing off) reported "you never retire" for a plan that a later date funds comfortably.
  //
  // Taking the running maximum of the partial present value asks the question the cash account
  // actually poses: how much do you need to REACH the worst point. It is unchanged whenever spending
  // is positive throughout, which is the ordinary case.
  const pvSpendPeak = (t, u, atCashRate = false) => {
    const pvf = atCashRate ? pvFlowC : pvFlow, base = atCashRate ? Gc : G;
    let acc = 0, peak = 0, disc = 1, s = t;
    const stop = Math.min(u, END + 1);
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      acc += disc * retireNetLiquid(yr) * pvf(dt);
      if (acc > peak) peak = acc;
      disc *= Math.pow(base, -dt);
      s = s1;
    }
    return peak;
  };

  // `atCashRate` discounts at the cash rate instead — the minimum CASH that bridges a window, which
  // is what's required when cash alone covers it
  const pvSpend = (t, u, atCashRate = false) => {
    const pvf = atCashRate ? pvFlowC : pvFlow, base = atCashRate ? Gc : G;
    let acc = 0, disc = 1, s = t;
    const stop = Math.min(u, END + 1);
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      acc += disc * retireNetLiquid(yr) * pvf(dt);
      disc *= Math.pow(base, -dt);
      s = s1;
    }
    return acc;
  };

  // Minimum SPENDABLE balance at `T` to cover `T..u`, given that `C` of it is cash and cash is spent
  // first. Same two-rate split as needTotalAt(): cash carries the window until it runs dry, then
  // investments take over at the portfolio rate.
  const spendReq = (T, u, C) => {
    const stop = Math.min(u, END + 1);
    if (stop <= T) return 0;
    if (!(C > 0)) return pvSpendPeak(T, u);
    const tau = cashDryAt(T, C, retireNetLiquid, stop);
    // cash alone spans the whole window — the requirement is then just the cash that exactly does it
    // (never more than C, so a fatter cash pile is never penalised for being large)
    if (tau >= stop - 1e-9) return cashReqFor(T, stop, retireNetLiquid);
    return C + pvSpendPeak(tau, u) / grow(tau - T);
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
  const bridgeAt = (T, C, balYou, balPartner) => {
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
      need = Math.max(need, spendReq(T, b.u, C) - unlocked);
      unlocked += b.bal;
    }
    return Math.max(0, need);
  };

  // --- coast FIRE ----------------------------------------------------------
  // "Coast" = stop SAVING but keep working, letting the pot compound untouched until you retire
  // at coastAge. So the coast bar is the retirement requirement at the coast target, discounted
  // back with no further contributions. It meets the Need curve exactly at coastAge.
  // NB: this assumes your income still covers everything on the way — including the college lumps.
  // Coast is opt-in: when it's off nothing here is computed and every coast output is null, so the
  // chart, legend and stats have nothing to draw rather than being merely hidden.
  const useCoast = p.useCoast !== false;
  // A coast age you have not typed is not a target. Blank normalises to 0, and the clamp below would
  // quietly turn that into "coast to next year" — a whole curve drawn off a number nobody chose.
  // Ticking the box asks the question; it does not answer it, so there is no curve until the age is
  // given. `useCoast` still reports the checkbox, so the UI can tell "off" from "asked, unanswered".
  const coastSpecified = useCoast && p.coastAge > 0;
  const coastTarget = coastSpecified ? Math.min(Math.max(p.coastAge, p.currentAge + 1), END) : null;
  const coastAt = (t) => (coastTarget != null ? needAt(coastTarget) / grow(coastTarget - t) : null);

  // --- annual flow RATES (nominal $/yr) during a working year ---------------
  const flows = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    // the working window is stated in the partner's own age, so translate before comparing
    const pAge = partnerAgeAt(age);
    const partnerOn = hasPartner && pAge >= earnFrom && pAge <= earnTo;
    // Guaranteed income counts in EVERY year it runs, not only after you retire. retireExpense()
    // subtracts incomeAt(); working years never call it, so a pension or Social Security claimed
    // while still employed used to vanish entirely — $40k/yr for five working years changed the
    // balances, and the retirement date, by exactly nothing.
    const salary = takeHomeNet * infl + (partnerOn ? partnerIncomeNet * infl : 0);
    const taxAdvYou = p.annualTaxAdv * infl;
    const taxAdvPartner = partnerOn ? p.partnerTaxAdv * infl : 0;
    // the SAME list the retired phase reads, asked for the working phase — so nothing can be charged
    // in one and forgotten in the other. `-INCOME` because the list stores it as a negative outflow.
    const living = flowOf(age, "working", HOUSEHOLD);
    const housing = flowOf(age, "working", HOUSING);
    const kidCost = flowOf(age, "working", KIDS);
    const lumps = flowOf(age, "working", LUMPS);
    const takeHome = salary - flowOf(age, "working", INCOME);
    const surplus = takeHome - (living + housing + kidCost);
    // the components ride along so the UI can show WHY a year drains cash, not just that it did
    return { taxable: surplus - lumps, taxAdvYou, taxAdvPartner, save: surplus + taxAdvYou + taxAdvPartner,
             takeHome, living, housing, kidCost, lumps, surplus };
  };

  // The same year's cash flow, in today's dollars, as a plain object — the arithmetic behind "your
  // taxable account went underwater at age N". Everything is divided back by inflation so the figures
  // are comparable to the inputs the user actually typed.
  const cashFlowAt = (age) => {
    const infl = inflAt(age);
    const f = flows(age);
    const r = (x) => Math.round(x / infl);
    return {
      age,
      takeHome: r(f.takeHome), living: r(f.living), housing: r(f.housing), kids: r(f.kidCost),
      lumps: r(f.lumps), taxAdv: r(f.taxAdvYou + f.taxAdvPartner),
      // what actually lands in (or drains out of) the spendable account this year
      toTaxable: r(f.taxable),
      // P&I vs. the rest of housing, because "the mortgage" is usually the line that breaks the budget
      mortgage: r(piAt(age)),
    };
  };

  // work for dt years: balances compound while the year's flows stream in. Cash earns its own rate
  // and takes no inflow — the annual surplus is invested. When the surplus is NEGATIVE (a down-payment
  // year, say) it drains the investment account, and settle() then covers that from cash, which is
  // what a buffer is for.
  const work = (st, age, dt) => {
    const f = flows(age), g = grow(dt), a = fv(dt);
    return {
      cash: st.cash * growC(dt),
      taxable: st.taxable * g + f.taxable * a,
      taxAdvYou: st.taxAdvYou * g + f.taxAdvYou * a,
      taxAdvPartner: st.taxAdvPartner * g + f.taxAdvPartner * a,
    };
  };

  // Draw `owed` down from a balance. A bucket already in deficit is skipped rather than "drawn" —
  // without the guard, Math.min(negative, owed) returns the negative balance, which would zero the
  // deficit and ADD it to the amount still owed.
  const drawFrom = (bal, take) => (bal <= 0 ? { bal, took: 0 } : { bal: bal - Math.min(bal, take), took: Math.min(bal, take) });

  // spend for dt years inside one calendar year, drawing cash first, then taxable investments, then
  // each tax-advantaged bucket that has already opened. `t0..t1` never straddles an unlock.
  const spend = (st, t0, t1, T) => {
    const age = Math.floor(t0), dt = t1 - t0, g = grow(dt);
    let cash = st.cash * growC(dt), taxable = st.taxable * g, ty = st.taxAdvYou * g, tp = st.taxAdvPartner * g;
    let owed = retireExpense(age) * fv(dt);
    // a year whose income or windfall outruns the bill is INVESTED, never banked — same convention as
    // retireStep() below, and the one needTotalAt() prices against
    if (owed < 0) { taxable += -owed; owed = 0; }
    const draw = (bal) => { const r = drawFrom(bal, owed); owed -= r.took; return r.bal; };
    cash = draw(cash);                                        // spend savings before selling anything
    taxable = draw(taxable);
    if (t0 >= unlockAt(accessYou, T) - 1e-9) ty = draw(ty);
    if (t0 >= unlockAt(accessPartner, T) - 1e-9) tp = draw(tp);
    let short = false;
    if (owed > 1) { cash -= owed; short = true; }             // illiquid: money exists, can't be reached
    return { st: { cash, taxable, taxAdvYou: ty, taxAdvPartner: tp }, short };
  };

  // one retired sub-year. When the partner is still earning their take-home offsets the bill (a
  // surplus lands in taxable) and their 401k contribution grows the locked bucket; otherwise this is
  // exactly spend(). Same taxable-first, then-unlocked draw order, so the two stay consistent.
  const retireStep = (st, t0, t1, T) => {
    const age = Math.floor(t0);
    if (!partnerEarnsInRetirement(age)) return spend(st, t0, t1, T);
    const dt = t1 - t0, g = grow(dt);
    let cash = st.cash * growC(dt), taxable = st.taxable * g, ty = st.taxAdvYou * g, tp = st.taxAdvPartner * g;
    tp += partnerTaxAdvAt(age) * fv(dt);                                  // locked contribution keeps building
    let owed = (interimExpense(age) - partnerTakeHomeAt(age)) * fv(dt);   // net of take-home
    if (owed < 0) { taxable += -owed; owed = 0; }                         // partner out-earned the bill -> invest it
    const draw = (bal) => { const r = drawFrom(bal, owed); owed -= r.took; return r.bal; };
    cash = draw(cash);
    taxable = draw(taxable);
    if (t0 >= unlockAt(accessYou, T) - 1e-9) ty = draw(ty);
    if (t0 >= unlockAt(accessPartner, T) - 1e-9) tp = draw(tp);
    let short = false;
    if (owed > 1) { cash -= owed; short = true; }
    return { st: { cash, taxable, taxAdvYou: ty, taxAdvPartner: tp }, short };
  };

  // spend from t0 to t1, splitting at any unlock instant that falls inside
  const spendSpan = (st, t0, t1, T) => {
    const cuts = [t0, t1];
    [unlockAt(accessYou, T), unlockAt(accessPartner, T)].forEach((u) => {
      if (u > t0 && u < t1) cuts.push(u);
    });
    // …and cut where cash runs dry, for the same reason the unlocks are cuts: a slice that is part
    // cash-funded and part investment-funded charges one bill against two different growth rates, and
    // no closed form can decompose that. Splitting at the instant means every slice is funded by one
    // regime, which is exactly what needTotalAt() assumes — and what lands the horizon back on zero.
    const dry = cashDryAt(t0, st.cash, retireNetLiquid, t1);
    if (dry > t0 + 1e-9 && dry < t1 - 1e-9) cuts.push(dry);
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
  // `T` is the retirement instant when one is known: after retiring, a Roth ladder can open the pipe
  // before the statutory age, so the sweep has to use the same key spend() does. While still working
  // there is no ladder to season, so the statutory age is the only key that turns.
  const settle = (st, t, T = null) => {
    const uYou = T != null ? unlockAt(accessYou, T) : accessYou;
    const uPartner = T != null ? unlockAt(accessPartner, T) : accessPartner;
    const openYou = !p.enforceAccess || t >= uYou - 1e-9;
    const openPartner = !p.enforceAccess || t >= uPartner - 1e-9;
    let { cash, taxable, taxAdvYou, taxAdvPartner } = st;
    // Cash is the buffer, so it absorbs an investment account driven negative before anything else is
    // touched. Both are spendable, so this moves nothing in net worth — it just stops the model
    // reporting "investments went negative" while a positive savings balance sat next to it.
    if (taxable < 0 && cash > 0) {
      const move = Math.min(cash, -taxable);
      cash -= move; taxable += move;
    }
    const pull = (bal, open) => {
      const deficit = -(cash + taxable);          // the SPENDABLE shortfall, cash and investments together
      if (!open || deficit <= 0 || bal <= 0) return bal;
      const move = Math.min(bal, deficit);        // only enough to bring spendable back to $0
      taxable += move;
      return bal - move;
    };
    taxAdvYou = pull(taxAdvYou, openYou);
    taxAdvPartner = pull(taxAdvPartner, openPartner);
    return { cash, taxable, taxAdvYou, taxAdvPartner };
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
  // `startPortfolio` / `partnerPortfolio` are INVESTED assets; cash is its own bucket alongside them,
  // earning its own rate. Cash is spendable at any age, so it counts toward the bridge exactly as
  // taxable investments do — it is simply the slice that doesn't compound at the market rate.
  const startCash = Math.max(0, +p.startCash || 0) + (hasPartner ? Math.max(0, +p.partnerCash || 0) : 0);
  let st = {
    cash: startCash,
    taxable: (p.startPortfolio - lockedYou) + (partnerPortfolio - lockedPartner),
    taxAdvYou: lockedYou,
    taxAdvPartner: lockedPartner,
  };

  // spendable = cash + taxable investments; both pay bills at any age, neither waits for 59.5
  const spendableOf = (s) => s.cash + s.taxable;
  const totalOf = (s) => s.cash + s.taxable + s.taxAdvYou + s.taxAdvPartner;

  // You may retire only when BOTH hold: enough money in total, and enough of it reachable before
  // 59.5. The binding one is whichever gap is smaller — and it is zero exactly at retirement.
  //
  // The bridge is a present value discounted at the PORTFOLIO rate, while part of what funds it is
  // cash earning less. That makes the screening test very slightly optimistic for a cash-heavy
  // household. It is not load-bearing: the forward drawdown below is the ground truth, it draws cash
  // first and grows each bucket at its own rate, and any resulting shortfall shows up as a negative
  // spendable balance — which, with borrowing off, invalidates the date rather than hiding it.
  const gapAt = (t, s) => Math.min(
    totalOf(s) - needTotalAt(t, s.cash),
    spendableOf(s) - bridgeAt(t, s.cash, s.taxAdvYou, s.taxAdvPartner),
  );

  let T = null;                                   // the retirement instant, a real number
  let fireCrossValue = null, fireReq = null, fireTaxable = null, fireBridge = null;
  let coastCross = null, coastCrossValue = null, prevCoastGap = null, prevCoastReal = null;
  let minSave = Infinity, minSaveAge = null, illiquidAge = null;
  const rows = [];
  const trace = [];        // one explained line per year: flows in, flows out, what each bucket did

  for (let age = p.currentAge; age <= END; age++) {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    const total = totalOf(st);
    const startReal = total / infl;
    const working = T === null;
    const coastReal = coastTarget != null && age <= coastTarget ? coastAt(age) / infl : null;

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
    const bornThisYear = kids.filter((k) => k.birthAge === age);
    if (bornThisYear.length) events.push("kid");
    // only NAMED children get a chart label — an unnamed one would just add "Kid 1" as clutter
    const bornNames = bornThisYear.filter((k) => (k.name || "").trim()).map((k) => kidName(k, k.idx));
    if (collegeGrossToday(age) > 0) events.push("college");

    const reqReal = needTotalAt(age, st.cash) / infl;
    const bridgeReal = bridgeAt(age, st.cash, st.taxAdvYou, st.taxAdvPartner) / infl;
    rows.push({
      age,
      portfolio: Math.round(startReal),
      // `taxable` is the SPENDABLE line — cash plus taxable investments — because that is what the
      // bridge is measured against. `cash` breaks out the slice of it that isn't invested.
      taxable: Math.round(spendableOf(st) / infl),
      cash: Math.round(st.cash / infl),
      retirement: Math.round((st.taxAdvYou + st.taxAdvPartner) / infl),   // 401k/IRA/HSA buckets
      required: Math.round(reqReal),
      bridge: Math.round(bridgeReal),
      // the slice of the number that may sit locked: everything past the taxable bridge (kept exactly
      // consistent with the rounded required/bridge so the three lines always sum on-screen)
      neededRetirement: Math.max(0, Math.round(reqReal) - Math.round(bridgeReal)),
      coast: coastReal == null ? null : Math.round(coastReal),
      save: Math.round(realSave),
      // home equity held this year: market value less principal still owed, in today's dollars.
      // Not part of the portfolio — you cannot spend a house — but the shape of it is what makes
      // buy-vs-rent legible, so the chart can draw it as its own series.
      equity: Math.round(homes.reduce((s, h) => s + (ownedIn(h, age) ? valueAt(h, age) - owedAt(h, age) : 0), 0) / infl),
      events, bornNames,
    });

    const stBefore = st;                                 // balances entering the year, for the trace

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
        fireCrossValue = totalOf(sT) / inflT;
        fireReq = needTotalAt(T, sT.cash) / inflT;
        fireTaxable = spendableOf(sT) / inflT;
        fireBridge = bridgeAt(T, sT.cash, sT.taxAdvYou, sT.taxAdvPartner) / inflT;
        if (T > age) {
          rows.push({
            age: T, portfolio: Math.round(fireCrossValue), required: Math.round(fireReq),
            taxable: Math.round(fireTaxable), cash: Math.round(sT.cash / inflT),
            retirement: Math.round((sT.taxAdvYou + sT.taxAdvPartner) / inflT),
            bridge: Math.round(fireBridge),
            neededRetirement: Math.max(0, Math.round(fireReq) - Math.round(fireBridge)),
            coast: coastTarget != null && T <= coastTarget ? Math.round(coastAt(T) / inflT) : null,
            // NB: this row is built by hand, so every field the yearly row carries has to be
            // repeated here or it reads as `undefined` for exactly one age — which is how `equity`
            // arrived non-finite at the retirement instant and nowhere else.
            equity: Math.round(homes.reduce((s, h) => s + (ownedIn(h, T) ? valueAt(h, T) - owedAt(h, T) : 0), 0) / inflT),
            save: 0, events: [], bornNames: [],
          });
        }
        const r = spendSpan(sT, T, age + 1, T);               // retired for the rest of the year
        // sweep any now-reachable account against a spendable shortfall, exactly as a working year
        // does — a deficit left sitting in the cash account would otherwise compound forever as debt
        // even after the 401k has legally opened and could simply pay it off.
        st = settle(r.st, age + 1, T);
        if (r.short && illiquidAge === null) illiquidAge = Math.floor(T);
      } else {
        st = step(st, age, 1);
        if (spendableOf(st) < 0 && illiquidAge === null) illiquidAge = age;
      }
    } else {
      const r = spendSpan(st, age, age + 1, T);
      st = settle(r.st, age + 1, T);
      if (r.short && illiquidAge === null) illiquidAge = age;
    }

    // --- the year, explained ------------------------------------------------
    // Every year decomposes into: what each bucket started with, the cash that moved in and out of it,
    // the interest it earned, and what it ended with. The decomposition RECONCILES exactly —
    //     start + in − out + growth = end
    // for both buckets — because `growth` is derived as the residual rather than modelled separately.
    // That is what makes the table trustworthy: if the arithmetic ever stopped adding up, the growth
    // column would visibly absorb the error instead of hiding it.
    //
    // Above all it explains the shape that looks wrong at first glance — the retirement bucket keeps
    // growing after you retire because it is locked, so its "out" is zero and its growth compounds
    // untouched while only the cash account is drawn down.
    {
      const inflEndYr = inflAt(age + 1);
      const r2 = (x) => x / inflEndYr;                              // end-of-year nominal $ -> today's $
      const wasWorking = working;                                   // captured before the transition
      const retiredThisYear = wasWorking && T !== null;
      const startTaxAdv = stBefore.taxAdvYou + stBefore.taxAdvPartner;
      const endTaxAdv = st.taxAdvYou + st.taxAdvPartner;
      const openYou = !p.enforceAccess || (T !== null ? age + 1 > unlockAt(accessYou, T) : age + 1 > accessYou);
      const openPartner = !p.enforceAccess || (T !== null ? age + 1 > unlockAt(accessPartner, T) : age + 1 > accessPartner);
      const f = flows(age);
      const partnerWorks = partnerEarnsInRetirement(age);
      const yearFV = fv(1);                                         // $1/yr flowing all year, valued at year end

      // --- the individual lines, as end-of-year nominal amounts ---
      // The year you retire is part salary and part drawdown. Charging it a full year of BOTH (a full
      // year's pay AND a full year's retirement budget) would leave a wild figure in the residual — it
      // showed up as −$268k of "interest" in the year of retirement — so split the transition year at
      // the retirement instant and weight each side by the fraction of the year it actually occupies.
      const wFrac = retiredThisYear ? Math.min(1, Math.max(0, T - age)) : (wasWorking ? 1 : 0);
      const rFrac = 1 - wFrac;
      const retiredLiving = (partnerWorks ? interimLiving : p.retirementSpendToday) * infl;
      // Salary in the "pay" column, guaranteed income in "other" — in BOTH phases. flows() now folds
      // the pension into take-home so working years actually receive it, but the trace should still
      // show it for what it is. The two columns are only ever added together downstream, so moving a
      // figure between them cannot disturb the row's reconciliation.
      const pension = incomeAt(age);
      const takeHomeFV   = (f.takeHome - pension) * wFrac * yearFV;
      const otherIncFV   = (pension + partnerTakeHomeAt(age) * rFrac) * yearFV;
      const livingFV     = (f.living * wFrac + retiredLiving * rFrac) * yearFV;
      // housing, kids and lumps are phase-independent in the flow list, so they are charged for the
      // whole year rather than split across the transition — only the household budget line differs
      // between working and retired, and only it needs the wFrac/rFrac weighting.
      const housingFV    = housingAt(age) * yearFV;
      const kidsFV       = f.kidCost * yearFV;
      const lumpsFV      = f.lumps * yearFV;
      const contribFV    = ((f.taxAdvYou + f.taxAdvPartner) * wFrac + partnerTaxAdvAt(age) * rFrac) * yearFV;

      // What the LOCKED bucket paid out: everything it held (plus this year's contributions and growth)
      // that is no longer there. Zero while it is sealed — which is the whole point.
      const advWithdrawFV = Math.max(0, startTaxAdv * grow(1) + contribFV - endTaxAdv);
      const spendFV = livingFV + housingFV + kidsFV + lumpsFV;
      const cashOutFV = spendFV - advWithdrawFV;                    // the share of the bill cash covered

      // Round to today's dollars FIRST, then derive interest as the residual of the rounded figures.
      // Balances are deflated at their own instant (start by this year's index, end by next year's) so
      // each row's end still equals the next row's start — but that means the two ends of a row are in
      // different index years, and a residual computed in nominal terms would not close in real terms.
      // Deriving growth from the displayed numbers makes every printed row add up exactly, and the
      // figure it yields is the REAL (inflation-adjusted) return, which is what a today's-dollars
      // table should be showing anyway.
      // the cash-account columns track SPENDABLE money (cash + taxable investments), which is the
      // account the bills are actually paid from; the cash slice is broken out separately below
      const startTaxableR = Math.round(spendableOf(stBefore) / infl), endTaxableR = Math.round(r2(spendableOf(st)));
      const startTaxAdvR  = Math.round(startTaxAdv / infl),      endTaxAdvR  = Math.round(r2(endTaxAdv));
      const takeHomeR = Math.round(r2(takeHomeFV)),  otherIncR = Math.round(r2(otherIncFV));
      const cashOutR  = Math.round(r2(cashOutFV));
      const contribR  = Math.round(r2(contribFV)),   withdrawnR = Math.round(r2(advWithdrawFV));

      trace.push({
        age,
        phase: retiredThisYear ? "retires" : wasWorking ? "working" : "retired",
        retireAt: retiredThisYear ? T : null,
        locked: !(openYou || openPartner),
        // balances (today's dollars)
        startTaxable: startTaxableR, endTaxable: endTaxableR,
        startTaxAdv: startTaxAdvR,   endTaxAdv: endTaxAdvR,
        startCash: Math.round(stBefore.cash / infl), endCash: Math.round(r2(st.cash)),
        startTotal: Math.round(startReal), endTotal: Math.round(r2(spendableOf(st) + endTaxAdv)),
        // cash account: money in, the bill it covered, and the real interest that closes the row
        takeHome: takeHomeR, otherIncome: otherIncR,
        living: Math.round(r2(livingFV)), housing: Math.round(r2(housingFV)),
        kids: Math.round(r2(kidsFV)), lumps: Math.round(r2(lumpsFV)),
        cashOut: cashOutR,
        cashGrowth: endTaxableR - startTaxableR - takeHomeR - otherIncR + cashOutR,
        // retirement accounts: contributions in, withdrawals out, real interest closing the row
        contributions: contribR, withdrawn: withdrawnR,
        advGrowth: endTaxAdvR - startTaxAdvR - contribR + withdrawnR,
        // kept for the existing callout/tests
        income: takeHomeR + otherIncR,
        spending: Math.round(r2(spendFV)),
      });
    }
  }

  // terminal balance, AFTER the final year is spent — zero by construction when total wealth binds
  const inflEnd = Math.pow(1 + p.inflation, END + 1 - p.currentAge);
  const end = totalOf(st) / inflEnd;
  const fireLocked = fireCrossValue == null ? null : fireCrossValue - fireTaxable;
  const lockedShare = fireCrossValue > 0 ? fireLocked / fireCrossValue : 0;

  // --- the borrowing rule ----------------------------------------------------
  // With borrowing off (the default) a path that only balances by running the spendable account
  // negative is not a fundable plan, so the model withholds the date rather than reporting one it
  // reached with an implicit loan. The simulated path is still returned in full — the chart has to be
  // able to show exactly where and why it broke — and the date it WOULD have found is kept separately,
  // so the UI can say "you'd retire at 44.2, but only by borrowing from age 50".
  const borrowingBlocked = !allowBorrowing && illiquidAge != null;
  const T2 = borrowingBlocked ? null : T;
  const nb = (v) => (borrowingBlocked ? null : v);   // withhold a figure that rests on a blocked date

  return {
    naiveNumber, fireAge: T2 == null ? null : Math.ceil(T2), fireCross: T2,
    allowBorrowing, borrowingBlocked,
    // the crossing the solver actually found, borrowing rule aside — null when there was none at all
    fireCrossIfBorrowed: T,
    fireCrossValue: nb(fireCrossValue), fireReq: nb(fireReq),
    // per-home derived numbers, so the UI can show what each one actually costs
    homes: homes.map((h) => ({
      price: h.price ?? 0, purchaseAge: h.purchaseAge, payoff: h.payoff,
      mPI: h.mPI, down: h.down, carryAtBuy: carryOf(h, h.purchaseAge), owned: !!h.owned,
      sellAge: h.sellAge,
      // what the sale actually hands you, in today's dollars, so the card can show it
      saleValue: h.sellAge == null ? null : valueAt(h, h.sellAge) / inflAt(h.sellAge),
      saleOwed: h.sellAge == null ? null : owedAt(h, h.sellAge) / inflAt(h.sellAge),
      saleNet: h.sellAge == null ? null
        : (valueAt(h, h.sellAge) * (1 - h.sellPct) - owedAt(h, h.sellAge)) / inflAt(h.sellAge),
    })),

    lastPayoff,
    mortgageAtFire: T == null ? 0 : piAt(Math.floor(T)),   // P&I still running when you retire
    minSave: Math.round(minSave), minSaveAge, end, rows, trace, END,
    accessYou, accessPartner, partnerOffset, hasPartner,
    // one-off expense/windfall markers for the chart, and each debt's derived payoff age for its card
    expenseMarks: (p.expenses || []).filter((e) => (+e.amount) || 0)
      .map((e) => ({
        age: Math.round(relAnchor(e) ? (retireAnchor ?? NaN) + (+e.age || 0) : e.age),
        amount: +e.amount,
      }))
      .filter((m) => Number.isFinite(m.age)),
    debtPayoffs: debts.map((d) => (d.neverPays || d.annual <= 0 ? null : d.payoff)),
    // guaranteed-income stream: its present value today (the "lump-sum equivalent") and where it starts
    incomePV, incomeStartMarks,
    incomeAtFire: T == null ? 0 : incomeAt(Math.floor(T)) / Math.pow(1 + p.inflation, Math.floor(T) - p.currentAge),
    // your age when a still-working partner stops earning — only meaningful when that's after you retire
    partnerStopsAtAge: p.partnerWorksAfterRetire && hasPartner && T != null && partnerStopAge > T ? partnerStopAge : null,
    // the age YOUR accounts actually become spendable given when you retire — with a Roth ladder this
    // is retire+5 (capped at 59.5), i.e. the real liquidity wall, which can sit well before 59.5
    unlockYouAtFire: T == null ? null : unlockAt(accessYou, T),
    fireTaxable: nb(fireTaxable), fireLocked: nb(fireLocked), fireBridge: nb(fireBridge),
    lockedShare, illiquidAge,
    // the arithmetic behind an underwater cash account: the flows in the year it broke, plus the year
    // before (usually the year the trouble actually started), both in today's dollars
    underwaterCause: illiquidAge == null ? null : {
      ...cashFlowAt(illiquidAge),
      prev: illiquidAge > p.currentAge ? cashFlowAt(illiquidAge - 1) : null,
      // the cash balance going into the year that broke, so the shortfall can be put in context
      taxableAtStart: (rows.find((r) => r.age === illiquidAge) || {}).taxable ?? null,
    },
    useCoast, coastSpecified, coastTarget, coastCross, coastCrossValue, coastToday: coastAt(p.currentAge),
    // when coast is ON but never reached: what you'd need vs. what you'd have at the coast target
    coastShortfall: !coastSpecified || coastCross != null ? null : (() => {
      const row = rows.find((r) => r.age === coastTarget) || rows[rows.length - 1];
      const bar = coastAt(row.age) / inflAt(row.age);
      return { age: row.age, have: Math.round(row.portfolio), need: Math.round(bar), gap: Math.round(bar - row.portfolio) };
    })(),
    // the partner's own age at the moments that matter, so the UI never has to do the offset math
    partnerAgeAtFire: hasPartner && T != null ? partnerAgeAt(T) : null,
    partnerAgeAtEnd: hasPartner ? partnerAgeAt(END) : null,
  };
}

// Phase-relative expenses are dated off an instant the model SOLVES for, so the schedule depends on
// the answer and the answer depends on the schedule. Resolve it by iteration: run with nothing
// anchored, feed the date back in, run again, and stop once it settles.
//
// It converges quickly because each pass moves the date by less than the last — an expense pushed
// later has less present value, which pushes the date back less. The cap is there for the pathological
// case rather than the normal one; if a plan genuinely oscillates, the final iterate is still a
// coherent world, just not a fixed point. Scenarios with no phase-relative expense take the first
// branch and run exactly once, so nothing that worked before pays for this.
export function simulate(rawP) {
  const hasRelative = (rawP && rawP.expenses || []).some((e) => e && e.anchor === "retirement" && (+e.amount || 0));
  if (!hasRelative) return simulateOnce(rawP, null);

  let out = simulateOnce(rawP, null), anchor = out.fireCross;
  for (let i = 0; i < 6 && anchor != null; i++) {
    const next = simulateOnce(rawP, anchor);
    const moved = next.fireCross == null ? Infinity : Math.abs(next.fireCross - anchor);
    out = next;
    if (moved < 0.01) break;
    anchor = next.fireCross;
  }
  return out;
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

// An "i" that reveals its explanation on hover (and on keyboard focus, so it isn't mouse-only).
// Explanatory prose used to sit permanently under the control it described, which made the input column
// long and buried the fields themselves. CSS-only so there is no state to manage and nothing to
// mispositition on re-render; the bubble is anchored to the icon and clamped to a readable width.
const InfoIcon = ({ children }) => {
  const bubble = useRef(null);
  // A 260px bubble anchored to an icon sitting two-thirds across a 390px phone runs off the screen, and
  // which icons do that depends on where the text wraps — so it can't be solved by hand-picking an anchor
  // per icon. Measure on open and nudge horizontally by whatever it takes to sit inside the viewport.
  const fit = () => {
    const el = bubble.current;
    if (!el) return;
    el.style.transform = "none";                       // reset before measuring
    const r = el.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    if (r.left + dx < pad) dx = pad - (r.left + dx);
    if (dx) el.style.transform = `translateX(${dx}px)`;
  };
  return (
    <span className="info" tabIndex={0} role="note" aria-label="more information"
      onMouseEnter={fit} onFocus={fit}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 14, height: 14, borderRadius: "50%", border: `1px solid ${C.mute}`, color: C.mute,
        lineHeight: 1, cursor: "help", position: "relative", flexShrink: 0, verticalAlign: "middle",
        textTransform: "none", letterSpacing: "normal",
      }}>
      {/* an inline SVG, not the letter "i": a text glyph inherits text-transform from whatever it sits
          in, so the icon rendered as a capital "I" inside the uppercase section titles. A drawn mark
          can't be transformed, restyled by a font stack, or reflowed by letter-spacing. */}
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden focusable="false"
        style={{ display: "block", overflow: "visible" }}>
        <circle cx="8" cy="3.6" r="1.35" fill="currentColor" />
        <rect x="6.8" y="6.4" width="2.4" height="7.2" rx="1.2" fill="currentColor" />
      </svg>
      <span ref={bubble} className="info-bubble" style={{
        position: "absolute", bottom: "calc(100% + 7px)", left: -6, zIndex: 40,
        width: "max-content", maxWidth: "min(260px, calc(100vw - 24px))", padding: "8px 10px",
        background: C.tip, border: `1px solid ${C.line}`, borderRadius: 6,
        boxShadow: "0 8px 22px rgba(0,0,0,.55)",
        color: C.ink, fontSize: 11, fontWeight: 400, fontStyle: "normal", lineHeight: 1.55,
        textTransform: "none", letterSpacing: "normal", textAlign: "left",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        // `display:none` rather than visibility/opacity: an absolutely-positioned element still
        // expands the document's scrollWidth while hidden, which was pushing the page to 619px on a
        // 390px phone and creating a horizontal scrollbar. Taking it out of layout fixes that; the
        // hover rule flips it back to `block` before onMouseEnter measures it.
        display: "none",
      }}>{children}</span>
    </span>
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

// A titled section that folds away. Used to tuck the settings most people never touch (the 59.5 rule,
// college funding, return/inflation assumptions) behind one "Advanced settings" disclosure, so the
// input column leads with the figures that actually get edited.
const Collapsible = ({ title, subtitle, open, onToggle, children }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8 }}>
    <button
      type="button" onClick={onToggle} aria-expanded={open}
      style={{
        background: "transparent", border: "none", width: "100%", cursor: "pointer",
        padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
        fontFamily: "'Space Grotesk', sans-serif", textAlign: "left",
      }}>
      <span>
        <span style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>{title}</span>
        {subtitle && !open && <span style={{ display: "block", fontSize: 10, color: C.mute, marginTop: 3 }}>{subtitle}</span>}
      </span>
      <span style={{ color: C.mute, fontSize: 11, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
    </button>
    {open && <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>}
  </div>
);

// one sub-panel inside Advanced settings — same look as a top-level card, minus the outer chrome
const SubSection = ({ title, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
    <div style={{ fontSize: 11, color: C.brass, letterSpacing: ".06em", textTransform: "uppercase" }}>{title}</div>
    {children}
  </div>
);

// The arithmetic behind a cash account that ran dry, laid out as a ledger. Knowing the year isn't much
// use on its own — what you need is the line that broke the budget, which is why every component is
// shown and the dominant one is called out underneath.
const CashLedger = ({ cause, accessAge }) => {
  if (!cause) return null;
  const { age, takeHome, living, housing, kids, lumps, taxAdv, toTaxable, mortgage, taxableAtStart } = cause;
  const rows = [
    ["Take-home pay", takeHome, true],
    ["Non-housing living", -living, false],
    ["Housing", -housing, false, mortgage > 0 ? `of which mortgage P&I ${fmt(mortgage)}` : null],
    ...(kids ? [["Kids", -kids, false, null]] : []),
    ...(lumps ? [["One-off costs this year", -lumps, false, null]] : []),
  ];
  // what actually broke it: the single biggest outflow, and whether it alone outruns income
  const outflows = [["housing", housing], ["living", living], ["kids", kids], ["one-off costs", lumps]]
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const [biggestName, biggestVal] = outflows[0] || ["spending", 0];
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: C.coral, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 8 }}>
        Why the cash runs out at age {age}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.8 }}>
        {rows.map(([label, v, positive, note]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: C.mute }}>
              {label}{note && <span style={{ fontSize: 10 }}> · {note}</span>}
            </span>
            <span style={{ color: positive ? C.teal : C.ink, whiteSpace: "nowrap" }}>
              {v >= 0 ? "+" : "−"}{fmt(Math.abs(v))}
            </span>
          </div>
        ))}
        <div style={{ borderTop: `1px solid ${C.line}`, margin: "6px 0", paddingTop: 6, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: C.ink }}>Left for the cash account</span>
          <span style={{ color: toTaxable < 0 ? C.coral : C.teal, whiteSpace: "nowrap" }}>
            {toTaxable >= 0 ? "+" : "−"}{fmt(Math.abs(toTaxable))}/yr
          </span>
        </div>
        {taxAdv > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: C.mute }}>…while still routing to 401k/IRA <span style={{ fontSize: 10 }}>· locked until {accessAge}</span></span>
            <span style={{ color: C.locked, whiteSpace: "nowrap" }}>{fmt(taxAdv)}/yr</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.6, marginTop: 10 }}>
        {taxableAtStart != null && toTaxable < 0 && (
          <>You start age {age} with <b>{fmt(taxableAtStart)}</b> of spendable cash and drain{" "}
            <b style={{ color: C.coral }}>{fmt(Math.abs(toTaxable))}</b> that year, so it goes negative. </>
        )}
        {housing > takeHome ? (
          <><b style={{ color: C.coral }}>Housing alone ({fmt(housing)}) costs more than your entire take-home ({fmt(takeHome)}).</b>{" "}
            No allocation change fixes that — the house is the problem.</>
        ) : toTaxable < 0 ? (
          <>The largest outflow is <b>{biggestName} ({fmt(biggestVal)})</b>. Spending exceeds income here, so the gap has to
            close on the spending or income side{taxAdv > 0 ? <>, or by routing less of your pay into locked accounts</> : null}.</>
        ) : (
          <>Income covers the year's spending, so the shortfall comes from money already committed elsewhere —
            typically a lump landing while savings sit locked in retirement accounts.</>
        )}
      </div>
    </div>
  );
};

// Page footnote. The full policies live on their own pages (built by scripts/build-legal.mjs from
// legal.js, the single source of truth); this keeps the one disclaimer that must be impossible to miss
// visible inline, and links out for the rest. Links are RELATIVE so they resolve correctly under a
// project sub-path such as /fire-calculator/ as well as at a domain root.
const Footnote = () => {
  const link = {
    color: C.teal, textDecoration: "none", borderBottom: `1px solid ${C.teal}55`, paddingBottom: 1,
  };
  return (
    <div style={{
      marginTop: 28, paddingTop: 14, borderTop: `1px solid ${C.line}`,
      fontSize: 11, lineHeight: 1.7, color: C.mute, maxWidth: 900,
      display: "flex", flexWrap: "wrap", gap: "6px 18px", alignItems: "baseline",
    }}>
      <span style={{ flex: "1 1 380px", minWidth: 0 }}>
        <b style={{ color: C.ink }}>Not financial advice.</b> A free educational tool — every figure is a
        projection from the assumptions you enter, not a prediction. Nothing you type leaves your browser.
      </span>
      <span style={{ display: "flex", gap: 16, flexShrink: 0 }}>
        <a href="privacy/" style={link}>Privacy Policy</a>
        <a href="terms/" style={link}>Terms &amp; Conditions</a>
      </span>
    </div>
  );
};

// Year-by-year arithmetic for the whole projection. The chart shows the shape; this shows the sums that
// produce it — and in particular answers the question the shape provokes: why does the portfolio keep
// CLIMBING after you retire? Because the retirement bucket is locked until 59.5, so it compounds
// untouched while only the taxable account is drawn down.
const TraceTable = ({ trace, accessAge, fireCross }) => {
  if (!trace || !trace.length) return null;
  const money = (v) => (!v ? <span style={{ color: `${C.mute}66` }}>·</span> : fmt(Math.abs(v)));
  const phaseColor = { working: C.teal, retires: C.brass, retired: C.mute };
  const cell = { padding: "3px 7px", whiteSpace: "nowrap", textAlign: "right" };
  const grp = { ...cell, fontSize: 9, letterSpacing: ".06em", textTransform: "uppercase", textAlign: "center", fontWeight: 400 };
  const edge = `1px solid ${C.line}`;
  return (
    <div>
      <div style={{ maxHeight: 420, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, minWidth: "100%" }}>
          <thead>
            {/* Grouping the columns by ACCOUNT is what makes the table readable: the two buckets obey
                different rules (one pays the bills, one is sealed until 59.5), and seeing each one's
                in / out / interest side by side is precisely what explains the chart's shape. */}
            <tr style={{ position: "sticky", top: 0, background: C.panel, color: C.mute, zIndex: 2 }}>
              <th style={grp} colSpan={2} />
              <th style={{ ...grp, color: C.teal, borderLeft: edge }} colSpan={2}>money in</th>
              <th style={{ ...grp, color: C.coral, borderLeft: edge }} colSpan={4}>money out</th>
              <th style={{ ...grp, color: C.liquid, borderLeft: edge }} colSpan={2}>cash account (taxable)</th>
              <th style={{ ...grp, color: C.locked, borderLeft: edge }} colSpan={3}>retirement accounts</th>
              <th style={{ ...grp, borderLeft: edge }} />
            </tr>
            <tr style={{ position: "sticky", top: 19, background: C.panel, color: C.mute, zIndex: 2, boxShadow: `0 1px 0 ${C.line}` }}>
              <th style={{ ...cell, textAlign: "left" }}>Age</th>
              <th style={{ ...cell, textAlign: "left" }}>Phase</th>
              <th style={{ ...cell, borderLeft: edge }}>pay</th>
              <th style={cell}>other</th>
              <th style={{ ...cell, borderLeft: edge }}>living</th>
              <th style={cell}>housing</th>
              <th style={cell}>kids</th>
              <th style={cell}>one-off</th>
              <th style={{ ...cell, borderLeft: edge }}>interest</th>
              <th style={cell}>balance</th>
              <th style={{ ...cell, borderLeft: edge }}>in</th>
              <th style={cell}>out</th>
              <th style={cell}>interest</th>
              <th style={{ ...cell, borderLeft: edge }}>total</th>
            </tr>
          </thead>
          <tbody>
            {trace.map((t) => {
              const retiring = t.phase === "retires";
              return (
                <tr key={t.age} style={{
                  borderTop: `1px solid ${C.line}55`,
                  background: retiring ? `${C.brass}1A` : "transparent",
                }}>
                  <td style={{ ...cell, textAlign: "left", color: C.ink }}>{t.age}</td>
                  <td style={{ ...cell, textAlign: "left", color: phaseColor[t.phase] }}>
                    {retiring ? `retires ${fireCross != null ? fireCross.toFixed(1) : ""}` : t.phase}
                    {t.locked && t.phase !== "working" ? <span style={{ color: C.locked }}> · locked</span> : null}
                  </td>
                  {/* money in */}
                  <td style={{ ...cell, color: C.teal, borderLeft: edge }}>{money(t.takeHome)}</td>
                  <td style={{ ...cell, color: C.teal }}>{money(t.otherIncome)}</td>
                  {/* money out */}
                  <td style={{ ...cell, color: C.ink, borderLeft: edge }}>{money(t.living)}</td>
                  <td style={{ ...cell, color: C.ink }}>{money(t.housing)}</td>
                  <td style={{ ...cell, color: C.ink }}>{money(t.kids)}</td>
                  <td style={{ ...cell, color: C.ink }}>{money(t.lumps)}</td>
                  {/* cash account */}
                  <td style={{ ...cell, color: t.cashGrowth < 0 ? C.coral : C.liquid, borderLeft: edge }}>
                    {t.cashGrowth < 0 ? "−" : ""}{money(t.cashGrowth)}
                  </td>
                  <td style={{ ...cell, color: t.endTaxable < 0 ? C.coral : C.liquid }}>{money(t.endTaxable)}</td>
                  {/* retirement accounts */}
                  <td style={{ ...cell, color: C.locked, borderLeft: edge }}>{money(t.contributions)}</td>
                  <td style={{ ...cell, color: C.locked }}>{money(t.withdrawn)}</td>
                  <td style={{ ...cell, color: t.advGrowth < 0 ? C.coral : C.locked }}>
                    {t.advGrowth < 0 ? "−" : ""}{money(t.advGrowth)}
                  </td>
                  <td style={{ ...cell, color: C.ink, borderLeft: edge }}>{money(t.endTotal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: C.mute, marginTop: 6, lineHeight: 1.6 }}>
        Today's dollars, at the END of each year. Each account balances exactly:{" "}
        <b style={{ color: C.ink }}>start + in − out + interest = balance</b>, so “interest” is the real
        (inflation-adjusted) return that closes the row. “Pay” is take-home while working; “other” is
        guaranteed income and a working partner's pay once retired. Retirement accounts are{" "}
        <span style={{ color: C.locked }}>locked</span> until {accessAge} — while they are, their “out”
        is zero and the interest simply compounds, which is why the total keeps climbing after you stop
        working. A <span style={{ color: `${C.mute}` }}>·</span> is zero. Note that in take-home mode
        your contributions are already excluded from “pay”, so they are not deducted again here.
      </div>
    </div>
  );
};

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

// a small pill that cycles a field's entry unit (/yr → /mo → …). Purely cosmetic — the value stored is
// always annual dollars; the pill only changes how it's shown and typed.
const UnitPill = ({ label, onClick }) => (
  <button type="button" onClick={onClick} title="change units"
    style={{
      background: "transparent", border: `1px solid ${C.line}`, color: C.teal, borderRadius: 999,
      padding: "0 7px", cursor: "pointer", fontSize: 10, letterSpacing: ".02em", textTransform: "none",
      fontFamily: "'Space Grotesk', sans-serif", flexShrink: 0, lineHeight: 1.7,
    }}>
    {label} ⇄
  </button>
);

// A money field that stores an ANNUAL dollar amount but lets you enter it the way you actually know it:
// /yr, /mo, or (for a 401k-style contribution) as a % of some income base. All conversions go through
// the exported pure helpers, so what you see and what is stored are exact inverses — which is why
// picking a different unit simply re-renders the same stored value in the new unit, and typing
// afterwards commits back through that unit. Nothing about the model changes.
const MONEY_LABEL = { yr: "per year", mo: "per month", pct: "% of income" };
function MoneyField({ label, value, onChange, step = 1000, min = 0, modes = ["yr", "mo"], base = 0 }) {
  const [mode, setMode] = useState(modes[0]);
  const usablePct = mode === "pct" && base > 0;
  // an unfilled box stays unfilled: the app opens with every figure blank, and converting "" through
  // the unit helpers would land on 0 and put a figure the user never typed in front of them
  const blank = value === "" || value === null || value === undefined;
  const shown = blank ? "" : mode === "mo" ? toShown(value, "mo") : usablePct ? pctFromDollars(value, base) : value;
  const commit = (v) => onChange(mode === "mo" ? toAnnual(v, "mo") : usablePct ? Math.round(dollarsFromPct(v, base)) : v);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>{label}</span>
      {/* input and unit picker share a row when there's room; `flexWrap` drops the picker onto its own
          line on a narrow phone rather than crushing the number box. The input flexes but is allowed to
          shrink (minWidth 0 beats the browser's default min-content floor for <input>), so the select
          keeps its natural width and the number field gives up the space instead. */}
      <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <span style={{ flex: "1 1 90px", minWidth: 0 }}>
          <NumberInput
            value={blank ? "" : Number.isFinite(shown) ? Math.round(shown * 100) / 100 : 0}
            step={mode === "mo" ? Math.max(1, Math.round(step / 12)) : usablePct ? 1 : step}
            min={min}
            onCommit={commit}
          />
        </span>
        {modes.length > 1 && (
          <select
            value={mode} onChange={(e) => setMode(e.target.value)} aria-label={`units for ${label}`}
            style={{
              background: C.bg, border: `1px solid ${C.line}`, color: C.teal, borderRadius: 6,
              padding: "7px 4px", cursor: "pointer", fontSize: 11, textTransform: "none",
              fontFamily: "'Space Grotesk', sans-serif", flexShrink: 0, maxWidth: "48%",
            }}>
            {modes.map((m) => <option key={m} value={m} style={{ background: C.panel, color: C.ink }}>{MONEY_LABEL[m]}</option>)}
          </select>
        )}
      </span>
      {usablePct && !blank && (
        <span style={{ fontSize: 10, color: C.mute }}>≈ {fmt(Math.round(value))}/yr of {fmt(Math.round(base))} income</span>
      )}
    </label>
  );
}

// inline caution, for when the inputs contradict each other
const Warn = ({ children }) => (
  <div style={{
    marginTop: 8, padding: "7px 9px", borderRadius: 6, fontSize: 10, lineHeight: 1.6,
    color: C.ink, background: `${C.coral}14`, border: `1px solid ${C.coral}66`,
  }}>
    ⚠ {children}
  </div>
);

// The demo household. The app itself now opens on EMPTY (below) and loads this only when the
// "Load demo" button is pressed — but it is still the canonical parameter set the tests run against.
// `startPortfolio` is INVESTED assets; cash is its own bucket beside it, earning `cashReturn`.
export const DEFAULTS = {
  currentAge: 27, startPortfolio: 560000, startPortfolioTaxAdv: 200000, startCash: 40000,
  annualTakeHome: 144000, annualTaxAdv: 36000,
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
  partnerPortfolio: 135000, partnerPortfolioTaxAdv: 100000, partnerCash: 15000,
  partnerStart: 26, partnerEnd: 60, partnerEnabled: true,
  partnerWorksAfterRetire: false, interimLivingToday: null,
  // EXCLUDES housing — every home now prices its own carry, mortgage and closing costs, so
  // baking a paid-off house into this number would double-count it. (Was 110k incl. ~36k carry.)
  retirementSpendToday: 100000, swr: 0.035, endAge: 100, coastAge: 48, useCoast: true,
  // income can be entered as take-home (default) or gross salary netted by a flat effective rate
  incomeMode: "net", effTaxRate: 25,
  collegeSpread: true, use529: false, annual529: 0,
  enforceAccess: true, rothLadder: false, ladderYears: 5, accessAge: 59.5,
  // cash earns its own (lower) rate; borrowing to fund the plan is off unless you opt in
  cashReturn: 0.04, allowBorrowing: false,
  // homes appreciate; without this they were pure expense and renting forever won by construction
  homeGrowth: 0.04,
};

// What the app opens on: every box you'd type a figure into is blank, and there is no home, no kid
// and no partner until you add one. The chart has nothing to draw and says so, rather than showing a
// stranger's projection you then have to overwrite field by field.
//
// The assumption sliders (return, inflation, withdrawal rate, horizon, access age) keep their values:
// a range input has no empty state, and these are the inputs a first-time visitor is least equipped
// to supply. They are visible and editable under Advanced settings.
export const EMPTY = {
  ...DEFAULTS,
  currentAge: "", startPortfolio: "", startPortfolioTaxAdv: "", startCash: "",
  annualTakeHome: "", annualTaxAdv: "", nonHousingLiving: "", rentAnnual: "",
  homes: [], kids: [], expenses: [], debts: [], incomes: [],
  daycarePerKid: "", ongoingPerKid: "", collegePerKid: "",
  partnerEnabled: false,
  partnerAge: "", partnerIncome: "", partnerTaxAdv: "",
  partnerPortfolio: "", partnerPortfolioTaxAdv: "", partnerCash: "",
  partnerStart: "", partnerEnd: "",
  retirementSpendToday: "", coastAge: "", useCoast: false,
  interimLivingToday: null,
};

// every mark on the chart, switchable. `on` is the default visibility: start with the
// headline story (portfolio vs. the total it must clear, and where they meet) and let the
// liquidity detail be opted into.
const SERIES = [
  { key: "portfolio", label: "total portfolio", color: C.teal, on: true },
  { key: "required", label: "FIRE curve", color: C.brass, dash: true, on: true },
  { key: "retire", label: "FIRE age", color: C.brass, mark: "◆", on: true },
  { key: "coast", label: "coast FIRE curve", color: C.coast, dash: true, on: true },
  { key: "taxable", label: "taxable cash account", color: C.liquid },
  { key: "equity", label: "home equity (not spendable)", color: C.brass },
  { key: "retirement", label: "retirement accounts (401k/IRA)", color: C.locked },
  { key: "bridge", label: "minimum in taxable before retirement", color: C.coral, dash: true },
  { key: "neededRetirement", label: "minimum in retirement accounts", color: C.locked, dash: true },
  { key: "underwater", label: "taxable underwater (< $0)", color: C.coral, mark: "▨", on: true },
  { key: "access", label: "retirement unlocked", color: C.mute, dash: true, on: true },
  { key: "partnerStops", label: "partner stops working", color: C.brass, dash: true, on: true },
  { key: "home", label: "home purchase", color: C.brass, mark: "●", on: true },
  { key: "kids", label: "child born", color: C.ink, mark: "●", on: true },
  { key: "expense", label: "major expense", color: C.coral, mark: "●", on: true },
  { key: "windfall", label: "major income", color: C.liquid, mark: "●", on: true },
];

// exported so tests read the real defaults rather than a hand-copy that silently goes stale whenever
// a series' default visibility changes (which is exactly how the share-link test broke)
export const defaultShow = () => Object.fromEntries(SERIES.map((s) => [s.key, !!s.on]));

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

// A FIRE date the model reaches only by letting the taxable (cash) account go negative is bought with
// an implicit loan (or a 10% early-withdrawal penalty on locked money) — not a fundable plan. `illiquidAge`
// is the model's own flag for "cash went underwater / a bill couldn't be reached". When it's set alongside
// a retirement instant, the date isn't real, so we don't present it as a FIRE number.
// "the only way this balances is by borrowing". With borrowing off (the default) simulate() has
// already withheld the date, so the flag it set is the answer; with borrowing ON the user has opted
// in, so a date is reported and this stays false — the UI warns instead of refusing.
export const retiresOnLoan = (sim) => sim.borrowingBlocked === true;

// the compact, columnar snapshot of everything the chart draws — carries NO inputs
export const snapshotFromSim = (sim, show, enforceAccess) => {
  // a loan-funded retirement instant is not shown, so a shared plot never marks a point that isn't real
  const onLoan = retiresOnLoan(sim);
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
    fireCross: onLoan ? null : sim.fireCross, fireCrossValue: onLoan ? null : sim.fireCrossValue,
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
    portfolio: true, required: true, taxable: true, retirement: true,
    coast: coastTarget != null,          // coast FIRE is opt-in; off ⇒ no curve, no legend chip
    retire: fireCross != null,
    bridge: !!enforceAccess,
    neededRetirement: !!enforceAccess,
    access: !!enforceAccess,
    partnerStops: showPartnerStops,
    underwater: underwaterSpans.length > 0,
    home: homeRows.length > 0,
    kids: kidRows.length > 0,
    equity: rows.some((r) => (r.equity || 0) > 0),
    expense: !!(expenseMarks && expenseMarks.some((m) => m.amount >= 0)),
    windfall: !!(expenseMarks && expenseMarks.some((m) => m.amount < 0)),
  };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 14px 8px" }}>
      <ResponsiveContainer width="100%" height={340}>
        {/* the top margin has to clear the ReferenceLine labels ("59.5", "partner stops 67"), which are
            drawn ABOVE the plot area — at the old 8px they were sliced in half. The right margin does the
            same job horizontally for a label sitting near the end of the axis. */}
        <ComposedChart data={rows} margin={{ top: 26, right: 26, left: 8, bottom: 4 }}>
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
              equity: "Home equity (not spendable)",
              coast: coastTarget != null ? `Coast bar (stop saving, retire at ${coastTarget})` : "Coast bar",
            }[name] || name]}
            labelFormatter={(a) => "Age " + a}
          />
          {show.access && enforceAccess ? (
            <ReferenceLine x={wallAt} stroke={C.mute} strokeDasharray="2 4"
              label={{ value: wallShifted ? `${wallAt.toFixed(0)}` : `${accessYou}`, fill: C.mute, fontSize: 10, position: "top" }} />
          ) : null}
          {show.partnerStops && showPartnerStops ? (
            <ReferenceLine x={partnerStopsAtAge} stroke={C.brass} strokeDasharray="4 3"
              label={{ value: `partner stops ${partnerStopsAtAge.toFixed(0)}`, fill: C.brass, fontSize: 10, position: "insideTopRight" }} />
          ) : null}
          {show.coast && applies.coast ? <Line type="monotone" dataKey="coast" stroke={C.coast} strokeWidth={1.5} strokeDasharray="6 3" dot={false} connectNulls={false} /> : null}
          {show.required ? <Line type="monotone" dataKey="required" stroke={C.brass} strokeWidth={1.5} strokeDasharray="5 4" dot={false} /> : null}
          {show.bridge && enforceAccess ? <Line type="monotone" dataKey="bridge" stroke={C.coral} strokeWidth={1.5} strokeDasharray="3 3" dot={false} /> : null}
          {show.neededRetirement && enforceAccess ? <Line type="monotone" dataKey="neededRetirement" stroke={C.locked} strokeWidth={1.5} strokeDasharray="5 4" dot={false} /> : null}
          {show.retirement ? <Line type="monotone" dataKey="retirement" stroke={C.locked} strokeWidth={1.5} dot={false} /> : null}
          {show.equity && applies.equity ? <Line type="monotone" dataKey="equity" stroke={C.brass} strokeWidth={1.5} strokeDasharray="1 3" dot={false} /> : null}
          {show.taxable ? <Line type="monotone" dataKey="taxable" stroke={C.liquid} strokeWidth={1.5} dot={false} /> : null}
          {show.portfolio ? <Line type="monotone" dataKey="portfolio" stroke={C.teal} strokeWidth={2.5} dot={false} /> : null}
          {show.home ? homeRows.map((h) => <ReferenceDot key={h.age} x={h.age} y={h.portfolio} r={5} fill={C.brass} stroke={C.bg} />) : null}
          {show.kids ? kidRows.map((k) => (
            <ReferenceDot key={k.age} x={k.age} y={k.portfolio} r={4} fill={C.ink} stroke={C.bg}
              label={k.bornNames && k.bornNames.length
                ? { value: k.bornNames.join(", "), fill: C.ink, fontSize: 10, position: "top" }
                : undefined} />
          )) : null}
          {/* a one-off is a cost or income depending on its sign; they get their own colour AND their
              own legend chip, so a teal dot on the chart has something to point back to */}
          {expenseMarks ? expenseMarks.map((m, i) => {
            const income = m.amount < 0;
            if (!(income ? show.windfall : show.expense)) return null;
            const row = rows.find((r) => r.age === m.age);
            return row ? <ReferenceDot key={`x${i}`} x={m.age} y={row.portfolio} r={5} fill={income ? C.liquid : C.coral} stroke={C.bg} strokeWidth={1.5} /> : null;
          }) : null}
          {show.coast && applies.coast && coastCross ? <ReferenceDot x={coastCross} y={coastCrossValue} r={5} fill={C.coast} stroke={C.bg} strokeWidth={2} /> : null}
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
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');
        /* InfoIcon: reveal on hover AND on keyboard focus, so the explanation is reachable without a mouse */
        .info:hover > .info-bubble, .info:focus > .info-bubble, .info:focus-visible > .info-bubble {
          display: block !important;
        }
        .info:focus-visible { outline: 2px solid ${C.teal}; outline-offset: 2px; }`}</style>
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
      <Footnote />
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
  // A "full details" link pre-fills the whole calculator; anything not in the link falls back to the
  // demo values. With no link we open EMPTY — blank boxes, no chart — so nobody has to overwrite a
  // stranger's household field by field before the numbers mean anything.
  const [p, setP] = useState(() => (shared && shared.mode === "full" ? { ...DEFAULTS, ...shared.p } : EMPTY));
  const [show, setShow] = useState(() => ({ ...defaultShow(), ...(shared && shared.mode === "full" ? shared.show : null) }));
  const [advancedOpen, setAdvancedOpen] = useState(false);   // the rarely-touched settings start folded
  const [traceOpen, setTraceOpen] = useState(false);         // the year-by-year arithmetic, on demand
  const [leversOpen, setLeversOpen] = useState(true);        // …but the levers are the payoff, so open
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
  // merge a patch into one home — used by the buy/own and %/$ mode toggles, which flip several keys at once
  const patchHome = (i, patch) =>
    setP((s) => ({ ...s, homes: s.homes.map((h, j) => (j === i ? { ...h, ...patch } : h)) }));
  const setKid = (i, patch) =>
    setP((s) => ({ ...s, kids: s.kids.map((k, j) => (j === i ? { ...k, ...patch } : k)) }));
  // Adding a kid seeds the three per-kid cost fields, because a kid with blank costs is a kid that
  // costs nothing — the one thing we know is false. Only blanks are filled: a figure you have already
  // typed (including a deliberate 0) survives adding a second kid untouched.
  const addKid = () =>
    setP((s) => {
      const last = s.kids[s.kids.length - 1];
      const blank = (v) => v === "" || v === null || v === undefined;
      const seed = (k) => (blank(s[k]) ? DEFAULTS[k] : s[k]);
      // A new kid lands two years after the last one, or two years from now for the first. With no
      // age to count from there is no sensible answer, so leave it blank for the user rather than
      // inventing one: `"" + 2` is the string "2", which rendered as a birth age of two and, once a
      // real age was typed, as a birth year decades in the past.
      const usable = (v) => Number.isFinite(+v) && +v > 0;
      // count from the last kid, or from your age when there is no last kid — or when that kid's own
      // birth age is still blank, which is what happens if kids were added before the age was typed
      const prev = last && usable(last.birthAge) ? +last.birthAge : +s.currentAge;
      const birthAge = usable(prev) ? prev + 2 : "";
      return {
        ...s,
        kids: [...s.kids, { birthAge }],
        daycarePerKid: seed("daycarePerKid"),
        ongoingPerKid: seed("ongoingPerKid"),
        collegePerKid: seed("collegePerKid"),
      };
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
  // Same helper the shared-plot view uses, so both read "underwater" identically.
  const underwaterSpans = useMemo(() => underwaterOf(sim.rows, sim.END), [sim]);
  // Until the inputs make the question well posed there is no answer to show — which is NOT the same
  // as "you never retire", nor as "you can retire today". Every panel below is gated on this, because
  // a half-filled form otherwise produces confident nonsense in both directions: an untouched form
  // reads as a failed plan, and an age-only form reads as "stop working today" (Need is zero when no
  // spending has been entered, so any balance clears it).
  const readiness = useMemo(() => planReadiness(p), [p]);
  const hasPlan = readiness.ready && sim.rows.length > 0;
  const neverRetire = hasPlan && sim.fireCross == null;
  // WHY you're stuck — three genuinely different failures, and the fix differs for each:
  //  • bridge     — enough in total AND enough liquid; only the 59.5 wall blocks you (gate-off retires)
  //  • insolvent  — total wealth does reach the requirement, but spendable cash is underwater, so you'd
  //                 be retiring on debt (gate-off still can't retire because taxable never clears $0)
  //  • tooPoor    — total wealth never reaches the requirement at any age
  const totalEverEnough = sim.rows.some((r) => r.portfolio >= r.required);
  const blockedByBridge = neverRetire && simFree.fireCross != null;
  const blockedByDebt = neverRetire && !blockedByBridge && totalEverEnough && underwaterSpans.length > 0;
  // the model DID find a date, but only by running the cash account negative somewhere along the way —
  // an implicit loan. We don't present that as a FIRE number; we explain it and still offer the fix.
  const retireOnLoan = retiresOnLoan(sim);
  const kidsCount = p.kids.length;
  const cap529 = kidsCount * 19000;
  // Which child-cost phases are still ahead of at least one kid. A phase entirely in the past can
  // never be charged, so the field for it is noise. `collegeSpread` stretches college to 21.
  const kidPhases = useMemo(() => {
    const collegeEnd = p.collegeSpread ? 21 : 18;
    const ages = p.kids
      .map((k) => (k.ageNow != null && k.ageNow !== "" ? +k.ageNow : +p.currentAge - +k.birthAge))
      .filter((a) => Number.isFinite(a));
    const anyBefore = (end) => ages.some((a) => a <= end);   // still ahead of, or inside, the phase
    return {
      daycare: ages.length === 0 || anyBefore(5),
      ongoing: ages.length === 0 || anyBefore(17),
      college: ages.length === 0 || anyBefore(collegeEnd),
    };
  }, [p.kids, p.currentAge, p.collegeSpread]);

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
    // `ready` as well as a date: on a half-filled form the model still returns a crossing (at your
    // current age, because Need is zero), and every lever then re-runs to the same 0.0y — a table of
    // nothing, eight simulations per keystroke to produce it.
    if (!readiness.ready || sim.fireCross == null) return [];
    // Only levers you can actually pull. Market return and inflation used to be listed (flagged "not
    // your choice") and would usually top the table — which is true but useless as advice, and it
    // squashed the bars for every decision you can really make. They're gone: this table is now
    // exclusively actionable, and the bar scale is set by real choices.
    const defs = [
      { label: "Retirement spend −$10k/yr", over: { retirementSpendToday: Math.max(0, p.retirementSpendToday - 10000) } },
      { label: "Your take-home +$10k/yr", over: { annualTakeHome: p.annualTakeHome + 10000 } },
      { label: "Living costs −$5k/yr", over: { nonHousingLiving: Math.max(0, p.nonHousingLiving - 5000) } },
      ...(p.partnerAge > 0 && p.partnerEnabled !== false
        ? [{ label: "Partner take-home +$10k/yr", over: { partnerIncome: p.partnerIncome + 10000 } }] : []),
      ...(p.homes.some((h) => !h.owned && h.price > 0)
        ? [{ label: p.homes.length > 1 ? "Every home −$100k" : "Home price −$100k",
             over: { homes: p.homes.map((h) => (h.owned ? h : { ...h, price: Math.max(0, h.price - 100000) })) } }] : []),
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

  // The stretch after you retire but before the 59.5 wall opens: the retirement bucket cannot be touched,
  // so it compounds untouched and drags the TOTAL curve upward even though you've stopped earning. That
  // shape reads as a bug until it's spelled out, so pull the numbers for the trace section's callout.
  const lockedGrowth = useMemo(() => {
    const seg = sim.trace.filter((t) => t.phase !== "working" && t.locked);
    if (seg.length < 2) return null;
    const from = seg[0].startTaxAdv, to = seg[seg.length - 1].endTaxAdv;
    if (to <= from) return null;                       // only worth explaining when it actually grows
    return { from, to, fromAge: seg[0].age, toAge: seg[seg.length - 1].age + 1 };
  }, [sim.trace]);
  const ticks = []; for (let a = 30; a <= sim.END; a += 10) ticks.push(a);

  const Stat = ({ label, value, accent, sub }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: C.mute, letterSpacing: ".05em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, color: accent || C.ink }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: C.mute }}>{sub}</span>}
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

  const gross = p.incomeMode === "gross";   // income fields entered as gross salary, netted by effTaxRate

  return (
    <div style={{ background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: isMobile ? 12 : 24, borderRadius: 12 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');
        /* InfoIcon: reveal on hover AND on keyboard focus, so the explanation is reachable without a mouse */
        .info:hover > .info-bubble, .info:focus > .info-bubble, .info:focus-visible > .info-bubble {
          display: block !important;
        }
        .info:focus-visible { outline: 2px solid ${C.teal}; outline-offset: 2px; }`}</style>

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
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexShrink: 0 }}>
            <button
              onClick={() => { setP(DEFAULTS); setShow(defaultShow()); }}
              title="Fill every field with a worked example you can then edit"
              style={{
                background: hasPlan ? "transparent" : C.brass, color: hasPlan ? C.brass : C.bg,
                border: `1px solid ${C.brass}`, borderRadius: 8, cursor: "pointer",
                padding: "8px 14px", fontFamily: "'Space Grotesk', sans-serif", fontSize: 13,
                fontWeight: 500, whiteSpace: "nowrap",
              }}>
              ▶ Load demo
            </button>
            <ShareMenu p={p} show={show} sim={sim} />
          </div>
        </div>
        <p style={{ margin: "8px 0 0", color: C.mute, fontSize: 14, maxWidth: 680 }}>
          {hasPlan ? <>Age {p.currentAge} to {sim.END}, all in <em>today's dollars</em>. </> : null}
          Retiring takes <b>two</b> things, and the
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
              ["Age", "currentAge", {}],
              ["Cash (savings / checking)", "startCash", { step: 5000 }],
              ["Investments", "startPortfolio", { step: 10000 }],
              ["Portion of investments in tax-advantaged accounts (401k / IRA / HSA)", "startPortfolioTaxAdv", { step: 10000, max: p.startPortfolio }],
              [gross ? "Gross salary" : "Take-home Pay (after contributions)", "annualTakeHome", { step: 1000, money: true }],
              ["Tax-advantaged contribution", "annualTaxAdv", { step: 500, money: true, modes: ["yr", "mo", "pct"], base: p.annualTakeHome }],
              ["Non-housing expense", "nonHousingLiving", { step: 1000, money: true }],
              ["Current rent", "rentAnnual", { step: 1000, money: true }],
            ]],
            ["Partner", [
              ["Age (0 = single)", "partnerAge", {}],
              ["Cash (savings / checking)", "partnerCash", { step: 5000 }],
              ["Investments", "partnerPortfolio", { step: 10000 }],
              ["Portion of investments in tax-advantaged accounts (401k / IRA / HSA)", "partnerPortfolioTaxAdv", { step: 10000, max: p.partnerPortfolio }],
              [gross ? "Partner gross salary" : "Take-home Pay (after contributions)", "partnerIncome", { step: 5000, money: true }],
              ["Tax-advantaged contribution", "partnerTaxAdv", { step: 500, money: true, modes: ["yr", "mo", "pct"], base: p.partnerIncome }],
              ["Partner earns from their age", "partnerStart", { min: p.partnerAge }],
              ["…until their age", "partnerEnd", { min: p.partnerStart, yearRef: p.partnerAge }],
            ]],
            ["Retirement", [
              ["Retirement spending, excluding housing", "retirementSpendToday", { step: 5000, money: true }],
              ["Life Expectancy", "endAge", { yearRef: p.currentAge }],
              // the coast target only exists when coast FIRE is switched on below
              ...(p.useCoast !== false ? [["Coast FIRE: fully retire at age", "coastAge", { yearRef: p.currentAge }]] : []),
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
                {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && (
                  <InfoIcon>
                    <b style={{ color: C.ink }}>Every field here is in your partner's own age.</b>{" "}
                    {sim.partnerOffset === 0
                      ? "They're the same age as you, so your timelines agree."
                      : `They're ${Math.abs(sim.partnerOffset)} year${Math.abs(sim.partnerOffset) !== 1 ? "s" : ""} ${sim.partnerOffset > 0 ? "younger" : "older"} than you, so their financial timeline runs ${Math.abs(sim.partnerOffset)} year${Math.abs(sim.partnerOffset) !== 1 ? "s" : ""} ${sim.partnerOffset > 0 ? "behind" : "ahead"} of yours.`}
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
                  </InfoIcon>
                )}
                {group === "Retirement" && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, color: C.mute, letterSpacing: ".03em" }}>
                    <input type="checkbox" checked={p.useCoast !== false}
                      onChange={(e) => set("useCoast", e.target.checked)}
                      style={{ accentColor: C.coast, cursor: "pointer", width: 15, height: 15 }} />
                    Calculate coast FIRE
                  </label>
                )}
              </div>
              {!(group === "Partner" && p.partnerEnabled === false) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fields.map(([l, k, o]) => (
                  <React.Fragment key={k}>
                    {o.money
                      ? <MoneyField label={l} value={p[k]} onChange={(v) => set(k, v)} step={o.step} modes={o.modes} base={o.base} />
                      : field(l, k, p[k], set, o)}
                    {/* the gross/net switch belongs beside the salary it reinterprets, not in a
                        separate block further down the column */}
                    {/* ticking the box adds this field but no curve — say why, rather than leaving
                        the chart looking broken */}
                    {k === "coastAge" && !(p.coastAge > 0) && (
                      <div style={{ fontSize: 10, color: C.mute, marginTop: -6, lineHeight: 1.6 }}>
                        Enter the age you'd fully retire and the coast curve appears — it's the pot that,
                        left alone from today with no further saving, still gets you there.
                      </div>
                    )}
                    {k === "annualTakeHome" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: -4 }}>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 11, color: C.ink }}>
                          <input type="checkbox" checked={gross}
                            onChange={(e) => set("incomeMode", e.target.checked ? "gross" : "net")}
                            style={{ accentColor: C.teal, cursor: "pointer", width: 15, height: 15, flexShrink: 0 }} />
                          I entered gross salary
                          <InfoIcon>Treats the figure above as your full pre-tax salary — including your
                            pre-tax 401k/HSA contribution. The contribution comes out first, then the flat
                            effective rate is applied to the rest, and both are applied to your partner's
                            salary too. A convenience, not a tax model.</InfoIcon>
                        </label>
                        {gross && field("Effective tax rate %", "effTaxRate", p.effTaxRate, set, { step: 1, max: 100 })}
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </div>
              )}


              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.line}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!p.partnerWorksAfterRetire}
                      onChange={(e) => set("partnerWorksAfterRetire", e.target.checked)}
                      style={{ accentColor: C.teal, cursor: "pointer", width: 15, height: 15, marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: C.ink, lineHeight: 1.4, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      Partner keeps working after you retire
                      <InfoIcon>Their income (to their age {p.partnerEnd}) funds the household, so you can
                        retire sooner if the math allows.</InfoIcon>
                    </span>
                  </label>
                  {p.partnerWorksAfterRetire &&
                    <MoneyField label="Non-housing expense while they work" value={p.interimLivingToday ?? p.nonHousingLiving}
                      onChange={(v) => set("interimLivingToday", v)} step={1000} />}
                </div>
              )}

              {/* the locked slice cannot exceed the pot it is a slice of — this fires if the
                  portfolio is later lowered beneath a 401k figure that was already valid */}
              {group === "You" && p.startPortfolioTaxAdv > p.startPortfolio && (
                <Warn>
                  Your 401k/IRA (<b>{fmt(p.startPortfolioTaxAdv)}</b>) is more than your total investments
                  (<b>{fmt(p.startPortfolio)}</b>). The model caps it there, so every invested dollar counts as
                  locked and <b>only your cash is spendable</b> — which will strand your bridge. Raise investments
                  or lower the 401k figure.
                </Warn>
              )}
              {group === "Partner" && p.partnerEnabled !== false && p.partnerAge > 0 && p.partnerPortfolioTaxAdv > p.partnerPortfolio && (
                <Warn>
                  Your partner's 401k/IRA (<b>{fmt(p.partnerPortfolioTaxAdv)}</b>) is more than their total
                  investments (<b>{fmt(p.partnerPortfolio)}</b>). The model caps it there — all locked, none
                  taxable.
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
              const owned = !!h.owned;
              const dollarCarry = owned || h.carryMode === "dollar";
              // flip to "already own it", prefilling the payment/years/carry from the buy params so nothing jumps
              const toOwned = () => patchHome(i, {
                owned: true,
                monthlyPI: Math.round((m?.mPI ?? 0) / 12),
                yearsLeft: Math.max(0, Math.round((m?.payoff ?? p.currentAge) - p.currentAge)),
                propTaxAnnual: Math.round((h.price || 0) * (h.propTaxRate || 0)),
                insMaintAnnual: Math.round((h.price || 0) * (h.insMaintRate || 0)),
              });
              // flip carry between % of price and $/yr, prefilling the other representation
              const toDollarCarry = () => patchHome(i, { carryMode: "dollar",
                propTaxAnnual: Math.round((h.price || 0) * (h.propTaxRate || 0)),
                insMaintAnnual: Math.round((h.price || 0) * (h.insMaintRate || 0)) });
              const toPctCarry = () => patchHome(i, { carryMode: "pct",
                propTaxRate: h.price > 0 ? +((h.propTaxAnnual || 0) / h.price).toFixed(4) : (h.propTaxRate || 0),
                insMaintRate: h.price > 0 ? +((h.insMaintAnnual || 0) / h.price).toFixed(4) : (h.insMaintRate || 0) });
              return (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                    <span style={{ fontSize: 11, color: C.brass, letterSpacing: ".06em", textTransform: "uppercase" }}>
                      Home {i + 1}
                    </span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <UnitPill label={owned ? "I already own it" : "planning to buy"}
                        onClick={() => (owned ? patchHome(i, { owned: false }) : toOwned())} />
                      <DropButton onClick={() => dropHome(i)} />
                    </div>
                  </div>

                  {owned ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Num label="What it's worth today" value={h.price ?? 0} step={25000} onChange={(v) => setHome(i, "price", v)} />
                      <Num label="Mortgage rate %" value={h.rate ?? 0} pct step={0.125} onChange={(v) => setHome(i, "rate", v)} />
                      <Num label="Payment / mo (P&I)" value={h.monthlyPI ?? 0} step={100} onChange={(v) => setHome(i, "monthlyPI", v)} />
                      {/* a duration, not an age — so anchor the year hint at today rather than at
                          your current age, and it reads as the year the mortgage clears */}
                      <Num label="Years left" value={h.yearsLeft ?? 0} step={1} yearRef={0}
                        onChange={(v) => setHome(i, "yearsLeft", v)} />
                      <Num label="Property tax / yr ($)" value={h.propTaxAnnual ?? 0} step={500} onChange={(v) => setHome(i, "propTaxAnnual", v)} />
                      <Num label="Ins + maint / yr ($)" value={h.insMaintAnnual ?? 0} step={500} onChange={(v) => setHome(i, "insMaintAnnual", v)} />
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Num label="Price" value={h.price} step={25000} onChange={(v) => setHome(i, "price", v)} />
                      <Num label="Buy at your age" value={h.purchaseAge} yearRef={p.currentAge} onChange={(v) => setHome(i, "purchaseAge", v)} />
                      <Num label="Down %" value={h.downPct} pct step={1} onChange={(v) => setHome(i, "downPct", v)} />
                      <Num label="Rate %" value={h.rate} pct step={0.125} onChange={(v) => setHome(i, "rate", v)} />
                      <Num label="Term (yrs)" value={h.term} onChange={(v) => setHome(i, "term", v)} />
                      <Num label="Closing %" value={h.closingPct} pct step={0.5} onChange={(v) => setHome(i, "closingPct", v)} />
                      {dollarCarry ? (
                        <>
                          <Num label="Prop tax / yr ($)" value={h.propTaxAnnual ?? 0} step={500} onChange={(v) => setHome(i, "propTaxAnnual", v)} />
                          <Num label="Ins + maint / yr ($)" value={h.insMaintAnnual ?? 0} step={500} onChange={(v) => setHome(i, "insMaintAnnual", v)} />
                        </>
                      ) : (
                        <>
                          <Num label="Prop tax %" value={h.propTaxRate} pct step={0.1} onChange={(v) => setHome(i, "propTaxRate", v)} />
                          <Num label="Ins + maint %" value={h.insMaintRate} pct step={0.1} onChange={(v) => setHome(i, "insMaintRate", v)} />
                        </>
                      )}
                    </div>
                  )}

                  {!owned && (
                    <div style={{ marginTop: 8 }}>
                      <UnitPill label={dollarCarry ? "tax & upkeep: $/yr" : "tax & upkeep: % of price"}
                        onClick={() => (dollarCarry ? toPctCarry() : toDollarCarry())} />
                    </div>
                  )}

                  {/* Selling is what makes a home an asset rather than a hole. Leave the age blank to
                      keep it for good. */}
                  <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 9 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Num label="Sell at your age (blank = keep)" value={h.sellAge ?? ""} step={1}
                        yearRef={p.currentAge} onChange={(v) => setHome(i, "sellAge", v || null)} />
                      <Num label="Selling costs %" value={h.sellCostPct ?? 6} step={0.5}
                        onChange={(v) => setHome(i, "sellCostPct", v)} />
                    </div>
                    {m && m.sellAge != null && (
                      <div style={{ fontSize: 10, color: C.mute, marginTop: 7, lineHeight: 1.6 }}>
                        Sells for <b style={{ color: C.ink }}>{fmt(m.saleValue)}</b> in today's $
                        {m.saleOwed > 0 && <> · still owing <b style={{ color: C.ink }}>{fmt(m.saleOwed)}</b></>}
                        {" "}· nets <b style={{ color: m.saleNet >= 0 ? C.teal : C.coral }}>{fmt(m.saleNet)}</b> into
                        your taxable account.
                        {m.saleNet < 0 && <> That's a sale <b style={{ color: C.coral }}>underwater</b> — it costs
                          you cash rather than paying you.</>}
                      </div>
                    )}
                  </div>

                  {m && (
                    <div style={{ fontSize: 10, color: C.mute, marginTop: 8, lineHeight: 1.6 }}>
                      {!owned && <>cash at closing <b style={{ color: C.ink }}>{fmt(m.down)}</b> · </>}
                      P&I <b style={{ color: C.ink }}>{fmt(m.mPI)}</b>/yr ·
                      carry <b style={{ color: C.ink }}>{fmt(m.carryAtBuy)}</b>/yr ·
                      clear at <b style={{ color: C.brass }}>age {m.payoff}</b>
                      {!owned && h.purchaseAge < p.currentAge && (
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
            {/* `birthAge` is ALWAYS the stored value and `entry` only chooses how it is displayed, so
                switching back and forth is lossless. The previous version rewrote the data on every
                switch and clamped it at zero, which is why a kid entered as birth-age 30 came back as
                27 after two toggles: 30 → max(0, 27−30)=0 → 27−0=27. Deriving instead of rewriting
                removes that class of bug entirely. */}
            {p.kids.map((k, i) => {
              // legacy share links may still carry `ageNow`; fold it into the canonical field for display
              // preserve a blank birth age as blank — coercing it with `+` turns "" into 0, which
              // shows a typed-looking zero in a box the user has not filled in yet
              const rawBirth = (k.ageNow != null && k.ageNow !== "") ? p.currentAge - (+k.ageNow) : k.birthAge;
              const birthAge = (rawBirth === "" || rawBirth == null) ? "" : +rawBirth;
              const showNow = k.entry === "now";
              const yearsAway = birthAge - p.currentAge;
              // a name, when given, replaces "Kid N" everywhere that number appears
              const who = kidName(k, i);
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <TextField label={`Kid ${i + 1} — name (optional)`} value={k.name || ""}
                    placeholder={`Kid ${i + 1}`} onChange={(v) => setKid(i, { name: v })} />
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      {showNow
                        ? <Num label={`${who} — age now`} value={p.currentAge - birthAge} step={1} min={-120}
                            onChange={(v) => setKid(i, { birthAge: p.currentAge - v, ageNow: undefined })} />
                        : <Num label={`${who} — your age at birth`} value={birthAge} yearRef={p.currentAge}
                            onChange={(v) => setKid(i, { birthAge: v, ageNow: undefined })} />}
                    </div>
                    <DropButton onClick={() => dropKid(i)} />
                  </div>
                  <select
                    value={showNow ? "now" : "birth"} aria-label={`how to enter ${who}'s age`}
                    onChange={(ev) => setKid(i, { entry: ev.target.value, birthAge, ageNow: undefined })}
                    style={{
                      background: C.bg, border: `1px solid ${C.line}`, color: C.teal, borderRadius: 5,
                      padding: "3px 5px", cursor: "pointer", fontSize: 10, alignSelf: "flex-start",
                      fontFamily: "'Space Grotesk', sans-serif",
                    }}>
                    <option value="birth" style={{ background: C.panel, color: C.ink }}>entering birth age</option>
                    <option value="now" style={{ background: C.panel, color: C.ink }}>entering age now</option>
                  </select>
                  {showNow && yearsAway > 0 && (
                    <span style={{ fontSize: 10, color: C.mute }}>
                      {k.name ? `${k.name} isn't born yet` : "Not born yet"} — arrives in {yearsAway} year{yearsAway !== 1 ? "s" : ""}.
                    </span>
                  )}
                </div>
              );
            })}
            {kidsCount > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 2 }}>
                {/* Only ask for a cost you can still incur. A phase every child has already aged out
                    of will never be charged — kidCostAt() keys off each kid's own age — so asking a
                    parent of teenagers for a daycare figure is asking for a number that cannot
                    affect the answer. Ages are measured from today, since the past is already in
                    your current balances. */}
                {kidPhases.daycare && field("Daycare / kid / yr (ages 0–5)", "daycarePerKid", p.daycarePerKid, set, { step: 1000 })}
                {kidPhases.ongoing && field("Ongoing / kid / yr (ages 6–17)", "ongoingPerKid", p.ongoingPerKid, set, { step: 1000 })}
                {kidPhases.college && field("College / kid (today's $)", "collegePerKid", p.collegePerKid, set, { step: 10000 })}
                {!kidPhases.daycare && !kidPhases.ongoing && !kidPhases.college && (
                  <div style={{ fontSize: 10, color: C.mute, lineHeight: 1.6 }}>
                    Everyone's grown — no daycare, school or college costs left to plan for.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* MAJOR EXPENSES / INCOME — one-off lumps in today's $; +cost / -income; optional window */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Major expenses / income{" "}
                <InfoIcon>One-off events: a wedding, medical costs, a car, an inheritance. Pick whether
                  each is money <em>out</em> or money <em>in</em> and enter the amount as a positive
                  figure. Set an “until” age to repeat it every year across a window.</InfoIcon>
                {p.expenses.length > 0 && <span style={{ color: C.mute }}> · {p.expenses.length}</span>}
              </div>
              <AddButton onClick={addExpense} label="add event" />
            </div>
            {p.expenses.map((e, i) => (
              <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, background: C.bg, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <TextField label="what" value={e.label} placeholder="wedding, medical…" onChange={(v) => setExpense(i, "label", v)} />
                  </div>
                  <DropButton onClick={() => dropExpense(i)} />
                </div>
                {/* Kind first, magnitude second. The stored value stays SIGNED (+cost / −income) so the
                    model and every share link are untouched; the UI just splits that one number into a
                    direction you pick and a magnitude you type, which removes the "why is my inheritance
                    negative?" trap without touching the math. */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 10, letterSpacing: ".03em", color: C.mute, textTransform: "uppercase" }}>this is an</span>
                    <select
                      value={e.amount < 0 ? "income" : "expense"}
                      onChange={(ev) => setExpense(i, "amount", Math.abs(+e.amount || 0) * (ev.target.value === "income" ? -1 : 1))}
                      style={{
                        background: C.bg, border: `1px solid ${C.line}`, color: e.amount < 0 ? C.liquid : C.coral,
                        borderRadius: 5, padding: "6px 6px", cursor: "pointer", fontSize: 13,
                        fontFamily: "'Space Grotesk', sans-serif", width: "100%", boxSizing: "border-box",
                      }}>
                      <option value="expense" style={{ background: C.panel, color: C.ink }}>expense (money out)</option>
                      <option value="income" style={{ background: C.panel, color: C.ink }}>income (money in)</option>
                    </select>
                  </label>
                  <Num label="amount (today's $)" value={Math.abs(+e.amount || 0)} step={1000} min={0}
                    onChange={(v) => setExpense(i, "amount", Math.abs(v) * ((+e.amount || 0) < 0 ? -1 : 1))} />
                  {e.anchor === "retirement" ? (
                    <>
                      <Num label="years from retirement" value={e.age} step={1} min={-60}
                        onChange={(v) => setExpense(i, "age", v)} />
                      <Num label="until (blank=one-off)" value={e.until ?? ""} step={1} min={-60}
                        onChange={(v) => setExpense(i, "until", v === "" ? null : v)} />
                    </>
                  ) : (
                    <>
                      <Num label="at your age" value={e.age} step={1} yearRef={p.currentAge} onChange={(v) => setExpense(i, "age", v)} />
                      <Num label="until age (blank=one-off)" value={e.until ?? ""} step={1} yearRef={p.currentAge} onChange={(v) => setExpense(i, "until", v || null)} />
                    </>
                  )}
                </div>
                {/* Dating an expense off retirement rather than off an age: the model solves for the
                    date, so "the first ten years of retirement" is not something you can express as a
                    fixed age until you already know the answer. */}
                <select
                  value={e.anchor === "retirement" ? "retirement" : "age"}
                  aria-label={`what ${e.label || "this expense"} is dated from`}
                  onChange={(ev) => {
                    const toRel = ev.target.value === "retirement";
                    // carry the value across frames so the field doesn't read as a wild age/offset
                    const at = Math.round(sim.fireCross ?? p.currentAge);
                    setExpense(i, "anchor", toRel ? "retirement" : "age");
                    setP((s) => ({ ...s, expenses: s.expenses.map((x, j) => j !== i ? x : {
                      ...x, anchor: toRel ? "retirement" : "age",
                      age: toRel ? Math.round((+x.age || 0) - at) : Math.round((+x.age || 0) + at),
                      until: x.until == null || x.until === "" ? x.until
                        : toRel ? Math.round((+x.until || 0) - at) : Math.round((+x.until || 0) + at),
                    }) }));
                  }}
                  style={{
                    background: C.bg, border: `1px solid ${C.line}`, color: C.teal, borderRadius: 5,
                    padding: "3px 5px", cursor: "pointer", fontSize: 10, alignSelf: "flex-start",
                    fontFamily: "'Space Grotesk', sans-serif",
                  }}>
                  <option value="age" style={{ background: C.panel, color: C.ink }}>dated at an age</option>
                  <option value="retirement" style={{ background: C.panel, color: C.ink }}>dated from retirement</option>
                </select>
                {(() => {
                  if (e.anchor === "retirement") {
                    const o0 = Math.round(+e.age || 0), o1 = e.until == null || e.until === "" ? o0 : Math.round(+e.until);
                    const when = (o) => o === 0 ? "the year you retire" : o > 0 ? `${o}y after retiring` : `${-o}y before retiring`;
                    return (
                      <div style={{ fontSize: 10, color: C.mute }}>
                        {fmt(Math.abs(e.amount))} {e.amount < 0 ? "in" : "out"}
                        {o1 > o0 ? <> each year from {when(o0)} to {when(o1)}</> : <> at {when(o0)}</>}
                        {sim.fireCross != null && <> — on the current answer, your age {Math.round(sim.fireCross + o0)}
                          {o1 > o0 ? `–${Math.round(sim.fireCross + o1)}` : ""}.</>}
                      </div>
                    );
                  }
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
                Retirement income{" "}
                <InfoIcon>Pension, Social Security, an annuity — guaranteed income you'll draw <em>in</em>
                  retirement. It lowers the number you need and, being spendable cash, shrinks the 59.5
                  bridge. A pot (a lump-sum payout, a rollover) is not this — add that to your portfolio
                  instead.</InfoIcon>
                {p.incomes?.length > 0 && <span style={{ color: C.mute }}> · {p.incomes.length}</span>}
              </div>
              <AddButton onClick={addIncome} label="add income" />
            </div>
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
                  <MoneyField label="amount (today's $)" value={+inc.amount || 0} step={1000} onChange={(v) => setIncome(i, "amount", v)} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
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
                Debts{" "}
                <InfoIcon>Student, car and personal loans. Enter the balance you owe today, the rate, and
                  what you actually pay each month — the payoff age is derived from those.</InfoIcon>
                {p.debts.length > 0 && <span style={{ color: C.mute }}> · {p.debts.length}</span>}
              </div>
              <AddButton onClick={addDebt} label="add debt" />
            </div>
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

          <Collapsible
            title="Advanced settings"
            subtitle="59.5 rule · child college funding · return, inflation and withdrawal assumptions"
            open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}
          >
            <SubSection title="Access to retirement accounts">
              <Toggle on={p.enforceAccess} onClick={() => set("enforceAccess", !p.enforceAccess)}
                label="Retirement accounts locked until 59.5"
                sub={p.enforceAccess ? "on — 401k/IRA can't pay bills before 59.5" : "off — every dollar spendable at any age (optimistic)"} />
              <Toggle on={p.rothLadder} onClick={() => set("rothLadder", !p.rothLadder)}
                label="Roth conversion ladder"
                sub={p.rothLadder ? "on — converted funds free after 5 years, so taxable cash account bridges only 5 years of expense (not to 59.5)" : "off — retirement accounts locked until 59.5"} />
            </SubSection>

            <SubSection title="Child College funding">
              <Toggle on={p.collegeSpread} onClick={() => set("collegeSpread", !p.collegeSpread)}
                label="Spread tuition over 4 years"
                sub={p.collegeSpread ? "on — quarter each at ages 18–21" : "off — single lump at 18"} />
              <Toggle on={p.use529} onClick={() => set("use529", !p.use529)}
                label="Pre-fund with a 529"
                sub={p.use529 ? "on — college paid from 529 account first" : "off — college paid from main portfolio"} />
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
            </SubSection>

            <SubSection title="Borrowing">
              <Toggle on={!!p.allowBorrowing} onClick={() => set("allowBorrowing", !p.allowBorrowing)}
                label="Allow the plan to borrow"
                sub={p.allowBorrowing
                  ? "on — spendable cash may go negative, and the shortfall compounds as debt"
                  : "off — a plan that only balances on an implicit loan gets no FIRE date"} />
              <div style={{ fontSize: 10, color: C.mute, lineHeight: 1.6 }}>
                With this off, a year where the bills exceed everything you can legally reach makes the
                whole plan unfundable, and the model says so instead of quietly financing it. Turning it
                on reports the date anyway — useful for seeing <em>how far</em> underwater you'd be, but
                the gap is a real loan you'd have to actually get.
              </div>
            </SubSection>

            <SubSection title="Assumptions">
              {[
                ["Annual portfolio return %", "nominalReturn", 3, 10],
                ["Cash return % (savings account)", "cashReturn", 0, 6],
                ["Home appreciation %", "homeGrowth", 0, 8],
                ["Inflation %", "inflation", 1, 6],
                ["Safe withdrawal rate %", "swr", 2.5, 5],
              ].map(([l, k, lo, hi]) => (
                <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
                    {l} · <span style={{ color: C.brass }}>{((p[k] || 0) * 100).toFixed(1)}</span>
                  </span>
                  <input type="range" min={lo} max={hi} step={0.1}
                    value={(p[k] || 0) * 100} onChange={(e) => setPct(k, Number(e.target.value))}
                    style={{ accentColor: C.brass }} />
                </label>
              ))}
              <div style={{ fontSize: 10, color: C.mute, lineHeight: 1.6 }}>
                Cash is spendable at any age — it counts toward the pre-59.5 bridge — but it compounds at
                its own rate and is drawn down first. Set it to 0 for a checking account.
              </div>
            </SubSection>
          </Collapsible>
        </div>

        {/* OUTPUT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {hasPlan && <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 18 }}>
            <Stat label={`FIRE number · lasts to ${sim.END}`} value={retireOnLoan || !sim.fireCrossValue ? "—" : fmtM(sim.fireCrossValue)} accent={neverRetire || retireOnLoan ? C.coral : C.brass} />
            <Stat label="FIRE age" value={retireOnLoan ? "—" : sim.fireCross ? sim.fireCross.toFixed(1) : "never"} accent={neverRetire || retireOnLoan ? C.coral : sim.fireCross <= 47 ? C.teal : C.ink}
              sub={retireOnLoan || !sim.fireCross ? null : `${(sim.fireCross - p.currentAge).toFixed(1)} years from now`} />
            {sim.coastTarget != null && (
              <Stat label={`Coast FIRE number today · retire at ${sim.coastTarget}`} value={fmtM(sim.coastToday)} accent={C.coast} />
            )}
            {sim.coastTarget != null && (
              <Stat label="Coast FIRE age" value={sim.coastCross ? sim.coastCross.toFixed(1) : "—"} accent={C.coast}
                sub={sim.coastCross ? `${(sim.coastCross - p.currentAge).toFixed(1)} years from now` : null} />
            )}
            <Stat label="Liquid (taxable) at that point" value={sim.fireTaxable != null ? fmtM(sim.fireTaxable) : "—"} accent={C.liquid} />
            <Stat
              label={sim.homes.length > 1 ? "Last mortgage clear at" : "Mortgage clear at"}
              value={sim.lastPayoff ? `age ${sim.lastPayoff}` : "—"}
            />
          </div>}

          {/* Every banner below reads the simulation, and the simulation happily answers a
              half-filled form — Need is zero when no spending has been entered, so an age-only
              form genuinely does clear the bar. Gating the whole block in one place is what keeps
              a new banner from being added without its guard, which is exactly how "you could stop
              working today" ended up greeting people who had typed nothing but their age. */}
          {hasPlan && (<>
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

          {p.allowBorrowing && sim.illiquidAge != null && sim.fireCross != null && (
            <div style={{ background: `${C.coral}14`, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
              <b style={{ color: C.coral }}>This date is bought with borrowing.</b> You allowed the plan to
              borrow, so the model reported a FIRE age — but it only balances by running your spendable
              cash negative from <b>age {sim.illiquidAge}</b>, and that shortfall compounds as debt for
              the rest of the projection. Switch <b>“Allow the plan to borrow”</b> back off in Advanced
              settings to see the date you can actually fund.
            </div>
          )}

          {retireOnLoan && (
            <div style={{ background: `${C.coral}1A`, border: `2px solid ${C.coral}`, borderRadius: 10, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontSize: 22, lineHeight: 1.1 }} aria-hidden>🚫</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.coral, marginBottom: 4, letterSpacing: ".01em" }}>
                  This retirement can't be funded without borrowing
                </div>
                <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
                  The only way the model balances the books here is by letting your <b>spendable cash go
                  negative from age {sim.illiquidAge}</b> — an implicit loan, or a 10% early-withdrawal penalty on money
                  locked until 59.5. That isn't a real, fundable plan, so <b>we don't show a FIRE number for it</b>.
                  {sim.fireCrossIfBorrowed != null && <> For reference, the crossing it found that way was{" "}
                  <b>age {sim.fireCrossIfBorrowed.toFixed(1)}</b> — turn on <b>“Allow the plan to borrow”</b> in
                  Advanced settings to explore it.</>}
                  {allocAdvice?.dir === "toTaxable" ? (
                    <> The fix below — moving saving from your 401k/IRA into a taxable account — is exactly what closes
                      the cash gap.</>
                  ) : (
                    <> Close the gap by moving saving from your 401k/IRA into a plain taxable account, trimming the lump
                      that lands underwater (home, college), or adding income.</>
                  )}{" "}
                  The underwater years are shaded on the chart below.
                </div>
              </div>
            </div>
          )}

          {/* the arithmetic behind an underwater cash account — shown whenever it happens, whether or not
              it also cost you a retirement date */}
          <CashLedger cause={sim.underwaterCause} accessAge={sim.accessYou} />

          {sim.coastShortfall && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coast}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
              <b style={{ color: C.coast }}>Coast FIRE isn't reachable on these inputs.</b> To coast from age{" "}
              {sim.coastShortfall.age} — stop saving and still retire on time — you'd need{" "}
              <b>{fmtM(sim.coastShortfall.need)}</b> by then, but you'd have <b>{fmtM(sim.coastShortfall.have)}</b>:
              short by <b style={{ color: C.coral }}>{fmtM(sim.coastShortfall.gap)}</b>. Push the coast age later, save
              more before it, or lower the retirement budget the coast bar is sized against.
            </div>
          )}

          {retireToday && !retireOnLoan && (
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
          {delay != null && delay > 0.05 && !retireOnLoan && (
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

          {sim.fireCross && sim.mortgageAtFire > 0 && !retireOnLoan && (
            <div style={{ background: C.panel2, border: `1px solid ${C.brass}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              You'd retire still owing <b>{fmt(sim.mortgageAtFire)}/yr</b> of principal and interest across{" "}
              {sim.homes.filter((h) => sim.fireCross < h.payoff && sim.fireCross >= h.purchaseAge).length} live
              mortgage{sim.homes.filter((h) => sim.fireCross < h.payoff && sim.fireCross >= h.purchaseAge).length === 1 ? "" : "s"},
              the last clearing at <b>{sim.lastPayoff}</b> — which is why the number (<b>{fmtM(sim.fireCrossValue)}</b>)
              sits above the naive {fmtM(sim.naiveNumber)}.
            </div>
          )}
          </>)}

          {!hasPlan && (
            <div style={{
              background: C.panel, border: `1px dashed ${C.line}`, borderRadius: 8,
              minHeight: 320, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 10, padding: 24, textAlign: "center",
            }}>
              <div style={{ fontSize: 15, color: C.ink, fontWeight: 500 }}>Nothing to plot yet</div>
              <div style={{ fontSize: 13, color: C.mute, maxWidth: 440, lineHeight: 1.6 }}>
                Three figures make the question answerable. Everything else — homes, kids, a partner,
                debts, pensions — is optional detail you can layer on afterwards.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, margin: "6px 0 2px", textAlign: "left" }}>
                {readiness.checks.map((c) => (
                  <div key={c.key} style={{ display: "flex", gap: 9, alignItems: "baseline", fontSize: 13 }}>
                    <span style={{ color: c.ok ? C.teal : C.mute, fontSize: 13, lineHeight: 1.3 }} aria-hidden>
                      {c.ok ? "◉" : "○"}
                    </span>
                    <span style={{ color: c.ok ? C.mute : C.ink, textDecoration: c.ok ? "line-through" : "none" }}>
                      {c.label}
                    </span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => { setP(DEFAULTS); setShow(defaultShow()); }}
                style={{
                  marginTop: 4, background: C.brass, color: C.bg, border: "none", borderRadius: 8,
                  cursor: "pointer", padding: "9px 16px", fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: 13, fontWeight: 500,
                }}>
                ▶ Load the demo household instead
              </button>
            </div>
          )}

          {hasPlan && <ChartPanel
            rows={sim.rows} xStart={p.currentAge} END={sim.END} ticks={ticks} underwaterSpans={underwaterSpans}
            accessYou={sim.accessYou} enforceAccess={p.enforceAccess} unlockAtFire={sim.unlockYouAtFire}
            partnerStopsAtAge={sim.partnerStopsAtAge} expenseMarks={sim.expenseMarks} coastTarget={sim.coastTarget}
            homeRows={homeRows} kidRows={kidRows}
            coastCross={sim.coastCross} coastCrossValue={sim.coastCrossValue}
            fireCross={retireOnLoan ? null : sim.fireCross} fireCrossValue={retireOnLoan ? null : sim.fireCrossValue}
            show={show} setShow={setShow}
          />}

          {/* TRACE THE NUMBERS — the year-by-year arithmetic behind the chart */}
          {hasPlan && <Collapsible
            title="Trace the numbers"
            subtitle="Year-by-year: what came in, what went out, and what each bucket did"
            open={traceOpen} onToggle={() => setTraceOpen((v) => !v)}
          >
            {lockedGrowth && (
              <div style={{ background: `${C.locked}14`, border: `1px solid ${C.locked}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
                <b style={{ color: C.locked }}>Why the portfolio keeps climbing after you retire.</b> From{" "}
                <b>{lockedGrowth.fromAge}</b> to <b>{lockedGrowth.toAge}</b> your retirement accounts are
                <b> locked</b> — you legally can't spend them — so they compound untouched, growing from{" "}
                <b>{fmtM(lockedGrowth.from)}</b> to <b>{fmtM(lockedGrowth.to)}</b> while only your taxable cash is
                drawn down. The total curve rises because that locked growth outruns what you're spending out of
                taxable. It isn't free money: it's money you can't reach yet, which is exactly what the coral
                bridge line is about.
              </div>
            )}
            <TraceTable trace={sim.trace} accessAge={sim.accessYou} fireCross={sim.fireCross} />
          </Collapsible>}

          {/* WHAT MOVES THE NEEDLE — each row is a full re-run of the model, not a rule of thumb */}
          {levers.length > 0 && (
            <Collapsible
              title="What moves the needle"
              subtitle="Years of retirement bought by each choice you control"
              open={leversOpen} onToggle={() => setLeversOpen((v) => !v)}
            >
              <p style={{ margin: 0, fontSize: 12, color: C.mute }}>
                Years of retirement bought by changing one thing, everything else held fixed. Only choices you
                control — market return and inflation live in <b>Advanced settings</b>.
                <span style={{ color: C.teal }}> Teal = retire earlier.</span>
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {levers.map((l) => {
                  const d = l.delta;
                  const earlier = d != null && d < 0;
                  const col = d == null ? C.mute : Math.abs(d) < 0.05 ? C.mute : earlier ? C.teal : C.coral;
                  return (
                    <div key={l.label} style={{ display: "grid", gridTemplateColumns: "1fr 90px 46px", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 12, color: C.ink }}>{l.label}</span>
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
            </Collapsible>
          )}
        </div>
      </div>
      <Footnote />
    </div>
  );
}
