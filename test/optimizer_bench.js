"use strict";

// Headless comparison of the two optimizers in js/physics.js.
//
// rng.js, geometry.js and physics.js are all DOM-free, so they can be
// concatenated into one vm context and driven directly. physics.js guards its
// only outward call (markChartsDirty) behind a typeof check, so nothing else
// needs stubbing.
//
// Run: node test/optimizer_bench.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = ["rng", "geometry", "physics"]
  .map((m) => fs.readFileSync(path.join(ROOT, "js", `${m}.js`), "utf8"))
  .join("\n");

const ctx = vm.createContext({ console, Math, Number, Infinity, NaN, Float64Array, Int32Array, Array, Set });
// Top-level `const`/`function` in a vm script live in the script's lexical
// scope, not on the context object, so they have to be pulled out by
// evaluating their names rather than read off `ctx`.
vm.runInContext(src + "\n;({ state, resetConfiguration, computeEnergyAndForce, stepPhysics, armijoObjective, lbfgsReset });",
  ctx, { filename: "bundle.js" });
const api = vm.runInContext(
  "({ state, resetConfiguration, computeEnergyAndForce, stepPhysics, armijoObjective, lbfgsReset })", ctx);

const { state, resetConfiguration, computeEnergyAndForce, stepPhysics, armijoObjective } = api;

// ---------- harness ----------

// Mirrors main.js's isConverged().
const CONVERGED_FORCE = 1e-4;
function isConverged() {
  return state.maxForce <= CONVERGED_FORCE || state.stalled;
}

function run(method, { N, p, metric, seed, maxSteps }) {
  state.N = N;
  state.p = p;
  state.metric = metric;
  state.seed = seed;
  state.method = method;
  resetConfiguration();
  // resetConfiguration zeroes _evals after the initial stats evaluation on
  // some paths; take the reading after it settles so both runs start level.
  const eval0 = state._evals;
  const obj0 = armijoObjective();

  let steps = 0;
  while (steps < maxSteps && !isConverged()) {
    stepPhysics();
    steps++;
  }
  return {
    method,
    steps,
    evals: state._evals - eval0,
    obj0,
    obj: armijoObjective(),
    energy: state.energy,
    logEnergy: state._logEnergy,
    maxForce: state.maxForce,
    residual: state._residual,
    converged: isConverged(),
    stalled: state.stalled,
    minSep: state._minSeparation,
    lsFailures: state._lbfgsLsFailures,
    skipped: state._lbfgsSkipped,
    points: state.points.map((q) => q.slice()),
  };
}

// Verify every point is still on the unit sphere - the retraction's whole job.
function maxRadiusError(points) {
  let e = 0;
  for (const q of points) {
    const r = Math.hypot(q[0], q[1], q[2]);
    e = Math.max(e, Math.abs(r - 1));
  }
  return e;
}

function fmt(x, d = 6) {
  if (!Number.isFinite(x)) return String(x);
  return Math.abs(x) >= 1e6 || (Math.abs(x) < 1e-4 && x !== 0)
    ? x.toExponential(3) : x.toFixed(d);
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log(`   FAIL  ${msg}`); }
  else console.log(`   ok    ${msg}`);
}

// ---------- cases ----------
const cases = [
  { name: "N=24  p=1   euclidean", N: 24,  p: 1,   metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=64  p=1   euclidean", N: 64,  p: 1,   metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=128 p=1   euclidean", N: 128, p: 1,   metric: "euclidean", seed: 3, maxSteps: 40000 },
  { name: "N=64  p=0   euclidean", N: 64,  p: 0,   metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=64  p=6   euclidean", N: 64,  p: 6,   metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=64  p=25  euclidean", N: 64,  p: 25,  metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=64  p=100 euclidean", N: 64,  p: 100, metric: "euclidean", seed: 1, maxSteps: 40000 },
  { name: "N=64  p=1   spherical", N: 64,  p: 1,   metric: "spherical", seed: 1, maxSteps: 40000 },
  { name: "N=32  p=2   spherical", N: 32,  p: 2,   metric: "spherical", seed: 7, maxSteps: 40000 },
];

console.log("Riesz energy: gradient descent vs Riemannian L-BFGS\n");

const header = ["case", "GD steps", "GD evals", "LB steps", "LB evals",
  "eval ratio", "GD obj", "LB obj", "better"];
const rows = [];

for (const c of cases) {
  console.log(`-- ${c.name} ${"-".repeat(Math.max(0, 46 - c.name.length))}`);
  const gd = run("gd", c);
  const lb = run("lbfgs", c);

  // Both must land on the sphere.
  check(maxRadiusError(gd.points) < 1e-12, `gd points on sphere (err ${fmt(maxRadiusError(gd.points))})`);
  check(maxRadiusError(lb.points) < 1e-12, `lbfgs points on sphere (err ${fmt(maxRadiusError(lb.points))})`);

  // Both must terminate on a convergence test, not by exhausting the budget.
  check(gd.converged, `gd converged in ${gd.steps} steps`);
  check(lb.converged, `lbfgs converged in ${lb.steps} steps`);

  // Both must have gone downhill from where they started.
  check(gd.obj < gd.obj0, `gd decreased the objective`);
  check(lb.obj < lb.obj0, `lbfgs decreased the objective`);

  // The claim L-BFGS is here to make: fewer O(N^2) evaluations, which is the
  // only cost that matters. Not asserted per-case at a fixed factor, because
  // the small-N spherical cases are close to parity; asserted as "not
  // materially worse", with the actual ratios in the summary table.
  check(lb.evals < gd.evals * 1.5,
    `lbfgs evals ${lb.evals} vs gd ${gd.evals} (${(gd.evals / Math.max(1, lb.evals)).toFixed(2)}x)`);

  // Deliberately NOT asserted: that L-BFGS reaches the same or a lower
  // objective than gradient descent. On a landscape with exponentially many
  // local minima the two trajectories diverge within a few steps and settle in
  // different basins, either way round - see the note in physics.js. What is
  // worth bounding is that L-BFGS has not gone somewhere absurd, so the gap is
  // only sanity-checked at a loose tolerance and reported for inspection.
  const scale = 1 + Math.abs(gd.obj);
  const objGap = (lb.obj - gd.obj) / scale;
  check(Math.abs(objGap) < 1e-2, `objective within 1% of gd (rel gap ${fmt(objGap, 9)})`);

  rows.push([
    c.name, gd.steps, gd.evals, lb.steps, lb.evals,
    (gd.evals / Math.max(1, lb.evals)).toFixed(2) + "x",
    fmt(gd.obj, 8), fmt(lb.obj, 8),
    objGap < -1e-9 ? "L-BFGS" : objGap > 1e-9 ? "GD" : "tie",
  ]);

  console.log(`   gd:    steps=${gd.steps} evals=${gd.evals} obj=${fmt(gd.obj, 8)} maxF=${fmt(gd.maxForce)} res=${fmt(gd.residual)}`);
  console.log(`   lbfgs: steps=${lb.steps} evals=${lb.evals} obj=${fmt(lb.obj, 8)} maxF=${fmt(lb.maxForce)} res=${fmt(lb.residual)} lsFail=${lb.lsFailures} skipped=${lb.skipped}`);
  console.log("");
}

// ---------- summary table ----------
const widths = header.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(line(r));

console.log(`\n${failures === 0 ? "All checks passed" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
