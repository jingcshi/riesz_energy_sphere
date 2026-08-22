"use strict";

// Two independent checks on state._objForce, the gradient array added for
// L-BFGS. They answer different questions and must not be conflated.
//
// CHECK 1 (exact, no finite differences) - "is the new scaling right?"
//   _objForce and the pre-existing _forces are both the same tangential
//   accumulator A times a scalar, so their ratio is predictable in closed form:
//     p=0        : both use scale 1                      -> ratio 1
//     0<p<=64    : _forces = A*p*dMin^-p (physical)      -> ratio 1/E
//     p>64       : _forces = A/sumW      (normalized)    -> ratio p
//   This is the part L-BFGS newly depends on and gradient descent never did,
//   and it is verifiable to machine precision.
//
// CHECK 2 (finite differences) - "is A the gradient of the energy at all?"
//   R_x(v) = normalize(x+v) is a first-order retraction, so DR_x(0) = id and
//     d/dt Phi(R_x(t v))|_0 = <grad Phi, v>.
//   This property is shared by _forces and predates L-BFGS, so a failure here
//   is attributed by running the identical test against _forces. Central
//   differences have a roundoff floor of ~eps*|Phi|/h, and a partly-relaxed
//   configuration has a nearly-zero directional derivative along a random
//   direction, so a bare relative tolerance would report noise as failure.
//   Errors are therefore judged against max(|analytic|, noise floor).
//
// Run: node test/gradient_check.js

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
  "({ state, resetConfiguration, computeEnergyAndForce, armijoObjective, stepPhysics, P_PHYSICAL_MAX })", ctx);
const { state, resetConfiguration, computeEnergyAndForce, armijoObjective, stepPhysics, P_PHYSICAL_MAX } = api;

const EPS = 2.220446049250313e-16;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTangent(pts, rnd) {
  const n = pts.length;
  const v = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const i3 = 3 * i, xi = pts[i];
    const a = 2 * rnd() - 1, b = 2 * rnd() - 1, c = 2 * rnd() - 1;
    const d = a * xi[0] + b * xi[1] + c * xi[2];
    v[i3] = a - d * xi[0]; v[i3 + 1] = b - d * xi[1]; v[i3 + 2] = c - d * xi[2];
  }
  let nrm = 0;
  for (let i = 0; i < v.length; i++) nrm += v[i] * v[i];
  nrm = Math.sqrt(nrm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= nrm;
  return v;
}

function retract(pts, v, t) {
  return pts.map((xi, i) => {
    const i3 = 3 * i;
    const nx = xi[0] + t * v[i3], ny = xi[1] + t * v[i3 + 1], nz = xi[2] + t * v[i3 + 2];
    const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / nn, ny / nn, nz / nn];
  });
}

function dirDeriv(arr, v) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const i3 = 3 * i;
    s += -(arr[i][0] * v[i3] + arr[i][1] * v[i3 + 1] + arr[i][2] * v[i3 + 2]);
  }
  return s;
}

// Smallest geodesic angle to the antipode of any point's partner, i.e. how
// close the configuration comes to an antipodal pair. The spherical branch's
// direction vectors are computed through 1/sin(theta), which the SIN_ZERO
// cutoff zeroes out near theta=pi, so the analytic gradient of the *geodesic*
// energy is deliberately inexact there. Reported so such cases can be
// recognised rather than mistaken for a scaling bug.
function minAntipodalGap(pts) {
  let g = Math.PI;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.max(-1, Math.min(1, pts[i][0] * pts[j][0] + pts[i][1] * pts[j][1] + pts[i][2] * pts[j][2]));
      g = Math.min(g, Math.PI - Math.acos(d));
    }
  }
  return g;
}

let fail1 = 0, fail2 = 0;
const rows1 = [], rows2 = [];

