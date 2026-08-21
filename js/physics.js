"use strict";

// ---------- shared state ----------
const state = {
  // Overwritten at init from the N slider's own value, which is the single
  // source of truth for the startup configuration - a literal here would be
  // free to drift out of step with the markup without anything noticing.
  N: 0,
  p: 1.0,
  seed: 1,
  speed: 1.0,
  metric: "euclidean", // "euclidean" | "spherical"
  edgesVisible: "hide",  // "hide" | "show" - master on/off for the edge layer, mirroring facesVisible
  // "chords" | "arcs" - how both edges *and* faces are drawn, independent of
  // `metric` and of either layer's visibility: straight chords with flat
  // polygon faces (the polytope reading) versus great-circle arcs with
  // spherical patch faces (the tiling reading). Split out of the old
  // three-way edgeStyle, which conflated this with edge visibility and left
  // faces silently following the edge control even with edges off.
  shapeStyle: "chords",
  playing: false,
  points: [],      // array of [x,y,z]
  step: 0,
  energy: 0,
  maxForce: 0,
  viewMatrix: matMultiply(rotationY(0.5), rotationX(-0.3)), // initial orientation, matches old rotX=-0.3/rotY=0.5
  zoom: 1.0, // origin-centered scale multiplier, no translation
  // Fraction of light the ball absorbs across one full diameter: 0 (fully
  // transparent - front and back equally clear) .. 1 (fully opaque - the
  // whole rear hemisphere blocked). Also drives a non-physical aerial fade
  // over the front hemisphere - see geometry.js's depthWithOpacity. Also
  // overwritten at init, from the slider.
  sphereOpacity: 0.65,
  _stepAccum: 0, // fractional physics-steps-per-frame carried by the speed slider
  _energyHistory: [],
  highlightedDegrees: new Set(), // degree values currently ring-highlighted on the canvas
  hiddenDegrees: new Set(),      // degree values currently hidden from rendering (display-only, doesn't touch the simulation)
  facesVisible: "hide",          // "hide" | "show" - master on/off for the whole face layer (left panel); "hide" by default so the generic triangle soup stays invisible until opted into
  hiddenFaceSides: new Set(),    // side-counts explicitly hidden via the right panel's per-side-count toggle - independent of, and persists across, the master switch above
};

// ---------- p slider domain ----------
// A pseudo-logarithmic scale: fine steps where the small-N phase transitions
// live (Schwartz's N=5 transition is at p~15, well inside the 0.5-step
// band), coarsening as p grows, then a geometric tail out to 1000. The tail
// used to stop at 25 because summing raw d^-p terms lost all conditioning
// past there (maxForce stalled around 1e+3 and never converged); the
// log-domain reformulation below removed that ceiling, so what limits the
// range now is only that the p -> Infinity limit becomes numerically
// indistinguishable long before 1000 - the softmin's error decays like
// log(pairs)/p, so p=1000 is already within ~1% of the Tammes optimum for
// N in the hundreds. Built by index rather than repeated float addition to
// avoid step-accumulation drift (e.g. a naive 0.1+0.1+0.1 landing on
// 1.7000000000000002).
function buildPValues() {
  const vals = [];
  const pushRange = (from, to, step) => {
    const n = Math.round((to - from) / step);
    for (let i = 0; i <= n; i++) vals.push(Math.round((from + i * step) * 100) / 100);
  };
  pushRange(0, 2, 0.1);     // 21 values: the original slider's range/step
  pushRange(2.2, 6, 0.2);   // 20 values
  pushRange(6.5, 16, 0.5);  // 20 values (covers the N=5 TBP->square-pyramid transition at p~15.05)
  pushRange(17, 25, 1);     // 9 values
  // Geometric tail. 64 is P_PHYSICAL_MAX, the last p whose *physical* force
  // is representable in double precision, so it gets its own stop rather
  // than being straddled.
  vals.push(30, 36, 44, 52, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000);
  vals.push(Infinity);      // the Tammes (max-min distance) limit - see TODO.md
  return vals; // 88 total
}
// The N slider's stops. Unit steps to 64, then the step doubles at each power
// of two - 2 to 128, 4 to 256, and so on to 1024. Almost everything worth
// looking at one point at a time (the magic numbers, the defect patterns, the
// N=5 degeneracy) lives below 64, whereas past a few hundred a single extra
// point is invisible, so a uniform slider would spend most of its travel on
// distinctions nobody can see. The exact-N input exists for the cases this
// misses.
function buildNValues() {
  const vals = [];
  for (let v = 1; v <= 64; v++) vals.push(v);
  for (let step = 2, top = 128; top <= 1024; step *= 2, top *= 2) {
    for (let v = vals[vals.length - 1] + step; v <= top; v += step) vals.push(v);
  }
  return vals; // 192 total
}
const N_VALUES = buildNValues();
const N_MAX = N_VALUES[N_VALUES.length - 1];

// Slider position for an arbitrary N, so the two controls can be kept in sync
// when the number input lands between stops.
function nearestNIndex(n) {
  let best = 0;
  for (let i = 1; i < N_VALUES.length; i++) {
    if (Math.abs(N_VALUES[i] - n) < Math.abs(N_VALUES[best] - n)) best = i;
  }
  return best;
}

