import { describe, it, expect } from "vitest";
import {
  simulate, DEFAULTS, EMPTY, isRunnable, planReadiness, kidName, runTrials, sankeyYear,
  encodeShare, decodeShare, sharePayload, snapshotFromSim, rehydrateRows, underwaterOf,
  allocationAdvice, retiresOnLoan, defaultShow,
  toAnnual, toShown, dollarsFromPct, pctFromDollars, netFromGross, grossFromNet,
} from "./fire_model.jsx";

// Every test below pins a bug that was actually found, or an invariant the model must not break.
// The comments say WHICH — a failing test here should tell you what regressed, not just that
// something did.

const run = (over = {}) => simulate({ ...DEFAULTS, ...over });
const HOME = (o = {}) => ({
  price: 1500000, purchaseAge: 31, downPct: 0.20, rate: 0.065, term: 30,
  closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013, ...o,
});
// no partner at all — note that on the default inputs a lone earner never affords the house,
// so tests that need a lone earner to actually RETIRE must also drop or shrink the home
const SINGLE = {
  partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0,
};

// Build a scenario that genuinely retires at or after the access age (59.5). Hard-coding a spending
// figure tuned to whatever DEFAULTS happen to be makes the FIXTURE the thing that breaks when a default
// moves — which is exactly what happened when the starting portfolio was raised. Search for a qualifying
// scenario instead, and throw if the sweep can't produce one, so a silently vacuous test is impossible.
const retiringAfterAccessAge = () => {
  for (const retirementSpendToday of [300000, 400000, 500000, 650000, 800000, 1000000]) {
    const p = { ...DEFAULTS, ...SINGLE, homes: [], retirementSpendToday };
    const sim = simulate(p);
    if (sim.fireCross != null && sim.fireCross >= DEFAULTS.accessAge) return { p, sim };
  }
  throw new Error("no scenario in the sweep retires at/after the access age — widen the fixture");
};

// sweep an input finely and hand back the per-step jumps in whatever you measure
const sweep = (key, from, to, step, pick, base = {}) => {
  const jumps = [];
  let prev = null;
  for (let v = from; v <= to; v += step) {
    const cur = pick(run({ ...base, [key]: v }));
    if (prev !== null) jumps.push(Math.abs(cur - prev));
    prev = cur;
  }
  return { max: Math.max(...jumps), jumps };
};

describe("continuity — the terminal-value sawtooth must never come back", () => {
  // THE BUG: retirement snapped to Math.ceil(fireCross), so nudging income up grew the surplus
  // smoothly and then collapsed it to ~0 the moment the ceiling tipped a whole year earlier.
  // Terminal value swung $3.92M -> $0.30M between two adjacent inputs.
  // NB: these pin rothLadder:true so TOTAL wealth is the binding constraint (leftover -> 0). With the
  // ladder off — the default — the 59.5 bridge binds and you legitimately over-save (see the LIQUIDITY
  // test below), so "leaves zero" would not apply; the continuity guard is what matters either way.
  it("leaves exactly zero at the horizon when total wealth is what binds", () => {
    for (let th = 140000; th <= 175000; th += 500) {
      expect(Math.abs(run({ annualTakeHome: th, rothLadder: true }).end)).toBeLessThan(1);
    }
  });

  it("never jumps the terminal value across a fine sweep of take-home", () => {
    expect(sweep("annualTakeHome", 140000, 175000, 250, (s) => s.end, { rothLadder: true }).max).toBeLessThan(1);
  });

  it("moves the retirement age continuously in take-home", () => {
    expect(sweep("annualTakeHome", 140000, 175000, 250, (s) => s.fireCross, { rothLadder: true }).max).toBeLessThan(0.02);
  });

  it("moves the retirement age continuously in partner income", () => {
    expect(sweep("partnerIncome", 100000, 140000, 250, (s) => s.fireCross, { rothLadder: true }).max).toBeLessThan(0.02);
  });

  it("moves the retirement age continuously in starting portfolio", () => {
    expect(sweep("startPortfolio", 300000, 600000, 2500, (s) => s.fireCross).max).toBeLessThan(0.02);
  });

  it("moves the retirement age continuously in retirement spend", () => {
    expect(sweep("retirementSpendToday", 60000, 95000, 250, (s) => s.fireCross).max).toBeLessThan(0.02);
  });

  it("keeps the surplus smooth even when LIQUIDITY binds (a real surplus, not an artifact)", () => {
    // with a hard 59.5 gate and the pot stuck in a 401k you are forced to over-save; the leftover
    // at the horizon is then genuinely > 0, but it must still not jump
    const gated = { rothLadder: false, startPortfolioTaxAdv: 300000 };
    let prev = null, maxJump = 0;
    for (let th = 140000; th <= 175000; th += 250) {
      const s = simulate({ ...DEFAULTS, ...gated, annualTakeHome: th });
      if (prev) maxJump = Math.max(maxJump, Math.abs(s.end - prev.end));
      prev = s;
    }
    const g = simulate({ ...DEFAULTS, ...gated });
    expect(g.end).toBeGreaterThan(0);              // the surplus is real
    expect(maxJump).toBeLessThan(50000);           // …and it does not sawtooth
  });
});

describe("age frames — partner inputs are in the PARTNER's own age", () => {
  // THE BUG: partnerStart defaulted to 31 meaning "when GEORG turns 31", silently discarding four
  // years of a working partner's income ($480k) and costing 2.5 years of retirement.
  it("keeps the partner's working window on their own clock", () => {
    const off = DEFAULTS.currentAge - DEFAULTS.partnerAge;
    const s = run();
    expect(s.partnerAgeAtFire).toBeCloseTo(s.fireCross - off, 9);
    expect(s.accessPartner).toBeCloseTo(DEFAULTS.accessAge + off, 9);
  });

  it("is invariant to shifting the whole household forward in time", () => {
    // same life, started 5 years later: years-to-retirement must be identical.
    // both sides pin the home explicitly — otherwise `a` would take its home from DEFAULTS and
    // `b` from HOME(), and the two worlds would not be the same life at all.
    // rothLadder:true keeps the 59.5 unlock RELATIVE (retire+5); with the hard gate the wall is an
    // absolute age, so starting 5 years later genuinely shortens the bridge and invariance won't hold.
    const a = run({ rothLadder: true, homes: [HOME()], partnerStart: 26, partnerEnd: 65 });
    const b = run({
      rothLadder: true,
      currentAge: 32, partnerAge: 31, partnerStart: 26, partnerEnd: 65,
      kids: [{ birthAge: 35 }, { birthAge: 37 }],
      homes: [HOME({ purchaseAge: 36 })],
      coastAge: 53, endAge: 105,
    });
    expect(b.fireCross - 32).toBeCloseTo(a.fireCross - 27, 6);
  });

  it("binds the partner's earning window in their age, not yours", () => {
    // stopping their income at THEIR 30 must delay retirement a lot
    expect(run({ partnerEnd: 30 }).fireCross).toBeGreaterThan(run().fireCross + 5);
    // starting it at THEIR 35 likewise
    expect(run({ partnerStart: 35 }).fireCross).toBeGreaterThan(run().fireCross + 4);
  });

  it("opens an older partner's 401k earlier on your clock, shortening the bridge", () => {
    const older = run({ partnerAge: 35, partnerStart: 35 });
    expect(older.accessPartner).toBeLessThan(DEFAULTS.accessAge);
    expect(older.partnerOffset).toBe(-8);
  });

  it("stretches the horizon for a younger partner and not for an older one", () => {
    expect(run({ partnerAge: 19 }).END).toBe(DEFAULTS.endAge + 8);   // 8y younger -> 8y longer
    expect(run({ partnerAge: 35 }).END).toBe(DEFAULTS.endAge);       // older -> you die last
    expect(run({ partnerAge: 0 }).END).toBe(DEFAULTS.endAge);        // single
  });

  it("prices the longer horizon (a younger partner needs more at any given age)", () => {
    // compare the requirement at a FIXED age — the retirement instants differ between these two
    // worlds, so their fireReq values are not measured at the same point and cannot be compared
    const required = (s, age) => s.rows.find((r) => r.age === age).required;
    expect(required(run({ partnerAge: 19 }), 60)).toBeGreaterThan(required(run({ partnerAge: 27 }), 60));
  });

  it("ignores the partner's portfolio entirely once there is no partner", () => {
    // a lone earner must not keep a phantom account: dropping the partner (age 0) has to zero out
    // their portfolio the same way it already zeroes their income and their 59.5 unlock.
    const single = run({ partnerAge: 0, partnerPortfolio: 250000, partnerPortfolioTaxAdv: 100000 });
    const explicitZero = run({ partnerAge: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0 });
    expect(single.rows[0].portfolio).toBe(explicitZero.rows[0].portfolio);
    // portfolio = invested + cash, and a dropped partner takes their cash with them
    expect(single.rows[0].portfolio).toBe(DEFAULTS.startPortfolio + DEFAULTS.startCash);
    // …but a real partner's portfolio still counts
    expect(run({ partnerPortfolio: 250000 }).rows[0].portfolio)
      .toBeGreaterThan(run({ partnerPortfolio: 0 }).rows[0].portfolio);
  });
});

describe("the 59.5 rule — money you cannot legally touch", () => {
  it("never lets the gate make you retire EARLIER", () => {
    expect(run().fireCross).toBeGreaterThanOrEqual(run({ enforceAccess: false }).fireCross - 1e-9);
  });

  it("orders the three regimes: no gate <= ladder <= hard gate", () => {
    const dual = { partnerAge: 27, partnerIncome: 90000, partnerTaxAdv: 23000 };
    const free = simulate({ ...DEFAULTS, ...dual, enforceAccess: false }).fireCross;
    const ladder = simulate({ ...DEFAULTS, ...dual, rothLadder: true }).fireCross;
    const hard = simulate({ ...DEFAULTS, ...dual, rothLadder: false }).fireCross;
    expect(free).toBeLessThanOrEqual(ladder + 1e-9);
    expect(ladder).toBeLessThanOrEqual(hard + 1e-9);
  });

  it("always leaves enough in TAXABLE to cover the bridge", () => {
    for (const over of [{}, { rothLadder: false }, { startPortfolioTaxAdv: 200000 }, { annualTaxAdv: 60000 }]) {
      const s = run(over);
      if (s.fireCross != null) expect(s.fireTaxable).toBeGreaterThanOrEqual(s.fireBridge - 1);
    }
  });

  it("needs no bridge at all when you retire after 59.5", () => {
    // retirement lands past the statutory age, so there is nothing to bridge: every dollar is
    // already reachable on the day you stop working
    const { sim } = retiringAfterAccessAge();
    expect(sim.fireCross).toBeGreaterThanOrEqual(DEFAULTS.accessAge);   // the fixture really is late
    expect(sim.fireBridge).toBe(0);
  });

  it("strands you when everything is locked in a 401k", () => {
    // all savings tax-advantaged + hard gate -> you cannot fund an early retirement
    const s = run({ rothLadder: false, startPortfolioTaxAdv: 400000, annualTaxAdv: 80000, annualTakeHome: 104000 });
    expect(s.fireCross).toBeGreaterThan(run().fireCross);
  });

  it("makes the ladder inert when retirement already lands past 59.5", () => {
    // a ladder opens at T+5, but never later than the access age — so past that age it changes nothing
    // Reuse the searched fixture: past the wall, unlockAt() returns the statutory age either way, so
    // the ladder is structurally inert. The old fixture had drifted to retiring at 48.7 — comfortably
    // BEFORE the wall — where the ladder is also a no-op, but for an unrelated reason (liquidity
    // simply wasn't binding). It therefore passed without ever exercising this rule.
    const { p, sim: without } = retiringAfterAccessAge();
    expect(without.fireCross).toBeGreaterThanOrEqual(DEFAULTS.accessAge);
    expect(simulate({ ...p, rothLadder: true }).fireCross).toBeCloseTo(without.fireCross, 6);
  });

  it("lets an unlocked 401k cover a cash shortfall while still working (past 59.5)", () => {
    // a lone earner carrying a big house runs the taxable account underwater for years. Before this
    // rule the shortfall compounded forever and retirement never came; now, once the 401k unlocks at
    // 59.5, the shortfall is paid from it — so retirement lands past the statutory age, pot to zero.
    const s = run({ ...SINGLE, allowBorrowing: true });
    expect(s.fireCross).toBeGreaterThan(DEFAULTS.accessAge);
    expect(s.fireCrossValue).toBeGreaterThanOrEqual(s.fireReq - 1);   // clears the total bar
    expect(s.end).toBeLessThanOrEqual(1);                             // drawn down, no phantom growth
    // the taxable account is no longer stranded underwater once past the unlock age
    const afterUnlock = s.rows.filter((r) => r.age >= Math.ceil(DEFAULTS.accessAge));
    expect(afterUnlock.every((r) => r.taxable >= -1)).toBe(true);
  });

  it("still reports 'never' when total wealth truly never covers the need", () => {
    // spending so far beyond income that net worth never reaches the requirement at any age — the
    // unlock sweep cannot rescue a plan that is simply underfunded, only one that is merely illiquid
    const s = run({ ...SINGLE, homes: [], annualTakeHome: 60000, annualTaxAdv: 0,
                    retirementSpendToday: 250000, startPortfolio: 50000, startPortfolioTaxAdv: 0 });
    expect(s.fireCross).toBeNull();
    expect(s.rows.some((r) => r.portfolio >= r.required)).toBe(false);
  });
});

describe("coast FIRE", () => {
  it("meets the required curve exactly at the coast age", () => {
    for (const coastAge of [45, 50, 60, 65, 75]) {
      const s = run({ coastAge });
      const row = s.rows.find((r) => r.age === coastAge);
      expect(Math.abs(row.coast - row.required)).toBeLessThanOrEqual(1);
    }
  });

  it("sits below the full-FIRE bar and rises to meet it", () => {
    const s = run({ coastAge: 65 });
    const at30 = s.rows.find((r) => r.age === 30);
    const at50 = s.rows.find((r) => r.age === 50);
    expect(at30.coast).toBeLessThan(at30.required);
    expect(at50.coast).toBeGreaterThan(at30.coast);
  });

  it("stops existing past the coast target", () => {
    const s = run({ coastAge: 60 });
    expect(s.rows.filter((r) => r.age > 60).every((r) => r.coast === null)).toBe(true);
  });

  it("is reached no later than full FIRE", () => {
    const s = run({ coastAge: 65 });
    expect(s.coastCross).toBeLessThanOrEqual(s.fireCross);
  });

  it("clamps a nonsense coast age into range", () => {
    expect(run({ coastAge: 200 }).coastTarget).toBe(run({ coastAge: 200 }).END);
    expect(run({ coastAge: 5 }).coastTarget).toBe(DEFAULTS.currentAge + 1);
  });
});

