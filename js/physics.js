"use strict";

// ---------- shared state ----------
const state = {
  N: 40,
  p: 1.0,
  seed: 1,
  speed: 1.0,
  metric: "euclidean", // "euclidean" | "spherical"
  edgeStyle: "none",   // "none" | "lines" | "arcs" - independent of `metric`
  playing: false,
  points: [],      // array of [x,y,z]
  step: 0,
  energy: 0,
  maxForce: 0,
  viewMatrix: matMultiply(rotationY(0.5), rotationX(-0.3)), // initial orientation, matches old rotX=-0.3/rotY=0.5
  zoom: 1.0, // origin-centered scale multiplier, no translation
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
// band), coarsening as p grows. Capped at 25, not pushed further toward
// p=Infinity as originally sketched: R_MIN=1e-4 floors the *magnitude* of a
// near-collision, but `Math.pow(rEff, -(p+1))` still overflows double
// precision once p is large enough (verified numerically stability starts
// degrading around p~25, well before actual overflow - the landscape is
// already ill-conditioned enough there that maxForce stalls around 1e+3
// without converging). Rather than chase that with an arbitrary-precision
// number library (massive overkill for a UI slider), the range simply stops
// at the point where the existing integrator is still reliable. Built by
// index rather than repeated float addition to avoid step-accumulation
// drift (e.g. a naive 0.1+0.1+0.1 landing on 1.7000000000000002).
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
  vals.push(Infinity);      // the Tammes (max-min distance) limit - see TODO.md
  return vals; // 71 total
}
const P_VALUES = buildPValues();
const P_DEFAULT_INDEX = P_VALUES.indexOf(1.0); // Coulomb/Newtonian law

function formatP(p) {
  if (p === Infinity) return "\u221e";
  return p.toFixed(p <= 2 ? 2 : 1);
}

// Capped so a very long run doesn't grow this array forever; halves
// resolution (keeps every other sample) rather than dropping the tail, so
// the chart still shows the full step range, just coarser.
const ENERGY_HISTORY_MAX = 4000;
function pushEnergyHistory() {
  state._energyHistory.push({ step: state.step, energy: state.energy, maxForce: state.maxForce });
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
  state._stepAccum = 0;
  computeEnergyAndForce(); // populate initial stats
  state._energyHistory = [{ step: 0, energy: state.energy, maxForce: state.maxForce }];
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
// used below is M(d) = -K_p'(d), i.e. p*d^-(p+1) or 1/d.
function energyAndMagnitude(dEff, p) {
  if (p <= 1e-9) return { e: -Math.log(dEff), m: 1 / dEff };
  return { e: Math.pow(dEff, -p), m: p * Math.pow(dEff, -(p + 1)) };
}

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
    state._forces = pts.map(() => [0, 0, 0]);
    state._pointEnergy = new Array(n).fill(NaN);
    state.maxForce = 0;
    return state._forces;
  }

  const p = state.p;
  const spherical = state.metric === "spherical";
  let energy = 0;
  const forces = new Array(n);
  const pointEnergy = new Array(n).fill(0); // per-vertex potential energy, for the hover info panel
  for (let i = 0; i < n; i++) forces[i] = [0, 0, 0];

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
        const { e, m } = energyAndMagnitude(thetaEff, p);
        energy += e;
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
        const { e, m } = energyAndMagnitude(rEff, p);
        energy += e;
        pointEnergy[i] += e; pointEnergy[j] += e;
        forces[i][0] += m * ux; forces[i][1] += m * uy; forces[i][2] += m * uz;
        forces[j][0] -= m * ux; forces[j][1] -= m * uy; forces[j][2] -= m * uz;
      }
    }
  }
  state.energy = energy;
  state._forces = forces;
  state._pointEnergy = pointEnergy;
  let maxF = 0;
  for (let i = 0; i < n; i++) {
    const xi = pts[i], f = forces[i];
    // project onto tangent plane at xi (a no-op for the spherical branch,
    // whose contributions are already exactly tangential by construction)
    const dot = f[0] * xi[0] + f[1] * xi[1] + f[2] * xi[2];
    const tx = f[0] - dot * xi[0], ty = f[1] - dot * xi[1], tz = f[2] - dot * xi[2];
    forces[i] = [tx, ty, tz];
    const mag = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (mag > maxF) maxF = mag;
  }
  state.maxForce = maxF;
  return forces;
}

// Pairwise restoring-force magnitude between two specific points under the
// *current* metric/p, independent of edge rendering style - used by the
// hover info panel to report an edge's "force" property.
function pairForceMagnitude(i, j) {
  if (state.p === Infinity) return NaN; // Tammes limit - not a Riesz force, see TODO.md
  const xi = state.points[i], xj = state.points[j], p = state.p;
  if (state.metric === "spherical") {
    const dot = Math.max(-1, Math.min(1, xi[0] * xj[0] + xi[1] * xj[1] + xi[2] * xj[2]));
    const thetaEff = Math.max(Math.acos(dot), THETA_MIN);
    return energyAndMagnitude(thetaEff, p).m;
  }
  const dx = xi[0] - xj[0], dy = xi[1] - xj[1], dz = xi[2] - xj[2];
  const rEff = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), R_MIN);
  return energyAndMagnitude(rEff, p).m;
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

function stepPhysics() {
  const forces = computeEnergyAndForce();
  const n = state.points.length;
  if (n < 2) { state.step++; pushEnergyHistory(); return; }
  const basePoints = state.points;
  const e0 = state.energy;

  const maxF = Math.max(state.maxForce, 1e-9);
  const dt0 = Math.min(0.02, 0.15 / maxF);
  let dt = dt0 * state._trust;

  // scale-aware slack so float roundoff noise in the energy sum can't be
  // mistaken for an uphill step once dt gets small - without this, a strict
  // "energy > e0" test can permanently freeze the trust multiplier near its
  // floor (found by stress-testing the spherical/p=0 landscapes: it stalled
  // at maxForce ~0.1-0.3, never decaying, exactly this failure mode)
  const tolerance = 1e-10 * (1 + Math.abs(e0));

  state.points = applyDisplacement(basePoints, forces, dt);
  computeEnergyAndForce();
  let tries = 0;
  while (state.energy > e0 + tolerance && tries < 30) {
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
  state.step++;
  pushEnergyHistory();
}