const P_VALUES = buildPValues();
const P_DEFAULT_INDEX = P_VALUES.indexOf(1.0); // Coulomb/Newtonian law

function formatP(p) {
  if (p === Infinity) return "\u221e";
  if (Number.isInteger(p) && p >= 10) return String(p); // the geometric tail: "100", not "100.0"
  return p.toFixed(p <= 2 ? 2 : 1);
}

// Capped so a very long run doesn't grow this array forever; halves
// resolution (keeps every other sample) rather than dropping the tail, so
// the chart still shows the full step range, just coarser.
const ENERGY_HISTORY_MAX = 4000;
function pushEnergyHistory() {
  // logEnergy is carried alongside energy so the chart has something
  // plottable at p large enough that E itself overflows to Infinity.
  state._energyHistory.push({
    step: state.step,
    energy: state.energy,
    logEnergy: state._logEnergy,
    residual: state._residual,
  });
  if (state._energyHistory.length > ENERGY_HISTORY_MAX) {
    state._energyHistory = state._energyHistory.filter((_, idx) => idx % 2 === 0);
  }
  // chart.js listens for this; it is defined after chart.js loads, so guard
  // for the brief window during init where it doesn't exist yet.
  if (typeof markChartsDirty === "function") markChartsDirty();
}

function randomPointsOnSphere(n, seed) {
  const rnd = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    // uniform sphere sampling via normal-ish rejection-free method (Marsaglia)
    const u = 2 * rnd() - 1;
    const theta = 2 * Math.PI * rnd();
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    pts.push([r * Math.cos(theta), r * Math.sin(theta), u]);
  }
  return pts;
}

function resetConfiguration() {
  state.points = randomPointsOnSphere(state.N, state.seed);
  state.step = 0;
  state._trust = 1.0; // fresh landscape (new N/seed) - don't carry over step-size tuning
  resetConvergenceTracking();
  state._stepAccum = 0;
  computeEnergyAndForce(); // populate initial stats
  state._energyHistory = [{
    step: 0,
    energy: state.energy,
    logEnergy: state._logEnergy,
    residual: state._residual,
  }];
  if (typeof markChartsDirty === "function") markChartsDirty();
}

// ---------- physics: projected gradient descent on Riesz / log energy ----------
//
// E = sum_{i<j} K_p(d_ij),  where d_ij is either the Euclidean chord
// ||x_i-x_j|| ("euclidean") or the geodesic angle arccos(x_i . x_j)
// ("spherical"), and
//     K_p(d) = d^{-p}          for p > 0   (Riesz energy)
//     K_p(d) = -ln(d)          for p = 0   (logarithmic / Fekete energy,
//                                           the p -> 0 limit of Riesz energy)
// K_p'(d) = -p d^{-(p+1)} for p>0, or -1/d for p=0; the restoring magnitude
// is M(d) = -K_p'(d), i.e. p*d^-(p+1) or 1/d.
//
// For p>0, computeEnergyAndForce() below does not evaluate those two
// expressions directly. It works with the objective
//     Psi = (1/p) * log E
// instead, whose minimizers are identical (log is monotone and p>0) but
// which is computable at any p: expanding it around the closest pair gives
//     Psi = -log d_min + (1/p) * log( sum_ij (d_ij/d_min)^-p )
// where every summand now lies in (0,1]. Two payoffs beyond not overflowing:
//   * grad Psi = grad E / (p*E), i.e. the same direction field as the
//     physical force scaled by one positive constant, so nothing about the
//     descent trajectory changes at the p values that already worked.
//   * as p -> Infinity the second term vanishes like log(pairs)/p, leaving
//     Psi -> -log d_min. Minimizing the Riesz energy at large p therefore
//     *is* maximizing the minimum separation - the Tammes problem - so the
//     softmin the TODO proposes for p=Infinity is already this same code
//     path with a large p, not a separate objective.

// Above this p, the *reported* energy/force switch from physical units to
// the dimensionless normalized gradient (see computeEnergyAndForce): the
// physical force carries a factor p*d_min^-p, which overflows double once p
// is large (worst case d_min = R_MIN = 1e-4 makes it ~e^(9.2p), i.e. finite
// only to p ~ 76). Deliberately a fixed constant rather than a check on the
// current d_min, so the displayed units can't flip back and forth mid-run
// as a transient near-collision forms and resolves. Everything the
// integrator does is unit-agnostic (dt is sized from the same force array
// it displaces along, so any global rescaling cancels), so this only
// affects what the panel shows.
const P_PHYSICAL_MAX = 64;

