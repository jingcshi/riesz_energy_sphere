"use strict";

// Topological invariants of the two geometry layers, over the same quantities
// the Geometry table reports. Two levels, checked separately so a failure says
// which layer broke.
//
// LEVEL 1 - the hull (js/hull.js). A convex hull of distinct points on a
//   sphere must be a closed, consistently-wound, orientable triangulation with
//   every point a vertex: each directed edge owned exactly once, each having
//   its reverse, every facet plane supporting the whole set, and V-E+F=2.
//
// LEVEL 2 - the face merge (js/faces.js), counted exactly as render.js counts
//   it: V is every point, E is the distinct undirected boundary edges of the
//   face set, F is the face count. This is the layer that regressed. A merged
//   group that absorbed every triangle around some vertex left that vertex on
//   no face boundary, so it belonged to no cell of the tiling while V still
//   counted it, raising chi by exactly 1 per swallowed vertex. Seed 933924
//   reached chi=3 at N=981 and chi=4 at N=993; the orphan list is asserted
//   empty rather than just chi==2 so a future regression names the vertex.
//
// Both levels are checked on random configurations and on partly relaxed ones,
// and level 2 additionally on the degree-hiding subsets render.js retriangulates.
//
// Against the pre-fix faces.js the reported case fails as chi=3 with orphan
// [547] from N=981 and chi=4 with orphans [547,667] from N=993.
//
// Run: node test/topology.js  (~5 min: the relaxations at N=1000 and the
// O(F*N) supporting-plane pass dominate)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = ["rng", "geometry", "physics", "hull", "edges", "faces"]
  .map((m) => fs.readFileSync(path.join(ROOT, "js", `${m}.js`), "utf8"))
  .join("\n");

const ctx = vm.createContext({
  console, Math, Number, Infinity, NaN, Float64Array, Int32Array, Array, Set, Map, WeakMap,
});
vm.runInContext(src, ctx, { filename: "bundle.js" });
const {
  state, resetConfiguration, stepPhysics, computeConvexHull3D,
  computeFacesForPoints, computeEdgesForPoints,
} = vm.runInContext(
  "({ state, resetConfiguration, stepPhysics, computeConvexHull3D," +
  "   computeFacesForPoints, computeEdgesForPoints })", ctx);

let failures = 0;
function fail(msg) { failures++; console.log(`  FAIL  ${msg}`); }

// ---------- level 1 ----------
function checkHull(label, pts) {
  const tris = computeConvexHull3D(pts);
  if (!tris) { fail(`${label}: hull degenerate for ${pts.length} points`); return null; }

  const dirCount = new Map();
  const undirected = new Set();
  const verts = new Set();
  for (const [a, b, c] of tris) {
    verts.add(a); verts.add(b); verts.add(c);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      dirCount.set(`${u},${v}`, (dirCount.get(`${u},${v}`) || 0) + 1);
      undirected.add(u < v ? `${u},${v}` : `${v},${u}`);
    }
  }
  for (const [d, k] of dirCount) {
    const [u, v] = d.split(",");
    if (k > 1) { fail(`${label}: directed edge ${d} owned by ${k} triangles`); return tris; }
    if (!dirCount.has(`${v},${u}`)) { fail(`${label}: directed edge ${d} has no reverse`); return tris; }
  }
  if (verts.size !== pts.length) {
    fail(`${label}: ${pts.length - verts.size} points missing from the hull`);
    return tris;
  }
  const chi = verts.size - undirected.size + tris.length;
  if (chi !== 2) fail(`${label}: hull chi=${chi}`);
  return tris;
}

// The supporting-plane test is O(F*N), too slow to run at every N, so it is
// applied to a sample of the largest cases only.
function checkSupporting(label, pts, tris) {
  for (const [a, b, c] of tris) {
    const pa = pts[a], pb = pts[b], pc = pts[c];
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const s = nx * (q[0] - pa[0]) + ny * (q[1] - pa[1]) + nz * (q[2] - pa[2]);
      if (s > 1e-9) { fail(`${label}: facet ${a},${b},${c} not supporting (${s.toExponential(2)})`); return; }
    }
  }
}

