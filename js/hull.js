"use strict";

// ---------- 3D convex hull (incremental) ----------
// Points already lie on the unit sphere, so the hull's facets are exactly
// the spherical Delaunay triangulation - no interior points to discard, and
// (since the sphere is strictly convex) every distinct point is guaranteed
// to end up as a hull vertex; none can be "swallowed" as interior.
//
// Classic incremental algorithm: build an initial tetrahedron, then insert
// the remaining points one at a time. Each insertion finds the faces
// visible from the new point, removes them, and stitches new faces between
// the point and the resulting "horizon" ring left behind. Visibility tests
// are done against the full current face list each insertion (~O(N) faces
// x O(N) insertions = O(N^2)) rather than a full conflict-graph
// implementation, which would bring it down to the textbook O(N log N)
// expected time - a reasonable further step if N grows into the many
// hundreds (see TODO.md), but not needed at current problem sizes, and this
// is already a large win over the O(N^2) *distance matrix* it replaces
// (dot products instead of sqrt'd distances, and only a small per-vertex
// neighbour set to post-filter instead of all N-1 others).
const HULL_EPS = 1e-9;

function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vLen(a) { return Math.sqrt(vDot(a, a)); }

// A face stores its 3 vertex indices in outward-CCW winding order, plus a
// precomputed outward normal so a visibility test is a single dot product.
function makeFace(pts, a, b, c) {
  const normal = vCross(vSub(pts[b], pts[a]), vSub(pts[c], pts[a]));
  return { a, b, c, normal, v0: pts[a] };
}

function faceVisible(face, p) {
  return vDot(face.normal, vSub(p, face.v0)) > HULL_EPS;
}

// Picks 4 extremal, non-coplanar points to seed the hull (max-spread
// selection, not just the first 4 points, to keep the seed numerically
// well-conditioned). Returns null if the whole point set is degenerate
// (coplanar) - callers should fall back to a non-hull method in that case.
function findInitialTetrahedron(pts) {
  const n = pts.length;
  let iMin = 0;
  for (let i = 1; i < n; i++) if (pts[i][0] < pts[iMin][0]) iMin = i;
  let a = iMin, b = -1, bestD = -1;
  for (let i = 0; i < n; i++) {
    if (i === a) continue;
    const d = vLen(vSub(pts[i], pts[a]));
    if (d > bestD) { bestD = d; b = i; }
  }
  if (bestD < HULL_EPS) return null;

  const ab = vSub(pts[b], pts[a]);
  let c = -1; bestD = -1;
  for (let i = 0; i < n; i++) {
    if (i === a || i === b) continue;
    const d = vLen(vCross(ab, vSub(pts[i], pts[a])));
    if (d > bestD) { bestD = d; c = i; }
  }
  if (bestD < HULL_EPS) return null;

  const planeNormal = vCross(ab, vSub(pts[c], pts[a]));
  let d = -1; bestD = -1;
  for (let i = 0; i < n; i++) {
    if (i === a || i === b || i === c) continue;
    const dist = Math.abs(vDot(planeNormal, vSub(pts[i], pts[a])));
    if (dist > bestD) { bestD = dist; d = i; }
  }
  if (bestD < HULL_EPS) return null;

  // Orient each of the 4 faces so its outward normal points away from the
  // tetrahedron's 4th vertex (the one not on that face).
  const orient = (x, y, z, other) => {
    const f = makeFace(pts, x, y, z);
    return vDot(f.normal, vSub(pts[other], f.v0)) > 0 ? [x, z, y] : [x, y, z];
  };
  return [
    orient(a, b, c, d),
    orient(a, b, d, c),
    orient(a, c, d, b),
    orient(b, c, d, a),
  ].map(([x, y, z]) => makeFace(pts, x, y, z));
}

// Returns an array of outward-oriented triangular faces [i, j, k], or null
// if the points are degenerate for hull purposes (fewer than 4 points, or
// all coplanar).
function computeConvexHull3D(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let faces = findInitialTetrahedron(pts);
  if (!faces) return null;
  const placed = new Set();
  for (const f of faces) { placed.add(f.a); placed.add(f.b); placed.add(f.c); }

  for (let p = 0; p < n; p++) {
    if (placed.has(p)) continue;
    const point = pts[p];
    const visible = [], keep = [];
    for (const f of faces) (faceVisible(f, point) ? visible : keep).push(f);
    if (visible.length === 0) continue; // interior to current partial hull - can't happen for distinct sphere points, but harmless if it did

    // Directed-edge ownership map for the *visible* faces only: in a closed,
    // consistently-wound mesh each undirected edge {u,v} is owned as u->v by
    // one adjacent face and as v->u by the other. So for a visible face's
    // edge u->v, the edge is a horizon edge (borders a *kept* face) exactly
    // when the reverse v->u is not also a visible face's edge.
    const visDirected = new Set();
    for (const f of visible) {
      visDirected.add(`${f.a},${f.b}`);
      visDirected.add(`${f.b},${f.c}`);
      visDirected.add(`${f.c},${f.a}`);
    }
    const newFaces = [];
    for (const f of visible) {
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
        if (!visDirected.has(`${v},${u}`)) newFaces.push(makeFace(pts, u, v, p));
      }
    }
    faces = keep.concat(newFaces);
    placed.add(p);
  }
  return faces.map((f) => [f.a, f.b, f.c]);
}