// Numerical care: the true restoring magnitude diverges as d -> 0, which is
// correct in principle but not something a discrete integrator can step
// against. We floor only the *magnitude* (at R_MIN / THETA_MIN below). The
// *direction* must still come from the actual (unfloored) separation, or the
// force vanishes instead of saturating as two points approach each other.
const R_MIN = 1e-4;        // Euclidean magnitude floor
const R_ZERO = 1e-12;      // Euclidean: below this, direction is undefined (coincident)
const THETA_MIN = 1e-4;    // geodesic magnitude floor (radians)
// geodesic: below this, treat direction as undefined (coincident or antipodal).
// Deliberately much larger than machine epsilon: sinTheta = |xj - dot*xi| is a
// near-total cancellation when xi and xj are close to coincident or antipodal,
// so after many integration steps its floating-point noise floor is far above
// 1e-15 (observed empirically around 1e-9 to 1e-8 for octahedron-like exactly-
// antipodal equilibria). A threshold that isn't comfortably above that noise
// floor lets a genuinely-converged antipodal pair's direction be computed from
// cancellation noise instead of being caught by the zero-force branch below,
// injecting a large, effectively-random force forever and never settling.
const SIN_ZERO = 1e-6;

function randomTangentAt(xi, rnd) {
  const a = 2 * rnd() - 1, th = 2 * Math.PI * rnd();
  const rr = Math.sqrt(Math.max(0, 1 - a * a));
  const v = [rr * Math.cos(th), rr * Math.sin(th), a];
  const dot = v[0] * xi[0] + v[1] * xi[1] + v[2] * xi[2];
  const tx = v[0] - dot * xi[0], ty = v[1] - dot * xi[1], tz = v[2] - dot * xi[2];
  const norm = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  return [tx / norm, ty / norm, tz / norm];
}

// ---------- pair-kernel scratch ----------
// state.points stays an array of [x,y,z] triples, which is what every other
// module reads. The pair kernel below is the only O(N^2) consumer, though, and
// paid for that layout on every one of those pairs: one pointer chase per
// coordinate, with the three doubles of a point free to sit anywhere in the
// heap. It mirrors the points into a flat Float64Array once per call - O(N),
// invisible beside the pair loop - accumulates forces into another, and
// materializes triples again only at the end.
let _pairScratch = { n: -1 };

function pairScratch(n) {
  if (_pairScratch.n !== n) {
    _pairScratch = {
      n,
      xs: new Float64Array(3 * n),
      fx: new Float64Array(3 * n),
      pe: new Float64Array(n),
    };
  }
  return _pairScratch;
}

// ---------- uniform cell grid ----------
// Buckets the points into a uniform 3D grid over the sphere's bounding cube,
// in CSR form: the indices of the points in cell c are order[start[c]] up to
// order[start[c+1]]. Cells are cubic and h on a side, so two points more than
// one cell apart on any axis are strictly more than h apart - which is what
// lets a caller with a cutoff of h ignore all but the 27 cells around each
// point.
//
// The bookkeeping is O(cells) as well as O(N) - the prefix sum sweeps every
// cell, occupied or not - and the cell count grows as (2/h)^3 while the points
// only occupy a surface. A cutoff far below the minimum separation (reachable
// when a configuration is momentarily clustered) would therefore allocate and
// sweep a volumetric grid vastly larger than the point set it sorts. Callers
// must pass h through cellSizeFloor to keep that linear in N; using cells
// *larger* than the cutoff only means visiting extra pairs, which the cutoff
// then finds to be exact zeros anyway.
function cellSizeFloor(n) {
  const budget = Math.max(4096, 64 * n); // cells, so the sweep stays O(N)
  return 2 / Math.max(1, Math.cbrt(budget) - 3);
}

function buildCellGrid(xs, n, h) {
  const K = Math.ceil(1 / h) + 1; // axis cells run -K..K, with a cell of margin
  const D = 2 * K + 1;
  const nCells = D * D * D;
  const start = new Int32Array(nCells + 1);
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[3 * i] / h) + K;
    const cy = Math.floor(xs[3 * i + 1] / h) + K;
    const cz = Math.floor(xs[3 * i + 2] / h) + K;
    const c = (cx * D + cy) * D + cz;
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nCells);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;
  return { D, start, order, cellOf };
}

// Largest pairwise dot product, i.e. the closest pair - the same pair under
// both metrics, since chord = sqrt(2-2*dot) and geodesic angle = acos(dot) are
// both monotone decreasing in dot.
//
// The grid can be used here despite the cutoff not being known yet, because
// the minimum separation has an a-priori bound: n disjoint spherical caps of
// angular radius theta/2 have total area at most 4*pi, so
// n*(1-cos(theta/2)) <= 2, and with chord = 2*sin(theta/2) that gives
// d_min <= 4/sqrt(n) exactly. Cells that size are therefore guaranteed to
// contain the closest pair within adjacent cells, whatever the configuration.
function closestPairMaxDot(xs, n) {
  const h = Math.max(4 / Math.sqrt(n), cellSizeFloor(n));
  if (h >= 2) return maxDotAllPairs(xs, n); // grid would be a single cell
  const { D, start, order, cellOf } = buildCellGrid(xs, n, h);
  let maxDot = -2;
  for (let i = 0; i < n; i++) {
    const c = cellOf[i];
    const cz = c % D, cy = ((c - cz) / D) % D, cx = (c - cz - cy * D) / (D * D);
    const xi0 = xs[3 * i], xi1 = xs[3 * i + 1], xi2 = xs[3 * i + 2];
    for (let ax = cx - 1; ax <= cx + 1; ax++) {
      for (let ay = cy - 1; ay <= cy + 1; ay++) {
        const base = (ax * D + ay) * D;
        for (let az = cz - 1; az <= cz + 1; az++) {
          const c2 = base + az;
          for (let s = start[c2], e = start[c2 + 1]; s < e; s++) {
            const j = order[s];
            if (j <= i) continue;
            const d = xi0 * xs[3 * j] + xi1 * xs[3 * j + 1] + xi2 * xs[3 * j + 2];
            if (d > maxDot) maxDot = d;
          }
        }
      }
    }
  }
  return maxDot;
}

