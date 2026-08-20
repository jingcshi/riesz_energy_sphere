"use strict";

// ---------- neighbour graph ----------
// Primary path: the 3D convex hull (js/hull.js) IS the spherical Delaunay
// triangulation here, since every point lies exactly on the unit sphere -
// O(N^2) worst case (see hull.js), but with only dot products per test and
// avg. ~6 hull-incident candidates per vertex afterwards, versus a full
// O(N^2) sqrt'd distance matrix. Falls back to that all-pairs distance
// matrix only when the hull degenerates (N<4, or coplanar points).
//
// EDGE_C still matters even with a real triangulation: raw hull output is
// simplicial (triangles only), so a literal quadrilateral face (e.g. the
// square antiprism's two square faces at N=8) comes back as two triangles
// joined by an arbitrary diagonal - a spurious "X across a square". EDGE_C
// resolves that by dropping, per vertex, any incident hull edge longer than
// EDGE_C times that vertex's shortest incident edge - this is exactly the
// diagonal-vs-side test needed to un-triangulate a coplanar quad, but now
// applied to ~6 hull-given candidates per vertex instead of all N-1 others
// (the heuristic's role flips from "find the edges" to "filter an
// already-correct candidate set").
//
// Bounds below, found empirically by relaxing the actual energy minimizers
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
const EDGE_C = 1.3;

function pointDist(pts, i, j) {
  const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Fallback for degenerate point sets (N<4 or coplanar): all-pairs distance
// matrix, exactly as before the hull was introduced.
function allPairsNeighbours(pts) {
  const n = pts.length;
  const neighbourSets = new Array(n);
  for (let i = 0; i < n; i++) neighbourSets[i] = new Set();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      neighbourSets[i].add(j);
      neighbourSets[j].add(i);
    }
  }
  return neighbourSets;
}

// Core Delaunay(-on-sphere) + EDGE_C computation, factored out of computeEdges()
// so it can also be run on an arbitrary *subset* of points - see the
// "non-local edges" use in render.js, which reruns this on just the
// currently visible (non-hidden) points to reveal their own triangulation
// once the rest have been hidden away.
function computeEdgesForPoints(pts) {
  const n = pts.length;
  if (n < 2) return { edges: [], degree: new Array(n).fill(0), nearest: new Array(n).fill(Infinity) };

  const hullFaces = computeConvexHull3D(pts);
  const neighbourSets = new Array(n);
  for (let i = 0; i < n; i++) neighbourSets[i] = new Set();
  if (hullFaces) {
    for (const [a, b, c] of hullFaces) {
      neighbourSets[a].add(b); neighbourSets[b].add(a);
      neighbourSets[b].add(c); neighbourSets[c].add(b);
      neighbourSets[c].add(a); neighbourSets[a].add(c);
    }
  } else {
    const fallback = allPairsNeighbours(pts);
    for (let i = 0; i < n; i++) neighbourSets[i] = fallback[i];
  }

  const nearest = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++)
    for (const j of neighbourSets[i]) {
      const d = pointDist(pts, i, j);
      if (d < nearest[i]) nearest[i] = d;
    }

  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const threshold = EDGE_C * nearest[i];
    for (const j of neighbourSets[i]) {
      if (pointDist(pts, i, j) > threshold) continue;
      const key = i < j ? i * 1000000 + j : j * 1000000 + i;
      if (!seen.has(key)) { seen.add(key); edges.push([Math.min(i, j), Math.max(i, j)]); }
    }
  }

  const degree = new Array(n).fill(0);
  for (const [a, b] of edges) { degree[a]++; degree[b]++; }

  return { edges, degree, nearest };
}

function computeEdges() {
  const { edges, degree, nearest } = computeEdgesForPoints(state.points);
  state._nearest = nearest; // exposed for the hover info panel's r0 readout
  state._degree = degree;   // exposed for the degree histogram and its vertex highlighting
  return edges;
}

function depthAlpha(z) {
  const depth = depthWithOpacity((z + 1) / 2); // 0 (back) .. 1 (front)
  return 0.06 + depth * 0.5;
}

const ARC_SEGMENTS = 14;

// Projects each edge into screen space once, as a polyline (2 points for
// "lines" style, ARC_SEGMENTS+1 for "arcs"). Shared by drawEdges (so the
// rendered path and the hover hit-test path can never drift apart) and by
// hover.js for accurate arc hit-testing. `edges` is an array of either
// [i, j] pairs or {i, j, nonLocal} descriptors - nonLocal (see render.js)
// marks a real, physically-interacting pair that just isn't part of the
// Delaunay triangulation over the currently-visible points, carried through
// so it can be drawn dashed to distinguish it from a "local" hull edge.
function computeEdgeScreenPaths(edges, cx, cy, scale) {
  const paths = [];
  for (const e of edges) {
    const i = Array.isArray(e) ? e[0] : e.i;
    const j = Array.isArray(e) ? e[1] : e.j;
    const nonLocal = Array.isArray(e) ? false : !!e.nonLocal;
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
    paths.push({ i, j, pa, pb, path, nonLocal });
  }
  return paths;
}

function drawEdges(ctx, edgePaths) {
  if (!edgePaths.length) return;
  ctx.lineWidth = 2.0;
  for (const { pa, pb, path, nonLocal } of edgePaths) {
    // a single linear gradient between the endpoints approximates the
    // front-to-back fade even along a curved (arc) path
    const gradient = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    gradient.addColorStop(0, `rgba(88,166,255,${depthAlpha(pa.z)})`);
    gradient.addColorStop(1, `rgba(88,166,255,${depthAlpha(pb.z)})`);
    ctx.strokeStyle = gradient;
    // Dashed rather than dimmer: these are just as real/physically
    // interacting a pair as any other edge, only excluded from the
    // Delaunay triangulation over the currently-visible points.
    ctx.setLineDash(nonLocal ? [5, 4] : []);

    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let k = 1; k < path.length; k++) ctx.lineTo(path[k].x, path[k].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
