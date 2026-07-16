import { describe, it, expect } from "vitest";
import {
  simulate, DEFAULTS,
  encodeShare, decodeShare, sharePayload, snapshotFromSim, rehydrateRows, underwaterOf,
  allocationAdvice,
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
    // same life, started 5 years later: years-to-retirement must be identical.
    // both sides pin the home explicitly — otherwise `a` would take its home from DEFAULTS and
    // `b` from HOME(), and the two worlds would not be the same life at all
    const a = run({ homes: [HOME()], partnerStart: 26, partnerEnd: 65 });
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

  it("ignores the partner's portfolio entirely once there is no partner", () => {
    // a lone earner must not keep a phantom account: dropping the partner (age 0) has to zero out
    // their portfolio the same way it already zeroes their income and their 59.5 unlock.
    const single = run({ partnerAge: 0, partnerPortfolio: 250000, partnerPortfolioTaxAdv: 100000 });
    const explicitZero = run({ partnerAge: 0, partnerPortfolio: 0, partnerPortfolioTaxAdv: 0 });
    expect(single.rows[0].portfolio).toBe(explicitZero.rows[0].portfolio);
    expect(single.rows[0].portfolio).toBe(DEFAULTS.startPortfolio);   // only YOUR money is left
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
    // single earner, fat budget -> retirement lands past the statutory age, so there is nothing
    // to bridge: every dollar is already reachable on the day you stop working
    const late = run({ ...SINGLE, homes: [], retirementSpendToday: 300000 });
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

  it("lets an unlocked 401k cover a cash shortfall while still working (past 59.5)", () => {
    // a lone earner carrying a big house runs the taxable account underwater for years. Before this
    // rule the shortfall compounded forever and retirement never came; now, once the 401k unlocks at
    // 59.5, the shortfall is paid from it — so retirement lands past the statutory age, pot to zero.
    const s = run({ ...SINGLE });
    expect(s.fireCross).toBeGreaterThan(59.5);
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
    // a lone earner carrying the house runs the cash account underwater for years, but once the
    // 401k unlocks at 59.5 it covers the shortfall — so retirement lands late rather than never
    "single earner carrying the house": { ...SINGLE },
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
    expect(startingTotal(silly)).toBe(400000 + DEFAULTS.partnerPortfolio);
  });

  it("does the same for the partner", () => {
    const silly = run({ partnerPortfolio: 150000, partnerPortfolioTaxAdv: 900000 });
    expect(startingTotal(silly)).toBe(DEFAULTS.startPortfolio + 150000);
  });

  it("treats an over-large figure as 'all locked, nothing taxable'", () => {
    const s = run({
      startPortfolio: 400000, startPortfolioTaxAdv: 900000,
      partnerPortfolio: 150000, partnerPortfolioTaxAdv: 900000,
    });
    expect(s.rows[0].taxable).toBe(0);
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
  const defaultShow = () => ({
    portfolio: true, required: true, retire: true, coast: true, taxable: false,
    retirement: true, bridge: false, underwater: true, access: true, home: true, kids: true,
  });

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
    const p = { ...DEFAULTS, ...SINGLE, homes: [], retirementSpendToday: 300000 };
    expect(simulate(p).fireCross).toBeGreaterThan(59.5);
    expect(allocationAdvice(p)).toBeNull();
  });

  it("flags spare liquidity when you retire early with taxable to burn", () => {
    // the default household retires well before 59.5 with far more liquid than the bridge needs
    const a = allocationAdvice({ ...DEFAULTS });
    expect(a?.dir).toBe("toTaxAdv");
    expect(a.slack).toBeGreaterThan(2 * DEFAULTS.retirementSpendToday);
  });
});