function maxDotAllPairs(xs, n) {
  let maxDot = -2;
  for (let i = 0; i < n; i++) {
    const xi0 = xs[3 * i], xi1 = xs[3 * i + 1], xi2 = xs[3 * i + 2];
    for (let j = i + 1; j < n; j++) {
      const d = xi0 * xs[3 * j] + xi1 * xs[3 * j + 1] + xi2 * xs[3 * j + 2];
      if (d > maxDot) maxDot = d;
    }
  }
  return maxDot;
}

// Below this the relative weight (d/dMin)^-p is not merely small but *exactly*
// zero in double precision: the smallest positive denormal is 2^-1074, and
// anything under 2^-1075 rounds to zero, so p*log(d/dMin) past ~745.1
// annihilates the term. Rounded up for margin, and deliberately the denormal
// limit rather than the normal one (~709), so that a skipped pair contributes
// bitwise nothing - to the energy, to the forces, and to the per-point
// energies alike - and truncation is exact rather than approximate.
const LOG_WEIGHT_UNDERFLOW = 746;

// Exponentiation by squaring, for the integer and half-integer stops the p
// slider mostly consists of. Math.pow dominates the pair kernel whenever the
// exponent isn't one V8 special-cases - N=1024 costs ~27ms per step at p=2.5
// against ~7ms at p=1, and the gap is almost entirely this one call - while
// q^k for modest integer k is a handful of multiplies. Safe from overflow
// because the caller's q = dMin/d always lies in (0,1].
function powInt(q, k) {
  let r = 1, b = q;
  while (k > 0) {
    if (k & 1) r *= b;
    k >>= 1;
    b *= b;
  }
  return r;
}

// Which power strategy a given p admits: 1 for integer, 2 for half-integer
// (taken on sqrt(q)), 0 for the general Math.pow. Restricted to p up to
// P_PHYSICAL_MAX, partly because squaring compounds rounding - about
// log2(p) ulps - and partly because above there the truncation grid is doing
// the work anyway, so the two accelerations divide the p range between them
// rather than competing over it.
function powStrategy(p, isLog) {
  if (isLog || p > P_PHYSICAL_MAX) return 0;
  if (Number.isInteger(p)) return 1;
  if (Number.isInteger(2 * p)) return 2;
  return 0;
}

