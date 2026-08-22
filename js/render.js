"use strict";

// ---------- rendering ----------
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const wrap = document.getElementById("canvasWrap");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

// ---------- vertex tension colouring ----------
// Vertex tension -> colour on a log scale, four decades wide: red at the top,
// then orange, yellow, mint, and pale (matching --text) at the bottom.
// Colours are plain RGB triples so we can linearly blend both across decades
// and, below, toward the existing depth-based blue as a point recedes into
// the background.
//
// The input is a *ratio*, not a force: each vertex's scale-free residual
// (|grad_i Psi|, the same quantity the Statistics panel reports) divided by
// the largest residual this landscape has held so far. So red means "as tense
// as this configuration ever was" and pale means "four or more decades
// quieter than that" - a genuine convergence proxy at every exponent.
//
// Two earlier candidates both fail, and it's worth recording why:
//   * Raw net force (what this used to take) is not scale-free at all. The
//     physical force's own magnitude grows like e^O(p), so at p=25 every
//     vertex sits at ~1e+8 and pins to red for the whole run - fully
//     converged configurations included.
//   * The absolute residual is scale-free but badly distributed: measured
//     across runs it starts near 1e+1 for p>=6 yet only 2e-1 at p=1, while
//     converged values range over 1e-4 (p=0, p>64) down to 5e-9 (p=6). No
//     fixed four-decade window covers both ends at every p - anchoring the
//     pale end at 1e-4 makes p=1 go pale by step 10 of 237, and widening the
//     ramp stops p=0 and high p reaching pale at all.
// Measuring against the run's own peak sidesteps that entirely: it needs no
// knowledge of where a given exponent's precision floor happens to sit.
const FORCE_COLOR_STOPS = [
  { logF: 0, rgb: [239, 68, 68] },    // red   - at this landscape's peak tension
  { logF: -1, rgb: [249, 115, 22] },  // orange
  { logF: -2, rgb: [234, 179, 8] },   // yellow
  { logF: -3, rgb: [110, 231, 183] }, // mint
  { logF: -4, rgb: [201, 209, 217] }, // pale (var(--text)) - 4+ decades below peak
];

// Vertex i's scale-free residual, in absolute terms. state._forces is in
// physical units below P_PHYSICAL_MAX and already normalized above it, so the
// conversion factor has to come from physics.js rather than being assumed.
function vertexResidual(i) {
  if (!state._forces || !state._forces[i]) return 0;
  const f = state._forces[i];
  return Math.hypot(f[0], f[1], f[2]) * state._residualScale;
}

// ...and the same thing as a fraction of the landscape's peak tension. The
// peak is maxed with the current residual so this is still well defined on
// the first frame after a reset or a p change, before any step has run.
function vertexTensionRatio(i) {
  const peak = Math.max(state._residualPeak || 0, state._residual || 0);
  return peak > 0 ? vertexResidual(i) / peak : 0;
}

// `ratio` is tension relative to the landscape's peak, so it never exceeds 1
// and the clamp below only ever bites at the pale end.
function forceColor(ratio) {
  const logF = Math.max(-4, Math.min(0, Math.log10(Math.max(ratio, 1e-12))));
  for (let k = 0; k < FORCE_COLOR_STOPS.length - 1; k++) {
    const a = FORCE_COLOR_STOPS[k], b = FORCE_COLOR_STOPS[k + 1];
    if (logF <= a.logF && logF >= b.logF) {
      const t = (a.logF - logF) / (a.logF - b.logF);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t,
      ];
    }
  }
  return FORCE_COLOR_STOPS[FORCE_COLOR_STOPS.length - 1].rgb;
}

// ---------- face colouring ----------
// Triangles are the generic case - the vast majority of faces, especially
// pre-convergence - so they get a deliberately muted, non-intrusive
// neutral (the app's own --muted grey-blue) rather than competing for
// attention with a vivid hue. Every *other* side-count gets one of 6
// distinct, mutually-contrasting colours the triangle never uses, cycling
// back to turquoise at 10 sides, yellow at 11, etc. Stable across the app
// (same side-count always gets the same colour) rather than assigned
// per-appearance.
const FACE_TRIANGLE_COLOR = [139, 148, 158]; // matches --muted
const FACE_COLOR_PALETTE = [
  [21, 110, 133],  // teal blue      - 4 (quadrilateral)
  [255, 214, 10],  // yellow         - 5 (pentagon)
  [214, 110, 102], // salmon pink    - 6 (hexagon)
  [46, 204, 113],  // green          - 7 (heptagon)
  [249, 115, 22],  // orange         - 8 (octagon)
  [168, 85, 247],  // purple         - 9 (nonagon)
];
function faceColorRgb(sides) {
  if (sides === 3) return FACE_TRIANGLE_COLOR;
  return FACE_COLOR_PALETTE[(sides - 4) % FACE_COLOR_PALETTE.length];
}
function faceFillColor(sides) {
  const [r, g, b] = faceColorRgb(sides);
  return `rgba(${r}, ${g}, ${b}, 0.28)`;
}
function faceStrokeColor(sides) {
  const [r, g, b] = faceColorRgb(sides);
  return `rgba(${r}, ${g}, ${b}, 0.85)`;
}

