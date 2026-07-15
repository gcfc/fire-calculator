import React, { useState, useMemo, useEffect } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceDot, ReferenceArea, ResponsiveContainer,
} from "recharts";

// ---- palette (ledger / instrument) ----
const C = {
  bg: "#0E1A1F", panel: "#14252B", panel2: "#1B303733", ink: "#EAE6DD",
  brass: "#C9A24B", teal: "#5FB0A6", coral: "#D9695A", mute: "#7A8A8E",
  line: "#26424B", liquid: "#9AD5CB", coast: "#B48EAD",
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
  const hasPartner = p.partnerAge > 0;
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

  // Nominal spending in year `age` once retired. retirementSpendToday now EXCLUDES housing —
  // with several homes coming and going there is no single "housing cost" to bake into it, so
  // housing is priced from the homes themselves every year instead of being assumed away.
  const retireExpense = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    return p.retirementSpendToday * infl   // non-housing budget
         + housingAt(age)                  // rent, or carry + P&I on every home owned that year
         + downAt(age)                     // closing cash on anything bought this year
         + (netCollege[age] || 0)          // college the 529 didn't cover
         + (contrib529[age] || 0);         // …and the 529 you are still feeding. Retiring does not
                                           // stop the sinking fund: if these were left out, any
                                           // contribution scheduled after retirement would be free
                                           // money, and a slow 529 would buy you an earlier date.
  };
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
    Need[age] = (Need[age + 1] + retireExpense(age) * fv(1)) / G;
  }
  // …and the same requirement evaluated at ANY instant, not just birthdays
  const needAt = (t) => {
    if (t >= END + 1) return 0;
    const A = Math.floor(t), rest = A + 1 - t;
    return (Need[A + 1] + retireExpense(A) * fv(rest)) / grow(rest);
  };

  // --- the liquidity (age-59.5) machinery ----------------------------------
  // Need[] answers "is there enough money?". It does NOT answer "can you legally touch it?".
  // A 401k/IRA/HSA dollar cannot pay a bill before 59.5 without a 10% penalty, so a retirement
  // before then must be bridged out of the TAXABLE bucket alone.

  // present value, at instant `t`, of every dollar you must spend between `t` and `u`
  const pvSpend = (t, u) => {
    let acc = 0, disc = 1, s = t;
    const stop = Math.min(u, END + 1);
    while (s < stop) {
      const yr = Math.floor(s), s1 = Math.min(stop, yr + 1), dt = s1 - s;
      acc += disc * retireExpense(yr) * pvFlow(dt);
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
    const buckets = [
      { u: unlockAt(accessYou, T), bal: balYou },
      { u: unlockAt(accessPartner, T), bal: balPartner },
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
    // every lump (down payments, college, 529) can only come out of taxable
    const lumps = downAt(age) + (netCollege[age] || 0) + (contrib529[age] || 0);
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

  // spend from t0 to t1, splitting at any unlock instant that falls inside
  const spendSpan = (st, t0, t1, T) => {
    const cuts = [t0, t1];
    [unlockAt(accessYou, T), unlockAt(accessPartner, T)].forEach((u) => {
      if (u > t0 && u < t1) cuts.push(u);
    });
    cuts.sort((a, b) => a - b);
    let s = st, short = false;
    for (let i = 0; i < cuts.length - 1; i++) {
      const r = spend(s, cuts[i], cuts[i + 1], T);
      s = r.st; short = short || r.short;
    }
    return { st: s, short };
  };

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

    rows.push({
      age,
      portfolio: Math.round(startReal),
      taxable: Math.round(st.taxable / infl),
      required: Math.round(needAt(age) / infl),
      bridge: Math.round(bridgeAt(age, st.taxAdvYou, st.taxAdvPartner) / infl),
      coast: coastReal == null ? null : Math.round(coastReal),
      save: Math.round(realSave),
      drawdown: working && realSave < 0 ? Math.round(realSave) : 0,
      events,
    });

    if (working) {
      // Does the crossing fall inside this year? Solve for the exact instant rather than
      // rounding up to the next birthday.
      if (gapAt(age, st) >= 0) {
        T = age;
      } else if (gapAt(age + 1, work(st, age, 1)) >= 0) {
        let lo = 0, hi = 1;                                  // bisection: gap is increasing in dt
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (gapAt(age + mid, work(st, age, mid)) >= 0) hi = mid; else lo = mid;
        }
        T = age + hi;
      }

      if (T !== null) {
        const inflT = Math.pow(1 + p.inflation, T - p.currentAge);
        const sT = T === age ? st : work(st, age, T - age);   // balances at the retirement instant
        fireCrossValue = (sT.taxable + sT.taxAdvYou + sT.taxAdvPartner) / inflT;
        fireReq = needAt(T) / inflT;
        fireTaxable = sT.taxable / inflT;
        fireBridge = bridgeAt(T, sT.taxAdvYou, sT.taxAdvPartner) / inflT;
        if (T > age) {
          rows.push({
            age: T, portfolio: Math.round(fireCrossValue), required: Math.round(fireReq),
            taxable: Math.round(fireTaxable), bridge: Math.round(fireBridge),
            coast: T <= coastTarget ? Math.round(coastAt(T) / inflT) : null,
            save: 0, drawdown: 0, events: [],
          });
        }
        const r = spendSpan(sT, T, age + 1, T);               // retired for the rest of the year
        st = r.st;
        if (r.short && illiquidAge === null) illiquidAge = Math.floor(T);
      } else {
        st = work(st, age, 1);
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
        if (draft === "") onCommit(min);                // left empty: settle on the floor
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
const Num = ({ label, value, onChange, step = 1, pct = false }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
    <span style={{ fontSize: 10, letterSpacing: ".03em", color: C.mute, textTransform: "uppercase" }}>{label}</span>
    <NumberInput
      small
      step={step}
      value={pct ? Number((value * 100).toFixed(4)) : value}
      onCommit={(v) => onChange(pct ? v / 100 : v)}
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

const field = (label, key, val, set, opts = {}) => (
  <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
      {label}
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
  partnerAge: 26, partnerIncome: 120000, partnerTaxAdv: 23000,
  partnerPortfolio: 150000, partnerPortfolioTaxAdv: 100000,
  partnerStart: 26, partnerEnd: 60,
  // EXCLUDES housing — every home now prices its own carry, mortgage and closing costs, so
  // baking a paid-off house into this number would double-count it. (Was 110k incl. ~36k carry.)
  retirementSpendToday: 100000, swr: 0.035, endAge: 100, coastAge: 48,
  collegeSpread: true, use529: false, annual529: 0,
  enforceAccess: true, rothLadder: true, ladderYears: 5, accessAge: 59.5,
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
  { key: "bridge", label: "needed in taxable (the bridge)", color: C.coral, dash: true },
  { key: "drawdown", label: "drawdown years", color: C.coral, mark: "▮" },
  { key: "underwater", label: "taxable underwater (< $0)", color: C.coral, mark: "▨", on: true },
  { key: "access", label: "the 59.5 line", color: C.mute, dash: true, on: true },
  { key: "home", label: "home purchase", color: C.brass, mark: "●", on: true },
  { key: "kids", label: "child born", color: C.ink, mark: "●", on: true },
];

export default function FireModel() {
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [p, setP] = useState(DEFAULTS);
  const [show, setShow] = useState(
    Object.fromEntries(SERIES.map((s) => [s.key, !!s.on]))
  );
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
      ...(p.partnerAge > 0
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
        <div style={{ fontSize: 11, letterSpacing: ".2em", color: C.brass, textTransform: "uppercase", marginBottom: 6 }}>
          Financial independence · trajectory model
        </div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, lineHeight: 1.15 }}>
          The number that actually lasts — and that you can actually touch
        </h1>
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
              ["Current age", "currentAge", {}],
              ["Current portfolio ← your real #", "startPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "startPortfolioTaxAdv", { step: 10000, max: p.startPortfolio }],
              ["Take-home / yr (after contrib.)", "annualTakeHome", { step: 1000 }],
              ["Tax-advantaged / yr (401k+HSA+IRA)", "annualTaxAdv", { step: 500 }],
              ["Non-housing living / yr", "nonHousingLiving", { step: 1000 }],
              ["Current rent / yr", "rentAnnual", { step: 1000 }],
            ]],
            ["Partner", [
              ["Partner's age now (0 = single)", "partnerAge", {}],
              ["Partner portfolio", "partnerPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "partnerPortfolioTaxAdv", { step: 10000, max: p.partnerPortfolio }],
              ["Partner take-home / yr", "partnerIncome", { step: 5000 }],
              ["Partner tax-advantaged / yr", "partnerTaxAdv", { step: 500 }],
              ["Partner earns from their age", "partnerStart", { min: p.partnerAge }],
              ["…until their age", "partnerEnd", { min: p.partnerStart }],
            ]],
            ["Retirement", [
              ["Retirement spend / yr — excl. housing", "retirementSpendToday", { step: 5000 }],
              ["Money must last to age", "endAge", {}],
              ["Coast FIRE: retire at age", "coastAge", {}],
            ]],
          ].map(([group, fields]) => (
            <div key={group} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>{group}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fields.map(([l, k, o]) => field(l, k, p[k], set, o))}
              </div>

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
              {group === "Partner" && p.partnerAge > 0 && p.partnerPortfolioTaxAdv > p.partnerPortfolio && (
                <Warn>
                  Your partner's 401k/IRA (<b>{fmt(p.partnerPortfolioTaxAdv)}</b>) is more than their whole
                  portfolio (<b>{fmt(p.partnerPortfolio)}</b>). The model caps it at the portfolio — all locked,
                  none taxable.
                </Warn>
              )}
              {group === "Partner" && p.partnerAge > 0 && p.partnerStart < p.partnerAge && (
                <Warn>
                  Your partner can't start earning at <b>{p.partnerStart}</b> — they're already{" "}
                  <b>{p.partnerAge}</b>. The model starts their income now, at <b>{p.partnerAge}</b>.
                </Warn>
              )}
              {group === "Partner" && p.partnerAge > 0 && p.partnerEnd < p.partnerStart && (
                <Warn>
                  Their earning window ends (<b>{p.partnerEnd}</b>) before it starts (<b>{p.partnerStart}</b>).
                  Left alone that would pay them <b>nothing at all</b>; the model instead holds the end at{" "}
                  <b>{Math.max(p.partnerStart, p.partnerAge)}</b>. Raise the end age.
                </Warn>
              )}

              {group.startsWith("Partner") && p.partnerAge > 0 && (
                <div style={{ fontSize: 10, color: C.mute, marginTop: 8, lineHeight: 1.6 }}>
                  <b style={{ color: C.ink }}>Every field above is in your partner's own age.</b>{" "}
                  {sim.partnerOffset === 0
                    ? "They're the same age as you, so the two clocks agree."
                    : `They're ${Math.abs(sim.partnerOffset)}y ${sim.partnerOffset > 0 ? "younger" : "older"} than you, so their clock runs ${Math.abs(sim.partnerOffset)}y ${sim.partnerOffset > 0 ? "behind" : "ahead"} of yours.`}
                  <br />
                  Their 401k opens at their {p.accessAge} — when you are{" "}
                  <span style={{ color: C.brass }}>{sim.accessPartner.toFixed(1)}</span>.
                  {sim.partnerAgeAtFire != null && (
                    <> You retire together when they are{" "}
                      <span style={{ color: C.brass }}>{sim.partnerAgeAtFire.toFixed(1)}</span>.</>
                  )}
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
                    <Num label="Buy at your age" value={h.purchaseAge} onChange={(v) => setHome(i, "purchaseAge", v)} />
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
                  <Num label={`Kid ${i + 1} — your age at birth`} value={k.birthAge} onChange={(v) => setKid(i, v)} />
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

          {/* only worth a banner when the rule actually costs something; otherwise it's wallpaper */}
          {delay != null && delay > 0.05 && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              <b>The 59.5 rule costs you {delay.toFixed(1)} years.</b> Ignoring it, you'd have enough in total at{" "}
              <b>{simFree.fireCross.toFixed(1)}</b> — but only {fmtM(sim.fireTaxable)} of the pot would be taxable
              against a bridge of {fmtM(sim.fireBridge)}, so you keep working until <b>{sim.fireCross.toFixed(1)}</b>.
              {!p.rothLadder && " A Roth conversion ladder shortens the bridge to 5 years — try the toggle."}
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

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 14px 8px" }}>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={sim.rows} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
                {/* shade every stretch where spendable cash is negative — drawn first so it sits behind the curves */}
                {show.underwater ? underwaterSpans.map(([a, b], i) => (
                  <ReferenceArea key={`uw${i}`} x1={a} x2={b} fill={C.coral} fillOpacity={0.14} stroke="none"
                    label={i === 0 ? { value: "taxable < $0", fill: C.coral, fontSize: 10, position: "insideTopLeft" } : undefined} />
                )) : null}
                {show.underwater && underwaterSpans.length ? (
                  <ReferenceLine y={0} stroke={`${C.coral}99`} strokeDasharray="2 3" />
                ) : null}
                <XAxis dataKey="age" type="number" domain={[p.currentAge, sim.END]} ticks={ticks}
                  stroke={C.mute} tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                <YAxis stroke={C.mute} tickFormatter={(v) => "$" + (v / 1e6).toFixed(1) + "M"}
                  tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                  labelStyle={{ color: C.brass }}
                  formatter={(v, name) => [fmt(v), {
                    portfolio: "Portfolio (total)", taxable: "Taxable (spendable now)",
                    required: "Needed in total", bridge: "Needed in taxable",
                    coast: `Coast bar (stop saving, retire at ${sim.coastTarget})`,
                  }[name] || name]}
                  labelFormatter={(a) => "Age " + a}
                />
                {show.drawdown ? <Bar dataKey="drawdown" fill={C.coral} opacity={0.8} barSize={10} /> : null}
                {show.access && p.enforceAccess ? (
                  <ReferenceLine x={sim.accessYou} stroke={C.mute} strokeDasharray="2 4"
                    label={{ value: "59.5", fill: C.mute, fontSize: 10, position: "top" }} />
                ) : null}
                {show.coast ? <Line type="monotone" dataKey="coast" stroke={C.coast} strokeWidth={1.5} strokeDasharray="6 3" dot={false} connectNulls={false} /> : null}
                {show.required ? <Line type="monotone" dataKey="required" stroke={C.brass} strokeWidth={1.5} strokeDasharray="5 4" dot={false} /> : null}
                {show.bridge ? <Line type="monotone" dataKey="bridge" stroke={C.coral} strokeWidth={1.5} strokeDasharray="3 3" dot={false} /> : null}
                {show.taxable ? <Line type="monotone" dataKey="taxable" stroke={C.liquid} strokeWidth={1.5} dot={false} /> : null}
                {show.portfolio ? <Line type="monotone" dataKey="portfolio" stroke={C.teal} strokeWidth={2.5} dot={false} /> : null}
                {show.home ? homeRows.map((h) => <ReferenceDot key={h.age} x={h.age} y={h.portfolio} r={5} fill={C.brass} stroke={C.bg} />) : null}
                {show.kids ? kidRows.map((k) => <ReferenceDot key={k.age} x={k.age} y={k.portfolio} r={4} fill={C.ink} stroke={C.bg} />) : null}
                {show.coast && sim.coastCross ? <ReferenceDot x={sim.coastCross} y={sim.coastCrossValue} r={5} fill={C.coast} stroke={C.bg} strokeWidth={2} /> : null}
                {show.retire && sim.fireCross ? <ReferenceDot x={sim.fireCross} y={sim.fireCrossValue} r={7} fill={C.brass} stroke={C.ink} strokeWidth={2} /> : null}
              </ComposedChart>
            </ResponsiveContainer>
            {/* the legend IS the control: click a series to show or hide it */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "6px 6px 12px" }}>
              {SERIES.map((s) => {
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
