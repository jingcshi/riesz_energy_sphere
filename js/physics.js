"use strict";

// ---------- shared state ----------
const state = {
  N: 40,
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
  // 0 (fully transparent - front/back equally clear) .. 1 (fully opaque -
  // directly-rear elements completely invisible). Default 0.65 reproduces
  // the original (pre-slider) fixed face fade exactly, as the closest
  // single-knob match across faces/edges/vertices - see geometry.js's
  // depthWithOpacity.
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
  for (let i = 0; i < n; i++) forces[i] = [0, 0, 0];

  if (n < 2) {
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

  // ---- pass 1: locate the closest pair ----
  // Only the largest dot product is needed, and it settles both metrics at
  // once: chord = sqrt(2-2*dot) and geodesic angle = acos(dot) are both
  // monotone decreasing in dot, so the closest pair is the same pair either
  // way. That makes this one multiply-add per pair plus a single sqrt/acos
  // afterwards - far cheaper than pass 2, which also needs directions and a
  // transcendental per pair. Two things consume it: the min-separation stat
  // (the quantity of interest as p grows, and the one Tammes tables are
  // written in), and the log-sum-exp shift below.
  let maxDot = -2;
  for (let i = 0; i < n; i++) {
    const xi = pts[i];
    for (let j = i + 1; j < n; j++) {
      const xj = pts[j];
      const d = xi[0] * xj[0] + xi[1] * xj[1] + xi[2] * xj[2];
      if (d > maxDot) maxDot = d;
    }
  }
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

  for (let i = 0; i < n; i++) {
    const xi = pts[i];
    for (let j = i + 1; j < n; j++) {
      const xj = pts[j];

      if (spherical) {
        // geodesic distance: d = theta = arccos(xi . xj), a great-circle
        // angle. Direction on xi is the tangent at xi pointing away from xj;
        // by construction (xj - dot*xi) is already orthogonal to xi, and its
        // norm equals sin(theta), so normalizing it is direct - no need to
        // separately compute theta first.
        const dot = Math.max(-1, Math.min(1, xi[0] * xj[0] + xi[1] * xj[1] + xi[2] * xj[2]));
        const rawI0 = xj[0] - dot * xi[0], rawI1 = xj[1] - dot * xi[1], rawI2 = xj[2] - dot * xi[2];
        const sinTheta = Math.sqrt(rawI0 * rawI0 + rawI1 * rawI1 + rawI2 * rawI2);

        let uix, uiy, uiz, ujx, ujy, ujz;
        if (sinTheta < SIN_ZERO && dot > 0) {
          // coincident (theta ~ 0): energy diverges here and any escape
          // direction reduces it, so break the tie with a random kick
          const rnd = mulberry32((i * 92821) ^ (j * 68917) ^ (state.step * 104729));
          const ti = randomTangentAt(xi, rnd);
          const tj = randomTangentAt(xj, rnd);
          uix = -ti[0]; uiy = -ti[1]; uiz = -ti[2];
          ujx = -tj[0]; ujy = -tj[1]; ujz = -tj[2];
        } else if (sinTheta < SIN_ZERO) {
          // antipodal (theta ~ pi): geodesic distance is already at its
          // maximum (pi) for this pair, i.e. this pair's energy is already
          // at *its* minimum - every direction away only increases it, so
          // (unlike the coincident case) the correct contribution is zero,
          // not a forced kick. This mirrors what the Euclidean branch gets
          // "for free": there, the antipodal force is exactly radial and is
          // annihilated by the tangential projection below; the spherical
          // branch's direction vectors are tangential by construction, so
          // that same cancellation never happens unless done explicitly here.
          uix = uiy = uiz = 0; ujx = ujy = ujz = 0;
        } else {
          // away-from-neighbour tangent unit vectors at xi and xj
          uix = -rawI0 / sinTheta; uiy = -rawI1 / sinTheta; uiz = -rawI2 / sinTheta;
          const rawJ0 = xi[0] - dot * xj[0], rawJ1 = xi[1] - dot * xj[1], rawJ2 = xi[2] - dot * xj[2];
          ujx = -rawJ0 / sinTheta; ujy = -rawJ1 / sinTheta; ujz = -rawJ2 / sinTheta;
        }

        const theta = Math.acos(dot);
        const thetaEff = Math.max(theta, THETA_MIN);
        const e = isLog ? -Math.log(thetaEff) : Math.pow(thetaEff / dMinEff, -p);
        const m = isLog ? 1 / thetaEff : e / thetaEff;
        accum += e;
        pointEnergy[i] += e; pointEnergy[j] += e;
        forces[i][0] += m * uix; forces[i][1] += m * uiy; forces[i][2] += m * uiz;
        forces[j][0] += m * ujx; forces[j][1] += m * ujy; forces[j][2] += m * ujz;
      } else {
        // Euclidean chord distance through the ambient 3D space
        const dx = xi[0] - xj[0], dy = xi[1] - xj[1], dz = xi[2] - xj[2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);

        let ux, uy, uz;
        if (r < R_ZERO) {
          const rnd = mulberry32((i * 92821) ^ (j * 68917) ^ (state.step * 104729));
          const a = 2 * rnd() - 1, th = 2 * Math.PI * rnd();
          const rr = Math.sqrt(Math.max(0, 1 - a * a));
          ux = rr * Math.cos(th); uy = rr * Math.sin(th); uz = a;
        } else {
          ux = dx / r; uy = dy / r; uz = dz / r;
        }

        const rEff = Math.max(r, R_MIN); // magnitude only - direction above is exact
        // e is the pair's relative weight (d/dMin)^-p for p>0, or its actual
        // log-energy for p=0; m is the matching restoring magnitude, which
        // for p>0 drops p as a common factor (reinstated in `scale` below)
        // so that m = w/d rather than p*d^-(p+1).
        const e = isLog ? -Math.log(rEff) : Math.pow(rEff / dMinEff, -p);
        const m = isLog ? 1 / rEff : e / rEff;
        accum += e;
        pointEnergy[i] += e; pointEnergy[j] += e;
        forces[i][0] += m * ux; forces[i][1] += m * uy; forces[i][2] += m * uz;
        forces[j][0] -= m * ux; forces[j][1] -= m * uy; forces[j][2] -= m * uz;
      }
    }
  }
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
    for (let i = 0; i < n; i++) pointEnergy[i] *= pointScale;
  }
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
    const xi = pts[i], f = forces[i];
    // project onto tangent plane at xi (a no-op for the spherical branch,
    // whose contributions are already exactly tangential by construction)
    const dot = f[0] * xi[0] + f[1] * xi[1] + f[2] * xi[2];
    const tx = (f[0] - dot * xi[0]) * scale, ty = (f[1] - dot * xi[1]) * scale, tz = (f[2] - dot * xi[2]) * scale;
    forces[i] = [tx, ty, tz];
    // Magnitude of the *unscaled* accumulator, so both the displayed force
    // and the dimensionless residual below can be derived exactly without
    // dividing by p*E (which is itself Infinity at large p).
    const magA = Math.sqrt((f[0] - dot * xi[0]) ** 2 + (f[1] - dot * xi[1]) ** 2 + (f[2] - dot * xi[2]) ** 2);
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
