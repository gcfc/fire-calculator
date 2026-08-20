// Annual US market history, bundled rather than fetched.
//
// WHY BUNDLED: the whole app is one self-contained HTML file with no backend, no account and no
// network calls — that is a real differentiator against every paid planner, and it would be silly to
// give it up for 150 rows of numbers. Annual (not monthly) because the model steps a year at a time;
// monthly data would be precision the simulation cannot use.
//
// SOURCE: Robert Shiller's series behind *Irrational Exuberance*, which is what FI Calc, cFIREsim and
// most of the field use — S&P composite total return, 10-year US Treasury total return, and CPI, all
// annual, from 1928. Shiller's data reaches back to 1871; this starts at 1928 because that is where
// the Treasury series becomes a real total return rather than a yield proxy, and it keeps 1929, 1966
// and 2000 — the three sequences early retirement actually dies from.
//
// HONEST CAVEATS, which the UI repeats:
//   • Index funds did not exist before 1972, so pre-1972 equity returns were not actually attainable
//     at these costs. FI Calc flags the same thing.
//   • These are US returns over the century in which the US won. Survivorship bias is real and this
//     dataset cannot see it.
//   • No fees, no taxes, no tracking error.
//
// Each row: [year, stock total return, 10y treasury total return, inflation], as decimal fractions.
export const HISTORY = [
  [1928, 0.4381, 0.0084, -0.0117], [1929, -0.0830, 0.0420, 0.0000], [1930, -0.2512, 0.0454, -0.0267],
  [1931, -0.4384, -0.0256, -0.0893], [1932, -0.0864, 0.0879, -0.1027], [1933, 0.4998, 0.0186, 0.0076],
  [1934, -0.0119, 0.0796, 0.0152], [1935, 0.4674, 0.0447, 0.0299], [1936, 0.3194, 0.0502, 0.0145],
  [1937, -0.3534, 0.0138, 0.0286], [1938, 0.2928, 0.0421, -0.0278], [1939, -0.0110, 0.0441, 0.0000],
  [1940, -0.1067, 0.0540, 0.0071], [1941, -0.1277, -0.0202, 0.0993], [1942, 0.1917, 0.0229, 0.0903],
  [1943, 0.2506, 0.0249, 0.0296], [1944, 0.1903, 0.0258, 0.0230], [1945, 0.3582, 0.0380, 0.0225],
  [1946, -0.0843, 0.0313, 0.1817], [1947, 0.0520, 0.0092, 0.0901], [1948, 0.0570, 0.0195, 0.0271],
  [1949, 0.1830, 0.0466, -0.0180], [1950, 0.3081, 0.0043, 0.0579], [1951, 0.2368, -0.0030, 0.0587],
  [1952, 0.1815, 0.0227, 0.0088], [1953, -0.0121, 0.0414, 0.0062], [1954, 0.5256, 0.0329, -0.0050],
  [1955, 0.3260, -0.0134, 0.0037], [1956, 0.0744, -0.0226, 0.0286], [1957, -0.1046, 0.0680, 0.0302],
  [1958, 0.4372, -0.0210, 0.0176], [1959, 0.1206, -0.0265, 0.0150], [1960, 0.0034, 0.1164, 0.0148],
  [1961, 0.2664, 0.0206, 0.0067], [1962, -0.0881, 0.0569, 0.0122], [1963, 0.2261, 0.0168, 0.0165],
  [1964, 0.1642, 0.0373, 0.0119], [1965, 0.1240, 0.0072, 0.0192], [1966, -0.0997, 0.0291, 0.0335],
  [1967, 0.2380, -0.0158, 0.0304], [1968, 0.1081, 0.0327, 0.0472], [1969, -0.0824, -0.0501, 0.0611],
  [1970, 0.0356, 0.1675, 0.0549], [1971, 0.1422, 0.0979, 0.0336], [1972, 0.1876, 0.0282, 0.0341],
  [1973, -0.1431, 0.0366, 0.0880], [1974, -0.2590, 0.0199, 0.1220], [1975, 0.3700, 0.0361, 0.0701],
  [1976, 0.2383, 0.1576, 0.0481], [1977, -0.0698, 0.0028, 0.0677], [1978, 0.0651, -0.0078, 0.0903],
  [1979, 0.1852, 0.0067, 0.1329], [1980, 0.3174, -0.0299, 0.1252], [1981, -0.0470, 0.0820, 0.0892],
  [1982, 0.2042, 0.3281, 0.0383], [1983, 0.2234, 0.0320, 0.0379], [1984, 0.0615, 0.1373, 0.0395],
  [1985, 0.3124, 0.2571, 0.0377], [1986, 0.1849, 0.2428, 0.0113], [1987, 0.0581, -0.0496, 0.0441],
  [1988, 0.1654, 0.0822, 0.0442], [1989, 0.3148, 0.1769, 0.0465], [1990, -0.0306, 0.0624, 0.0611],
  [1991, 0.3023, 0.1500, 0.0306], [1992, 0.0749, 0.0936, 0.0290], [1993, 0.0997, 0.1421, 0.0275],
  [1994, 0.0133, -0.0804, 0.0267], [1995, 0.3720, 0.2348, 0.0254], [1996, 0.2268, 0.0143, 0.0332],
  [1997, 0.3310, 0.0994, 0.0170], [1998, 0.2834, 0.1492, 0.0161], [1999, 0.2089, -0.0825, 0.0268],
  [2000, -0.0903, 0.1666, 0.0339], [2001, -0.1185, 0.0557, 0.0155], [2002, -0.2197, 0.1512, 0.0238],
  [2003, 0.2836, 0.0038, 0.0188], [2004, 0.1074, 0.0449, 0.0326], [2005, 0.0483, 0.0287, 0.0342],
  [2006, 0.1561, 0.0196, 0.0254], [2007, 0.0548, 0.1021, 0.0408], [2008, -0.3655, 0.2010, 0.0009],
  [2009, 0.2594, -0.1112, 0.0272], [2010, 0.1482, 0.0846, 0.0150], [2011, 0.0210, 0.1604, 0.0296],
  [2012, 0.1589, 0.0297, 0.0174], [2013, 0.3215, -0.0910, 0.0150], [2014, 0.1352, 0.1075, 0.0076],
  [2015, 0.0138, 0.0128, 0.0073], [2016, 0.1177, 0.0069, 0.0207], [2017, 0.2161, 0.0280, 0.0211],
  [2018, -0.0423, -0.0002, 0.0191], [2019, 0.3121, 0.0964, 0.0229], [2020, 0.1802, 0.1133, 0.0136],
  [2021, 0.2847, -0.0442, 0.0704], [2022, -0.1811, -0.1751, 0.0645], [2023, 0.2629, 0.0339, 0.0335],
  [2024, 0.2502, -0.0170, 0.0289],
];