describe("horizon (end age) is configurable", () => {
  it("raises the number and delays retirement as the horizon lengthens", () => {
    // total wealth must be the binding constraint for the horizon to move the number — pin the ladder
    // on, else the 59.5 bridge (which is horizon-independent) sets the date and the number won't move
    const short = run({ endAge: 85, rothLadder: true });
    const long = run({ endAge: 110, rothLadder: true });
    expect(short.fireCrossValue).toBeLessThan(long.fireCrossValue);
    expect(short.fireCross).toBeLessThanOrEqual(long.fireCross);
    expect(short.coastToday).toBeLessThan(long.coastToday);
  });

  it("composes with the partner offset", () => {
    expect(run({ endAge: 100, partnerAge: 26 }).END).toBe(101);
  });
});

describe("homes — any number, each with its own loan", () => {
  it("matches the closed-form amortisation for P&I", () => {
    const s = run({ homes: [HOME()] });
    const loan = 1500000 * 0.8, i = 0.065 / 12, n = 360;
    const expected = ((loan * i * (1 + i) ** n) / ((1 + i) ** n - 1)) * 12;
    expect(s.homes[0].mPI).toBeCloseTo(expected, 2);
  });

  it("charges (down% + closing%) x price as cash at closing", () => {
    expect(run({ homes: [HOME()] }).homes[0].down).toBeCloseTo(0.22 * 1500000, 6);
  });

  it("stacks homes independently — each keeps its own P&I and payoff", () => {
    const two = run({ homes: [HOME(), HOME({ price: 700000, purchaseAge: 40 })] });
    const solo = run({ homes: [HOME({ price: 700000, purchaseAge: 40 })] });
    expect(two.homes[1].mPI).toBeCloseTo(solo.homes[0].mPI, 6);
    expect(two.homes[0].payoff).toBe(61);
    expect(two.homes[1].payoff).toBe(70);
    expect(two.lastPayoff).toBe(70);
  });

  it("delays retirement with each extra home (they are pure cost in this model)", () => {
    const none = run({ homes: [] });
    const one = run({ homes: [HOME()] });
    const two = run({ homes: [HOME(), HOME({ price: 700000, purchaseAge: 40 })] });
    expect(none.fireCross).toBeLessThan(one.fireCross);
    expect(one.fireCross).toBeLessThan(two.fireCross);
  });

  it("rents forever when there are no homes", () => {
    const s = run({ homes: [] });
    expect(s.lastPayoff).toBeNull();
    expect(s.homes).toHaveLength(0);
  });

  it("has no mortgage at 100% down, and a bigger annual bill on a shorter term", () => {
    expect(run({ homes: [HOME({ downPct: 1.0 })] }).homes[0].mPI).toBe(0);
    expect(run({ homes: [HOME({ term: 15 })] }).homes[0].mPI)
      .toBeGreaterThan(run({ homes: [HOME({ term: 30 })] }).homes[0].mPI);
    expect(run({ homes: [HOME({ term: 15 })] }).homes[0].payoff).toBe(46);
  });

  it("responds correctly to rate arbitrage: borrow cheap, pay cash when dear", () => {
    // 3% mortgage vs a 7% return -> financing wins, so a small down payment retires you EARLIER
    const cheapLow = run({ homes: [HOME({ rate: 0.03, downPct: 0.05 })] }).fireCross;
    const cheapAll = run({ homes: [HOME({ rate: 0.03, downPct: 1.0 })] }).fireCross;
    expect(cheapLow).toBeLessThan(cheapAll);
    // 12% mortgage -> borrowing loses badly, so paying cash retires you earlier
    const dearLow = run({ homes: [HOME({ rate: 0.12, downPct: 0.05 })] }).fireCross;
    const dearAll = run({ homes: [HOME({ rate: 0.12, downPct: 1.0 })] }).fireCross;
    expect(dearAll).toBeLessThan(dearLow);
  });

  it("emits one home event per home", () => {
    const s = run({ homes: [HOME(), HOME({ purchaseAge: 40 }), HOME({ purchaseAge: 45 })] });
    expect(s.rows.filter((r) => r.events.includes("home"))).toHaveLength(3);
  });

  it("reports P&I still running at retirement", () => {
    const s = run({ homes: [HOME()] });                       // 30y loan from 31, retire ~39
    expect(s.mortgageAtFire).toBeGreaterThan(0);
    expect(run({ homes: [] }).mortgageAtFire).toBe(0);
  });
});

describe("kids — any number, each on their own clock", () => {
  it("delays retirement with each extra kid", () => {
    const zero = run({ kids: [] });
    const two = run();
    const four = run({ kids: [30, 32, 34, 36].map((birthAge) => ({ birthAge })) });
    expect(zero.fireCross).toBeLessThan(two.fireCross);
    expect(two.fireCross).toBeLessThan(four.fireCross);
  });

  it("emits one birth event per kid", () => {
    const s = run({ kids: [30, 32, 34, 36].map((birthAge) => ({ birthAge })) });
    expect(s.rows.filter((r) => r.events.includes("kid"))).toHaveLength(4);
  });

  it("bills college on each kid's own 18th birthday", () => {
    const s = run({ kids: [{ birthAge: 30 }], collegeSpread: false });
    const collegeYears = s.rows.filter((r) => r.events.includes("college")).map((r) => r.age);
    expect(collegeYears).toEqual([48]);                       // 30 + 18
  });

  it("spreads tuition over four years when asked", () => {
    const s = run({ kids: [{ birthAge: 30 }], collegeSpread: true });
    expect(s.rows.filter((r) => r.events.includes("college")).map((r) => r.age)).toEqual([48, 49, 50, 51]);
  });

  // THE BUG: the 529 sinking fund compounded with year-end lumps while the portfolio compounded
  // continuously, so every dollar diverted into it silently lost ~3.4% of a year's growth.
  // Saving for college actively destroyed wealth and pushed retirement out by ~0.05y.
  it("is exactly wealth-neutral — diverting into a 529 must not leak value", () => {
    // no taxes are modelled, and the fund grows at the same rate as the portfolio, so routing
    // college through a 529 can only be a wash. Any difference here is a leak.
    const without = run({ use529: false, enforceAccess: false });
    const with529 = run({ use529: true, annual529: 38000, enforceAccess: false });
    expect(with529.fireCross).toBeCloseTo(without.fireCross, 6);
  });

  it("never makes retirement EARLIER (the model has no tax benefit to give it)", () => {
    for (const annual529 of [10000, 25000, 38000]) {
      expect(run({ use529: true, annual529 }).fireCross)
        // tolerance is 1e-3 years (~9 hours) rather than 1e-6: spendSpan now also cuts at the
        // instant cash runs dry, and a 529 shifts that instant by a hair
        .toBeGreaterThanOrEqual(run({ use529: false }).fireCross - 1e-3);
    }
  });
});

describe("core invariants (must hold for every scenario)", () => {
  const scenarios = {
    default: {},
    // a lone earner carrying the house runs the cash account underwater for years, but once the
    // 401k unlocks at 59.5 it covers the shortfall — so retirement lands late rather than never
    // a lone earner carrying this house runs the spendable account underwater for years, so it only
    // reaches a crossing at all with borrowing switched on
    "single earner carrying the house": { ...SINGLE, allowBorrowing: true },
    "single, renting": { ...SINGLE, homes: [] },
    "no kids, no home": { kids: [], homes: [] },
    "three homes": { homes: [HOME(), HOME({ price: 700000, purchaseAge: 40 }), HOME({ price: 500000, purchaseAge: 45 })] },
    "hard gate": { rothLadder: false, startPortfolioTaxAdv: 250000 },
    "gate off": { enforceAccess: false },
    "long horizon": { endAge: 115 },
    "lean spend": { retirementSpendToday: 40000 },
    "fat spend": { retirementSpendToday: 160000 },
    "four kids": { kids: [30, 32, 34, 36].map((birthAge) => ({ birthAge })) },
  };

  for (const [name, spec] of Object.entries(scenarios)) {
    describe(name, () => {
      const { retires = true, ...over } = spec;
      const s = run(over);

      it("produces no NaN anywhere in the rows", () => {
        for (const r of s.rows) {
          for (const [k, v] of Object.entries(r)) {
            if (typeof v === "number") expect(Number.isFinite(v), `${k} @ age ${r.age}`).toBe(true);
          }
        }
      });

      it("keeps rows sorted by age", () => {
        expect(s.rows.every((r, i, a) => i === 0 || a[i - 1].age <= r.age)).toBe(true);
      });

      it("never runs out of money before the horizon", () => {
        expect(s.end).toBeGreaterThanOrEqual(-1);
      });

      if (retires) {
        it("clears BOTH bars at retirement", () => {
          expect(s.fireCross).not.toBeNull();
          expect(s.fireCrossValue).toBeGreaterThanOrEqual(s.fireReq - 1);
          expect(s.fireTaxable).toBeGreaterThanOrEqual(s.fireBridge - 1);
        });
      } else {
        it("reports 'never' rather than inventing a retirement", () => {
          expect(s.fireCross).toBeNull();
          expect(s.fireCrossValue).toBeNull();
        });
      }
    });
  }
});

describe("the tax-advantaged slice can never exceed the portfolio it slices", () => {
  // Without the clamp, taxable floors at 0 while the locked bucket keeps the whole oversized
  // number — so an over-large 401k figure would INVENT money.
  const startingTotal = (s) => s.rows[0].portfolio;   // age-0 row, already in today's $

  it("does not invent money when the 401k figure exceeds your portfolio", () => {
    const sane = run({ startPortfolio: 400000, startPortfolioTaxAdv: 400000 });
    const silly = run({ startPortfolio: 400000, startPortfolioTaxAdv: 900000 });
    expect(startingTotal(silly)).toBe(startingTotal(sane));
    expect(startingTotal(silly)).toBe(400000 + DEFAULTS.partnerPortfolio + DEFAULTS.startCash + DEFAULTS.partnerCash);
  });

  it("does the same for the partner", () => {
    const silly = run({ partnerPortfolio: 150000, partnerPortfolioTaxAdv: 900000 });
    expect(startingTotal(silly)).toBe(DEFAULTS.startPortfolio + 150000 + DEFAULTS.startCash + DEFAULTS.partnerCash);
  });

  it("treats an over-large figure as 'all locked, nothing taxable'", () => {
    const s = run({
      startPortfolio: 400000, startPortfolioTaxAdv: 900000,
      partnerPortfolio: 150000, partnerPortfolioTaxAdv: 900000,
    });
    // `taxable` is now the spendable line — cash plus taxable investments. The clamp zeroes the
    // INVESTED slice of it; the cash bucket is untouched by a bad 401k figure.
    expect(s.rows[0].taxable - s.rows[0].cash).toBe(0);
    expect(s.rows[0].cash).toBe(DEFAULTS.startCash + DEFAULTS.partnerCash);
  });

  it("never lets an over-large figure retire you EARLIER than the honest cap", () => {
    const capped = run({ startPortfolio: 400000, startPortfolioTaxAdv: 400000 });
    const silly = run({ startPortfolio: 400000, startPortfolioTaxAdv: 900000 });
    expect(silly.fireCross).toBeCloseTo(capped.fireCross, 9);
  });
});

describe("the partner's earning window must be a real interval", () => {
  // An inverted or backdated window would silently pay the partner nothing — the same class of
  // quiet income-discarding that the partnerStart age-frame bug caused.
  it("starts income now when the window starts before the partner exists today", () => {
    // partner is 26; "earns from 20" cannot mean anything but "already earning"
    expect(run({ partnerStart: 20 }).fireCross).toBeCloseTo(run({ partnerStart: 26 }).fireCross, 9);
  });

  it("never pays the partner nothing just because the window is inverted", () => {
    // drop the home so a thin-income world is still solvable and the comparison is meaningful
    const inverted = run({ homes: [], partnerStart: 40, partnerEnd: 30 });   // ends before it starts
    const noPartnerIncome = run({ homes: [], partnerIncome: 0, partnerTaxAdv: 0 });
    // an empty window would be indistinguishable from having no partner income at all
    expect(inverted.fireCross).toBeLessThan(noPartnerIncome.fireCross);
  });

  it("holds the end of an inverted window at its start", () => {
    // earning exactly one year from 40 is what the clamp produces
    expect(run({ homes: [], partnerStart: 40, partnerEnd: 30 }).fireCross)
      .toBeCloseTo(run({ homes: [], partnerStart: 40, partnerEnd: 40 }).fireCross, 9);
  });

  it("still lets a valid window bind normally", () => {
    expect(run({ partnerStart: 26, partnerEnd: 35 }).fireCross)
      .toBeGreaterThan(run({ partnerStart: 26, partnerEnd: 60 }).fireCross);
  });
});