// One pair's contribution: adds to the two force accumulators and the two
// per-point energies, and returns its energy term. Kept as a function so the
// grid-truncated and all-pairs loops can share it rather than each carry a
// copy of the metric handling and its degenerate cases.
function accumulatePair(i, j, xs, fx, pe, p, isLog, spherical, dMinEff, step, powMode, powK) {
  const i3 = 3 * i, j3 = 3 * j;
  const xi0 = xs[i3], xi1 = xs[i3 + 1], xi2 = xs[i3 + 2];
  const xj0 = xs[j3], xj1 = xs[j3 + 1], xj2 = xs[j3 + 2];

  if (spherical) {
    // geodesic distance: d = theta = arccos(xi . xj), a great-circle angle.
    // Direction on xi is the tangent at xi pointing away from xj; by
    // construction (xj - dot*xi) is already orthogonal to xi, and its norm
    // equals sin(theta), so normalizing it is direct - no need to separately
    // compute theta first.
    let dot = xi0 * xj0 + xi1 * xj1 + xi2 * xj2;
    dot = dot < -1 ? -1 : dot > 1 ? 1 : dot;
    const rawI0 = xj0 - dot * xi0, rawI1 = xj1 - dot * xi1, rawI2 = xj2 - dot * xi2;
    const sinTheta = Math.sqrt(rawI0 * rawI0 + rawI1 * rawI1 + rawI2 * rawI2);

    let uix, uiy, uiz, ujx, ujy, ujz;
    if (sinTheta < SIN_ZERO && dot > 0) {
      // coincident (theta ~ 0): energy diverges here and any escape
      // direction reduces it, so break the tie with a random kick
      const rnd = mulberry32((i * 92821) ^ (j * 68917) ^ (step * 104729));
      const ti = randomTangentAt([xi0, xi1, xi2], rnd);
      const tj = randomTangentAt([xj0, xj1, xj2], rnd);
      uix = -ti[0]; uiy = -ti[1]; uiz = -ti[2];
      ujx = -tj[0]; ujy = -tj[1]; ujz = -tj[2];
    } else if (sinTheta < SIN_ZERO) {
      // antipodal (theta ~ pi): geodesic distance is already at its maximum
      // (pi) for this pair, i.e. this pair's energy is already at *its*
      // minimum - every direction away only increases it, so (unlike the
      // coincident case) the correct contribution is zero, not a forced kick.
      // This mirrors what the Euclidean branch gets "for free": there, the
      // antipodal force is exactly radial and is annihilated by the tangential
      // projection later; the spherical branch's direction vectors are
      // tangential by construction, so that same cancellation never happens
      // unless done explicitly here.
      uix = uiy = uiz = 0; ujx = ujy = ujz = 0;
    } else {
      // away-from-neighbour tangent unit vectors at xi and xj
      uix = -rawI0 / sinTheta; uiy = -rawI1 / sinTheta; uiz = -rawI2 / sinTheta;
      const rawJ0 = xi0 - dot * xj0, rawJ1 = xi1 - dot * xj1, rawJ2 = xi2 - dot * xj2;
      ujx = -rawJ0 / sinTheta; ujy = -rawJ1 / sinTheta; ujz = -rawJ2 / sinTheta;
    }

    const theta = Math.acos(dot);
    const thetaEff = theta > THETA_MIN ? theta : THETA_MIN;
    const e = isLog ? -Math.log(thetaEff)
      : powMode === 1 ? powInt(dMinEff / thetaEff, powK)
      : powMode === 2 ? powInt(Math.sqrt(dMinEff / thetaEff), powK)
      : Math.pow(thetaEff / dMinEff, -p);
    const m = isLog ? 1 / thetaEff : e / thetaEff;
    pe[i] += e; pe[j] += e;
    fx[i3] += m * uix; fx[i3 + 1] += m * uiy; fx[i3 + 2] += m * uiz;
    fx[j3] += m * ujx; fx[j3 + 1] += m * ujy; fx[j3 + 2] += m * ujz;
    return e;
  }

  // Euclidean chord distance through the ambient 3D space
  const dx = xi0 - xj0, dy = xi1 - xj1, dz = xi2 - xj2;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);

  let ux, uy, uz;
  if (r < R_ZERO) {
    const rnd = mulberry32((i * 92821) ^ (j * 68917) ^ (step * 104729));
    const a = 2 * rnd() - 1, th = 2 * Math.PI * rnd();
    const rr = Math.sqrt(Math.max(0, 1 - a * a));
    ux = rr * Math.cos(th); uy = rr * Math.sin(th); uz = a;
  } else {
    ux = dx / r; uy = dy / r; uz = dz / r;
  }

  const rEff = r > R_MIN ? r : R_MIN; // magnitude only - direction above is exact
  // e is the pair's relative weight (d/dMin)^-p for p>0, or its actual
  // log-energy for p=0; m is the matching restoring magnitude, which for p>0
  // drops p as a common factor (reinstated in `scale` by the caller) so that
  // m = w/d rather than p*d^-(p+1).
  const e = isLog ? -Math.log(rEff)
    : powMode === 1 ? powInt(dMinEff / rEff, powK)
    : powMode === 2 ? powInt(Math.sqrt(dMinEff / rEff), powK)
    : Math.pow(rEff / dMinEff, -p);
  const m = isLog ? 1 / rEff : e / rEff;
  pe[i] += e; pe[j] += e;
  fx[i3] += m * ux; fx[i3 + 1] += m * uy; fx[i3 + 2] += m * uz;
  fx[j3] -= m * ux; fx[j3 + 1] -= m * uy; fx[j3 + 2] -= m * uz;
  return e;
}