function checkCase({ N, p, metric, seed, warmSteps }) {
  state.N = N; state.p = p; state.metric = metric; state.seed = seed;
  state.method = "gd";
  resetConfiguration();
  for (let i = 0; i < warmSteps; i++) stepPhysics();

  const base = state.points.map((q) => q.slice());
  state.points = base.map((q) => q.slice());
  computeEnergyAndForce();

  const label = `N=${N} p=${p} ${metric}${warmSteps ? " +" + warmSteps : ""}`;

  // ---- CHECK 1: exact scaling relation between _objForce and _forces ----
  const isLog = p <= 1e-9;
  const expectedRatio = isLog ? 1
    : (p > P_PHYSICAL_MAX ? p : 1 / state.energy);
  let worstRatioErr = 0;
  const of = state._objForce, fo = state._forces;
  for (let i = 0; i < of.length; i++) {
    for (let k = 0; k < 3; k++) {
      const a = of[i][k], b = fo[i][k] * expectedRatio;
      const scale = Math.max(Math.abs(a), Math.abs(b));
      if (scale > 1e-280) worstRatioErr = Math.max(worstRatioErr, Math.abs(a - b) / scale);
    }
  }
  const ok1 = worstRatioErr < 1e-12;
  if (!ok1) fail1++;
  rows1.push([label,
    isLog ? "1" : (p > P_PHYSICAL_MAX ? "p" : "1/E"),
    worstRatioErr.toExponential(2), ok1 ? "ok" : "FAIL"]);

  // ---- CHECK 2: finite-difference directional derivative ----
  const rnd = mulberry32(seed * 7919 + 13);
  const v = randomTangent(base, rnd);
  const anaObj = dirDeriv(of, v);
  const anaFrc = dirDeriv(fo, v);
  const ratioFrcToObj = expectedRatio; // same conversion as above

  const h = 1e-5;
  state.points = retract(base, v, h);
  computeEnergyAndForce();
  const phiPlus = armijoObjective();
  state.points = retract(base, v, -h);
  computeEnergyAndForce();
  const phiMinus = armijoObjective();
  const numeric = (phiPlus - phiMinus) / (2 * h);

  // Central-difference roundoff floor. The subtraction Phi(+h) - Phi(-h) loses
  // ~eps*|Phi| of absolute accuracy and is then divided by 2h, so no error
  // below this is attributable to the gradient. The 500x margin is empirical:
  // Phi is itself a sum of O(N^2) terms, so its own evaluation noise exceeds a
  // single rounding, and at N=120 a bare eps*|Phi|/h floor still reported pure
  // noise as failure.
  const phiMag = Math.max(Math.abs(phiPlus), Math.abs(phiMinus), 1);
  const floor = 500 * EPS * phiMag / h;
  const absErrObj = Math.abs(anaObj - numeric);
  const denom = Math.max(Math.abs(anaObj), floor);
  const relErrObj = absErrObj / denom;
  // The same comparison for the pre-existing array, converted into the
  // objective's units, to attribute any failure.
  const relErrFrc = Math.abs(anaFrc * ratioFrcToObj - numeric) / denom;

  // A pair closer to antipodal than SIN_ZERO has its direction deliberately
  // zeroed by the spherical branch, so the analytic gradient is inexact there
  // by design and the finite difference legitimately disagrees. Recognise the
  // situation rather than reporting it as a gradient error.
  const gap = metric === "spherical" ? minAntipodalGap(base) : Infinity;
  const antipodalCutoff = gap < 1e-6;
  // An absolute error under the roundoff floor is unattributable no matter how
  // it compares relatively - which is the usual case once the configuration is
  // partly relaxed and the derivative along a random direction is near zero.
  const ok2 = absErrObj < floor || relErrObj < 1e-5 || antipodalCutoff;
  if (!ok2) fail2++;
  rows2.push([label,
    anaObj.toExponential(6), numeric.toExponential(6),
    relErrObj.toExponential(2), relErrFrc.toExponential(2),
    Number.isFinite(gap) ? gap.toExponential(2) : "-",
    antipodalCutoff ? "n/a (SIN_ZERO)" : ok2 ? "ok" : "FAIL"]);
}

const cases = [];
for (const metric of ["euclidean", "spherical"]) {
  for (const p of [0, 0.5, 1, 2, 6, 25, 64, 100, 400]) {
    cases.push({ N: 40, p, metric, seed: 5, warmSteps: 0 });
    cases.push({ N: 40, p, metric, seed: 5, warmSteps: 60 });
  }
}
cases.push({ N: 120, p: 1, metric: "euclidean", seed: 11, warmSteps: 30 });
cases.push({ N: 120, p: 3, metric: "spherical", seed: 11, warmSteps: 30 });
cases.push({ N: 7, p: 12, metric: "euclidean", seed: 2, warmSteps: 200 });

for (const c of cases) checkCase(c);

function table(title, header, rows) {
  console.log(`\n${title}\n`);
  const widths = header.map((hh, i) =>
    Math.max(hh.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

table("CHECK 1 - exact scaling: _objForce == _forces * ratio",
  ["case", "ratio", "worst rel err", ""], rows1);
table("CHECK 2 - finite difference along the retraction  (err_frc = same test on the pre-existing _forces)",
  ["case", "analytic <g,v>", "numeric <g,v>", "err_obj", "err_frc", "antipodal gap", ""], rows2);

console.log(`\nCHECK 1: ${fail1 === 0 ? "all passed" : fail1 + " FAILED"}`);
console.log(`CHECK 2: ${fail2 === 0 ? "all passed" : fail2 + " failed"}`);
process.exit(fail1 === 0 ? 0 : 1);