export const HISTORY_FIRST = HISTORY[0][0];
export const HISTORY_LAST = HISTORY[HISTORY.length - 1][0];

// A blended nominal return for a given stock weight, plus that year's inflation. Rebalanced annually,
// which is what a single blended figure implicitly assumes.
export const blendedReturn = (row, stockPct) => {
  const w = Math.max(0, Math.min(100, stockPct)) / 100;
  return row[1] * w + row[2] * (1 - w);
};

// ---- sequence generators ---------------------------------------------------
// Two ways to ask "what would have happened", and they answer different questions.

// HISTORICAL CYCLES: replay each contiguous run of years, in the order they actually occurred. This
// preserves the autocorrelation and mean reversion that early retirement lives or dies on — 1929
// followed by 1930, not 1929 followed by a coin flip. The cost is few independent samples: about a
// century of data yields only ~100 overlapping cycles, and they share most of their years.
export const historicalCycles = (years, stockPct) => {
  const out = [];
  for (let start = 0; start + years <= HISTORY.length; start++) {
    const seq = [];
    for (let i = 0; i < years; i++) {
      const row = HISTORY[start + i];
      seq.push({ ret: blendedReturn(row, stockPct), infl: row[3] });
    }
    out.push({ label: String(HISTORY[start][0]), seq });
  }
  return out;
};

// RANDOM START: begin at a random year and run forward in real chronological order, wrapping past
// the end of the record back to the start. This is the direct fix for the weakness in the method
// above: a 76-year plan leaves only ~20 complete windows in a century of data, and neighbouring
// windows share all but one year, so "95% survived" rests on almost no independent evidence. Wrapping
// buys many more distinct sequences while keeping every year followed by the year that actually
// followed it — 1929 is still followed by 1930.
//
// The seam is the honest cost: one junction per trial where 2024 is followed by 1928. That is one
// artificial transition in ~76 real ones, against a bootstrap's one every `blockYears`.
export const randomStart = (years, stockPct, trials, rand) => {
  const out = [];
  for (let t = 0; t < trials; t++) {
    const start = Math.floor(rand() * HISTORY.length);
    const seq = [];
    for (let i = 0; i < years; i++) {
      const row = HISTORY[(start + i) % HISTORY.length];
      seq.push({ ret: blendedReturn(row, stockPct), infl: row[3] });
    }
    out.push({ label: `from ${HISTORY[start][0]}`, seq });
  }
  return out;
};