function computeEnergyAndForce() {
  const pts = state.points;
  const n = pts.length;

  // p=Infinity is the Tammes (maximize the minimum pairwise distance) limit,
  // not a Riesz energy at all - d^-Infinity isn't a meaningful summand, and
  // there's no gradient-descent-friendly objective defined yet (see TODO.md).
  // Report inert stats rather than let the sum blow up; main.js also disables
  // Play whenever this is selected, and maxForce=0 here means stepPhysics()
  // would no-op even if it were somehow invoked anyway.
  if (state.p === Infinity) {
    state.energy = NaN;
    state._logEnergy = NaN;
    state._minSeparation = NaN;
    state._forces = pts.map(() => [0, 0, 0]);
    state._pointEnergy = new Array(n).fill(NaN);
    state._forceUnitsRelative = false;
    state._energyRelative = false;
    state._residualScale = 1;
    state._residual = 0;
    state.maxForce = 0;
    return state._forces;
  }

  const p = state.p;
  const isLog = p <= 1e-9; // p=0: logarithmic (Fekete) energy, not a power law
  const spherical = state.metric === "spherical";
  const forces = new Array(n);
  const pointEnergy = new Array(n).fill(0); // per-vertex potential energy, for the hover info panel

  if (n < 2) {
    for (let i = 0; i < n; i++) forces[i] = [0, 0, 0];
    state.energy = 0;
    state._logEnergy = -Infinity;
    state._minSeparation = NaN;
    state._forces = forces;
    state._pointEnergy = pointEnergy;
    state._forceUnitsRelative = false;
    state._energyRelative = false;
    state._residualScale = 1;
    state._residual = 0;
    state.maxForce = 0;
    return forces;
  }

  const { xs, fx, pe } = pairScratch(n);
  for (let i = 0; i < n; i++) {
    const xi = pts[i];
    xs[3 * i] = xi[0]; xs[3 * i + 1] = xi[1]; xs[3 * i + 2] = xi[2];
  }
  fx.fill(0);
  pe.fill(0);

  // ---- pass 1: locate the closest pair ----
  // Only the largest dot product is needed, and it settles both metrics at
  // once (see closestPairMaxDot). Two things consume it: the min-separation
  // stat (the quantity of interest as p grows, and the one Tammes tables are
  // written in), and the log-sum-exp shift below.
  const maxDot = closestPairMaxDot(xs, n);
  const minAngle = Math.acos(Math.max(-1, Math.min(1, maxDot)));
  state._minSeparation = minAngle;
  // The smallest *effective* (floored) separation, in the active metric's
  // own units. This is the log-sum-exp shift: dividing every separation by
  // it makes each pair's weight (d/dMin)^-p land in (0,1], so nothing
  // overflows at any p, however large. It doesn't have to be the exact
  // minimum for that to hold - any near-maximal term works as a shift - so
  // deriving it from maxDot rather than from pass 2's own chord arithmetic
  // is safe even if float rounding disagrees about a near-tie.
  const dMinEff = spherical
    ? Math.max(minAngle, THETA_MIN)
    : Math.max(Math.sqrt(Math.max(0, 2 - 2 * maxDot)), R_MIN);

  // ---- pass 2: energy and force ----
  // For p>0 this accumulates the *relative* weights w = (d/dMin)^-p rather
  // than the raw d^-p terms, i.e. everything is measured against the
  // closest pair's contribution. Summing numbers in (0,1] instead of ones
  // spanning 1e-8..1e13 is what makes large p work at all: the raw sum
  // loses every distant pair to roundoff long before it overflows, and
  // (worse) leaves the Armijo test in stepPhysics comparing energies whose
  // difference is far below the sum's own noise floor. The true energy is
  // recovered exactly afterwards as sumW * dMin^-p, in log form when that
  // overflows.
  //
  // For p=0 there is no such structure (the energy is a sum of logs, not of
  // powers, and can be negative), and no conditioning problem either, so
  // `accum` there is simply the energy itself.
  let accum = 0;

  // Truncation radius, in chord units so the grid can use it directly. Past
  // it every weight is exactly zero (see LOG_WEIGHT_UNDERFLOW), so dropping
  // those pairs is not an approximation with an error budget - it is the same
  // arithmetic with the zeros left out. The radius shrinks as p grows, which
  // is exactly when it is needed: the log-domain reformulation made p=1000
  // reachable, and at that exponent the sum is genuinely short-ranged.
  //
  // For the spherical metric the cutoff is on the angle, converted to a chord
  // through the monotone chord = 2*sin(theta/2).
  let chordCut = Infinity;
  if (!isLog) {
    const cut = dMinEff * Math.exp(LOG_WEIGHT_UNDERFLOW / p);
    chordCut = spherical ? (cut >= Math.PI ? Infinity : 2 * Math.sin(cut / 2)) : cut;
  }
  const hCut = Math.max(chordCut, cellSizeFloor(n));
  // Above this the grid is a handful of cells wide and buys nothing but its
  // own bookkeeping, so the plain double loop stays the default.
  const useGrid = hCut < 0.5 && n >= 32;
  const powMode = powStrategy(p, isLog);
  const powK = powMode === 2 ? 2 * p : p;

  if (useGrid) {
    const { D, start, order, cellOf } = buildCellGrid(xs, n, hCut);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const cz = c % D, cy = ((c - cz) / D) % D, cx = (c - cz - cy * D) / (D * D);
      for (let ax = cx - 1; ax <= cx + 1; ax++) {
        for (let ay = cy - 1; ay <= cy + 1; ay++) {
          const base = (ax * D + ay) * D;
          for (let az = cz - 1; az <= cz + 1; az++) {
            const c2 = base + az;
            for (let s = start[c2], e = start[c2 + 1]; s < e; s++) {
              const j = order[s];
              if (j > i) accum += accumulatePair(i, j, xs, fx, pe, p, isLog, spherical, dMinEff, state.step, powMode, powK);
            }
          }
        }
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        accum += accumulatePair(i, j, xs, fx, pe, p, isLog, spherical, dMinEff, state.step, powMode, powK);
      }
    }
  }
  state._truncated = useGrid;

  // ---- recover real units ----
  // Everything above is in "relative to the closest pair" units for p>0.
  // Undoing that is a single scalar per quantity:
  //   E        = sumW * dMin^-p          (in log form: log sumW - p*log dMin)
  //   F_phys   = A    * p * dMin^-p
  //   F_norm   = A    / sumW             = -grad of (1/p)*log E
  // F_norm and F_phys differ only by the positive scalar p*E, so they define
  // the same descent direction - which is why switching between them at
  // extreme p changes nothing about the trajectory, only the numbers shown.
  let scale;
  if (isLog) {
    state.energy = accum;
    state._logEnergy = NaN; // a sum of logs has no useful log form (it can be negative)
    state._forceUnitsRelative = false;
    state._energyRelative = false;
    scale = 1;
  } else {
    const logDMin = Math.log(dMinEff);
    state._logEnergy = Math.log(accum) - p * logDMin;
    state.energy = Math.exp(state._logEnergy); // Infinity past ~e709; the panel falls back to log E
    state._forceUnitsRelative = p > P_PHYSICAL_MAX;
    state._energyRelative = !Number.isFinite(state.energy);
    scale = state._forceUnitsRelative ? 1 / accum : p * Math.exp(-p * logDMin);
    // Per-point energies follow the total: real units where the total is
    // representable, otherwise each point's share of it.
    const pointScale = state._energyRelative ? 1 / accum : Math.exp(-p * logDMin);
    for (let i = 0; i < n; i++) pe[i] *= pointScale;
  }
  for (let i = 0; i < n; i++) pointEnergy[i] = pe[i];
  state._dMinEff = dMinEff; // consumed by pairForceMagnitude's relative branch
  state._sumW = accum;
  // Multiply any magnitude drawn from state._forces by this to get it in
  // scale-free residual units (|grad Psi|). Needed because those forces are
  // physical below P_PHYSICAL_MAX and already normalized above it, while the
  // vertex tension colouring wants one consistent scale at every p. Works
  // out to 1/(p*E) in the physical branch and exactly 1 in the relative one.
  state._residualScale = isLog ? 1 : 1 / (scale * accum);
  state._forces = forces;
  state._pointEnergy = pointEnergy;

  let maxA = 0;
  for (let i = 0; i < n; i++) {
    const i3 = 3 * i;
    const x0 = xs[i3], x1 = xs[i3 + 1], x2 = xs[i3 + 2];
    const f0 = fx[i3], f1 = fx[i3 + 1], f2 = fx[i3 + 2];
    // project onto tangent plane at xi (a no-op for the spherical branch,
    // whose contributions are already exactly tangential by construction)
    const dot = f0 * x0 + f1 * x1 + f2 * x2;
    const ax = f0 - dot * x0, ay = f1 - dot * x1, az = f2 - dot * x2;
    forces[i] = [ax * scale, ay * scale, az * scale];
    // Magnitude of the *unscaled* accumulator, so both the displayed force
    // and the dimensionless residual below can be derived exactly without
    // dividing by p*E (which is itself Infinity at large p).
    const magA = Math.sqrt(ax * ax + ay * ay + az * az);
    if (magA > maxA) maxA = magA;
  }
  state.maxForce = maxA * scale;
  // The scale-free convergence measure: max_i |grad_i Psi|, i.e. the force in
  // units of p*E. Unlike maxForce it means the same thing at every p, which
  // matters because the physical force's own scale grows like e^O(p) - at
  // p=25 a fully converged N=40 configuration still reports maxForce ~1e+3,
  // so no fixed absolute threshold on it can ever be met there. For p=0
  // there's no p*E factor to divide out, so the two coincide.
  state._residual = isLog ? state.maxForce : maxA / accum;
  return forces;
}