// ---------- level 2 ----------
function checkFaces(label, pts) {
  const { faces } = computeFacesForPoints(pts);
  if (!faces.length) { fail(`${label}: no faces`); return; }
  const boundary = new Set();
  const onBoundary = new Set();
  for (const f of faces) {
    const vs = f.vertices;
    if (vs.length !== f.sides) fail(`${label}: face sides=${f.sides} but loop length=${vs.length}`);
    if (new Set(vs).size !== vs.length) fail(`${label}: face loop repeats a vertex: ${vs.join(",")}`);
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k], b = vs[(k + 1) % vs.length];
      onBoundary.add(a); onBoundary.add(b);
      boundary.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  }
  const orphans = [];
  for (let i = 0; i < pts.length; i++) if (!onBoundary.has(i)) orphans.push(i);
  if (orphans.length) fail(`${label}: ${orphans.length} vertices on no face boundary: ${orphans.join(",")}`);
  const chi = pts.length - boundary.size + faces.length;
  if (chi !== 2) fail(`${label}: face-layer chi=${chi} (V=${pts.length} E=${boundary.size} F=${faces.length})`);
}

// ---------- sweeps ----------
function configure(N, seed, p, metric, steps) {
  state.N = N; state.seed = seed; state.p = p; state.metric = metric;
  resetConfiguration();
  for (let s = 0; s < steps; s++) stepPhysics();
  return state.points;
}

console.log("1. the reported case: seed 933924, N=976..1024, initial configuration");
for (let N = 976; N <= 1024; N++) {
  const pts = configure(N, 933924, 1.0, "euclidean", 0);
  const label = `N=${N} s=933924 step0`;
  checkHull(label, pts);
  checkFaces(label, pts);
}

console.log("2. random configurations across seeds and N");
for (const seed of [1, 42, 777, 2026, 12345, 933924]) {
  for (const N of [4, 5, 8, 12, 32, 64, 137, 256, 512, 800, 1000, 1024]) {
    const pts = configure(N, seed, 1.0, "euclidean", 0);
    const label = `N=${N} s=${seed} step0`;
    checkHull(label, pts);
    checkFaces(label, pts);
  }
}

console.log("3. relaxed configurations (merging is far more common near an optimum)");
for (const [N, p, metric] of [[64, 1, "euclidean"], [128, 1, "euclidean"], [256, 2, "euclidean"],
                              [512, 1, "euclidean"], [1000, 1, "euclidean"], [64, 1, "spherical"],
                              [256, 6, "euclidean"], [1000, 0, "euclidean"]]) {
  for (const steps of [1, 10, 100, 500]) {
    const pts = configure(N, 933924, p, metric, steps);
    const label = `N=${N} p=${p} ${metric} step${steps}`;
    checkHull(label, pts);
    checkFaces(label, pts);
  }
}

console.log("4. supporting-plane check on the largest cases");
for (const N of [512, 1000, 1024]) {
  const pts = configure(N, 933924, 1.0, "euclidean", 0);
  checkSupporting(`N=${N} s=933924 step0`, pts, computeConvexHull3D(pts));
}

console.log("5. degree-hiding subsets, the retriangulation render.js runs");
for (const [N, steps] of [[64, 0], [64, 300], [256, 0], [256, 300], [1000, 0]]) {
  const pts = configure(N, 933924, 1.0, "euclidean", steps);
  const { degree } = computeEdgesForPoints(pts);
  const present = Array.from(new Set(degree)).sort((a, b) => a - b);
  for (const hide of present) {
    const subPts = pts.filter((_, i) => degree[i] !== hide);
    if (subPts.length < 4) continue;
    const label = `N=${N} step${steps} hiding degree ${hide} (${subPts.length} left)`;
    checkHull(label, subPts);
    checkFaces(label, subPts);
  }
}

console.log(failures === 0 ? "\nAll topology checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
