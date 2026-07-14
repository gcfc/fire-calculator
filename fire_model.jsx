import React, { useState, useMemo } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceDot, ResponsiveContainer,
} from "recharts";

// ---- palette (ledger / instrument) ----
const C = {
  bg: "#0E1A1F", panel: "#14252B", panel2: "#1B303733", ink: "#EAE6DD",
  brass: "#C9A24B", teal: "#5FB0A6", coral: "#D9695A", mute: "#7A8A8E",
  line: "#26424B", liquid: "#9AD5CB", coast: "#B48EAD",
};

const fmt = (n) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtM = (n) =>
  n == null ? "—" : "$" + (n / 1e6).toFixed(2) + "M";

// exported so the model can be exercised headlessly, without mounting the UI
export function simulate(p) {
  const loan = p.homePrice * (1 - p.downPct);
  const r = p.mortgageRate / 12, n = p.mortgageTerm * 12;
  const mPI = p.buyHome
    ? (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) * 12
    : 0;
  const payoffAge = p.purchaseAge + p.mortgageTerm;
  const naiveNumber = p.retirementSpendToday / p.swr;
  const ret = p.nominalReturn;

  // --- household ages -------------------------------------------------------
  // Everything below is indexed by YOUR age. The partner enters through two offsets:
  // when their retirement accounts unlock, and how long the money has to last.
  const hasPartner = p.partnerAge > 0;
  const partnerOffset = hasPartner ? p.currentAge - p.partnerAge : 0;  // >0 when partner is younger
  // the money must survive the LAST survivor: if the partner is younger by d, they reach the
  // target age when you are endAge + d, so the horizon stretches by d.
  const END = p.endAge + Math.max(0, partnerOffset);
  // tax-advantaged money unlocks at each person's own 59.5, expressed in your age
  const accessYou = p.accessAge;
  const accessPartner = p.accessAge + partnerOffset;

  // --- college schedule (single lump at 18, or spread over ages 18–21) with optional 529 pre-funding ---
  const kidsCount = [p.kid1BirthAge, p.kid2BirthAge].filter((b) => b > 0).length;
  const cap529 = kidsCount * 19000;                       // gift-tax-free annual max, single donor, today's $
  const lastCollegeAge = Math.max(p.kid1BirthAge, p.kid2BirthAge) + (p.collegeSpread ? 21 : 18);
  const collegeGrossToday = (age) => {
    let c = 0;
    [p.kid1BirthAge, p.kid2BirthAge].forEach((b) => {
      if (b <= 0) return;
      const ka = age - b;
      if (p.collegeSpread) { if (ka >= 18 && ka <= 21) c += p.collegePerKid / 4; }
      else if (ka === 18) c += p.collegePerKid;
    });
    return c;
  };
  // present value (nominal, discounted to each age) of remaining gross college — the funding target
  const pvCollege = {}; pvCollege[END + 1] = 0;
  for (let age = END; age >= p.currentAge; age--) {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    pvCollege[age] = collegeGrossToday(age) * infl + pvCollege[age + 1] / (1 + ret);
  }
  // pre-pass: 529 balance is independent of the main portfolio, so compute net-of-529 college up front.
  // Contribute up to the annual amount, but only until the fund covers remaining college (no overfunding).
  const netCollege = {}, contrib529 = {};
  {
    let bal = 0;
    const annual = p.use529 ? Math.min(p.annual529, cap529) : 0;
    for (let age = p.currentAge; age <= END; age++) {
      const infl = Math.pow(1 + p.inflation, age - p.currentAge);
      const c = (annual > 0 && age <= lastCollegeAge)
        ? Math.min(annual * infl, Math.max(0, pvCollege[age] - bal))   // fund toward target, cap at annual
        : 0;
      contrib529[age] = c;
      bal = bal * (1 + ret) + c;
      const gross = collegeGrossToday(age) * infl;
      const pay = annual > 0 ? Math.min(bal, gross) : 0;
      bal -= pay;
      netCollege[age] = gross - pay;                      // remainder the main portfolio must cover
    }
  }

  // ownership carrying costs (property tax + insurance/maintenance) at a given age, nominal
  const ownCarry = (age) => {
    const yrs = age - p.purchaseAge;
    return p.homePrice * p.propTaxRate * Math.pow(1.02, yrs) +
           p.homePrice * p.insMaintRate * Math.pow(1 + p.inflation, yrs);
  };
  const downPayment = (p.downPct + p.closingPct) * p.homePrice;   // nominal, paid at purchaseAge

  // nominal retirement expense at `age`. retirementSpendToday assumes a PAID-OFF home, so it already
  // contains ownership carry. Adjust when that isn't yet true:
  //   - still renting (before purchase): swap the baked-in carry for actual rent
  //   - purchase year: add the down payment + closing lump
  //   - mortgage still running: add P&I on top
  const retireExpense = (age) => {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    let e = p.retirementSpendToday * infl;
    if (p.buyHome && age < p.purchaseAge) {
      e += p.rentAnnual * infl - ownCarry(age);      // renting: pay rent, not ownership carry
    }
    if (p.buyHome && age === p.purchaseAge) e += downPayment;          // the lump that was being skipped
    if (p.buyHome && age >= p.purchaseAge && age < payoffAge) e += mPI; // mortgage P&I during overlap
    e += netCollege[age] || 0;
    return e;
  };
  // backward induction: Need[age] = min nominal portfolio at start of `age` to fund age..END ending >= 0.
  // Expenses are paid at year end, so a balance grows for a year before it is drawn on.
  const Need = {}; Need[END + 1] = 0;
  for (let age = END; age >= p.currentAge; age--) {
    Need[age] = (retireExpense(age) + Need[age + 1]) / (1 + ret);
  }

  // --- the liquidity (age-59.5) machinery ----------------------------------
  // Need[] answers "is there enough money?". It does NOT answer "can you legally touch it?".
  // A 401k/IRA/HSA dollar cannot pay a bill before 59.5 without a 10% penalty, so a retirement
  // before then must be bridged out of the TAXABLE bucket alone.
  //
  // cum[k] discounts every expense back to `currentAge`, which lets us price any window in O(1).
  const cum = {}; cum[p.currentAge - 1] = 0;
  for (let age = p.currentAge; age <= END; age++) {
    cum[age] = cum[age - 1] + retireExpense(age) / Math.pow(1 + ret, age - p.currentAge + 1);
  }
  // nominal cost, valued at the start of age `a`, of funding expenses for years a..k
  const pvExp = (a, k) =>
    k < a ? 0 : (cum[Math.min(k, END)] - cum[a - 1]) * Math.pow(1 + ret, a - p.currentAge);

  // first age at which a bucket may legally pay a bill. A Roth conversion ladder seasons each
  // conversion for 5 years, so retiring at `a` opens the pipe at a+5 — but never later than 59.5,
  // since you'd simply wait for the statutory age instead.
  const unlockAge = (access, a) => {
    if (!p.enforceAccess) return p.currentAge;                       // gate switched off
    const eff = p.rothLadder ? Math.min(access, a + p.ladderYears) : access;
    return Math.ceil(eff);
  };

  // Minimum TAXABLE balance at the start of age `a` to stay liquid through the locked years,
  // given the tax-advantaged balances you'd be sitting on. Each bucket adds a checkpoint: taxable
  // (plus anything already unlocked) must cover every expense up to the year before that bucket opens.
  const bridgeNeed = (a, balYou, balPartner) => {
    if (!p.enforceAccess) return 0;
    const buckets = [
      { u: unlockAge(accessYou, a), bal: balYou },
      { u: unlockAge(accessPartner, a), bal: balPartner },
    ].filter((b) => b.bal > 0).sort((x, y) => x.u - y.u);
    let need = 0, unlocked = 0;
    for (const b of buckets) {
      need = Math.max(need, pvExp(a, b.u - 1) - unlocked);
      unlocked += b.bal;
    }
    return Math.max(0, need);
  };

  // --- coast FIRE ----------------------------------------------------------
  // "Coast" = stop SAVING but keep working, letting the pot compound untouched until you retire
  // at coastAge. So the coast bar at age `a` is simply the retirement requirement at the coast
  // target, discounted back to `a` with no further contributions. It meets the Need curve exactly
  // at coastAge, which is what makes the two lines readable together.
  // NB: this assumes your income still covers everything on the way — including the college lumps.
  const coastTarget = Math.min(Math.max(p.coastAge, p.currentAge + 1), END);
  const coastNeed = (age) => Need[coastTarget] / Math.pow(1 + ret, coastTarget - age);
  let coastCross = null, coastCrossValue = null, prevCoastGap = null;

  // --- three buckets, because "whose account is it" now changes the answer ---
  let taxable = Math.max(0, p.startPortfolio - p.startPortfolioTaxAdv)
              + Math.max(0, p.partnerPortfolio - p.partnerPortfolioTaxAdv);
  let taxAdvYou = p.startPortfolioTaxAdv;
  let taxAdvPartner = p.partnerPortfolioTaxAdv;

  let fireAge = null, minSave = Infinity, minSaveAge = null, fireReq = null;
  let fireCross = null, fireCrossValue = null, prevGap = null, prev = null;
  let fireTaxable = null, fireLocked = null, fireBridge = null, illiquidAge = null;
  const rows = [];

  for (let age = p.currentAge; age <= END; age++) {
    const infl = Math.pow(1 + p.inflation, age - p.currentAge);
    const startReal = (taxable + taxAdvYou + taxAdvPartner) / infl;   // start-of-year, today's $
    const taxableReal = taxable / infl;
    const reqReal = Need[age] / infl;
    const bridgeReal = bridgeNeed(age, taxAdvYou, taxAdvPartner) / infl;
    // the coast bar only exists up to the coast target; past it, coasting isn't a thing
    const coastReal = age <= coastTarget ? coastNeed(age) / infl : null;

    // hitting the coast bar means you could stop saving today and still retire on time
    const coastGap = coastReal == null ? null : startReal - coastReal;
    if (coastCross === null && coastGap != null && coastGap >= 0) {
      if (prev && prevCoastGap != null && prevCoastGap < 0) {
        const f = prevCoastGap / (prevCoastGap - coastGap);
        coastCross = (age - 1) + f;
        coastCrossValue = prev.startReal + (startReal - prev.startReal) * f;
      } else {
        coastCross = age;
        coastCrossValue = startReal;
      }
    }
    prevCoastGap = coastGap;

    // You may retire only when BOTH hold: enough money in total, and enough of it reachable
    // before 59.5. The binding one is whichever gap is smaller.
    const gap = Math.min(startReal - reqReal, taxableReal - bridgeReal);

    if (fireAge === null && age > p.currentAge && gap >= 0) {
      // continuous crossing: interpolate the fractional age where the binding gap hits zero
      const f = prevGap !== null && prevGap < 0 ? prevGap / (prevGap - gap) : 0;
      const lerp = (a0, a1) => a0 + (a1 - a0) * f;
      fireCross = prevGap !== null && prevGap < 0 ? (age - 1) + f : age;
      fireCrossValue = prevGap !== null && prevGap < 0 ? lerp(prev.startReal, startReal) : startReal;
      fireAge = Math.ceil(fireCross);                  // integer boundary used to switch the sim to drawdown
      fireReq = prevGap !== null && prevGap < 0 ? lerp(prev.reqReal, reqReal) : reqReal;
      fireTaxable = prevGap !== null && prevGap < 0 ? lerp(prev.taxableReal, taxableReal) : taxableReal;
      fireBridge = prevGap !== null && prevGap < 0 ? lerp(prev.bridgeReal, bridgeReal) : bridgeReal;
      fireLocked = fireCrossValue - fireTaxable;
      const inflAt = Math.pow(1 + p.inflation, fireCross - p.currentAge);
      rows.push({
        age: fireCross, portfolio: Math.round(fireCrossValue), required: Math.round(fireReq),
        taxable: Math.round(fireTaxable), bridge: Math.round(fireBridge),
        coast: fireCross <= coastTarget ? Math.round(coastNeed(fireCross) / inflAt) : null,
        save: 0, drawdown: 0, events: [],
      });
    }
    prevGap = gap;
    prev = { startReal, taxableReal, reqReal, bridgeReal };

    const working = fireAge === null;
    const mort = (p.buyHome && age >= p.purchaseAge && age < payoffAge) ? mPI : 0;
    let realSave = 0;

    if (working) {
      const partnerWorking = hasPartner && age >= p.partnerStart && age <= p.partnerEnd;
      const takeHome = p.annualTakeHome * infl + (partnerWorking ? p.partnerIncome * infl : 0);
      const taxAdvFlowYou = p.annualTaxAdv * infl;
      const taxAdvFlowPartner = partnerWorking ? p.partnerTaxAdv * infl : 0;

      const living = p.nonHousingLiving * infl;
      const housing = (p.buyHome && age >= p.purchaseAge)
        ? mort + ownCarry(age)
        : p.rentAnnual * infl;
      let kids = 0;
      [p.kid1BirthAge, p.kid2BirthAge].forEach((b) => {
        if (b <= 0) return;
        const ka = age - b;
        if (ka >= 0 && ka <= 5) kids += p.daycarePerKid * infl;
        else if (ka >= 6 && ka <= 17) kids += p.ongoingPerKid * infl;
      });
      const expenses = living + housing + kids;

      // payroll splits at the source: tax-advantaged contributions land in the locked buckets,
      // and every lump (house, college, 529) can only come out of taxable.
      taxable = taxable * (1 + ret) + (takeHome - expenses);
      if (age === p.purchaseAge && p.buyHome) taxable -= downPayment;
      taxable -= (netCollege[age] || 0) + (contrib529[age] || 0);
      taxAdvYou = taxAdvYou * (1 + ret) + taxAdvFlowYou;
      taxAdvPartner = taxAdvPartner * (1 + ret) + taxAdvFlowPartner;

      realSave = (takeHome - expenses + taxAdvFlowYou + taxAdvFlowPartner) / infl;
      if (realSave < minSave) { minSave = realSave; minSaveAge = age; }
    } else {
      // retired: grow, then pay the year's bill from whatever is legally reachable —
      // taxable first, then each tax-advantaged bucket once its owner is past 59.5.
      taxable *= (1 + ret); taxAdvYou *= (1 + ret); taxAdvPartner *= (1 + ret);
      let owed = retireExpense(age);
      const draw = (bal) => { const x = Math.min(bal, owed); owed -= x; return bal - x; };
      taxable = draw(taxable);
      if (age >= unlockAge(accessYou, fireAge)) taxAdvYou = draw(taxAdvYou);
      if (age >= unlockAge(accessPartner, fireAge)) taxAdvPartner = draw(taxAdvPartner);
      if (owed > 1) { taxable -= owed; if (illiquidAge === null) illiquidAge = age; }
    }

    if (working && taxable < 0 && illiquidAge === null) illiquidAge = age;

    const events = [];
    if (age === p.purchaseAge && p.buyHome) events.push("home");
    if (age === p.kid1BirthAge || age === p.kid2BirthAge) events.push("kid");
    if (collegeGrossToday(age) > 0) events.push("college");

    rows.push({
      age,
      portfolio: Math.round(working ? startReal : (taxable + taxAdvYou + taxAdvPartner) / infl),
      taxable: Math.round(working ? taxableReal : taxable / infl),
      required: Math.round(reqReal),
      bridge: Math.round(bridgeReal),
      coast: coastReal == null ? null : Math.round(coastReal),
      save: Math.round(realSave),
      drawdown: working && realSave < 0 ? Math.round(realSave) : 0,
      events,
    });
  }

  const end = rows[rows.length - 1].portfolio;
  const lockedShare = fireCrossValue > 0 ? fireLocked / fireCrossValue : 0;
  return {
    naiveNumber, fireAge, fireCross, fireCrossValue, fireReq, payoffAge, mPI,
    minSave: Math.round(minSave), minSaveAge, end, rows, END,
    accessYou, accessPartner, partnerOffset, hasPartner,
    fireTaxable, fireLocked, fireBridge, lockedShare, illiquidAge,
    coastTarget, coastCross, coastCrossValue, coastToday: coastNeed(p.currentAge),
  };
}