// Pairwise restoring-force magnitude between two specific points under the
// *current* metric/p, independent of edge rendering style - used by the
// hover info panel to report an edge's "force" property.
function pairForceMagnitude(i, j) {
  if (state.p === Infinity) return NaN; // Tammes limit - not a Riesz force, see TODO.md
  const xi = state.points[i], xj = state.points[j], p = state.p;
  let dEff;
  if (state.metric === "spherical") {
    const dot = Math.max(-1, Math.min(1, xi[0] * xj[0] + xi[1] * xj[1] + xi[2] * xj[2]));
    dEff = Math.max(Math.acos(dot), THETA_MIN);
  } else {
    const dx = xi[0] - xj[0], dy = xi[1] - xj[1], dz = xi[2] - xj[2];
    dEff = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), R_MIN);
  }
  if (p <= 1e-9) return 1 / dEff;
  // Reported in whatever units computeEnergyAndForce last used, so a hovered
  // edge's Force stays directly comparable with the panel's Max force.
  if (state._forceUnitsRelative) return Math.pow(dEff / state._dMinEff, -p) / (dEff * state._sumW);
  return p * Math.pow(dEff, -(p + 1));
}

function applyDisplacement(basePoints, forces, dt) {
  const n = basePoints.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const xi = basePoints[i], f = forces[i];
    const nx = xi[0] + dt * f[0], ny = xi[1] + dt * f[1], nz = xi[2] + dt * f[2];
    const norm = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out[i] = [nx / norm, ny / norm, nz / norm];
  }
  return out;
}

// The geodesic energy landscape's stiffness near equilibrium can differ a
// lot from the Euclidean one's (verified: the analytic force matches a
// finite-difference gradient check to 6+ significant figures under both
// metrics and p=0/p>0, so this is curvature, not a sign or formula error).
// A single fixed step-size formula tuned against one landscape can therefore
// wildly over- or under-shoot on another, causing either a non-decaying
// oscillation or glacially slow crawling. Two safeguards:
//   1. Armijo backtracking: halve dt until the step actually decreases
//      energy, guaranteeing energy is a monotone (bounded) sequence.
//   2. A persistent trust-region multiplier that grows geometrically after
//      unimpeded successes and shrinks after a backtrack, so the step size
//      adapts to *this* configuration's stiffness rather than one constant
//      tuned for a single case.
// Deliberately no `state.speed` term anywhere below: dt is sized purely for
// numerical stability/convergence quality. The "Animation speed" slider
// instead controls how many of these steps run per rendered frame (see
// main.js's tick loop) - a playback-rate knob, not a step-size knob. The two
// used to be conflated (speed multiplied directly into dt), but `_trust`'s
// own geometric growth (up to 64x) dwarfed whatever speed asked for, so
// slower settings had almost no visible effect once trust saturated.
state._trust = 1.0;

