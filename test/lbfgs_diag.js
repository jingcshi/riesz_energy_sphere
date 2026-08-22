"use strict";

// Diagnostic for a single L-BFGS run: traces residual, step length, restarts
// and memory size so a premature stop can be told apart from convergence to a
// different local minimum.
//
// Run: node test/lbfgs_diag.js [N] [p] [metric] [seed]

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = ["rng", "geometry", "physics"]
  .map((m) => fs.readFileSync(path.join(ROOT, "js", `${m}.js`), "utf8"))
  .join("\n");

const ctx = vm.createContext({ console, Math, Number, Infinity, NaN, Float64Array, Int32Array, Array, Set });
vm.runInContext(src, ctx, { filename: "bundle.js" });
const api = vm.runInContext(
  "({ state, resetConfiguration, computeEnergyAndForce, stepPhysics, armijoObjective })", ctx);
const { state, resetConfiguration, stepPhysics, armijoObjective } = api;

const N = parseInt(process.argv[2] || "64", 10);
const p = parseFloat(process.argv[3] || "1");
const metric = process.argv[4] || "spherical";
const seed = parseInt(process.argv[5] || "1", 10);

const CONVERGED_FORCE = 1e-4;
function isConverged() { return state.maxForce <= CONVERGED_FORCE || state.stalled; }

function trace(method, maxSteps) {
  state.N = N; state.p = p; state.metric = metric; state.seed = seed;
  state.method = method;
  resetConfiguration();

  const log = [];
  let steps = 0;
  let restartsSeen = 0;
  while (steps < maxSteps && !isConverged()) {
    const prevRestarts = state._lbfgsRestarts || 0;
    stepPhysics();
    steps++;
    if ((state._lbfgsRestarts || 0) > prevRestarts) restartsSeen++;
    if (steps % Math.max(1, Math.floor(maxSteps / 40)) === 0 || steps < 5) {
      log.push({
        step: steps,
        obj: armijoObjective(),
        res: state._residual,
        maxF: state.maxForce,
        t: state._lbfgsLastT || 0,
        mem: state._lbfgsS ? state._lbfgsS.length : 0,
        stall: state._stallCount,
        restarts: state._lbfgsRestarts || 0,
        evals: state._evals,
      });
    }
  }
  return { steps, restartsSeen, log,
    final: { obj: armijoObjective(), res: state._residual, maxF: state.maxForce,
             evals: state._evals, stalled: state.stalled,
             lsFail: state._lbfgsLsFailures || 0,
             restarts: state._lbfgsRestarts || 0 } };
}

const e = (x, d = 3) => Number.isFinite(x) ? x.toExponential(d) : String(x);

for (const method of ["lbfgs", "gd"]) {
  console.log(`\n===== ${method}  N=${N} p=${p} ${metric} seed=${seed} =====`);
  const r = trace(method, 40000);
  console.log("  step      obj              residual    maxForce    t          mem  stall  rst  evals");
  for (const L of r.log) {
    console.log(`  ${String(L.step).padStart(6)}  ${L.obj.toFixed(10).padStart(15)}  ` +
      `${e(L.res)}  ${e(L.maxF)}  ${e(L.t)}  ${String(L.mem).padStart(3)}  ` +
      `${String(L.stall).padStart(5)}  ${String(L.restarts).padStart(3)}  ${L.evals}`);
  }
  const f = r.final;
  console.log(`  FINAL steps=${r.steps} evals=${f.evals} obj=${f.obj.toFixed(10)} ` +
    `res=${e(f.res)} maxF=${e(f.maxF)} stalled=${f.stalled} lsFail=${f.lsFail} ` +
    `restarts=${f.restarts} (restart events seen: ${r.restartsSeen})`);
}