describe("purity", () => {
  it("does not mutate the params it is given", () => {
    const p = { ...DEFAULTS, homes: [HOME()], kids: [{ birthAge: 30 }] };
    const before = JSON.stringify(p);
    simulate(p);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("is deterministic", () => {
    expect(run().fireCross).toBe(run().fireCross);
  });
});

describe("reported figures line up with each other", () => {
  it("splits the pot into taxable + locked", () => {
    const s = run();
    expect(s.fireTaxable + s.fireLocked).toBeCloseTo(s.fireCrossValue, 6);
    expect(s.lockedShare).toBeCloseTo(s.fireLocked / s.fireCrossValue, 9);
  });

  it("finds the tightest saving year", () => {
    const s = run();
    expect(s.minSaveAge).toBeGreaterThanOrEqual(DEFAULTS.currentAge);
    expect(s.minSaveAge).toBeLessThanOrEqual(Math.ceil(s.fireCross));
    expect(Number.isFinite(s.minSave)).toBe(true);
  });

  it("beats the naive SWR number when a mortgage outlives retirement", () => {
    // the whole point of the model: a live mortgage means you need MORE than spending / swr
    const s = run({ homes: [HOME()] });
    expect(s.mortgageAtFire).toBeGreaterThan(0);
    expect(s.fireCrossValue).toBeGreaterThan(s.naiveNumber);
  });
});

describe("share links — encode/decode round-trips and hydration", () => {
  it("round-trips a full-details payload and stores only the diff from DEFAULTS", () => {
    const p = { ...DEFAULTS, annualTakeHome: 175000, partnerAge: 0,
      homes: [], kids: [{ birthAge: 33 }] };
    const show = { ...defaultShow(), taxable: true };
    const payload = sharePayload("full", { p, show });
    // only changed keys are carried, keeping links short
    expect(Object.keys(payload.p).sort()).toEqual(["annualTakeHome", "homes", "kids", "partnerAge"]);
    expect(payload.show).toEqual({ taxable: true });
    const decoded = decodeShare(encodeShare(payload));
    expect(decoded).toEqual(payload);
    // hydration merges the diff back onto DEFAULTS -> the exact original p
    expect({ ...DEFAULTS, ...decoded.p }).toEqual(p);
  });

  it("carries NO inputs in a plot-only link, only computed chart data", () => {
    const p = { ...DEFAULTS, annualTakeHome: 173456 };   // a distinctive salary to grep for
    const sim = simulate(p);
    const token = encodeShare(sharePayload("plot", { p, show: defaultShow(), sim }));
    // the raw salary must not be recoverable from the link
    const json = JSON.stringify(decodeShare(token));
    expect(json).not.toContain("173456");
    expect(json).not.toContain("annualTakeHome");
    // and there is no `p` on a plot payload at all
    expect(decodeShare(token).p).toBeUndefined();
    expect(decodeShare(token).mode).toBe("plot");
  });

  it("rebuilds the charted rows from a plot snapshot", () => {
    const sim = simulate({ ...DEFAULTS });
    const snap = snapshotFromSim(sim, defaultShow(), true);
    const rebuilt = rehydrateRows(decodeShare(encodeShare({ v: 1, mode: "plot", snap })).snap);
    expect(rebuilt.length).toBe(sim.rows.length);
    for (let i = 0; i < sim.rows.length; i++) {
      for (const k of ["age", "portfolio", "taxable", "retirement", "required", "bridge", "coast"]) {
        expect(rebuilt[i][k]).toBe(sim.rows[i][k]);
      }
    }
    // event dots survive the columnar trip
    const homeAges = sim.rows.filter((r) => r.events.includes("home")).map((r) => r.age);
    expect(rebuilt.filter((r) => r.events.includes("home")).map((r) => r.age)).toEqual(homeAges);
  });

  it("recomputes underwater spans from a rebuilt snapshot the same way the live app does", () => {
    // a lone earner runs the taxable account underwater for years before the 401k unlocks
    const sim = simulate({ ...DEFAULTS, partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0,
      partnerPortfolio: 0, partnerPortfolioTaxAdv: 0 });
    const snap = snapshotFromSim(sim, defaultShow(), true);
    const rebuilt = rehydrateRows(snap);
    expect(underwaterOf(rebuilt, snap.END)).toEqual(underwaterOf(sim.rows, sim.END));
    expect(underwaterOf(rebuilt, snap.END).length).toBeGreaterThan(0);   // there really is a window
  });

  it("returns null for anything malformed, empty, or the wrong version", () => {
    expect(decodeShare("")).toBeNull();
    expect(decodeShare(null)).toBeNull();
    expect(decodeShare("not-base64-@@@")).toBeNull();
    expect(decodeShare(encodeShare({ v: 999, mode: "full", p: {} }))).toBeNull();
    expect(decodeShare(encodeShare({ v: 1, mode: "bogus" }))).toBeNull();
    expect(decodeShare(encodeShare("plain string"))).toBeNull();
  });

  it("accepts a bare token, a #s=… hash, or a whole URL", () => {
    const token = encodeShare(sharePayload("full", { p: { ...DEFAULTS, coastAge: 55 }, show: defaultShow() }));
    expect(decodeShare(token).p).toEqual({ coastAge: 55 });
    expect(decodeShare("#s=" + token).p).toEqual({ coastAge: 55 });
    expect(decodeShare("https://x.io/fire-calculator/#s=" + token).p).toEqual({ coastAge: 55 });
  });
});

describe("allocation advice — tax-advantaged vs. taxable split", () => {
  const SINGLE = { partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0 };

  it("tells a locked-heavy saver to shift toward taxable, and by how much / how much earlier", () => {
    // a single earner pouring $60k/yr into a 401k while renting is starved of the pre-59.5 bridge
    const p = { ...DEFAULTS, ...SINGLE, homes: [], annualTaxAdv: 60000, annualTakeHome: 90000 };
    const a = allocationAdvice(p);
    expect(a?.dir).toBe("toTaxable");
    expect(a.years).toBeGreaterThan(1);                 // a real acceleration, not a rounding wobble
    expect(a.amount).toBeGreaterThan(0);
    expect(a.amount).toBeLessThanOrEqual(60000);        // never suggest moving more than they contribute
    // the promised earlier date must actually be reproducible by making the shift
    const shifted = simulate({ ...p, annualTaxAdv: 0, annualTakeHome: p.annualTakeHome + p.annualTaxAdv });
    expect(shifted.fireCross).toBeCloseTo(a.newAge, 5);
    expect(simulate(p).fireCross - shifted.fireCross).toBeCloseTo(a.years, 5);
  });

  it("only advises within the freedom to allocate — nothing to move means no advice", () => {
    // no tax-advantaged saving at all: there is nothing to redirect toward taxable
    const p = { ...DEFAULTS, ...SINGLE, homes: [], annualTaxAdv: 0, annualTakeHome: 60000,
      retirementSpendToday: 250000, startPortfolio: 50000, startPortfolioTaxAdv: 0 };
    expect(allocationAdvice(p)).toBeNull();
  });

  it("shifting toward taxable never delays retirement (liquidity is free in this model)", () => {
    // whatever the inputs, moving 401k -> taxable keeps total wealth fixed and only adds liquidity,
    // so the retirement date can only move earlier or stay put — never later
    for (const over of [{}, { ...SINGLE, homes: [] }, { annualTaxAdv: 80000, annualTakeHome: 104000 }]) {
      const p = { ...DEFAULTS, ...over };
      const base = simulate(p).fireCross;
      const taxable = simulate({ ...p, annualTaxAdv: 0, annualTakeHome: p.annualTakeHome + p.annualTaxAdv }).fireCross;
      if (base != null && taxable != null) expect(taxable).toBeLessThanOrEqual(base + 1e-9);
    }
  });

  it("says nothing about allocation once retirement already lands after 59.5", () => {
    // past the wall the split is irrelevant, so neither direction should fire
    const { p, sim } = retiringAfterAccessAge();
    expect(sim.fireCross).toBeGreaterThanOrEqual(DEFAULTS.accessAge);   // the fixture really is late
    expect(allocationAdvice(p)).toBeNull();
  });

  it("flags spare liquidity when you retire early with taxable to burn", () => {
    // with a Roth ladder the household retires well before 59.5 with far more liquid than the (short,
    // retire+5) bridge needs — the over-liquid case. (Ladder off, the same household is liquidity-bound
    // and would instead be told to shift toward taxable — covered by the locked-heavy test above.)
    const a = allocationAdvice({ ...DEFAULTS, rothLadder: true });
    expect(a?.dir).toBe("toTaxAdv");
    expect(a.slack).toBeGreaterThan(2 * DEFAULTS.retirementSpendToday);
  });
});

describe("partner enable/disable + new chart requirement lines", () => {
  it("partnerEnabled:false matches dropping to a single filer, and re-enabling restores it", () => {
    const off = simulate({ ...DEFAULTS, partnerEnabled: false });     // keep age 26, just disabled
    const single = simulate({ ...DEFAULTS, partnerAge: 0 });          // the legacy age-0 path
    expect(off.hasPartner).toBe(false);
    expect(off.fireCross).toBeCloseTo(single.fireCross, 9);
    expect(off.END).toBe(single.END);
    // the flag is additive: enabled + a real age is the full partnered result
    expect(simulate({ ...DEFAULTS, partnerEnabled: true }).fireCross).toBeCloseTo(simulate(DEFAULTS).fireCross, 9);
  });

  it("age 0 still means single even with the box checked", () => {
    expect(simulate({ ...DEFAULTS, partnerAge: 0, partnerEnabled: true }).hasPartner).toBe(false);
  });

  it("splits the total requirement into the taxable bridge plus the retirement-accounts line", () => {
    const s = simulate(DEFAULTS);
    for (const r of s.rows) {
      expect(r.neededRetirement).toBe(Math.max(0, r.required - r.bridge));
    }
  });

  it("reports the real liquidity wall: retire+5 with a Roth ladder, statutory 59.5 without", () => {
    const ladder = simulate({ ...DEFAULTS, rothLadder: true });
    expect(ladder.fireCross).toBeLessThan(ladder.accessYou);          // retires before 59.5
    expect(ladder.unlockYouAtFire).toBeCloseTo(Math.min(ladder.accessYou, ladder.fireCross + DEFAULTS.ladderYears), 6);
    const hard = simulate({ ...DEFAULTS, rothLadder: false });
    expect(hard.unlockYouAtFire).toBe(hard.accessYou);
  });

  it("defaults the Roth ladder OFF, so the unlock wall is the statutory 59.5 (no ladder line)", () => {
    expect(DEFAULTS.rothLadder).toBe(false);
    const s = simulate(DEFAULTS);
    expect(s.unlockYouAtFire).toBe(s.accessYou);   // effective unlock == 59.5 => the ladder line stays hidden
  });
});

describe("a partner who keeps working after you retire (opt-in)", () => {
  it("is a perfect no-op when off (default) across a spread of inputs", () => {
    for (const over of [{}, { partnerEnd: 65 }, { partnerAge: 35 }, { annualTakeHome: 170000 }, { enforceAccess: false }]) {
      const base = simulate({ ...DEFAULTS, ...over });
      const same = simulate({ ...DEFAULTS, ...over, partnerWorksAfterRetire: false, interimLivingToday: 999 });
      expect(same.fireCross).toBe(base.fireCross);
      expect(same.end).toBe(base.end);
      expect(same.rows).toEqual(base.rows);
    }
  });

  it("retires you earlier and shrinks the number when the partner works past your date", () => {
    const off = simulate({ ...DEFAULTS });                                  // retire together
    const on = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true });    // partner works to their 60
    expect(on.fireCross).toBeLessThan(off.fireCross - 1);
    expect(on.fireCrossValue).toBeLessThan(off.fireCrossValue);
    expect(on.partnerStopsAtAge).toBeGreaterThan(on.fireCross);             // they really do outlast your retirement
  });

  it("stays gate<->forward consistent: terminal lands ~0 when total wealth binds", () => {
    // gate off => no bridge => total binds => the closed-form requirement must match the drawdown
    const g = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true, enforceAccess: false });
    expect(g.fireCrossValue).toBeCloseTo(g.fireReq, 0);
    expect(Math.abs(g.end)).toBeLessThan(5);
  });

  it("moves the retirement date continuously in a continuous input (no sawtooth)", () => {
    expect(sweep("annualTakeHome", 140000, 175000, 250, (s) => s.fireCross, { partnerWorksAfterRetire: true }).max)
      .toBeLessThan(0.02);
  });

  it("interim living defaults to working-years living and moves the date monotonically", () => {
    const inherit = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true });
    const explicit = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true, interimLivingToday: DEFAULTS.nonHousingLiving });
    expect(inherit.fireCross).toBe(explicit.fireCross);                     // null == nonHousingLiving
    const lean = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true, interimLivingToday: 20000, allowBorrowing: true });
    const rich = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true, interimLivingToday: 80000, allowBorrowing: true });
    expect(lean.fireCross).toBeLessThan(rich.fireCross);                    // spend more in between -> retire later
  });

  it("does nothing when the partner already stops before you retire, or when disabled", () => {
    const early = { partnerEnd: 30 };                                        // their 30 is well before your date
    expect(simulate({ ...DEFAULTS, ...early, partnerWorksAfterRetire: true }).fireCross)
      .toBe(simulate({ ...DEFAULTS, ...early }).fireCross);
    // no partner at all -> the toggle is inert
    expect(simulate({ ...DEFAULTS, partnerEnabled: false, partnerWorksAfterRetire: true }).fireCross)
      .toBe(simulate({ ...DEFAULTS, partnerEnabled: false }).fireCross);
  });

  it("when a working partner over-covers the interim bill, you retire today and the pot GROWS (not a bug)", () => {
    // A household whose working partner out-earns the (interim) living budget is a net saver even after
    // you quit, so Need starts below zero, the crossing is clamped at currentAge, and the pot is never
    // drawn down — it compounds to a large terminal surplus. This is the shared-link scenario from the
    // "curve exploding" report: correct behavior, not a defect. Pin it so a refactor can't silently
    // turn the intentional surplus into a $0-terminal "fix".
    const p = {
      ...DEFAULTS,
      currentAge: 26, startPortfolio: 35000, startPortfolioTaxAdv: 3500, startCash: 0, partnerCash: 0,
      annualTakeHome: 60000, annualTaxAdv: 7000, nonHousingLiving: 18000, rentAnnual: 18000,
      homes: [{ price: 200000, purchaseAge: 30, downPct: 0.3, rate: 0.065, term: 15, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }],
      kids: [{ birthAge: 35 }, { birthAge: 37 }],
      expenses: [{ label: "Mom's Retire", age: 42, amount: 30000, until: null }],
      partnerAge: 24, partnerIncome: 50000, partnerTaxAdv: 7000, partnerPortfolio: 25000, partnerPortfolioTaxAdv: 5000,
      partnerStart: 24, partnerEnd: 65, partnerWorksAfterRetire: true, retirementSpendToday: 60000, coastAge: 40,
    };
    // Kids now cost real money in retirement (they used to be free once you stopped working), and two
    // of them are exactly enough to stop this partner from over-covering the bill. The phenomenon being
    // pinned is about the partner carrying the household, so pin it on the household without kids —
    // and pin the kids' effect separately, just below.
    const s = simulate({ ...p, kids: [] });
    expect(s.fireCross).toBe(p.currentAge);          // "retire today" — clamped at the earliest possible instant
    expect(s.rows[0].required).toBeLessThan(0);      // Need < 0: future income already outweighs future spending
    expect(s.end).toBeGreaterThan(1_000_000);        // terminal is a real surplus, NOT drawn to zero
    expect(Number.isNaN(s.end)).toBe(false);

    // …and adding the two kids back is what breaks the over-coverage: their costs land squarely in
    // the retired years, so the requirement flips positive and the date moves out.
    const withKids = simulate(p);
    expect(withKids.rows[0].required).toBeGreaterThan(0);
    expect(withKids.fireCross).toBeGreaterThan(p.currentAge);

    // and it really is the partner carrying it: living at the FULL retirement budget in the interim
    // (so the partner no longer over-covers) restores the ordinary interior crossing and ~$0 terminal.
    const full = simulate({ ...p, interimLivingToday: p.retirementSpendToday });
    expect(full.fireCross).toBeGreaterThan(p.currentAge + 1);
    expect(full.rows[0].required).toBeGreaterThan(0);
  });
});

