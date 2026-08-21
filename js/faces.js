"use strict";

// ---------- face detection (visual-only layer) ----------
// Merges convex-hull triangles into genuine flat n-gon faces wherever two
// triangles are both mesh-adjacent (share a hull edge) AND their outward
// normals are nearly parallel. Requiring *adjacency*, not just parallel
// normals, is what keeps this from ever conflating a real flat face with a
// merely-coplanar non-face - e.g. an octahedron's internal diagonal plane
// is coplanar with nothing in particular on the hull, and more to the
// point those two "inner square" triangles never appear in the hull's
// triangle list at all, let alone share an edge with each other.
//
// Because a convex hull's intersection with any supporting plane is itself
// convex, a group of coplanar-adjacent triangles always traces out a single
// simple polygon - there's no bowtie/self-intersection case to design
// around, just float-precision robustness (see the fallback in trace()).
//
// Early in a simulation, dihedral angles between adjacent triangles are
// generically far from 0 degrees, so nothing merges and every triangle
// surfaces as its own 3-sided group - the "messy everything-else" case
// upfront is simply the generic case, requiring no special-casing here.
// (Rendering additionally chooses not to draw 3-sided groups by default,
// see render.js/main.js, so that generic triangle soup stays invisible
// until the user explicitly asks to see it.)
const FACE_COPLANAR_DOT = 0.9995; // ~1.8 degree dihedral tolerance

function faceUnitNormal(pts, a, b, c) {
  const pa = pts[a], pb = pts[b], pc = pts[c];
  const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
  const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len, len]; // len (pre-normalize) reused for area below
}

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function makeUnionFind(n) {
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; }
  return { find, union };
}

// Traces a merged group's boundary into an ordered vertex loop, using the
// directed-edge ownership already computed by hull.js's consistent CCW
// winding: a boundary directed edge u->v is one whose owning triangle is in
// this group while the reverse v->u's owner is not (every hull edge has
// exactly 2 owners total, one per direction, so "not in this group" also
// covers the group-has-no-neighbour-here case). Chaining u->v pairs
// head-to-tail reconstructs the loop in the same outward-CCW orientation
// the underlying triangles already had.
function traceBoundary(triIdxs, tris, owner) {
  const triSet = new Set(triIdxs);
  const nextFrom = new Map();
  let edgeCount = 0, duplicate = false;
  for (const t of triIdxs) {
    const [a, b, c] = tris[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const revOwner = owner.get(`${v},${u}`);
      if (revOwner !== undefined && triSet.has(revOwner)) continue; // internal edge, not part of boundary
      if (nextFrom.has(u)) duplicate = true;
      nextFrom.set(u, v);
      edgeCount++;
    }
  }
  if (duplicate || edgeCount < 3) return null;

  const start = nextFrom.keys().next().value;
  const loop = [];
  let cur = start;
  for (let iter = 0; iter < edgeCount; iter++) {
    loop.push(cur);
    cur = nextFrom.get(cur);
    if (cur === undefined) return null;
  }
  if (cur !== start || loop.length !== edgeCount) return null;
  return loop;
}

// Core face-merging computation, factored out of computeFaces() so it can
// also run on an arbitrary subset of points, mirroring
// computeEdgesForPoints's role for the "non-local edges" feature.
function computeFacesForPoints(pts) {
  const tris = computeConvexHull3D(pts);
  if (!tris) return { faces: [] };

  const nTri = tris.length;
  const normals = new Array(nTri);
  const triArea = new Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tris[t];
    const [nx, ny, nz, crossLen] = faceUnitNormal(pts, a, b, c);
    normals[t] = [nx, ny, nz];
    triArea[t] = crossLen / 2;
  }

  // Directed-edge -> owning triangle index (exactly one owner per direction
  // on a closed, consistently-wound manifold hull - the same invariant
  // hull.js itself relies on for horizon detection).
  const owner = new Map();
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tris[t];
    owner.set(`${a},${b}`, t);
    owner.set(`${b},${c}`, t);
    owner.set(`${c},${a}`, t);
  }

  const uf = makeUnionFind(nTri);
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tris[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const other = owner.get(`${v},${u}`);
      if (other === undefined || other <= t) continue; // each undirected edge considered once
      if (dot3(normals[t], normals[other]) > FACE_COPLANAR_DOT) uf.union(t, other);
    }
  }

  const groups = new Map(); // root triIdx -> [triIdx, ...]
  for (let t = 0; t < nTri; t++) {
    const r = uf.find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }

  const faces = [];
  for (const triIdxs of groups.values()) {
    const area = triIdxs.reduce((s, t) => s + triArea[t], 0);
    if (triIdxs.length === 1) {
      faces.push({ vertices: tris[triIdxs[0]].slice(), sides: 3, area });
      continue;
    }
    const loop = traceBoundary(triIdxs, tris, owner);
    if (loop) {
      faces.push({ vertices: loop, sides: loop.length, area });
    } else {
      // Defensive fallback (shouldn't trigger given hull-convexity, see
      // header comment) - keep this group's triangles unmerged rather than
      // risk drawing a malformed polygon.
      for (const t of triIdxs) faces.push({ vertices: tris[t].slice(), sides: 3, area: triArea[t] });
    }
  }
  return { faces };
}

