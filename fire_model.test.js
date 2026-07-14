import { describe, it, expect } from "vitest";
import { simulate, DEFAULTS } from "./fire_model.jsx";

// Every test below pins a bug that was actually found, or an invariant the model must not break.
// The comments say WHICH — a failing test here should tell you what regressed, not just that
// something did.

const run = (over = {}) => simulate({ ...DEFAULTS, ...over });
const HOME = (o = {}) => ({
  price: 1500000, purchaseAge: 31, downPct: 0.20, rate: 0.065, term: 30,
  closingPct: 0.02, propTaxRate: 0.011, insMaintRate: 0.013, ...o,
});

// sweep an input finely and hand back the per-step jumps in whatever you measure
const sweep = (key, from, to, step, pick) => {
  const jumps = [];
  let prev = null;
  for (let v = from; v <= to; v += step) {
    const cur = pick(run({ [key]: v }));
    if (prev !== null) jumps.push(Math.abs(cur - prev));
    prev = cur;
  }
  return { max: Math.max(...jumps), jumps };
};

describe("continuity — the terminal-value sawtooth must never come back", () => {
  // THE BUG: retirement snapped to Math.ceil(fireCross), so nudging income up grew the surplus
  // smoothly and then collapsed it to ~0 the moment the ceiling tipped a whole year earlier.
  // Terminal value swung $3.92M -> $0.30M between two adjacent inputs.
  it("leaves exactly zero at the horizon when total wealth is what binds", () => {
    for (let th = 140000; th <= 175000; th += 500) {
      expect(Math.abs(run({ annualTakeHome: th }).end)).toBeLessThan(1);
    }
  });

  it("never jumps the terminal value across a fine sweep of take-home", () => {
    expect(sweep("annualTakeHome", 140000, 175000, 250, (s) => s.end).max).toBeLessThan(1);
  });

  it("moves the retirement age continuously in take-home", () => {
    expect(sweep("annualTakeHome", 140000, 175000, 250, (s) => s.fireCross).max).toBeLessThan(0.02);
  });

  it("moves the retirement age continuously in partner income", () => {
    expect(sweep("partnerIncome", 100000, 140000, 250, (s) => s.fireCross).max).toBeLessThan(0.02);
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
    // same life, started 5 years later: years-to-retirement must be identical
    const a = run({ partnerStart: 26, partnerEnd: 65 });
    const b = run({
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
    // single earner, fat budget -> retirement lands past the statutory age, so there is nothing
    // to bridge: every dollar is already reachable on the day you stop working
    const late = run({
      retirementSpendToday: 150000,
      partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0,
    });
    expect(late.fireCross).toBeGreaterThan(59.5);
    expect(late.fireBridge).toBe(0);
  });

  it("strands you when everything is locked in a 401k", () => {
    // all savings tax-advantaged + hard gate -> you cannot fund an early retirement
    const s = run({ rothLadder: false, startPortfolioTaxAdv: 400000, annualTaxAdv: 80000, annualTakeHome: 104000 });
    expect(s.fireCross).toBeGreaterThan(run().fireCross);
  });

  it("makes the ladder inert when retirement already lands past 59.5", () => {
    // a ladder opens at T+5, but never later than 59.5 — so past that age it changes nothing
    const spend = { retirementSpendToday: 200000 };
    expect(simulate({ ...DEFAULTS, ...spend, rothLadder: true }).fireCross)
      .toBeCloseTo(simulate({ ...DEFAULTS, ...spend, rothLadder: false }).fireCross, 6);
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
    const short = run({ endAge: 85 });
    const long = run({ endAge: 110 });
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
        .toBeGreaterThanOrEqual(run({ use529: false }).fireCross - 1e-6);
    }
  });
});

describe("core invariants (must hold for every scenario)", () => {
  const scenarios = {
    default: {},
    single: { partnerAge: 0, partnerIncome: 0, partnerTaxAdv: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0 },
    "no kids, no home": { kids: [], homes: [] },
    "three homes": { homes: [HOME(), HOME({ price: 700000, purchaseAge: 40 }), HOME({ price: 500000, purchaseAge: 45 })] },
    "hard gate": { rothLadder: false, startPortfolioTaxAdv: 250000 },
    "gate off": { enforceAccess: false },
    "long horizon": { endAge: 115 },
    "lean spend": { retirementSpendToday: 40000 },
    "fat spend": { retirementSpendToday: 160000 },
    "four kids": { kids: [30, 32, 34, 36].map((birthAge) => ({ birthAge })) },
  };

  for (const [name, over] of Object.entries(scenarios)) {
    describe(name, () => {
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

      if (over.retirementSpendToday !== 160000) {
        it("clears BOTH bars at retirement", () => {
          expect(s.fireCross).not.toBeNull();
          expect(s.fireCrossValue).toBeGreaterThanOrEqual(s.fireReq - 1);
          expect(s.fireTaxable).toBeGreaterThanOrEqual(s.fireBridge - 1);
        });
      }
    });
  }
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