// BLOCK BOOTSTRAP: sample contiguous blocks of years at random and stitch them together. Unlimited
// samples, and because the blocks are contiguous it keeps some of the sequence structure that plain
// draw-a-year-at-a-time destroys. Drawing years independently would understate exactly the risk this
// feature exists to show — a bad decade, not a bad year.
export const blockBootstrap = (years, stockPct, trials, blockYears, rand) => {
  const out = [];
  for (let t = 0; t < trials; t++) {
    const seq = [];
    while (seq.length < years) {
      const start = Math.floor(rand() * HISTORY.length);
      for (let i = 0; i < blockYears && seq.length < years; i++) {
        const row = HISTORY[(start + i) % HISTORY.length];      // wrap rather than truncate
        seq.push({ ret: blendedReturn(row, stockPct), infl: row[3] });
      }
    }
    out.push({ label: `trial ${t + 1}`, seq });
  }
  return out;
};

// A small seeded PRNG (mulberry32), so a given plan always produces the same trials. A success rate
// that flickers on every keystroke reads as noise rather than as a result.
export const seededRandom = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---- mortality ---------------------------------------------------------------
// Annual probability of death, qx, by exact age. Shaped from the SSA Actuarial Life Table (the
// period table at ssa.gov/oact/STATS/table4c6.html), which is a US government work and so public
// domain — the same reason the market data above is bundled rather than fetched.
//
// THREE CAVEATS THE UI REPEATS, because each one moves the answer by more than the arithmetic does:
//
//  1. PERIOD, NOT COHORT. This freezes today's age-specific rates forever and ignores future
//     improvement, so it understates how long someone currently in their twenties will live.
//  2. GENERAL POPULATION. A FIRE audience skews high-income, high-education and non-smoking, all of
//     which carry materially lower mortality. Insurers use annuitant tables (SOA 2012 IAM) for
//     exactly this reason; those show longer lives still.
//  3. UNISEX BLEND. The app asks for no demographics at all and this keeps it that way. The male /
//     female spread is around two to three years — smaller than either bias above.
//
// Values are a blended male/female qx at five-year anchors, interpolated between.
const QX_ANCHORS = [
  [20, 0.00085], [25, 0.00105], [30, 0.00125], [35, 0.00160], [40, 0.00215],
  [45, 0.00310], [50, 0.00460], [55, 0.00680], [60, 0.00990], [65, 0.01430],
  [70, 0.02180], [75, 0.03500], [80, 0.05800], [85, 0.09600], [90, 0.15600],
  [95, 0.23500], [100, 0.33000], [105, 0.42000], [110, 0.50000], [115, 0.60000], [120, 1.0],
];

export const qxAt = (age) => {
  if (age <= QX_ANCHORS[0][0]) return QX_ANCHORS[0][1];
  for (let i = 1; i < QX_ANCHORS.length; i++) {
    const [a1, q1] = QX_ANCHORS[i], [a0, q0] = QX_ANCHORS[i - 1];
    if (age <= a1) return q0 + (q1 - q0) * ((age - a0) / (a1 - a0));
  }
  return 1;
};

// Probability of surviving from `from` to each age up to `to`, as { age -> p }. Conditional on being
// alive at `from`, which is the only useful framing for someone using this: you have already made it
// this far, so the risk you care about starts now.
export const survivalCurve = (from, to) => {
  const out = {};
  let p = 1;
  for (let age = Math.floor(from); age <= to; age++) {
    out[age] = p;
    p *= 1 - qxAt(age);
  }
  return out;
};

// For a couple: the probability that AT LEAST ONE is still alive. This is the horizon the model
// already plans to — money must outlive the last survivor — so it is the curve that belongs beside
// the plan, with the single-life curve for contrast.
export const lastSurvivorCurve = (yourFrom, partnerFrom, to, partnerOffset) => {
  const you = survivalCurve(yourFrom, to);
  const out = {};
  for (let age = Math.floor(yourFrom); age <= to; age++) {
    const sYou = you[age] ?? 0;
    if (partnerFrom == null) { out[age] = sYou; continue; }
    // the partner is on their own clock; their age when you are `age`
    const theirAge = age - partnerOffset;
    const theirs = survivalCurve(partnerFrom, to + Math.abs(partnerOffset) + 1)[Math.floor(theirAge)] ?? 0;
    out[age] = 1 - (1 - sYou) * (1 - theirs);
  }
  return out;
};

// The age by which survival has fallen to `p` — "half of people are gone by here".
//
// Returns null when the curve never gets that low. This used to return the curve's last age instead,
// which was a silent lie the moment a curve was cut short: a plan to 60 produced a survival curve
// ending at 60, still around 90%, and the panel reported "half of people are gone by 60". Callers
// that want a real answer should hand in a curve run to the end of the table, not to the horizon.
export const survivalPercentileAge = (curve, p) => {
  const ages = Object.keys(curve).map(Number).sort((a, b) => a - b);
  for (const a of ages) if (curve[a] <= p) return a;
  return null;
};

// The last age the life table has anything to say about. Medians are computed against a curve run
// this far no matter where the PLAN stops, because "half of people are gone by 84" is a fact about
// the table and has nothing to do with where someone chose to end their projection.
export const TABLE_END = 120;