// The quantity the Armijo test below compares. For p>0 this is log E rather
// than E: the two are monotonically equivalent, but E itself spans 1e0 to
// well past 1e300 across the p range, so a *relative* tolerance on E is the
// only kind that means the same thing at every p - and a relative tolerance
// on E is an absolute one on log E. Comparing E directly is what used to
// break above p~25: at E~1e13 the old `1e-10 * (1 + |E|)` slack came out to
// ~1e3, far larger than the real per-step energy change, so every step read
// as "downhill" regardless of whether it was, and the trust region never
// found a workable dt (the documented maxForce-stalls-at-1e+3 symptom).
// p=0's energy is a sum of logs, can be negative, has no log form, and never
// had the conditioning problem in the first place - so it is compared as-is.
function armijoObjective() {
  return state.p > 1e-9 ? state._logEnergy : state.energy;
}

// Second convergence test, alongside main.js's threshold on maxForce. That
// threshold is an *absolute* one, so it only works while the force's own
// scale is O(1) - it is unreachable by construction at large p, where a
// fully-settled configuration still reports maxForce ~1e+3 and up. Nor can
// it simply be restated as a threshold on the scale-free residual, because
// the *achievable* residual floor itself degrades with p (measured: ~1e-9 at
// p=1, ~1e-8 at p=6, ~2e-6 at p=25), as relative energy differences near the
// optimum shrink with the stiffening landscape. So detect the honest
// condition instead: the objective has stopped improving by more than double
// precision can resolve - the standard `ftol` companion to a `gtol` test.
// Measured against the best objective seen rather than the previous step's,
// so the small oscillation a trust region performs around a
// precision-limited minimum reads as stagnation rather than resetting the
// count every time it happens to tick downhill.
const STALL_STEPS = 100;  // consecutive non-improving steps before declaring convergence
const STALL_REL = 1e-14;  // improvement below this (relative to |objective|) counts as none

function resetConvergenceTracking() {
  state._stallCount = 0;
  state._bestObjective = Infinity;
  state.stalled = false;
  // Peak residual for the current landscape, i.e. the most tension the
  // system has held since the last change of N/seed/p/metric. The vertex
  // colouring measures against this (see render.js) so that "red" means
  // as-tense-as-it-ever-was rather than a fixed number that only lands
  // usefully at one exponent.
  state._residualPeak = 0;
}
resetConvergenceTracking();

function stepPhysics() {
  const forces = computeEnergyAndForce();
  const n = state.points.length;
  if (n < 2) { state.step++; pushEnergyHistory(); return; }
  const basePoints = state.points;
  const usesLog = state.p > 1e-9;
  const e0 = armijoObjective();

  const maxF = Math.max(state.maxForce, 1e-9);
  const dt0 = Math.min(0.02, 0.15 / maxF);
  let dt = dt0 * state._trust;

  // scale-aware slack so float roundoff noise in the energy sum can't be
  // mistaken for an uphill step once dt gets small - without this, a strict
  // "energy > e0" test can permanently freeze the trust multiplier near its
  // floor (found by stress-testing the spherical/p=0 landscapes: it stalled
  // at maxForce ~0.1-0.3, never decaying, exactly this failure mode)
  const tolerance = (usesLog ? 1e-11 : 1e-10) * (1 + Math.abs(e0));

  state.points = applyDisplacement(basePoints, forces, dt);
  computeEnergyAndForce();
  let tries = 0;
  while (armijoObjective() > e0 + tolerance && tries < 30) {
    dt *= 0.5;
    state.points = applyDisplacement(basePoints, forces, dt);
    computeEnergyAndForce();
    tries++;
  }

  if (tries === 0) {
    state._trust = Math.min(state._trust * 1.15, 64);
  } else {
    state._trust = Math.max((dt / dt0) * 0.8, 1e-3);
  }

  // Accepted states only. A trial point mid-backtrack can momentarily throw
  // two vertices almost on top of each other, and at large p that near
  // collision's residual would dwarf anything real - inflating the peak
  // permanently and washing the vertex colouring pale for the rest of the run.
  if (state._residual > state._residualPeak) state._residualPeak = state._residual;

  const obj = armijoObjective();
  if (obj < state._bestObjective - STALL_REL * (1 + Math.abs(obj))) {
    state._bestObjective = obj;
    state._stallCount = 0;
  } else {
    if (obj < state._bestObjective) state._bestObjective = obj;
    state._stallCount++;
  }
  state.stalled = state._stallCount >= STALL_STEPS;

  state.step++;
  pushEnergyHistory();
}