describe("major one-off expenses and debts", () => {
  it("empty expenses/debts arrays are a perfect no-op", () => {
    const base = simulate({ ...DEFAULTS });
    const same = simulate({ ...DEFAULTS, expenses: [], debts: [] });
    expect(same.fireCross).toBe(base.fireCross);
    expect(same.rows).toEqual(base.rows);
  });

  it("a one-off expense pushes the date out; a windfall pulls it in", () => {
    const base = simulate({ ...DEFAULTS });
    const cost = simulate({ ...DEFAULTS, expenses: [{ age: 32, amount: 60000 }] });
    const gift = simulate({ ...DEFAULTS, expenses: [{ age: 40, amount: -300000 }] });
    expect(cost.fireCross).toBeGreaterThan(base.fireCross);
    expect(gift.fireCross).toBeLessThan(base.fireCross);
    expect(gift.fireCrossValue).toBeLessThan(base.fireCrossValue);
  });

  it("a windowed expense costs more than the same amount once (and scales with the window)", () => {
    const once = simulate({ ...DEFAULTS, expenses: [{ age: 35, amount: 10000 }] });
    const win = simulate({ ...DEFAULTS, expenses: [{ age: 35, amount: 10000, until: 45 }] });
    expect(win.fireCross).toBeGreaterThan(once.fireCross);
  });

  it("prices a debt and derives its payoff age by amortization", () => {
    const s = simulate({ ...DEFAULTS, debts: [{ balance: 80000, apr: 6, payment: 900 }] });
    expect(s.fireCross).toBeGreaterThan(simulate({ ...DEFAULTS }).fireCross);   // servicing it costs time
    // 80k at 6% APR, $900/mo -> ~117 months -> ~9.8y from age 27
    expect(s.debtPayoffs[0]).toBeGreaterThan(27 + 9);
    expect(s.debtPayoffs[0]).toBeLessThan(27 + 11);
  });

  it("flags a debt whose payment doesn't cover the interest as never clearing", () => {
    const s = simulate({ ...DEFAULTS, debts: [{ balance: 80000, apr: 12, payment: 100 }] });
    expect(s.debtPayoffs[0]).toBeNull();
  });

  it("stays gate<->forward consistent with expenses + debts (terminal ~0, gate off)", () => {
    const g = simulate({ ...DEFAULTS, enforceAccess: false,
      expenses: [{ age: 35, amount: 50000 }, { age: 55, amount: -100000 }],
      debts: [{ balance: 40000, apr: 5, payment: 800 }] });
    expect(g.fireCrossValue).toBeCloseTo(g.fireReq, 0);
    expect(Math.abs(g.end)).toBeLessThan(5);
  });

  it("surfaces one-off expense markers and is continuous in the amount", () => {
    const s = simulate({ ...DEFAULTS, expenses: [{ age: 33, amount: 40000 }, { age: 50, amount: -20000 }] });
    expect(s.expenseMarks).toEqual([{ age: 33, amount: 40000 }, { age: 50, amount: -20000 }]);
    // nudging the amount moves the date smoothly (no snap)
    let prev = null, max = 0;
    for (let a = 20000; a <= 80000; a += 1000) {
      const c = simulate({ ...DEFAULTS, expenses: [{ age: 35, amount: a }] }).fireCross;
      if (prev != null) max = Math.max(max, Math.abs(c - prev)); prev = c;
    }
    expect(max).toBeLessThan(0.05);
  });
});

// The model runs forward from currentAge with the portfolio you have TODAY, so a one-time cost that
// already happened is assumed baked into that number. Past events must therefore only ever contribute
// their still-remaining FUTURE cash flows — never their original one-time cost — and never crash.
describe("events dated before the current age (in the past)", () => {
  const C = DEFAULTS.currentAge;
  const noNaN = (s) => {
    for (const r of s.rows) for (const v of Object.values(r)) if (typeof v === "number" && Number.isNaN(v)) return false;
    return !Number.isNaN(s.end);
  };

  it("a purely-past one-off expense is a no-op (already in your current portfolio)", () => {
    const base = simulate({ ...DEFAULTS });
    const past = simulate({ ...DEFAULTS, expenses: [{ age: C - 3, amount: 100000 }] });
    expect(past.fireCross).toBe(base.fireCross);
    expect(past.rows).toEqual(base.rows);
  });

  it("a windowed expense straddling today counts only its remaining (future) years", () => {
    const base = simulate({ ...DEFAULTS });
    // past-only window: fully ignored, exactly equal to the baseline
    const gone = simulate({ ...DEFAULTS, expenses: [{ age: C - 6, amount: 20000, until: C - 1 }] });
    expect(gone.fireCross).toBe(base.fireCross);
    // straddling window == the same window clamped to start today (past years drop, future years bill)
    const straddle = simulate({ ...DEFAULTS, expenses: [{ age: C - 3, amount: 20000, until: C + 3 }] });
    const fromNow = simulate({ ...DEFAULTS, expenses: [{ age: C, amount: 20000, until: C + 3 }] });
    expect(straddle.fireCross).toBeCloseTo(fromNow.fireCross, 6);
  });

  // THE BUG: `balance` is "balance now", but a past startAge amortized it from origination, so the
  // payoff landed years too early — and far enough back it fell before today and was billed as $0.
  it("a debt started in the past still amortizes its balance-now from today", () => {
    const now = simulate({ ...DEFAULTS, debts: [{ balance: 30000, apr: 6, payment: 400, startAge: C }] });
    for (const back of [3, 6, 10, 25]) {
      const past = simulate({ ...DEFAULTS, debts: [{ balance: 30000, apr: 6, payment: 400, startAge: C - back }] });
      expect(past.debtPayoffs[0]).toBeCloseTo(now.debtPayoffs[0], 6);   // same remaining horizon
      expect(past.fireCross).toBeCloseTo(now.fireCross, 6);             // and the same cost in time
    }
    // a FUTURE start is still honored (deferred), not clamped
    const later = simulate({ ...DEFAULTS, debts: [{ balance: 30000, apr: 6, payment: 400, startAge: C + 4 }] });
    expect(later.debtPayoffs[0]).toBeGreaterThan(now.debtPayoffs[0] + 3.9);
  });

  it("a home bought in the past keeps its remaining mortgage but is not re-charged the down payment", () => {
    // buying the identical home in the past must be cheaper (5 fewer mortgage years, down already paid)
    const nowHome = simulate({ ...DEFAULTS, homes: [{ price: 1500000, purchaseAge: C, downPct: 0.2, rate: 0.065, term: 30, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }] });
    const pastHome = simulate({ ...DEFAULTS, homes: [{ price: 1500000, purchaseAge: C - 5, downPct: 0.2, rate: 0.065, term: 30, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }] });
    expect(pastHome.homes[0].payoff).toBe(C - 5 + 30);   // mortgage clears on its original schedule
    expect(noNaN(pastHome)).toBe(true);
    expect(pastHome.fireCross).toBeLessThan(nowHome.fireCross);
  });

  it("never produces NaN with every kind of event dated in the past at once", () => {
    const s = simulate({ ...DEFAULTS,
      homes: [{ price: 1200000, purchaseAge: C - 5, downPct: 0.2, rate: 0.06, term: 30, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }],
      kids: [{ birthAge: C - 4 }],
      expenses: [{ age: C - 3, amount: 50000, until: C + 2 }],
      debts: [{ balance: 30000, apr: 6, payment: 400, startAge: C - 3 }] });
    expect(noNaN(s)).toBe(true);
  });
});

describe("guaranteed retirement income — pensions / Social Security / annuities", () => {
  const C = DEFAULTS.currentAge;
  const pension = (over = {}) => ({ label: "pension", amount: 40000, startAge: 65, whose: "you", cola: true, until: null, ...over });

  it("is a perfect no-op when empty or zero-amount", () => {
    const base = simulate({ ...DEFAULTS });
    expect(simulate({ ...DEFAULTS, incomes: [] })).toEqual(base);
    const zero = simulate({ ...DEFAULTS, incomes: [pension({ amount: 0 })] });
    expect(zero.fireCross).toBe(base.fireCross);
    expect(zero.end).toBe(base.end);
    expect(zero.incomePV).toBe(0);
  });

  it("lowers the requirement and, when total wealth binds, retires you earlier for a smaller number", () => {
    // gate off => total wealth binds => a pension is pure requirement relief
    const off = simulate({ ...DEFAULTS, enforceAccess: false });
    const on = simulate({ ...DEFAULTS, enforceAccess: false, incomes: [pension()] });
    expect(on.rows[0].required).toBeLessThan(off.rows[0].required);   // Need at every age drops
    expect(on.fireCross).toBeLessThan(off.fireCross);                 // …so you retire sooner
    expect(on.fireCrossValue).toBeLessThan(off.fireCrossValue);       // …with a smaller pot
    expect(on.incomePV).toBeGreaterThan(0);
  });

  it("keeps the terminal balance ~0 when total wealth binds (the requirement stays self-consistent)", () => {
    const g = simulate({ ...DEFAULTS, enforceAccess: false, incomes: [pension({ amount: 60000, startAge: 62 })] });
    expect(g.fireCrossValue).toBeCloseTo(g.fireReq, 0);
    expect(Math.abs(g.end)).toBeLessThan(5);
  });

  it("a fixed-nominal pension is worth strictly less than the same COLA'd one", () => {
    const cola = simulate({ ...DEFAULTS, incomes: [pension({ cola: true })] });
    const nom = simulate({ ...DEFAULTS, incomes: [pension({ cola: false })] });
    expect(nom.incomePV).toBeGreaterThan(0);
    expect(nom.incomePV).toBeLessThan(cola.incomePV);                 // erodes with inflation -> worth less
  });

  it("an income that starts before 59.5 shrinks the pre-59.5 bridge; one after it does not", () => {
    const none = simulate({ ...DEFAULTS });
    const early = simulate({ ...DEFAULTS, incomes: [pension({ startAge: 55 })] });   // before the wall
    const late = simulate({ ...DEFAULTS, incomes: [pension({ startAge: 65 })] });    // after the wall
    expect(early.fireBridge).toBeLessThan(none.fireBridge);
    expect(late.fireBridge).toBeCloseTo(none.fireBridge, 0);
  });

  it("a partner's income runs on the PARTNER's clock and is ignored without a partner", () => {
    const off = DEFAULTS.currentAge - DEFAULTS.partnerAge;            // your age = partner age + offset
    const s = simulate({ ...DEFAULTS, incomes: [pension({ whose: "partner", startAge: 67 })] });
    expect(s.incomeStartMarks).toEqual([67 + off]);                  // 67 in their frame -> your frame
    // no partner -> a partner income contributes nothing
    const noP = simulate({ ...DEFAULTS, partnerEnabled: false });
    const noPInc = simulate({ ...DEFAULTS, partnerEnabled: false, incomes: [pension({ whose: "partner" })] });
    expect(noPInc.fireCross).toBe(noP.fireCross);
    expect(noPInc.incomePV).toBe(0);
  });

  it("is age-frame invariant: shift the whole household forward and years-to-retirement is unchanged", () => {
    const a = simulate({ ...DEFAULTS, enforceAccess: false, incomes: [pension({ startAge: 65 })] });
    const shift = 5;
    const b = simulate({
      ...DEFAULTS, enforceAccess: false, currentAge: C + shift, partnerAge: DEFAULTS.partnerAge + shift,
      homes: DEFAULTS.homes.map((h) => ({ ...h, purchaseAge: h.purchaseAge + shift })),
      kids: DEFAULTS.kids.map((k) => ({ birthAge: k.birthAge + shift })),
      partnerStart: DEFAULTS.partnerStart + shift, partnerEnd: DEFAULTS.partnerEnd + shift,
      endAge: DEFAULTS.endAge + shift, coastAge: DEFAULTS.coastAge + shift,
      incomes: [pension({ startAge: 65 + shift })],
    });
    expect(b.fireCross - (C + shift)).toBeCloseTo(a.fireCross - C, 2);
  });

  it("a stream that ends early (non-lifetime) is worth less than the same one for life", () => {
    const life = simulate({ ...DEFAULTS, incomes: [pension({ until: null })] });
    const short = simulate({ ...DEFAULTS, incomes: [pension({ until: 75 })] });
    expect(short.incomePV).toBeGreaterThan(0);
    expect(short.incomePV).toBeLessThan(life.incomePV);
  });
});