const field = (label, key, val, set, opts = {}) => (
  <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 11, letterSpacing: ".04em", color: C.mute, textTransform: "uppercase" }}>
      {label}
    </span>
    <input
      type="number"
      value={val}
      step={opts.step || 1}
      min={0}
      onChange={(e) => set(key, e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))}
      style={{
        background: C.bg, border: `1px solid ${C.line}`, color: C.ink,
        padding: "8px 10px", borderRadius: 6, fontFamily: "'JetBrains Mono', monospace",
        fontSize: 14, width: "100%", boxSizing: "border-box",
      }}
    />
  </label>
);

export const DEFAULTS = {
  currentAge: 27, startPortfolio: 400000, startPortfolioTaxAdv: 0,
  annualTakeHome: 144000, annualTaxAdv: 40000,
  nonHousingLiving: 36000, rentAnnual: 36000, inflation: 0.03, nominalReturn: 0.07,
  buyHome: true, homePrice: 1500000, downPct: 0.20, mortgageRate: 0.065, mortgageTerm: 30,
  purchaseAge: 31, propTaxRate: 0.011, insMaintRate: 0.013, closingPct: 0.02,
  kid1BirthAge: 30, kid2BirthAge: 32, daycarePerKid: 26000, ongoingPerKid: 8000, collegePerKid: 200000,
  partnerAge: 26, partnerIncome: 120000, partnerTaxAdv: 23000,
  partnerPortfolio: 150000, partnerPortfolioTaxAdv: 100000,
  partnerStart: 31, partnerEnd: 70,
  retirementSpendToday: 110000, swr: 0.035, endAge: 100, coastAge: 48,
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
  { key: "access", label: "the 59.5 line", color: C.mute, dash: true, on: true },
  { key: "home", label: "home purchase", color: C.brass, mark: "●", on: true },
  { key: "kids", label: "child born", color: C.ink, mark: "●", on: true },
];

