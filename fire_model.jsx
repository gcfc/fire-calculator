import React, { useState, useMemo } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceDot, ResponsiveContainer,
} from "recharts";

// ---- palette (ledger / instrument) ----
const C = {
  bg: "#0E1A1F", panel: "#14252B", panel2: "#1B303733", ink: "#EAE6DD",
  brass: "#C9A24B", teal: "#5FB0A6", coral: "#D9695A", mute: "#7A8A8E",
  line: "#26424B",
};

const fmt = (n) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fmtM = (n) =>
  n == null ? "—" : "$" + (n / 1e6).toFixed(2) + "M";

function simulate(p) {
  const loan = p.homePrice * (1 - p.downPct);
  const r = p.mortgageRate / 12, n = p.mortgageTerm * 12;
  const mPI = p.buyHome
    ? (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) * 12
    : 0;
  const payoffAge = p.purchaseAge + p.mortgageTerm;
  const naiveNumber = p.retirementSpendToday / p.swr;
  const END = 100;

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
    pvCollege[age] = collegeGrossToday(age) * infl + pvCollege[age + 1] / (1 + p.nominalReturn);
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
      bal = bal * (1 + p.nominalReturn) + c;
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
  // backward induction: Need[age] = min nominal portfolio at start of `age` to fund age..100 ending >= 0
  const Need = {}; Need[END + 1] = 0;
  for (let age = END; age >= p.currentAge; age--) {
    Need[age] = (retireExpense(age) + Need[age + 1]) / (1 + p.nominalReturn);
  }

  let portfolio = p.startPortfolio;
  let fireAge = null, minSave = Infinity, minSaveAge = null, fireReal = null, fireReq = null;
  let fireCross = null, fireCrossValue = null, prevGap = null, prevStartReal = null;
  const rows = [];

  for (let age = p.currentAge; age <= END; age++) {
    const t = age - p.currentAge;
    const infl = Math.pow(1 + p.inflation, t);
    // continuous crossing: interpolate the fractional age where portfolio meets the "needed" curve
    const startReal = portfolio / infl;   // start-of-year portfolio, today's $
    const reqReal = Need[age] / infl;
    const gap = startReal - reqReal;
    if (fireAge === null && age > p.currentAge && gap >= 0) {
      if (prevGap !== null && prevGap < 0) {
        const f = prevGap / (prevGap - gap);          // fraction into the prior year, between 0 and 1
        fireCross = (age - 1) + f;
        fireCrossValue = prevStartReal + (startReal - prevStartReal) * f;
      } else {
        fireCross = age;
        fireCrossValue = startReal;
      }
      fireAge = Math.ceil(fireCross);                  // integer boundary used only to switch the sim to drawdown
      fireReal = startReal;
      fireReq = reqReal;
      // explicit data point at the fractional crossing: accumulation ends here, needed-curve ride begins here
      rows.push({ age: fireCross, portfolio: Math.round(fireCrossValue), required: Math.round(fireCrossValue), save: 0, drawdown: 0, events: [] });
    }
    prevGap = gap;
    prevStartReal = startReal;
    const working = fireAge === null;
    const mort = (p.buyHome && age >= p.purchaseAge && age < payoffAge) ? mPI : 0;

    let takeHome = working ? p.annualTakeHome * infl : 0;
    if (working && p.partnerIncome > 0 && age >= p.partnerStart && age <= p.partnerEnd)
      takeHome += p.partnerIncome * infl;
    const taxAdv = working ? p.annualTaxAdv * infl : 0;

    let expenses;
    if (working) {
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
      expenses = living + housing + kids;
    } else {
      expenses = p.retirementSpendToday * infl + mort;
    }

    const contribution = takeHome - expenses + taxAdv;
    if (!working) {
      // retired at the fractional crossing: portfolio rides the "needed" curve, ending on target at 100
      portfolio = Need[age];
    } else {
      portfolio = portfolio * (1 + p.nominalReturn) + contribution;
      if (age === p.purchaseAge && p.buyHome) portfolio -= downPayment;
      portfolio -= (netCollege[age] || 0);       // college paid from portfolio (after any 529 coverage)
      portfolio -= (contrib529[age] || 0);        // money diverted into the 529 sinking fund
    }

    const realSave = contribution / infl;
    if (working && realSave < minSave) { minSave = realSave; minSaveAge = age; }

    const events = [];
    if (age === p.purchaseAge && p.buyHome) events.push("home");
    if (age === p.kid1BirthAge || age === p.kid2BirthAge) events.push("kid");
    if (collegeGrossToday(age) > 0) events.push("college");

    rows.push({
      age,
      portfolio: Math.round(working ? startReal : portfolio / infl),
      required: Math.round(Need[age] / infl),
      save: Math.round(realSave),
      drawdown: working && realSave < 0 ? Math.round(realSave) : 0,
      events,
    });
  }
  const end = rows[rows.length - 1].portfolio;
  return { naiveNumber, fireAge, fireCross, fireCrossValue, fireReal, fireReq, payoffAge, mPI, minSave: Math.round(minSave), minSaveAge, end, rows };
}

const field = (label, key, val, set, opts = {}) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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