// Builds a face's projected screen-space boundary path. In the "arcs" shape
// style, each side is subdivided into great-circle-arc segments (the same
// slerp machinery edges.js uses) so the polygon renders as a genuine
// spherical tile bulging along the sphere's surface; "chords" keeps the flat
// polytope facet a straight line between two vertices would draw. One
// setting drives both layers, so an arc-edged shape can't have flat faces.
function buildFacePath(vertexIdxs, cx, cy, scale) {
  const useArcs = state.shapeStyle === "arcs";
  const m = vertexIdxs.length;
  const path = [];
  for (let k = 0; k < m; k++) {
    const u = state.points[vertexIdxs[k]];
    if (k === 0) path.push(project(rotate(u, state.viewMatrix), cx, cy, scale));
    const v = state.points[vertexIdxs[(k + 1) % m]];
    if (useArcs) {
      const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
      const omega = Math.acos(dot);
      const sinOmega = Math.sin(omega);
      for (let s = 1; s <= ARC_SEGMENTS; s++) {
        const wp = slerp(u, v, s / ARC_SEGMENTS, omega, sinOmega);
        path.push(project(rotate(wp, state.viewMatrix), cx, cy, scale));
      }
    } else {
      path.push(project(rotate(v, state.viewMatrix), cx, cy, scale));
    }
  }
  return path;
}

function vertexSetKey(verts) {
  return verts.slice().sort((a, b) => a - b).join(",");
}