export default function FireModel() {
  const [p, setP] = useState(DEFAULTS);
  const [show, setShow] = useState(
    Object.fromEntries(SERIES.map((s) => [s.key, !!s.on]))
  );
  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));
  const setPct = (k, v) => setP((s) => ({ ...s, [k]: v / 100 }));

  const sim = useMemo(() => simulate(p), [p]);
  // the same world with the 59.5 gate switched off — the difference IS the cost of the rule
  const simFree = useMemo(() => simulate({ ...p, enforceAccess: false }), [p]);
  const delay = sim.fireCross && simFree.fireCross ? sim.fireCross - simFree.fireCross : null;

  const homeRow = sim.rows.find((r) => r.events.includes("home"));
  const kidRows = sim.rows.filter((r) => r.events.includes("kid"));
  const kidsCount = [p.kid1BirthAge, p.kid2BirthAge].filter((b) => b > 0).length;
  const cap529 = kidsCount * 19000;
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
    <div style={{ background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: 24, borderRadius: 12 }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 24, alignItems: "start" }}>
        {/* INPUTS */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {[
            ["You", [
              ["Current age", "currentAge", {}],
              ["Current portfolio ← your real #", "startPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "startPortfolioTaxAdv", { step: 10000 }],
              ["Take-home / yr (after contrib.)", "annualTakeHome", { step: 1000 }],
              ["Tax-advantaged / yr (401k+HSA+IRA)", "annualTaxAdv", { step: 500 }],
              ["Non-housing living / yr", "nonHousingLiving", { step: 1000 }],
              ["Current rent / yr", "rentAnnual", { step: 1000 }],
            ]],
            ["Home", [
              ["Home price", "homePrice", { step: 25000 }],
              ["Purchase age", "purchaseAge", {}],
            ]],
            ["Kids", [
              ["Kid 1 — your age at birth", "kid1BirthAge", {}],
              ["Kid 2 — your age at birth", "kid2BirthAge", {}],
              ["Daycare / kid / yr (ages 0–5)", "daycarePerKid", { step: 1000 }],
              ["College / kid (today's $)", "collegePerKid", { step: 10000 }],
            ]],
            ["Partner (the dominant lever)", [
              ["Partner's age now (0 = single)", "partnerAge", {}],
              ["Partner take-home / yr", "partnerIncome", { step: 5000 }],
              ["Partner tax-advantaged / yr", "partnerTaxAdv", { step: 500 }],
              ["Partner portfolio", "partnerPortfolio", { step: 10000 }],
              ["…of which in 401k / IRA / HSA", "partnerPortfolioTaxAdv", { step: 10000 }],
            ]],
            ["Retirement", [
              ["Retirement spend / yr (today's $)", "retirementSpendToday", { step: 5000 }],
              ["Money must last to age", "endAge", {}],
              ["Coast FIRE: retire at age", "coastAge", {}],
            ]],
          ].map(([group, fields]) => (
            <div key={group} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>{group}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fields.map(([l, k, o]) => field(l, k, p[k], set, o))}
              </div>
              {group.startsWith("Partner") && p.partnerAge > 0 && (
                <div style={{ fontSize: 10, color: C.mute, marginTop: 8, lineHeight: 1.5 }}>
                  {sim.partnerOffset > 0
                    ? `${sim.partnerOffset}y younger — their 401k opens when you're ${sim.accessPartner.toFixed(1)}, and the money must last to your ${sim.END}.`
                    : sim.partnerOffset < 0
                      ? `${-sim.partnerOffset}y older — their 401k opens when you're only ${sim.accessPartner.toFixed(1)}, which shortens your bridge.`
                      : "same age — both accounts open at 59.5."}
                </div>
              )}
            </div>
          ))}

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
                <input
                  type="number" value={p.annual529} step={1000} min={0} max={cap529}
                  onChange={(e) => set("annual529", Math.max(0, Math.min(cap529, Number(e.target.value) || 0)))}
                  style={{ background: C.bg, border: `1px solid ${C.line}`, color: C.ink, padding: "8px 10px",
                    borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 14, width: "100%", boxSizing: "border-box" }}
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
            <Stat label={`FIRE number · lasts to ${sim.END}`} value={sim.fireCrossValue ? fmtM(sim.fireCrossValue) : "—"} accent={C.brass} />
            <Stat label="Retire at age" value={sim.fireCross ? sim.fireCross.toFixed(1) : ">" + sim.END} accent={sim.fireCross && sim.fireCross <= 47 ? C.teal : C.ink} />
            <Stat label="Years from now" value={sim.fireCross ? (sim.fireCross - p.currentAge).toFixed(1) : "—"} />
            <Stat label={`Coast bar today · retire at ${sim.coastTarget}`} value={fmtM(sim.coastToday)} accent={C.coast} />
            <Stat label="Coast reached at" value={sim.coastCross ? sim.coastCross.toFixed(1) : "not yet"} accent={C.coast} />
            <Stat label="Liquid (taxable) at that point" value={sim.fireTaxable != null ? fmtM(sim.fireTaxable) : "—"} accent={C.liquid} />
            <Stat label="Locked until 59.5" value={sim.lockedShare ? (sim.lockedShare * 100).toFixed(0) + "%" : "—"} accent={sim.lockedShare > 0.6 ? C.coral : C.ink} />
            <Stat label="Mortgage clear at" value={`age ${sim.payoffAge}`} />
          </div>

          {!sim.fireAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              ⚠ On these inputs you never clear both bars. Lower the retirement budget, add partner income, trim the
              home price — or shift savings from the 401k into a taxable account so the bridge can be funded.
            </div>
          )}

          {delay != null && (
            <div style={{ background: C.panel2, border: `1px solid ${delay > 0.05 ? C.coral : C.teal}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              {delay > 0.05 ? (
                <>
                  <b>The 59.5 rule costs you {delay.toFixed(1)} years.</b> Ignoring it, you'd have enough in total at{" "}
                  <b>{simFree.fireCross.toFixed(1)}</b> — but only {fmtM(sim.fireTaxable)} of the pot would be taxable
                  against a bridge of {fmtM(sim.fireBridge)}, so you keep working until <b>{sim.fireCross.toFixed(1)}</b>.
                  {!p.rothLadder && " A Roth conversion ladder shortens the bridge to 5 years — try the toggle."}
                </>
              ) : (
                <>Total wealth, not liquidity, is what binds here — the taxable bucket already covers the bridge at{" "}
                <b>{sim.fireCross.toFixed(1)}</b>, so the 59.5 rule costs you nothing.</>
              )}
            </div>
          )}

          {sim.illiquidAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              ⚠ Taxable cash goes negative at age <b>{sim.illiquidAge}</b> — a lump (house, college) lands with the
              money stuck in retirement accounts. In reality that's a loan or a 10% early-withdrawal penalty.
            </div>
          )}

          {sim.fireCross && sim.fireCross < sim.payoffAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.brass}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              You'd still owe the mortgage (~{fmt(sim.mPI)}/yr) until <b>{sim.payoffAge}</b>, which is why the number
              (<b>{fmtM(sim.fireCrossValue)}</b>) sits above the naive {fmtM(sim.naiveNumber)}.
            </div>
          )}

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 14px 8px" }}>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={sim.rows} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
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
                {show.home && homeRow ? <ReferenceDot x={homeRow.age} y={homeRow.portfolio} r={5} fill={C.brass} stroke={C.bg} /> : null}
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
        </div>
      </div>
    </div>
  );
}
