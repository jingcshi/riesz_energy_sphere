"use strict";

// ---------- neighbour graph ----------
// For each point, connect it to every other point within EDGE_C times its
// nearest-neighbour distance. O(N^2), trivial for N <= 100.
//
// EDGE_C bounds, found empirically by relaxing the actual energy minimizers
// for small N (see git history / chat log for the derivation script) and
// reading off, per vertex, the ratio of its longest "true" hull edge and its
// shortest "false" (non-adjacent) distance, both relative to its own nearest
// neighbour:
//   N=5  (triangular bipyramid): need c >= sqrt(3/2) = 1.2247, c < sqrt(2) = 1.4142
//   N=6  (octahedron):           c < sqrt(2) = 1.4142 (equatorial "square" diagonal)
//   N=7:                         need c >= ~1.22,      c < ~1.43
//   N=8  (square antiprism):     need c >= ~1.09,      c < sqrt(2) = 1.4142
//   N=9:                         need c >= ~1.24,      c < ~1.52
// The sqrt(2) ceiling recurs because it's a pure Euclidean fact (a square's
// diagonal is always sqrt(2) times its side) independent of p, N, or energy -
// it shows up whenever the hull has a square face (N=6, N=8, ...).
//
// Note this does NOT keep improving with N as one might hope: N=9's lower
// bound (~1.24) is already tighter than N=5's, and spot checks up to N=30
// found individual 5-fold-defect vertices needing c beyond 1.4 - i.e. no
// single constant is exactly correct for every N. EDGE_C is a heuristic that
// works well for typical/most vertices, not an exact hull reconstruction; a
// true convex-hull (Delaunay-on-sphere) triangulation would be the robust
// fix for a future iteration.
const EDGE_C = 1.3;

function computeEdges() {
  const pts = state.points;
  const n = pts.length;
  if (n < 2) return [];
  const dist = new Array(n);
  for (let i = 0; i < n; i++) dist[i] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      dist[i][j] = d; dist[j][i] = d;
    }
  }
  const nearest = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && dist[i][j] < nearest[i]) nearest[i] = dist[i][j];
  state._nearest = nearest; // exposed for the hover info panel's r0 readout

  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const threshold = EDGE_C * nearest[i];
    for (let j = 0; j < n; j++) {
      if (i === j || dist[i][j] > threshold) continue;
      const key = i < j ? i * 1000 + j : j * 1000 + i;
      if (!seen.has(key)) { seen.add(key); edges.push([Math.min(i, j), Math.max(i, j)]); }
    }
  }
  return edges;
}

function depthAlpha(z) {
  const depth = (z + 1) / 2; // 0 (back) .. 1 (front)
  return 0.06 + depth * 0.5;
}

const ARC_SEGMENTS = 14;

// Projects each edge into screen space once, as a polyline (2 points for
// "lines" style, ARC_SEGMENTS+1 for "arcs"). Shared by drawEdges (so the
// rendered path and the hover hit-test path can never drift apart) and by
// hover.js for accurate arc hit-testing.
function computeEdgeScreenPaths(edges, cx, cy, scale) {
  const paths = [];
  for (const [i, j] of edges) {
    const u = state.points[i], v = state.points[j];
    const uRot = rotate(u, state.viewMatrix);
    const vRot = rotate(v, state.viewMatrix);
    const pa = project(uRot, cx, cy, scale);
    const pb = project(vRot, cx, cy, scale);

    let path;
    if (state.edgeStyle === "arcs") {
      const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
      const omega = Math.acos(dot);
      const sinOmega = Math.sin(omega);
      path = [pa];
      for (let s = 1; s <= ARC_SEGMENTS; s++) {
        const wp = slerp(u, v, s / ARC_SEGMENTS, omega, sinOmega);
        path.push(project(rotate(wp, state.viewMatrix), cx, cy, scale));
      }
    } else {
      path = [pa, pb];
    }
    paths.push({ i, j, pa, pb, path });
  }
  return paths;
}

function drawEdges(ctx, edgePaths) {
  if (!edgePaths.length) return;
  ctx.lineWidth = 2.0;
  for (const { pa, pb, path } of edgePaths) {
    // a single linear gradient between the endpoints approximates the
    // front-to-back fade even along a curved (arc) path
    const gradient = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    gradient.addColorStop(0, `rgba(88,166,255,${depthAlpha(pa.z)})`);
    gradient.addColorStop(1, `rgba(88,166,255,${depthAlpha(pb.z)})`);
    ctx.strokeStyle = gradient;

    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let k = 1; k < path.length; k++) ctx.lineTo(path[k].x, path[k].y);
    ctx.stroke();
  }
}