// Perimeter of a face's boundary, following the Shape control for the same
// reason the edge tooltip's Length row does: it's the length of the boundary
// as drawn, chords or great-circle arcs. (The Area reported alongside it is
// the flat polygon's, in both modes - a spherical patch's own area needs the
// angle sum, which nothing here computes.)
function facePerimeter(vertices) {
  const arcs = state.shapeStyle === "arcs";
  let total = 0;
  for (let k = 0; k < vertices.length; k++) {
    const p = state.points[vertices[k]], q = state.points[vertices[(k + 1) % vertices.length]];
    if (arcs) {
      total += Math.acos(Math.max(-1, Math.min(1, dot3(p, q))));
    } else {
      total += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
  }
  return total;
}

// Newell's method: robust for an n-gon whose consecutive triples can be
// near-collinear, where a single cross product isn't, and exact for a
// triangle. Then flipped to point outward, which every face of a hull of
// points on an origin-centred sphere identifies unambiguously by its own
// centroid - so the result doesn't depend on the caller's winding.
function facePlaneNormal(vertices) {
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < vertices.length; k++) {
    const p = state.points[vertices[k]], q = state.points[vertices[(k + 1) % vertices.length]];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0]; cy += p[1]; cz += p[2];
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0)) return null;
  const sign = (nx * cx + ny * cy + nz * cz) < 0 ? -1 : 1;
  return [sign * nx / len, sign * ny / len, sign * nz / len];
}

// Dihedral angle along an edge: the interior angle between the two faces
// meeting there, 180 degrees meaning they lie flat. Costs nothing per frame
// because it's only ever asked for the one edge under the cursor, and the
// faces are already sitting in state._faces with their boundaries in order.
//
// Returns NaN unless exactly two faces claim the edge, which is the honest
// answer in the cases where they don't: an edge running *through* a merged
// face has no dihedral to report (its two triangles are why the face merged
// in the first place), and with vertices hidden, local and non-local faces
// can overlap enough for three or more to share an edge, leaving no single
// well-defined pair.
function edgeDihedralDeg(i, j) {
  if (!state._faces) return NaN;
  const touching = [];
  for (const face of state._faces) {
    const vs = face.vertices;
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k], b = vs[(k + 1) % vs.length];
      if ((a === i && b === j) || (a === j && b === i)) { touching.push(vs); break; }
    }
    if (touching.length > 2) return NaN;
  }
  if (touching.length !== 2) return NaN;
  const n1 = facePlaneNormal(touching[0]), n2 = facePlaneNormal(touching[1]);
  if (!n1 || !n2) return NaN;
  // Both normals point outward, so the angle between them is the amount the
  // surface turns at the edge - the interior dihedral is its supplement.
  return 180 - Math.acos(Math.max(-1, Math.min(1, dot3(n1, n2)))) * 180 / Math.PI;
}

// English polygon names, indexed by side count (index 0-2 unused). Beyond
// icosagon (20 sides) there's no common single-word English name in
// everyday use, so callers should fall back to "N-gon" past this table.
const FACE_SIDE_NAMES = [
  undefined, undefined, undefined,
  "Triangle", "Quadrilateral", "Pentagon", "Hexagon", "Heptagon", "Octagon",
  "Nonagon", "Decagon", "Hendecagon", "Dodecagon", "Tridecagon",
  "Tetradecagon", "Pentadecagon", "Hexadecagon", "Heptadecagon",
  "Octadecagon", "Nonadecagon", "Icosagon",
];
function faceSidesName(sides) {
  return FACE_SIDE_NAMES[sides] || `${sides}-gon`;
}

function computeFaces() {
  const { faces } = computeFacesForPoints(state.points);
  state._faces = faces;
  return faces;
}