describe("entry conveniences — enter what you actually know", () => {
  const C = DEFAULTS.currentAge;

  // ---- homes: "I already own it" (payment + years left) and $ carry --------
  it("an owned home takes the payment and years-left directly, with no closing cash", () => {
    const s = simulate({ ...DEFAULTS, homes: [{ owned: true, monthlyPI: 2000, yearsLeft: 18, propTaxAnnual: 9000, insMaintAnnual: 3000 }] });
    const h = s.homes[0];
    expect(h.owned).toBe(true);
    expect(h.mPI).toBe(24000);              // 2000/mo × 12
    expect(h.payoff).toBe(C + 18);          // owned today, 18 years of P&I left
    expect(h.down).toBe(0);                 // already bought — no down payment charged
    expect(h.carryAtBuy).toBe(12000);       // 9000 + 3000 this year
    // the home is really billed (P&I + carry drains a year of saving vs a housing-free world), and
    // owning one means rent is not charged on top
    const noHousing = simulate({ ...DEFAULTS, homes: [], rentAnnual: 0 });
    expect(s.rows[1].portfolio).toBeLessThan(noHousing.rows[1].portfolio);
  });

  it("a paid-off owned home (0 years left) charges only carry, no P&I", () => {
    const s = simulate({ ...DEFAULTS, homes: [{ owned: true, monthlyPI: 2000, yearsLeft: 0, propTaxAnnual: 9000, insMaintAnnual: 3000 }] });
    expect(s.homes[0].mPI).toBe(24000);     // the payment is still recorded…
    expect(s.homes[0].payoff).toBe(C);      // …but P&I stops immediately, so it never bills
    expect(s.mortgageAtFire).toBe(0);
  });

  it("dollar carry is identical to the equivalent % of price", () => {
    const price = 1500000, propTaxRate = 0.011, insMaintRate = 0.013;
    const common = { price, purchaseAge: 31, downPct: 0.2, rate: 0.065, term: 30, closingPct: 0.02 };
    const pct = simulate({ ...DEFAULTS, homes: [{ ...common, propTaxRate, insMaintRate }] });
    const dollar = simulate({ ...DEFAULTS, homes: [{ ...common, carryMode: "dollar", propTaxAnnual: price * propTaxRate, insMaintAnnual: price * insMaintRate }] });
    expect(dollar.naiveNumber).toBeCloseTo(pct.naiveNumber, 6);
    expect(dollar.rows).toEqual(pct.rows);
    expect(dollar.fireCross).toBe(pct.fireCross);
  });

  // ---- kids: "my kid is 4 now" --------------------------------------------
  it("a kid entered by age-now is identical to the same kid by birth-age", () => {
    const byAge = simulate({ ...DEFAULTS, kids: [{ ageNow: 4 }] });
    const byBirth = simulate({ ...DEFAULTS, kids: [{ birthAge: C - 4 }] });
    expect(byAge.rows).toEqual(byBirth.rows);
    expect(byAge.fireCross).toBe(byBirth.fireCross);
  });

  it("age-now and birth-age can be mixed across kids", () => {
    const mixed = simulate({ ...DEFAULTS, kids: [{ ageNow: 2 }, { birthAge: C + 3 }] });
    const both = simulate({ ...DEFAULTS, kids: [{ birthAge: C - 2 }, { birthAge: C + 3 }] });
    expect(mixed.rows).toEqual(both.rows);
  });

  // ---- income: gross salary netted to take-home ---------------------------
  it("gross income at an effective rate equals the same figure entered as take-home", () => {
    // Gross mode treats the entered figure as full pre-tax pay INCLUDING the pre-tax contribution, so
    // the equivalent gross is (take-home / (1 - rate)) + contribution — the contribution is deducted
    // before tax rather than taxed.
    const rate = 0.25;
    const net = simulate({ ...DEFAULTS });
    const gross = simulate({
      ...DEFAULTS, incomeMode: "gross", effTaxRate: rate * 100,
      annualTakeHome: DEFAULTS.annualTakeHome / (1 - rate) + DEFAULTS.annualTaxAdv,
      partnerIncome: DEFAULTS.partnerIncome / (1 - rate) + DEFAULTS.partnerTaxAdv,
    });
    expect(gross.rows).toEqual(net.rows);
    expect(gross.fireCross).toBe(net.fireCross);
    expect(gross.end).toBeCloseTo(net.end, 6);
  });

  it("gross mode does not tax the pre-tax contribution", () => {
    // raising the 401k contribution moves money from taxable pay into the locked bucket; because it
    // comes out before tax, total household wealth added that year should RISE by the tax saved on it,
    // not stay flat as it would if the contribution were taxed first
    const base = { ...DEFAULTS, incomeMode: "gross", effTaxRate: 25, annualTakeHome: 200000 };
    const low = simulate({ ...base, annualTaxAdv: 10000 });
    const high = simulate({ ...base, annualTaxAdv: 30000 });
    const saved = (r) => r.rows[0].save;
    expect(saved(high)).toBeGreaterThan(saved(low));            // the tax break is real…
    // …and worth exactly the rate on the extra contribution (20k × 25%)
    expect(saved(high) - saved(low)).toBeCloseTo(20000 * 0.25, 0);
  });

  it("incomeMode defaults to net, so effTaxRate is inert unless gross is chosen", () => {
    expect(simulate({ ...DEFAULTS, effTaxRate: 40 }).fireCross).toBe(simulate({ ...DEFAULTS }).fireCross);
  });

  it("gross netting touches only take-home, not pre-tax 401k contributions", () => {
    // raising the effective rate must lower spendable income (retire later) but leave the tax-adv flow alone
    // netting this hard drives the spendable account underwater, so both runs need borrowing on
    const base = simulate({ ...DEFAULTS, incomeMode: "gross", effTaxRate: 20, allowBorrowing: true });
    const higher = simulate({ ...DEFAULTS, incomeMode: "gross", effTaxRate: 35, allowBorrowing: true });
    expect(higher.fireCross).toBeGreaterThan(base.fireCross);
  });

  // ---- the pure unit-conversion helpers -----------------------------------
  it("monthly⇄annual is an exact round-trip", () => {
    for (const a of [0, 1000, 144000, 999999]) {
      expect(toAnnual(toShown(a, "mo"), "mo")).toBeCloseTo(a, 9);
      expect(toAnnual(a, "yr")).toBe(a);
      expect(toShown(a, "yr")).toBe(a);
    }
    expect(toAnnual(1000, "mo")).toBe(12000);
    expect(toShown(12000, "mo")).toBe(1000);
  });

  it("%-of-income ⇄ dollars round-trips and is safe at zero income", () => {
    expect(dollarsFromPct(10, 90000)).toBe(9000);
    expect(pctFromDollars(9000, 90000)).toBe(10);
    expect(pctFromDollars(dollarsFromPct(7, 120000), 120000)).toBeCloseTo(7, 9);
    expect(pctFromDollars(5000, 0)).toBe(0);          // no divide-by-zero
  });

  it("gross⇄net round-trips and clamps the rate to 0–100%", () => {
    expect(netFromGross(100000, 25)).toBe(75000);
    expect(grossFromNet(75000, 25)).toBe(100000);
    expect(grossFromNet(netFromGross(120000, 30), 30)).toBeCloseTo(120000, 6);
    expect(netFromGross(100000, -10)).toBe(100000);   // clamped up to 0
    expect(netFromGross(100000, 150)).toBe(0);        // clamped down to 100
    expect(grossFromNet(50000, 150)).toBe(50000);     // rate≥100 can't invert -> passthrough
  });
});

describe("a retirement that only works on a loan is not a FIRE number", () => {
  // A single earner buying a home they can't cash-fund runs the taxable (cash) account negative for
  // years — the model still finds a crossing, but it's bought with implicit borrowing, not real money.
  const LOAN_CASE = {
    ...DEFAULTS, partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0,
  };

  it("retiresOnLoan flags a crossing reached only by going underwater, and clears when the path is solvent", () => {
    const loan = simulate(LOAN_CASE);
    expect(loan.fireCrossIfBorrowed).not.toBeNull();   // a crossing DOES exist…
    expect(loan.illiquidAge).not.toBeNull();           // …but the cash account went underwater to get there
    expect(retiresOnLoan(loan)).toBe(true);
    expect(loan.fireCross).toBeNull();                 // …so with borrowing off, no date is reported

    const clean = simulate({ ...DEFAULTS });     // the default two-earner path never goes underwater
    expect(clean.illiquidAge).toBeNull();
    expect(retiresOnLoan(clean)).toBe(false);
  });

  it("a shared plot of a loan-funded path carries no retirement point", () => {
    const loan = simulate(LOAN_CASE);
    const snap = snapshotFromSim(loan, defaultShow(), true);
    expect(snap.fireCross).toBeNull();           // the dot the chart would draw is suppressed
    expect(snap.fireCrossValue).toBeNull();
    // a solvent path still carries its point
    const clean = snapshotFromSim(simulate({ ...DEFAULTS }), defaultShow(), true);
    expect(clean.fireCross).toBe(simulate({ ...DEFAULTS }).fireCross);
  });

  it("the model itself still exposes the raw crossing (only the presentation is suppressed)", () => {
    // downstream code (levers, allocation advice) still needs the underlying number; suppression is a
    // UI/snapshot concern, so simulate() must keep reporting it
    const loan = simulate(LOAN_CASE);
    expect(typeof loan.fireCrossIfBorrowed).toBe("number");
  });
});

describe("coast FIRE is opt-in", () => {
  it("is on by default and produces a full coast curve", () => {
    const s = simulate({ ...DEFAULTS });
    expect(s.useCoast).toBe(true);
    expect(s.coastTarget).toBe(DEFAULTS.coastAge);
    expect(s.coastToday).toBeGreaterThan(0);
    expect(s.rows.some((r) => r.coast != null)).toBe(true);
  });

  it("switched off, every coast output is null and no row carries a coast point", () => {
    const s = simulate({ ...DEFAULTS, useCoast: false });
    expect(s.useCoast).toBe(false);
    expect(s.coastTarget).toBeNull();
    expect(s.coastToday).toBeNull();
    expect(s.coastCross).toBeNull();
    expect(s.coastCrossValue).toBeNull();
    expect(s.rows.every((r) => r.coast == null)).toBe(true);   // nothing for the chart to draw
  });

  it("does not disturb the retirement answer — coast is a read-out, not an input to the model", () => {
    const on = simulate({ ...DEFAULTS });
    const off = simulate({ ...DEFAULTS, useCoast: false });
    expect(off.fireCross).toBe(on.fireCross);
    expect(off.fireCrossValue).toBe(on.fireCrossValue);
    expect(off.end).toBe(on.end);
    // …and the coast target itself is inert when off: changing it changes nothing
    const offOtherAge = simulate({ ...DEFAULTS, useCoast: false, coastAge: 60 });
    expect(offOtherAge.rows).toEqual(off.rows);
  });

  it("a shared plot of a coast-off model carries no coast series", () => {
    const s = simulate({ ...DEFAULTS, useCoast: false });
    const snap = snapshotFromSim(s, { portfolio: true }, true);
    expect(snap.coastTarget).toBeNull();
    expect(snap.coast.every((v) => v == null)).toBe(true);
    expect(snap.coastCross).toBeNull();
  });
});

describe("diagnostics — WHY the cash ran out, or coast is unreachable", () => {
  // the reported scenario: a lone earner buying a $2M home at 25. Housing alone outruns take-home,
  // so the cash account bleeds every year and goes underwater in his early thirties.
  const BROKE = {
    ...DEFAULTS, nominalReturn: 0.10, partnerEnabled: false, kids: [], swr: 0.025,
    retirementSpendToday: 200000, coastAge: 30, useCoast: false,
    homes: [{ price: 2000000, purchaseAge: 25, downPct: 0.2, rate: 0.065, term: 30, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }],
  };

  it("reports the cash-flow arithmetic for the year the account breaks", () => {
    const s = simulate(BROKE);
    expect(s.illiquidAge).not.toBeNull();
    const c = s.underwaterCause;
    expect(c).not.toBeNull();
    expect(c.age).toBe(s.illiquidAge);
    // the components must reconcile: take-home − living − housing − kids − lumps = what reaches cash
    expect(c.takeHome - c.living - c.housing - c.kids - c.lumps).toBeCloseTo(c.toTaxable, 0);
    expect(c.toTaxable).toBeLessThan(0);            // the year really does drain cash
    // …and the ledger points at the culprit: housing is the dominant outflow. (Whether it also exceeds
    // take-home outright depends on which year the account happens to break, which shifts with the
    // starting portfolio — so pin the diagnosis, not that incidental threshold.)
    const outflows = { housing: c.housing, living: c.living, kids: c.kids, lumps: c.lumps };
    expect(Math.max(...Object.values(outflows))).toBe(c.housing);
    expect(c.mortgage).toBeGreaterThan(0);          // and P&I is called out within housing
    expect(c.taxAdv).toBe(DEFAULTS.annualTaxAdv);   // still routing pay into locked accounts
    expect(c.prev.age).toBe(c.age - 1);             // the prior year is carried for context
  });

  it("is null when the cash account never goes underwater", () => {
    const ok = simulate({ ...DEFAULTS });
    expect(ok.illiquidAge).toBeNull();
    expect(ok.underwaterCause).toBeNull();
  });

  it("explains an unreachable coast target with the size of the gap", () => {
    const s = simulate({ ...BROKE, useCoast: true, coastAge: 30 });
    expect(s.coastCross).toBeNull();                 // never reaches the bar
    const g = s.coastShortfall;
    expect(g.age).toBe(30);
    expect(g.need).toBeGreaterThan(g.have);
    expect(g.gap).toBe(g.need - g.have);
  });

  it("reports no coast shortfall when coast is off, or when it IS reached", () => {
    expect(simulate({ ...BROKE, useCoast: false }).coastShortfall).toBeNull();
    const reached = simulate({ ...DEFAULTS });
    expect(reached.coastCross).not.toBeNull();
    expect(reached.coastShortfall).toBeNull();
  });
});

describe("what moves the needle lists only choices you control", () => {
  it("no lever is a market assumption", () => {
    // return and inflation are no longer offered as levers: true but unactionable, and they dwarfed
    // every real decision on the bar scale. Guard the model inputs they used to perturb.
    const s = simulate({ ...DEFAULTS });
    expect(s.fireCross).not.toBeNull();
    // the levers list lives in the UI, but its perturbations must still be valid model inputs
    for (const over of [
      { retirementSpendToday: DEFAULTS.retirementSpendToday - 10000 },
      { annualTakeHome: DEFAULTS.annualTakeHome + 10000 },
      { nonHousingLiving: DEFAULTS.nonHousingLiving - 5000 },
      { annualTaxAdv: DEFAULTS.annualTaxAdv - 10000, annualTakeHome: DEFAULTS.annualTakeHome + 10000 },
    ]) {
      const alt = simulate({ ...DEFAULTS, ...over });
      expect(Number.isNaN(alt.fireCross ?? 0)).toBe(false);
      expect(alt.fireCross).not.toBeNull();
    }
  });
});