// Draws a subtle highlight ring/stroke/fill over whichever V/E/F is
// currently under the mouse (hover.js's currentHoverTarget, set at the end
// of the previous frame's updateHover() call - see hover.js for why the
// resulting one-frame lag is a non-issue). Drawn as a final overlay pass
// on top of everything else, so it never gets occluded by faces/edges/
// vertices in front of it, and never needs its own depth sort.
function drawHoverHighlight(projectedPoints, edgePaths, facePaths) {
  const t = currentHoverTarget;
  if (!t) return;

  if (t.type === "vertex") {
    const pt = projectedPoints.find((p) => p.idx === t.idx);
    if (!pt) return;
    const depth = depthWithOpacity((pt.z + 1) / 2);
    const radius = 3.5 + depth * 3.5;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius * 1.6, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (t.type === "edge") {
    const ep = edgePaths.find((e) => e.i === t.i && e.j === t.j && !!e.nonLocal === !!t.nonLocal);
    if (!ep) return;
    ctx.beginPath();
    ctx.moveTo(ep.path[0].x, ep.path[0].y);
    for (let k = 1; k < ep.path.length; k++) ctx.lineTo(ep.path[k].x, ep.path[k].y);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    ctx.setLineDash(t.nonLocal ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (t.type === "face") {
    const key = vertexSetKey(t.vertices);
    const fp = facePaths.find((f) => vertexSetKey(f.vertices) === key);
    if (!fp) return;
    ctx.beginPath();
    ctx.moveTo(fp.path[0].x, fp.path[0].y);
    for (let k = 1; k < fp.path.length; k++) ctx.lineTo(fp.path[k].x, fp.path[k].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash(fp.nonLocal ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// Latitude/longitude wireframe. It used to be stroked at one flat alpha for
// the whole sphere, which made it the one layer that ignored sphere opacity
// entirely - the rear half of the grid stayed just as visible at 100% as at
// 0%, so an "opaque" sphere was still transparently gridded.
//
// Depth-fading it needs per-segment alpha, and a stroke() per segment would
// be ~700 draw calls a frame. Instead each segment is filed into one of
// GRID_DEPTH_LEVELS paths by its own depth, and each path is stroked once, so
// the whole grid costs a fixed dozen calls however finely it's subdivided.
// Quantizing is invisible here: the levels are 0.18/11 apart in alpha on a
// line that's barely there to begin with.
const GRID_DEPTH_LEVELS = 12;
const GRID_ALPHA = 0.18;

function drawSphereWireframe(cx, cy, scale) {
  const NLAT = 6, NLON = 10, SEG = 48;
  const levels = [];
  for (let b = 0; b < GRID_DEPTH_LEVELS; b++) levels.push(new Path2D());

  // `pointAt(s)` walks one closed curve; consecutive samples become one
  // segment, filed by the depth of its midpoint.
  const addCurve = (pointAt) => {
    let prev = pointAt(0);
    for (let s = 1; s <= SEG; s++) {
      const cur = pointAt(s);
      const depth = depthWithOpacity(((prev.z + cur.z) / 2 + 1) / 2);
      const b = Math.round(depth * (GRID_DEPTH_LEVELS - 1));
      levels[b].moveTo(prev.x, prev.y);
      levels[b].lineTo(cur.x, cur.y);
      prev = cur;
    }
  };

  for (let k = 1; k < NLAT; k++) {
    const lat = Math.PI * (k / NLAT - 0.5);
    const rr = Math.cos(lat), zz = Math.sin(lat);
    addCurve((s) => {
      const lon = 2 * Math.PI * s / SEG;
      return project(rotate([rr * Math.cos(lon), rr * Math.sin(lon), zz], state.viewMatrix), cx, cy, scale);
    });
  }
  for (let k = 0; k < NLON; k++) {
    const lon = Math.PI * k / NLON;
    addCurve((s) => {
      const lat = Math.PI * (s / SEG - 0.5) * 2;
      return project(rotate([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)], state.viewMatrix), cx, cy, scale);
    });
  }

  ctx.lineWidth = 1;
  for (let b = 1; b < GRID_DEPTH_LEVELS; b++) { // level 0 is fully transparent
    ctx.strokeStyle = `rgba(139,148,158,${GRID_ALPHA * b / (GRID_DEPTH_LEVELS - 1)})`;
    ctx.stroke(levels[b]);
  }
}

// Visible-subset point list, keyed on the points array and the hidden set -
// see its use in draw() below.
let _subsetCache = { points: null, sig: "", visibleIdx: null, subPts: null };

function draw() {
  const wrap = document.getElementById("canvasWrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const scale = Math.min(w, h) * 0.36 * state.zoom; // origin-centered zoom only, no translation

  drawSphereWireframe(cx, cy, scale);

  // Always compute the neighbour graph (cheap at N<=100) so state._nearest
  // (r0 per vertex) is available for the hover panel even when edges aren't
  // drawn; only render it when the edge style calls for it. This is always
  // the *true* graph over every point, hidden or not - hiding is display-
  // only and must never feed back into the physics or into r0/degree.
  const edgeList = computeEdges();

  const n = state.points.length;
  const isHidden = new Array(n).fill(false);
  if (state.hiddenDegrees.size > 0 && state._degree) {
    for (let i = 0; i < n; i++) isHidden[i] = state.hiddenDegrees.has(state._degree[i]);
  }
  // Shared by both the face and edge "non-local" recomputation below -
  // the indices of every point that's still visible, in visible-array
  // order (so a subset re-computation's own local indices can be mapped
  // straight back via visibleIdx[subIdx]).
  // Built once and shared by both, rather than each mapping its own copy, and
  // reused across frames while neither the points nor the hidden set has
  // changed. Both matter because the hull is memoized on the point array's
  // identity (see hull.js): a second copy of the same points, or a fresh copy
  // each frame, would each pay for their own hull and defeat the memo.
  let visibleIdx = null, subPts = null;
  if (state.hiddenDegrees.size > 0) {
    const sig = Array.from(state.hiddenDegrees).sort((a, b) => a - b).join(",");
    if (_subsetCache.points === state.points && _subsetCache.sig === sig) {
      ({ visibleIdx, subPts } = _subsetCache);
    } else {
      visibleIdx = [];
      for (let i = 0; i < n; i++) if (!isHidden[i]) visibleIdx.push(i);
      subPts = visibleIdx.map((i) => state.points[i]);
      _subsetCache = { points: state.points, sig, visibleIdx, subPts };
    }
  }

  // Faces: purely visual, computed on the true (full) point set. Faces
  // touching a hidden vertex are dropped ("local" faces); when vertices are
  // hidden, the merge is *also* rerun on just the surviving points, exactly
  // mirroring the edges' "non-local" treatment below - hiding away the
  // vertex that used to separate two flat regions (or that used to anchor
  // part of a larger merged face) can produce a genuinely different tiling
  // over the reduced point set, not just a subset of the original one.
  // Faces already identical to a local face are deduplicated away. Nothing
  // is drawn unless its side-count has been explicitly toggled on in the
  // "Faces by side count" panel, so the generic triangle soup (especially
  // pre-convergence) stays invisible by default.
  const faceList = computeFaces();
  const faceCandidates = [];
  const localFaceKeys = new Set();
  for (const face of faceList) {
    if (face.vertices.some((vi) => isHidden[vi])) continue;
    faceCandidates.push({ vertices: face.vertices, sides: face.sides, nonLocal: false });
    localFaceKeys.add(vertexSetKey(face.vertices));
  }
  if (visibleIdx && visibleIdx.length >= 4) {
    const { faces: subFaces } = computeFacesForPoints(subPts);
    for (const sf of subFaces) {
      const mapped = sf.vertices.map((vi) => visibleIdx[vi]);
      if (localFaceKeys.has(vertexSetKey(mapped))) continue;
      faceCandidates.push({ vertices: mapped, sides: sf.sides, nonLocal: true });
    }
  }
  // Exposed for the face histogram + hover - deliberately the post-hiding,
  // post-non-local set (`faceCandidates`), not the raw full-set `faceList`:
  // unlike vertex degree (a real, hiding-independent physical property),
  // a face's side count is already a purely visual artifact of the current
  // triangulation, so the panel should track whatever's actually on screen
  // (or would be, once toggled on) rather than a fixed "true" structure.
  state._faces = faceCandidates;

  let facePaths = [];
  if (state.facesVisible === "show") {
    for (const face of faceCandidates) {
      if (state.hiddenFaceSides.has(face.sides)) continue;
      const path = buildFacePath(face.vertices, cx, cy, scale);
      const avgZ = path.reduce((s, pv) => s + pv.z, 0) / path.length;
      facePaths.push({ sides: face.sides, vertices: face.vertices, nonLocal: face.nonLocal, path, avgZ });
    }
    // Painter's algorithm, back-to-front, same convention as the vertex
    // depth sort below - lets rear-facing faces be drawn without simply
    // occluding whatever's in front of them.
    facePaths.sort((a, b) => a.avgZ - b.avgZ);
    for (const { sides, path, nonLocal, avgZ } of facePaths) {
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let k = 1; k < path.length; k++) ctx.lineTo(path[k].x, path[k].y);
      ctx.closePath();
      // Depth-fade toward fully transparent, same idea as the vertex
      // tension colouring: a rear face reads as "further away" rather than
      // competing on equal footing with whatever's in front of it. At full
      // sphere opacity every rear face comes out at zero, so "opaque" means
      // the sphere genuinely blocks the far side rather than merely fading
      // it. A face straddling the silhouette is judged by its average depth
      // and so switches over all at once, the one place that shows.
      const depth = depthWithOpacity(Math.max(0, Math.min(1, (avgZ + 1) / 2)));
      ctx.globalAlpha = depth;
      ctx.fillStyle = faceFillColor(sides);
      ctx.fill();
      ctx.strokeStyle = faceStrokeColor(sides);
      ctx.lineWidth = 1.5;
      // Dashed rather than dimmer, matching the non-local edges' treatment:
      // this tiling is exactly as "real" a visual layer as the local one,
      // it's just specific to the currently-visible subset.
      ctx.setLineDash(nonLocal ? [5, 4] : []);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  // Edge candidates, computed whether or not edges are drawn: the Geometry
  // count table needs them either way, and the cost is one extra hull over
  // the visible subset (only when something is actually hidden).
  const edgeKeys = new Set();
  const edgeCandidates = [];
  for (const [a, b] of edgeList) {
    if (isHidden[a] || isHidden[b]) continue;
    edgeKeys.add(a + "," + b);
    edgeCandidates.push({ i: a, j: b, nonLocal: false });
  }
  // Non-local edges: rerun Delaunay+EDGE_C on just the surviving (visible)
  // points, so hiding away everything but e.g. the pentagonal defects
  // reveals *their own* triangulation - a fresh local r0 among just those
  // points - rather than only ever showing the true graph with some
  // edges erased. These are real, physically-interacting pairs (the
  // underlying Riesz/log potential has no notion of a triangulation) -
  // "non-local" just means excluded from the visible subset's Delaunay
  // graph, not that the interaction itself is any less real. Only kept
  // when they don't already coincide with a true edge already drawn.
  if (visibleIdx && visibleIdx.length >= 2) {
    const { edges: subEdges } = computeEdgesForPoints(subPts);
    for (const [sa, sb] of subEdges) {
      const a = visibleIdx[sa], b = visibleIdx[sb];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edgeCandidates.push({ i: lo, j: hi, nonLocal: true });
    }
  }

  // V/E/F/chi over exactly what the two layers describe right now, hiding
  // included: a non-local edge or face is a genuine part of the visible
  // subset's own triangulation, not a lesser kind of one, so it counts.
  //
  // E is the face tiling's own edge set - the boundaries of faceCandidates -
  // because that, not the drawn edge set, is the 1-skeleton chi is about. The
  // two differ because the edge and face layers are independent heuristics
  // (EDGE_C's ratio test vs. faces.js's coplanarity tolerance) and disagree
  // in both directions:
  //   - a tiling edge EDGE_C rejected, still drawn as a face boundary. These
  //     are the amber "+n" the table reports, since silently omitting them
  //     would put chi above 2 and read as broken topology on a surface that
  //     is in fact perfectly closed.
  //   - an accepted edge running *through* a merged face (a quadrilateral
  //     whose diagonal was short enough to survive the ratio test). Excluded
  //     here, being drawn but not an edge of the surface. Hovering one reports
  //     a dash for its dihedral, which is the honest answer: the two triangles
  //     it separates are why the face merged in the first place. Not rare at
  //     large N, whatever the 493-case sweep at N<=100 suggested - 68 of them
  //     at N=1000 on a random configuration, still 33 after 200 steps - which
  //     is the same local flatness that makes the merge itself so common
  //     there (see faces.js).
  // Sweeping N=1..100 x 5 relaxation stages x every degree-hiding subset,
  // chi came out 2 for all 493 cases with at least 4 visible points; below
  // that there's no hull and so no closed surface to have a chi of 2. That
  // sweep stopped an order of magnitude short of where the face merge first
  // breaks, though - see swallowsVertex in faces.js, and test/topology.js,
  // which carries the same invariant out to N=1024.
  let tilingEdges = 0, filteredEdges = 0;
  const boundarySeen = new Set();
  for (const face of faceCandidates) {
    const vs = face.vertices;
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k], b = vs[(k + 1) % vs.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (boundarySeen.has(key)) continue;
      boundarySeen.add(key);
      if (edgeKeys.has(key)) tilingEdges++; else filteredEdges++;
    }
  }
  state._counts = {
    V: visibleIdx ? visibleIdx.length : n,
    E: tilingEdges,
    EFiltered: filteredEdges,
    F: faceCandidates.length,
  };

  let edgePaths = [];
  if (state.edgesVisible === "show") {
    edgePaths = computeEdgeScreenPaths(edgeCandidates, cx, cy, scale);
    drawEdges(ctx, edgePaths);
  }

  // points, depth sorted - hidden vertices are display-only excluded, both
  // from drawing and from hover eligibility (via the `projected` list
  // updateHover receives below).
  const projected = state.points.map((p3, idx) => {
    const rp = rotate(p3, state.viewMatrix);
    const pr = project(rp, cx, cy, scale);
    return { ...pr, idx };
  }).filter((pt) => !isHidden[pt.idx]);
  projected.sort((a, b) => a.z - b.z);

  for (const pt of projected) {
    const depth = depthWithOpacity((pt.z + 1) / 2); // 0 (back) .. 1 (front)
    const radius = 3.5 + depth * 3.5;

    const bg = hslToRgb(212, 0.9, 0.45 + depth * 0.45); // existing depth-based blue
    const tension = forceColor(vertexTensionRatio(pt.idx));
    // background blue in the distance, tension colour up front
    const rC = bg[0] + (tension[0] - bg[0]) * depth;
    const gC = bg[1] + (tension[1] - bg[1]) * depth;
    const bC = bg[2] + (tension[2] - bg[2]) * depth;

    // Same full-block-at-full-opacity contract as faces/edges: at
    // sphereOpacity=1 any vertex behind the silhouette comes out completely
    // invisible, not merely small and dim.
    ctx.globalAlpha = depth;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = `rgb(${rC}, ${gC}, ${bC})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(13,17,23,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Degree-highlight ring (see the clickable "Degree x" rows in the
    // statistics panel) - an outline rather than a fill, so it frames the
    // existing tension-coloured point instead of covering it.
    const deg = state._degree ? state._degree[pt.idx] : undefined;
    if (deg !== undefined && state.highlightedDegrees.has(deg)) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius * 1.25, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawHoverHighlight(projected, edgePaths, facePaths);
  updateHover(projected, edgePaths, facePaths);
}