export default function FireModel() {
  const [p, setP] = useState({
    currentAge: 27, startPortfolio: 400000, annualTakeHome: 144000, annualTaxAdv: 40000,
    nonHousingLiving: 36000, rentAnnual: 36000, inflation: 0.03, nominalReturn: 0.07,
    buyHome: true, homePrice: 1500000, downPct: 0.20, mortgageRate: 0.065, mortgageTerm: 30,
    purchaseAge: 31, propTaxRate: 0.011, insMaintRate: 0.013, closingPct: 0.02,
    kid1BirthAge: 30, kid2BirthAge: 32, daycarePerKid: 26000, ongoingPerKid: 8000, collegePerKid: 200000,
    partnerIncome: 0, partnerStart: 31, partnerEnd: 70,
    retirementSpendToday: 110000, swr: 0.035,
    collegeSpread: false, use529: false, annual529: 0,
  });
  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));
  const setPct = (k, v) => setP((s) => ({ ...s, [k]: v / 100 }));

  const sim = useMemo(() => simulate(p), [p]);
  const homeRow = sim.rows.find((r) => r.events.includes("home"));
  const kidRows = sim.rows.filter((r) => r.events.includes("kid"));
  const kidsCount = [p.kid1BirthAge, p.kid2BirthAge].filter((b) => b > 0).length;
  const cap529 = kidsCount * 19000;

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
          The number that actually lasts to 100
        </h1>
        <p style={{ margin: "8px 0 0", color: C.mute, fontSize: 14, maxWidth: 660 }}>
          Age 27 to 100, all in <em>today's dollars</em>. The dashed brass curve is what you'd need at each age for the
          money to survive to 100 — it falls as your horizon shortens and the mortgage burns off. Your teal portfolio
          climbs until it meets that curve (brass dot); you retire at that exact point, then ride the curve straight to
          the target at 100. Drive it with your real figures on the left.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 24, alignItems: "start" }}>
        {/* INPUTS */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {[
            ["You", [
              ["Current age", "currentAge", {}],
              ["Current portfolio ← your real #", "startPortfolio", { step: 10000 }],
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
              ["Partner take-home / yr (0 = single)", "partnerIncome", { step: 5000 }],
            ]],
            ["Retirement", [
              ["Retirement spend / yr (today's $)", "retirementSpendToday", { step: 5000 }],
            ]],
          ].map(([group, fields]) => (
            <div key={group} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.teal, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>{group}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fields.map(([l, k, o]) => field(l, k, p[k], set, o))}
              </div>
            </div>
          ))}

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
            <Stat label="FIRE number · lasts to 100" value={sim.fireReq ? fmtM(sim.fireReq) : ">$" + fmtM(sim.rows[sim.rows.length-1].required).slice(1)} accent={C.brass} />
            <Stat label="Retire at age" value={sim.fireCross ? sim.fireCross.toFixed(1) : ">100"} accent={sim.fireCross && sim.fireCross <= 47 ? C.teal : C.ink} />
            <Stat label="Years from now" value={sim.fireCross ? (sim.fireCross - p.currentAge).toFixed(1) : "—"} />
            <Stat label="Money lasts" value={sim.fireCross ? "to 100 ✓" : "—"} accent={C.teal} />
            <Stat label="Ends at 100 (today's $)" value={fmtM(sim.end)} accent={C.teal} />
            <Stat label="Mortgage clear at" value={`age ${sim.payoffAge}`} />
          </div>

          {!sim.fireAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.coral}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              ⚠ On these inputs you never accumulate enough to retire <em>and</em> last to 100. Lower the retirement
              budget, add partner income, or trim the home price until a retirement age appears.
            </div>
          )}
          {sim.fireCross && sim.fireCross < sim.payoffAge && (
            <div style={{ background: C.panel2, border: `1px solid ${C.brass}55`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.ink }}>
              At <b>{sim.fireCross.toFixed(1)}</b> you've got enough to last to 100 — but you'd still owe the mortgage
              (~{fmt(sim.mPI)}/yr) until <b>{sim.payoffAge}</b>, which is exactly why the number
              (<b>{fmtM(sim.fireReq)}</b>) sits <b>above</b> the naive {fmtM(sim.naiveNumber)}. Paying the house off
              by retirement lowers the number you need.
            </div>
          )}

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 14px 8px" }}>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={sim.rows} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis dataKey="age" type="number" domain={[p.currentAge, 100]} ticks={[30,40,50,60,70,80,90,100]}
                  stroke={C.mute} tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                <YAxis stroke={C.mute} tickFormatter={(v) => "$" + (v / 1e6).toFixed(1) + "M"}
                  tick={{ fill: C.mute, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                  labelStyle={{ color: C.brass }}
                  formatter={(v, name) => [fmt(v), name === "portfolio" ? "Portfolio" : name === "required" ? "Needed to reach 100" : "Saving"]}
                  labelFormatter={(a) => "Age " + a}
                />
                <Bar dataKey="drawdown" fill={C.coral} opacity={0.8} barSize={10} />
                <Line type="monotone" dataKey="required" stroke={C.brass} strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
                <Line type="monotone" dataKey="portfolio" stroke={C.teal} strokeWidth={2.5} dot={false} />
                {homeRow && <ReferenceDot x={homeRow.age} y={homeRow.portfolio} r={5} fill={C.brass} stroke={C.bg} />}
                {kidRows.map((k) => <ReferenceDot key={k.age} x={k.age} y={k.portfolio} r={4} fill={C.ink} stroke={C.bg} />)}
                {sim.fireCross && <ReferenceDot x={sim.fireCross} y={sim.fireCrossValue} r={7} fill={C.brass} stroke={C.ink} strokeWidth={2} />}
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: C.mute, padding: "4px 6px 10px" }}>
              <span><span style={{ color: C.teal }}>●</span> your portfolio (real)</span>
              <span><span style={{ color: C.brass }}>┄</span> needed to last to 100</span>
              <span><span style={{ color: C.brass }}>◆</span> retirement point</span>
              <span><span style={{ color: C.ink }}>●</span> child born</span>
              <span><span style={{ color: C.coral }}>▮</span> drawdown year</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