describe("the year-by-year trace explains the chart's shape", () => {
  it("covers every year exactly once, in order, and labels the phases", () => {
    const s = simulate({ ...DEFAULTS });
    expect(s.trace.length).toBe(s.END - DEFAULTS.currentAge + 1);
    expect(s.trace[0].age).toBe(DEFAULTS.currentAge);
    expect(s.trace[s.trace.length - 1].age).toBe(s.END);
    s.trace.forEach((t, i) => { if (i) expect(t.age).toBe(s.trace[i - 1].age + 1); });
    // exactly one "retires" year, and it is the year the crossing falls in
    const retiring = s.trace.filter((t) => t.phase === "retires");
    expect(retiring.length).toBe(1);
    expect(retiring[0].age).toBe(Math.floor(s.fireCross));
    // everything before it is working, everything after is retired
    expect(s.trace.filter((t) => t.age < retiring[0].age).every((t) => t.phase === "working")).toBe(true);
    expect(s.trace.filter((t) => t.age > retiring[0].age).every((t) => t.phase === "retired")).toBe(true);
  });

  it("each year's end balances carry into the next year's start", () => {
    const s = simulate({ ...DEFAULTS });
    for (let i = 1; i < s.trace.length; i++) {
      // end-of-year and start-of-next are the same instant, so they must agree (to rounding)
      expect(Math.abs(s.trace[i].startTaxable - s.trace[i - 1].endTaxable)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.trace[i].startTaxAdv - s.trace[i - 1].endTaxAdv)).toBeLessThanOrEqual(1);
    }
  });

  it("the totals are the sum of the two buckets", () => {
    const s = simulate({ ...DEFAULTS });
    for (const t of s.trace) {
      expect(Math.abs(t.startTotal - (t.startTaxable + t.startTaxAdv))).toBeLessThanOrEqual(1);
      expect(Math.abs(t.endTotal - (t.endTaxable + t.endTaxAdv))).toBeLessThanOrEqual(1);
    }
  });

  it("shows WHY the pot climbs after retirement: locked accounts grow while taxable is drawn down", () => {
    // this is the counter-intuitive shape the trace exists to explain
    const s = simulate({ ...DEFAULTS });
    const locked = s.trace.filter((t) => t.phase === "retired" && t.locked);
    expect(locked.length).toBeGreaterThan(1);
    for (const t of locked) {
      expect(t.income).toBe(0);                          // no earnings — you've retired
      expect(t.contributions).toBe(0);                   // …and nothing new going in
      expect(t.endTaxAdv).toBeGreaterThan(t.startTaxAdv); // yet the locked bucket still grows
      expect(t.endTaxable).toBeLessThan(t.startTaxable);  // because only taxable pays the bills
    }
    // and the buckets flip once the wall opens: the locked one starts being spent
    const open = s.trace.filter((t) => t.phase === "retired" && !t.locked);
    expect(open.length).toBeGreaterThan(0);
  });

  it("marks accounts unlocked only from the access age onward", () => {
    const s = simulate({ ...DEFAULTS });
    for (const t of s.trace) {
      if (t.phase === "working") continue;
      expect(t.locked).toBe(t.age + 1 <= s.accessYou);
    }
  });
});

describe("the trace decomposition balances", () => {
  const SCENARIOS = {
    defaults: {},
    "lone earner": { partnerEnabled: false },
    "gate off": { enforceAccess: false },
    "partner works on": { partnerWorksAfterRetire: true },
    "with a pension": { incomes: [{ amount: 40000, startAge: 65, whose: "you", cola: true }] },
    "with one-offs": { expenses: [{ age: 40, amount: 60000 }, { age: 50, amount: -80000 }] },
  };

  it("every row closes: start + in − out + interest = balance, for BOTH accounts", () => {
    // The table prints these columns as an equation, so if the identity ever stopped holding the UI
    // would be quietly lying. Pin it across a spread of scenarios rather than just the defaults.
    for (const [name, over] of Object.entries(SCENARIOS)) {
      for (const t of simulate({ ...DEFAULTS, ...over }).trace) {
        const cash = t.startTaxable + t.takeHome + t.otherIncome - t.cashOut + t.cashGrowth;
        const adv = t.startTaxAdv + t.contributions - t.withdrawn + t.advGrowth;
        expect(`${name} age ${t.age} cash ${cash}`).toBe(`${name} age ${t.age} cash ${t.endTaxable}`);
        expect(`${name} age ${t.age} adv ${adv}`).toBe(`${name} age ${t.age} adv ${t.endTaxAdv}`);
        expect(Math.abs(t.endTaxable + t.endTaxAdv - t.endTotal)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("itemised outgoings add up to the bill the two accounts actually paid", () => {
    for (const over of Object.values(SCENARIOS)) {
      for (const t of simulate({ ...DEFAULTS, ...over }).trace) {
        const itemised = t.living + t.housing + t.kids + t.lumps;
        expect(Math.abs(itemised - (t.cashOut + t.withdrawn))).toBeLessThanOrEqual(2);
      }
    }
  });

  it("a locked retirement account never pays out, and only compounds", () => {
    const s = simulate({ ...DEFAULTS });
    const locked = s.trace.filter((t) => t.phase === "retired" && t.locked);
    expect(locked.length).toBeGreaterThan(1);
    for (const t of locked) {
      expect(t.withdrawn).toBe(0);                 // sealed: nothing can come out
      expect(t.advGrowth).toBeGreaterThan(0);      // so the whole change is interest
      expect(t.endTaxAdv).toBeGreaterThan(t.startTaxAdv);
    }
  });
});

describe("a one-off's sign is its direction (the UI enters a positive magnitude)", () => {
  it("an income of X is exactly the mirror of an expense of X", () => {
    const at = 40, amt = 75000;
    const cost = simulate({ ...DEFAULTS, expenses: [{ age: at, amount: amt }] });
    const gain = simulate({ ...DEFAULTS, expenses: [{ age: at, amount: -amt }] });
    const base = simulate({ ...DEFAULTS });
    expect(cost.fireCross).toBeGreaterThan(base.fireCross);   // paying it out costs you time
    expect(gain.fireCross).toBeLessThan(base.fireCross);      // taking it in buys time
    // and the requirement moves by the same magnitude in each direction. `required` is reported as a
    // rounded integer, so demand symmetry only to the precision the value actually carries — $1.
    const req = (s) => s.rows[0].required;
    expect(Math.abs((req(cost) - req(base)) - (req(base) - req(gain)))).toBeLessThanOrEqual(1);
  });

  it("flipping direction only flips the sign — magnitude is untouched", () => {
    // this is the invariant the expense/income picker relies on: it writes ±|amount|
    const asExpense = simulate({ ...DEFAULTS, expenses: [{ age: 45, amount: 50000 }] });
    const asIncome = simulate({ ...DEFAULTS, expenses: [{ age: 45, amount: -50000 }] });
    expect(asExpense.expenseMarks[0].amount).toBe(50000);
    expect(asIncome.expenseMarks[0].amount).toBe(-50000);
    expect(asExpense.expenseMarks[0].age).toBe(asIncome.expenseMarks[0].age);
  });
});

describe("cash is its own bucket, earning its own rate", () => {
  // THE POINT: splitting the portfolio into cash + investments is only meaningful if cash compounds
  // differently. That breaks the single-rate closed form Need[] is built on, so the requirement had
  // to learn the two-rate split. These pin that it learned it exactly, not approximately.

  it("is a no-op when cash earns exactly the portfolio rate", () => {
    // the strongest available equivalence: at the same rate the split cannot matter, so a household
    // holding 55k in cash must land on the identical date as one holding it in taxable investments
    const split = simulate({ ...DEFAULTS, cashReturn: DEFAULTS.nominalReturn });
    const merged = simulate({
      ...DEFAULTS, cashReturn: DEFAULTS.nominalReturn,
      startCash: 0, partnerCash: 0,
      startPortfolio: DEFAULTS.startPortfolio + DEFAULTS.startCash,
      partnerPortfolio: DEFAULTS.partnerPortfolio + DEFAULTS.partnerCash,
    });
    expect(split.fireCross).toBeCloseTo(merged.fireCross, 6);
    expect(split.fireCrossValue).toBeCloseTo(merged.fireCrossValue, 2);
  });

  it("still lands the horizon on exactly zero when total wealth binds", () => {
    // The invariant the whole two-rate split exists to protect. A single-rate Need[] against a
    // slower-growing cash bucket left $8.4k at the horizon, and for a cash-HEAVY household it would
    // have erred the other way — retiring you on a pot that then ran dry.
    for (const startCash of [0, 40000, 200000, 400000]) {
      const s = simulate({ ...DEFAULTS, startCash, rothLadder: true });
      expect(Math.abs(s.end), `startCash=${startCash}`).toBeLessThan(1);
    }
  });

  it("holds that invariant with a still-working partner too", () => {
    // the partner's surplus lands in INVESTMENTS while cash pays the bills, so the investments at
    // retirement are smaller than untouched compounding implies — worth $1.46M when unmodelled
    const s = simulate({ ...DEFAULTS, partnerWorksAfterRetire: true, enforceAccess: false, startCash: 150000 });
    expect(Math.abs(s.end)).toBeLessThan(5);
  });

  it("makes you retire later the more of the pot sits in cash, once cash yields less", () => {
    const lean = simulate({ ...DEFAULTS, startPortfolio: 500000, startCash: 100000 });
    const heavy = simulate({ ...DEFAULTS, startPortfolio: 200000, startCash: 400000 });
    expect(heavy.fireCross).toBeGreaterThan(lean.fireCross);
  });

  it("counts cash toward the pre-59.5 bridge — it is spendable at any age", () => {
    // a household with the same total but more of it in cash is no LESS liquid, so moving invested
    // taxable money into cash must never strand the bridge
    const s = simulate({ ...DEFAULTS, startCash: 300000, startPortfolio: 300000 });
    expect(s.rows[0].taxable).toBe(s.rows[0].cash + (300000 - DEFAULTS.startPortfolioTaxAdv)
      + (DEFAULTS.partnerPortfolio - DEFAULTS.partnerPortfolioTaxAdv));
  });

  it("erodes against inflation at a 0% cash rate", () => {
    const zero = simulate({ ...DEFAULTS, cashReturn: 0, startCash: 200000 });
    const yielding = simulate({ ...DEFAULTS, cashReturn: 0.04, startCash: 200000 });
    expect(zero.fireCross).toBeGreaterThan(yielding.fireCross);
    expect(zero.rows.every((r) => Number.isFinite(r.portfolio))).toBe(true);   // no divide-by-ln(1)
  });

  it("drops a partner's cash along with the rest of their money", () => {
    const single = simulate({ ...DEFAULTS, partnerAge: 0 });
    expect(single.rows[0].cash).toBe(DEFAULTS.startCash);
  });
});

describe("borrowing is opt-in", () => {
  // A plan that only balances by running the spendable account negative is an implicit loan. The UI
  // always refused to PRESENT it; the model now refuses to produce it unless you ask.
  const LOAN = { ...DEFAULTS, partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0,
                 partnerPortfolio: 0, partnerPortfolioTaxAdv: 0, partnerCash: 0 };

  it("withholds the date by default, and hands it back when borrowing is allowed", () => {
    const off = simulate(LOAN);
    const on = simulate({ ...LOAN, allowBorrowing: true });
    expect(off.illiquidAge).not.toBeNull();
    expect(off.fireCross).toBeNull();
    expect(off.borrowingBlocked).toBe(true);
    expect(on.fireCross).not.toBeNull();
    expect(on.borrowingBlocked).toBe(false);
    // the underlying crossing is the same either way — only whether it is reported changes
    expect(off.fireCrossIfBorrowed).toBeCloseTo(on.fireCross, 9);
  });

  it("withholds every figure that rests on the blocked date, not just the age", () => {
    const off = simulate(LOAN);
    for (const k of ["fireCross", "fireCrossValue", "fireReq", "fireTaxable", "fireBridge", "fireLocked"]) {
      expect(off[k], k).toBeNull();
    }
    expect(off.fireAge).toBeNull();
  });

  it("still returns the full path, so the chart can show where it broke", () => {
    const off = simulate(LOAN);
    expect(off.rows.length).toBeGreaterThan(0);
    expect(off.trace.length).toBeGreaterThan(0);
    expect(off.underwaterCause).not.toBeNull();
  });

  it("is inert on a solvent plan", () => {
    const off = simulate({ ...DEFAULTS });
    const on = simulate({ ...DEFAULTS, allowBorrowing: true });
    expect(off.illiquidAge).toBeNull();
    expect(off.fireCross).toBe(on.fireCross);
    expect(off.borrowingBlocked).toBe(false);
  });
});

describe("the app opens empty", () => {
  it("returns a well-formed empty result rather than NaN soup", () => {
    const s = simulate(EMPTY);
    expect(s.rows).toEqual([]);
    expect(s.trace).toEqual([]);
    expect(s.fireCross).toBeNull();
    expect(s.END).toBe(0);
    expect(s.hasPartner).toBe(false);
  });

  it("returns exactly the same keys as a real run, so no consumer hits undefined", () => {
    // an empty-state field that simulate() forgot would read as `undefined` in the UI and render as
    // "NaN" or crash a chart; pinning the key sets makes that impossible to introduce
    expect(Object.keys(simulate(EMPTY)).sort()).toEqual(Object.keys(simulate(DEFAULTS)).sort());
  });

  it("treats a blank box as blank, not as a string", () => {
    // "" + 5 is "5"; without the normalise pass a half-filled form produced string arithmetic
    const half = simulate({ ...EMPTY, currentAge: 30, endAge: 90, retirementSpendToday: 50000 });
    expect(half.rows.length).toBeGreaterThan(0);
    expect(half.rows.every((r) => Number.isFinite(r.portfolio) && Number.isFinite(r.required))).toBe(true);
  });

  it("starts projecting as soon as there is an age and a horizon", () => {
    expect(isRunnable(EMPTY)).toBe(false);
    expect(isRunnable({ ...EMPTY, currentAge: 30 })).toBe(true);   // endAge keeps its default
    expect(isRunnable({ ...EMPTY, currentAge: 30, endAge: 25 })).toBe(false);
  });

  it("loading the demo fills every blank", () => {
    const demo = simulate(DEFAULTS);
    expect(demo.fireCross).not.toBeNull();
    expect(demo.rows.length).toBeGreaterThan(0);
  });
});

describe("a half-filled form has no answer to give", () => {
  // THE BUG: with no retirement budget entered, retireExpense() is zero every year, so Need[] is
  // identically zero, so ANY balance clears the bar. An age-only form reported "you could stop
  // working today" — and because you retire in year one, every working-year input became inert:
  // sweeping non-housing living costs moved neither the date nor the terminal value by a cent.
  const PARTIAL = {
    ...EMPTY, currentAge: 30, startCash: 10000, startPortfolio: 500000,
    startPortfolioTaxAdv: 200000, annualTakeHome: 144000, annualTaxAdv: 30000,
  };

  it("reproduces the inert sweep it exists to prevent", () => {
    const dates = [0, 20000, 40000, 80000].map((nonHousingLiving) =>
      simulate({ ...PARTIAL, nonHousingLiving }).fireCross);
    expect(new Set(dates).size).toBe(1);         // nothing moves…
    expect(dates[0]).toBe(PARTIAL.currentAge);   // …because you "retire" on day one
    expect(planReadiness(PARTIAL).ready).toBe(false);
  });

  it("moves again the moment a retirement budget exists", () => {
    const withBudget = { ...PARTIAL, retirementSpendToday: 60000 };
    expect(planReadiness(withBudget).ready).toBe(true);
    const dates = [0, 20000, 40000, 80000].map((nonHousingLiving) =>
      simulate({ ...withBudget, nonHousingLiving }).fireCross);
    expect(new Set(dates).size).toBe(4);
    for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeGreaterThan(dates[i - 1]);
  });

  it("asks for an age, a retirement budget, and something to fund it with", () => {
    const keysMissing = (p) => planReadiness(p).checks.filter((c) => !c.ok).map((c) => c.key);
    expect(keysMissing(EMPTY)).toEqual(["age", "spend", "resources"]);
    expect(keysMissing({ ...EMPTY, currentAge: 30 })).toEqual(["spend", "resources"]);
    expect(keysMissing({ ...EMPTY, currentAge: 30, retirementSpendToday: 60000 })).toEqual(["resources"]);
    expect(keysMissing({ ...EMPTY, currentAge: 30, retirementSpendToday: 60000, annualTakeHome: 90000 })).toEqual([]);
  });

  it("counts savings alone as enough to fund it — someone already retired has no income", () => {
    const retiree = { ...EMPTY, currentAge: 67, retirementSpendToday: 50000, startPortfolio: 1200000 };
    expect(planReadiness(retiree).ready).toBe(true);
  });

  it("counts a pension alone, too", () => {
    const p = { ...EMPTY, currentAge: 67, retirementSpendToday: 50000,
                incomes: [{ label: "SS", amount: 30000, startAge: 67, whose: "you", cola: true }] };
    expect(planReadiness(p).ready).toBe(true);
  });

  it("ignores a partner's money while the partner is switched off", () => {
    const p = { ...EMPTY, currentAge: 30, retirementSpendToday: 60000,
                partnerEnabled: false, partnerAge: 30, partnerPortfolio: 900000 };
    expect(planReadiness(p).ready).toBe(false);
    expect(planReadiness({ ...p, partnerEnabled: true }).ready).toBe(true);
  });

  it("the demo is ready by construction", () => {
    expect(planReadiness(DEFAULTS).ready).toBe(true);
  });
});

describe("coast FIRE needs a target before it draws anything", () => {
  // THE BUG: a blank coast age normalises to 0, and the clamp turned that into currentAge + 1 — so
  // ticking the checkbox drew a full coast curve against "retire next year", a target nobody chose.
  const READY = { ...EMPTY, currentAge: 30, retirementSpendToday: 60000, annualTakeHome: 120000,
                  startPortfolio: 400000 };

  it("draws no curve while the coast age is blank", () => {
    const s = simulate({ ...READY, useCoast: true, coastAge: "" });
    expect(s.useCoast).toBe(true);            // the box is ticked…
    expect(s.coastSpecified).toBe(false);     // …but the question is unanswered
    expect(s.coastTarget).toBeNull();
    expect(s.coastToday).toBeNull();
    expect(s.coastCross).toBeNull();
    expect(s.coastShortfall).toBeNull();
    expect(s.rows.every((r) => r.coast == null)).toBe(true);
  });

  it("never invents a target one year out", () => {
    const s = simulate({ ...READY, useCoast: true, coastAge: "" });
    expect(s.coastTarget).not.toBe(READY.currentAge + 1);
  });

  it("draws it as soon as an age is given", () => {
    const s = simulate({ ...READY, useCoast: true, coastAge: 50 });
    expect(s.coastSpecified).toBe(true);
    expect(s.coastTarget).toBe(50);
    expect(s.coastToday).toBeGreaterThan(0);
    expect(s.rows.some((r) => r.coast != null)).toBe(true);
  });

  it("is still fully off when the box is unticked", () => {
    const s = simulate({ ...READY, useCoast: false, coastAge: 50 });
    expect(s.useCoast).toBe(false);
    expect(s.coastSpecified).toBe(false);
    expect(s.coastTarget).toBeNull();
  });
});

describe("guaranteed income counts in every year it runs", () => {
  // THE BUG: retireExpense() subtracts incomeAt(), and working years never call retireExpense() —
  // so a pension or Social Security claimed while still employed was invisible. A $40k/yr stream
  // running five working years moved the balances, and the date, by exactly nothing.
  const BASE = {
    ...DEFAULTS, partnerEnabled: false, homes: [], kids: [], currentAge: 55,
    startPortfolio: 200000, startPortfolioTaxAdv: 0, startCash: 20000,
    annualTakeHome: 90000, annualTaxAdv: 0, nonHousingLiving: 80000,
    retirementSpendToday: 80000, rentAnnual: 0,
  };
  const PENSION = [{ label: "pension", amount: 40000, startAge: 56, whose: "you", cola: true, until: 60 }];

  it("a pension drawn entirely while working still helps", () => {
    const without = simulate(BASE);
    const with_ = simulate({ ...BASE, incomes: PENSION });
    expect(with_.fireCross).toBeLessThan(without.fireCross);
    const bal = (s, age) => s.trace.find((t) => t.age === age).endTotal;
    expect(bal(with_, 58)).toBeGreaterThan(bal(without, 58));
  });

  it("shows it in the other-income column, not folded into salary", () => {
    const s = simulate({ ...BASE, incomes: PENSION });
    const yr = s.trace.find((t) => t.age === 57);
    expect(yr.phase).toBe("working");
    expect(yr.otherIncome).toBeGreaterThan(0);
    expect(yr.takeHome).toBeCloseTo(s.trace.find((t) => t.age === 61).takeHome, -2);  // salary unchanged
  });

  it("does not double-count it across the retirement transition", () => {
    // the year you retire is part working, part retired; the stream must be paid once, not twice
    const s = simulate({ ...BASE, incomes: [{ label: "SS", amount: 30000, startAge: 56, whose: "you", cola: true }] });
    const at = Math.floor(s.fireCross);
    const yr = s.trace.find((t) => t.age === at);
    const infl = Math.pow(1 + BASE.inflation, at - BASE.currentAge);
    expect(yr.otherIncome).toBeLessThanOrEqual(Math.round(30000 * 1.02) + 1);
  });

  it("still lands the horizon on zero with a stream spanning both phases", () => {
    const s = simulate({ ...BASE, rothLadder: true, enforceAccess: false,
      incomes: [{ label: "SS", amount: 25000, startAge: 58, whose: "you", cola: true }] });
    expect(Math.abs(s.end)).toBeLessThan(5);
  });
});

describe("kids cost the same whether or not you have a job", () => {
  // THE BUG: kidCostAt() was charged in flows() and absent from retireExpense(), so retiring early
  // with young children made daycare and school free for their entire childhood. Retire at 40 with a
  // two-year-old and the model charged $0 a year until college.
  const EARLY = {
    ...DEFAULTS, currentAge: 40, partnerEnabled: false, homes: [], kids: [{ birthAge: 38 }],
    retirementSpendToday: 60000, startPortfolio: 2500000, startPortfolioTaxAdv: 0,
    startCash: 50000, enforceAccess: false, rentAnnual: 0,
  };

  it("charges daycare and school in retired years", () => {
    const s = simulate(EARLY);
    const retiredKidYears = s.trace.filter((t) => t.phase === "retired" && t.age >= 40 && t.age <= 55);
    expect(retiredKidYears.length).toBeGreaterThan(0);
    expect(retiredKidYears.every((t) => t.kids > 0)).toBe(true);
  });

  it("makes an early retirement with young kids genuinely more expensive", () => {
    const withKid = simulate(EARLY);
    const without = simulate({ ...EARLY, kids: [] });
    expect(withKid.rows[0].required).toBeGreaterThan(without.rows[0].required);
    expect(withKid.fireCross).toBeGreaterThanOrEqual(without.fireCross);
  });

  it("still stops charging once they age out", () => {
    const s = simulate(EARLY);
    const grown = s.trace.filter((t) => t.age - 38 > 21);
    expect(grown.length).toBeGreaterThan(0);
    expect(grown.every((t) => t.kids === 0)).toBe(true);
  });

  it("both phases read one list, so nothing can be charged in only one of them", () => {
    // a household that never retires early still sees identical kid costs on either side of the date
    const s = simulate({ ...DEFAULTS, kids: [{ birthAge: 30 }] });
    const at = Math.floor(s.fireCross);
    const before = s.trace.find((t) => t.age === at - 1);
    const after = s.trace.find((t) => t.age === at + 1);
    const kidAgeBefore = at - 1 - 30, kidAgeAfter = at + 1 - 30;
    // both inside the 6-17 band ⇒ the same real cost, regardless of which side of retirement it is
    if (kidAgeBefore >= 6 && kidAgeBefore <= 17 && kidAgeAfter >= 6 && kidAgeAfter <= 17) {
      expect(after.kids).toBeCloseTo(before.kids, -2);
    }
  });

  it("still lands the horizon on zero with kids spanning the retirement date", () => {
    const s = simulate({ ...DEFAULTS, kids: [{ birthAge: 38 }], rothLadder: true, enforceAccess: false });
    expect(Math.abs(s.end)).toBeLessThan(5);
  });
});

describe("kids can carry names", () => {
  it("falls back to Kid N, numbered as authored", () => {
    expect(kidName({}, 0)).toBe("Kid 1");
    expect(kidName({ name: "" }, 2)).toBe("Kid 3");
    expect(kidName({ name: "   " }, 1)).toBe("Kid 2");
    expect(kidName(undefined, 0)).toBe("Kid 1");
  });

  it("uses the name when given, trimmed", () => {
    expect(kidName({ name: "Ada" }, 0)).toBe("Ada");
    expect(kidName({ name: "  Ada  " }, 4)).toBe("Ada");
  });

  it("puts named children on the birth-year row and leaves unnamed ones off", () => {
    const s = simulate({ ...DEFAULTS, kids: [{ birthAge: 30, name: "Ada" }, { birthAge: 32 }] });
    const born30 = s.rows.find((r) => r.age === 30);
    const born32 = s.rows.find((r) => r.age === 32);
    expect(born30.events).toContain("kid");
    expect(born30.bornNames).toEqual(["Ada"]);
    expect(born32.events).toContain("kid");
    expect(born32.bornNames).toEqual([]);     // unnamed ⇒ no chart label, no "Kid 2" clutter
  });

  it("numbers a named child by its authoring position, not its position among named ones", () => {
    const s = simulate({ ...DEFAULTS, kids: [{ birthAge: 30 }, { birthAge: 32, name: "Bo" }] });
    expect(s.rows.find((r) => r.age === 32).bornNames).toEqual(["Bo"]);
  });

  it("a name never changes the numbers", () => {
    const named = simulate({ ...DEFAULTS, kids: [{ birthAge: 30, name: "Ada" }, { birthAge: 32, name: "Bo" }] });
    const plain = simulate({ ...DEFAULTS, kids: [{ birthAge: 30 }, { birthAge: 32 }] });
    expect(named.fireCross).toBe(plain.fireCross);
    expect(named.fireCrossValue).toBe(plain.fireCrossValue);
  });
});

describe("a home is an asset, not just a hole", () => {
  // Until homes appreciated and could be sold, they were pure expense with no resale value — so
  // "rent forever" beat buying by construction. This was the single biggest distortion the README
  // admitted to.
  const H = (o = {}) => ({ price: 600000, purchaseAge: 30, downPct: 0.2, rate: 0.06, term: 30,
                           closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013, ...o });
  const BASE = { ...DEFAULTS, partnerEnabled: false, kids: [], currentAge: 28,
                 annualTakeHome: 150000, nonHousingLiving: 40000, retirementSpendToday: 70000,
                 startPortfolio: 300000, startPortfolioTaxAdv: 100000, startCash: 20000 };

  it("tracks equity: value climbs, principal falls", () => {
    const s = simulate({ ...BASE, homes: [H()] });
    const at = (age) => s.rows.find((r) => r.age === age).equity;
    expect(at(29)).toBe(0);                       // not bought yet
    expect(at(31)).toBeGreaterThan(0);            // down payment plus a year of appreciation
    expect(at(45)).toBeGreaterThan(at(35));       // equity builds
    expect(at(65)).toBeGreaterThan(at(45));       // …and keeps building once the loan clears
  });

  it("selling pays the net proceeds into the taxable account", () => {
    const keep = simulate({ ...BASE, homes: [H()] });
    const sell = simulate({ ...BASE, homes: [H({ sellAge: 50 })] });
    const spendableAt = (s, age) => s.rows.find((r) => r.age === age).taxable;
    expect(spendableAt(sell, 51)).toBeGreaterThan(spendableAt(keep, 51));
    expect(sell.homes[0].saleNet).toBeGreaterThan(0);
  });

  it("stops charging carry and P&I once it is sold, and puts you back on rent", () => {
    const s = simulate({ ...BASE, rentAnnual: 30000, homes: [H({ sellAge: 40 })] });
    const t = (age) => s.trace.find((x) => x.age === age).housing;
    expect(t(39)).toBeGreaterThan(0);
    // after the sale the only housing cost is rent, which is far below carry + mortgage
    expect(t(41)).toBeLessThan(t(39));
    expect(t(41)).toBeGreaterThan(0);            // renting again, not living free
  });

  it("nets out the loan still outstanding, and selling costs", () => {
    const s = simulate({ ...BASE, homes: [H({ sellAge: 40, sellCostPct: 6 })] });
    const h = s.homes[0];
    expect(h.saleOwed).toBeGreaterThan(0);                       // mid-term, principal remains
    expect(h.saleNet).toBeCloseTo(h.saleValue * 0.94 - h.saleOwed, -1);
  });

  it("a bigger selling cost nets less", () => {
    const cheap = simulate({ ...BASE, homes: [H({ sellAge: 40, sellCostPct: 2 })] });
    const dear = simulate({ ...BASE, homes: [H({ sellAge: 40, sellCostPct: 10 })] });
    expect(dear.homes[0].saleNet).toBeLessThan(cheap.homes[0].saleNet);
  });

  it("can sell underwater without pretending it pays", () => {
    // sell one year in, at 10% costs, having put only 5% down: the loan outruns the net price
    const s = simulate({ ...BASE, homeGrowth: 0, homes: [H({ downPct: 0.05, sellAge: 31, sellCostPct: 10 })] });
    expect(s.homes[0].saleNet).toBeLessThan(0);
  });

  it("selling is what lets buying beat renting", () => {
    const rent = simulate({ ...BASE, homes: [], rentAnnual: 30000 });
    const keep = simulate({ ...BASE, homes: [H()], rentAnnual: 30000 });
    const sell = simulate({ ...BASE, homes: [H({ sellAge: 60 })], rentAnnual: 30000 });
    // holding a home is still costly on these inputs; realising the equity is what changes the answer
    expect(sell.fireCross).toBeLessThan(keep.fireCross);
    expect(rent.fireCross).toBeGreaterThan(0);
  });

  it("appreciation matters and zero growth is not a crash", () => {
    const flat = simulate({ ...BASE, homeGrowth: 0, homes: [H({ sellAge: 55 })] });
    const rising = simulate({ ...BASE, homeGrowth: 0.05, homes: [H({ sellAge: 55 })] });
    expect(rising.homes[0].saleNet).toBeGreaterThan(flat.homes[0].saleNet);
    expect(flat.rows.every((r) => Number.isFinite(r.equity))).toBe(true);
  });

  it("a sale age at or before purchase is ignored, not honoured", () => {
    const bad = simulate({ ...BASE, homes: [H({ sellAge: 29 })] });   // before the purchase at 30
    const none = simulate({ ...BASE, homes: [H()] });
    expect(bad.fireCross).toBe(none.fireCross);
    expect(bad.homes[0].sellAge).toBeNull();
  });

  it("no sale age leaves every figure exactly as before", () => {
    const a = simulate({ ...BASE, homes: [H()] });
    const b = simulate({ ...BASE, homes: [H({ sellAge: null, sellCostPct: 6 })] });
    expect(a.fireCross).toBe(b.fireCross);
    expect(a.fireCrossValue).toBe(b.fireCrossValue);
  });

  it("still lands the horizon on zero with a sale in the middle of retirement", () => {
    const s = simulate({ ...BASE, rothLadder: true, enforceAccess: false, homes: [H({ sellAge: 62 })] });
    expect(Math.abs(s.end)).toBeLessThan(5);
  });

  it("gives the retirement-instant row every field the yearly rows carry", () => {
    // that row is built by hand, so a new row field can be present for 70 ages and undefined for one
    const s = simulate({ ...DEFAULTS, homes: [{ price: 600000, purchaseAge: 30, downPct: 0.2, rate: 0.06,
      term: 30, closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013 }] });
    const whole = s.rows.find((r) => Number.isInteger(r.age));
    for (const r of s.rows) {
      expect(Object.keys(r).sort(), `age ${r.age}`).toEqual(Object.keys(whole).sort());
    }
  });

  it("an earlier sale retires you earlier, and one past the unlock changes nothing", () => {
    // THE BUG this pins: the bridge was a plain present value, so a sale scheduled before 59.5 netted
    // against the spending it had to precede. The model retired you years early, ran the cash account
    // underwater waiting for the proceeds, and (borrowing off) reported "you never retire" for a plan
    // a later date funds comfortably. The bridge now funds the WORST MOMENT of the window.
    const at = (sellAge) => simulate({ ...DEFAULTS, homes: DEFAULTS.homes.map((h) => ({ ...h, sellAge })) });
    const s50 = at(50), s55 = at(55), s60 = at(60), keep = at(null);
    for (const s of [s50, s55, s60, keep]) {
      expect(s.fireCross).not.toBeNull();
      expect(s.illiquidAge).toBeNull();
    }
    expect(s50.fireCross).toBeLessThan(s55.fireCross);
    expect(s55.fireCross).toBeLessThan(s60.fireCross);
    // a sale after the 59.5 wall cannot shorten a bridge that is already over
    expect(s60.fireCross).toBeCloseTo(keep.fireCross, 6);
    // …but it still lowers the total requirement, because the money is real
    expect(s60.rows[0].required).toBeLessThan(keep.rows[0].required);
  });

  it("a mid-bridge windfall cannot fund the years before it arrives", () => {
    // same defect, reachable without a home: a large inheritance late in the bridge used to reduce the
    // taxable requirement below what was needed to reach it
    const base = { ...DEFAULTS, partnerEnabled: false, homes: [], kids: [], currentAge: 35,
                   annualTakeHome: 160000, nonHousingLiving: 45000, retirementSpendToday: 70000,
                   startPortfolio: 900000, startPortfolioTaxAdv: 600000, startCash: 20000, rentAnnual: 24000 };
    const s = simulate({ ...base, expenses: [{ label: "inheritance", age: 57, amount: -800000, until: null }] });
    expect(s.fireCross == null || s.illiquidAge == null).toBe(true);
  });

  it("equity is never counted as spendable portfolio", () => {
    const s = simulate({ ...BASE, homes: [H()] });
    const r = s.rows.find((x) => x.age === 45);
    expect(r.equity).toBeGreaterThan(0);
    expect(r.portfolio).toBeCloseTo(r.taxable + r.retirement, -1);   // the house is not in the pot
  });
});

describe("expenses can be dated from retirement instead of from an age", () => {
  // The model SOLVES for the retirement instant, so "the first ten years of retirement" is not
  // expressible as a fixed age until you already know the answer. The schedule depends on the date
  // and the date depends on the schedule; simulate() resolves it by iteration.
  const BASE = { ...DEFAULTS, partnerEnabled: false, homes: [], kids: [], currentAge: 35,
                 annualTakeHome: 150000, nonHousingLiving: 45000, retirementSpendToday: 60000,
                 startPortfolio: 700000, startPortfolioTaxAdv: 200000, startCash: 30000, rentAnnual: 24000 };
  const rel = (o) => ({ label: "travel", amount: 25000, anchor: "retirement", age: 0, until: 9, ...o });

  it("lands the expense on the date it solves for, not on a guess", () => {
    const s = simulate({ ...BASE, expenses: [rel()] });
    expect(s.fireCross).not.toBeNull();
    const at = Math.round(s.fireCross);
    // the marker the chart draws sits at the resolved age
    expect(s.expenseMarks[0].age).toBe(at);
    // …and the money is actually charged across the window
    const inWindow = s.trace.filter((t) => t.age >= at && t.age <= at + 9);
    expect(inWindow.every((t) => t.lumps > 0)).toBe(true);
    const after = s.trace.find((t) => t.age === at + 11);
    expect(after.lumps).toBe(0);
  });

  it("costs money — a retirement-dated expense pushes the date out", () => {
    const without = simulate({ ...BASE });
    const with_ = simulate({ ...BASE, expenses: [rel()] });
    expect(with_.fireCross).toBeGreaterThan(without.fireCross);
  });

  it("settles on a fixed point: the window really does start at the answer", () => {
    const s = simulate({ ...BASE, expenses: [rel({ amount: 40000, until: 14 })] });
    const at = s.fireCross;
    // re-running with the answer already known must not move it again
    const again = simulate({ ...BASE, expenses: [rel({ amount: 40000, until: 14 })] });
    expect(again.fireCross).toBeCloseTo(at, 6);
  });

  it("negative offsets put money before the date", () => {
    const s = simulate({ ...BASE, expenses: [rel({ label: "sabbatical", age: -3, until: -1 })] });
    const at = Math.round(s.fireCross);
    expect(s.trace.find((t) => t.age === at - 2).lumps).toBeGreaterThan(0);
  });

  it("a windfall dated from retirement brings the date in", () => {
    const s = simulate({ ...BASE, expenses: [rel({ label: "inheritance", amount: -200000, age: 2, until: null })] });
    const plain = simulate({ ...BASE });
    expect(s.fireCross).toBeLessThan(plain.fireCross);
  });

  it("is inert when the household never retires", () => {
    const broke = { ...BASE, startPortfolio: 0, startCash: 0, annualTakeHome: 20000,
                    retirementSpendToday: 200000 };
    const s = simulate({ ...broke, expenses: [rel()] });
    expect(s.fireCross).toBeNull();
    expect(s.expenseMarks).toEqual([]);      // nothing to anchor to ⇒ nothing to draw
  });

  it("leaves absolute-age expenses exactly as they were", () => {
    const abs = [{ label: "roof", amount: 30000, age: 50, until: null }];
    const a = simulate({ ...BASE, expenses: abs });
    const b = simulate({ ...BASE, expenses: abs });
    expect(a.fireCross).toBe(b.fireCross);
    expect(a.expenseMarks[0].age).toBe(50);
  });

  it("runs the model once when nothing is retirement-dated", () => {
    // the iteration is opt-in: a plan with no relative expense must not pay for the fixed point
    const plain = simulate({ ...BASE, expenses: [{ label: "car", amount: 30000, age: 45, until: null }] });
    expect(plain.fireCross).not.toBeNull();
  });
});

describe("backtesting replays the plan against real sequences", () => {
  it("keeps the plan's date and only varies the returns", () => {
    const plan = simulate(DEFAULTS);
    const mc = runTrials(DEFAULTS, { mode: "historical", stockPct: 80 });
    expect(mc.fireCross).toBe(plan.fireCross);
    expect(mc.trials).toBeGreaterThan(0);
    expect(mc.successRate).toBeGreaterThanOrEqual(0);
    expect(mc.successRate).toBeLessThanOrEqual(1);
  });

  it("is deterministic — the same plan gives the same answer twice", () => {
    // a success rate that flickers between identical runs reads as noise, not as a result
    const a = runTrials(DEFAULTS, { mode: "bootstrap", trials: 40, seed: 7 });
    const b = runTrials(DEFAULTS, { mode: "bootstrap", trials: 40, seed: 7 });
    expect(a.successRate).toBe(b.successRate);
    expect(a.median).toBe(b.median);
    expect(runTrials(DEFAULTS, { mode: "bootstrap", trials: 40, seed: 8 }).successRate)
      .not.toBe(undefined);
  });

  it("reports how few independent windows a long horizon leaves", () => {
    const mc = runTrials(DEFAULTS, { mode: "historical" });
    expect(mc.cycleYears).toBeGreaterThan(60);
    expect(mc.trials).toBeLessThan(40);          // ~a century of data, minus a 70+ year window
    expect(mc.dataFrom).toBeLessThan(mc.dataTo);
  });

  it("surfaces the gap between the assumed return and the sampled one", () => {
    // without this the terminal figures look broken rather than conservative
    const mc = runTrials(DEFAULTS, { mode: "historical", stockPct: 80 });
    expect(mc.assumedReal).toBeCloseTo((1 + DEFAULTS.nominalReturn) / (1 + DEFAULTS.inflation) - 1, 6);
    expect(Number.isFinite(mc.sampledReal)).toBe(true);
  });

  it("a bond-heavy mix survives less often than a stock-heavy one over a long horizon", () => {
    const stocks = runTrials(DEFAULTS, { mode: "historical", stockPct: 100 });
    const bonds = runTrials(DEFAULTS, { mode: "historical", stockPct: 0 });
    expect(bonds.median).toBeLessThan(stocks.median);
  });

  it("returns percentile bands over the whole path", () => {
    const mc = runTrials(DEFAULTS, { mode: "historical" });
    expect(mc.bands.length).toBeGreaterThan(10);
    for (const b of mc.bands) {
      expect(b.p10).toBeLessThanOrEqual(b.p50);
      expect(b.p50).toBeLessThanOrEqual(b.p90);
    }
  });

  it("counts a plan that could only continue by borrowing as a failure", () => {
    const mc = runTrials(DEFAULTS, { mode: "bootstrap", trials: 60, stockPct: 100, seed: 3 });
    expect(mc.failures.length + Math.round(mc.successRate * mc.trials)).toBe(mc.trials);
  });

  it("gives nothing back for a plan that never retires", () => {
    const broke = { ...DEFAULTS, startPortfolio: 0, startCash: 0, annualTakeHome: 10000,
                    retirementSpendToday: 300000 };
    expect(runTrials(broke)).toBeNull();
  });

  it("leaves the ordinary simulate() untouched", () => {
    // the replay hooks are opt-in via __returns / __fixedRetireAt; without them nothing changes
    const a = simulate(DEFAULTS);
    runTrials(DEFAULTS, { mode: "historical" });
    const b = simulate(DEFAULTS);
    expect(a.fireCross).toBe(b.fireCross);
    expect(a.end).toBe(b.end);
  });
});

describe("the Sankey balances, because the trace does", () => {
  const yearOf = (s, age) => sankeyYear(s.trace.find((t) => t.age === age));

  it("sums to the same total on both sides, every year", () => {
    const s = simulate(DEFAULTS);
    for (const t of s.trace) {
      const d = sankeyYear(t);
      const sum = (l) => l.reduce((a, n) => a + n.value, 0);
      expect(Math.abs(sum(d.sources) - sum(d.sinks)), `age ${t.age}`).toBeLessThan(2);
    }
  });

  it("shows salary while working and a drawdown after", () => {
    const s = simulate(DEFAULTS);
    const at = Math.floor(s.fireCross);
    const working = yearOf(s, at - 3), retired = yearOf(s, at + 3);
    expect(working.sources.some((n) => n.key === "pay")).toBe(true);
    expect(retired.sources.some((n) => n.key === "pay")).toBe(false);
    expect(retired.sources.some((n) => n.key === "cashBal" || n.key === "advBal")).toBe(true);
  });

  it("puts the locked account's growth on the diagram while it is sealed", () => {
    // the year the pot climbs while you spend is the one people report as a bug
    const s = simulate(DEFAULTS);
    const at = Math.floor(s.fireCross) + 4;
    const d = yearOf(s, at);
    expect(d.locked).toBe(true);
    expect(d.sources.some((n) => n.isGrowth)).toBe(true);
  });

  it("gives a borrowing year its own coral band rather than silently not adding up", () => {
    const loan = { ...DEFAULTS, partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0,
                   partnerPortfolio: 0, partnerPortfolioTaxAdv: 0, partnerCash: 0, allowBorrowing: true };
    const s = simulate(loan);
    expect(s.illiquidAge).not.toBeNull();
    const d = yearOf(s, s.illiquidAge + 1);
    const sum = (l) => l.reduce((a, n) => a + n.value, 0);
    expect(Math.abs(sum(d.sources) - sum(d.sinks))).toBeLessThan(2);
  });

  it("scales absolutely, so the year you retire is visibly smaller", () => {
    const s = simulate(DEFAULTS);
    const at = Math.floor(s.fireCross);
    expect(yearOf(s, at + 5).total).toBeLessThan(yearOf(s, at - 5).total);
  });

  it("is a pure lookup — no re-simulation to scrub", () => {
    const s = simulate(DEFAULTS);
    expect(sankeyYear(s.trace[0]).age).toBe(s.trace[0].age);
    expect(sankeyYear(null)).toBeNull();
  });
});
