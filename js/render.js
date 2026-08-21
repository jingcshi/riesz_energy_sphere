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
// Net-force magnitude -> colour, on a log scale: red at >=1, orange at 1e-1,
// yellow at 1e-2, mint at 1e-3, pale (matching --text) at <=1e-4. Colours are
// plain RGB triples so we can linearly blend both across decades and, below,
// toward the existing depth-based blue as a point recedes into the background.
const FORCE_COLOR_STOPS = [
  { logF: 0, rgb: [239, 68, 68] },    // red
  { logF: -1, rgb: [249, 115, 22] },  // orange
  { logF: -2, rgb: [234, 179, 8] },   // yellow
  { logF: -3, rgb: [110, 231, 183] }, // mint
  { logF: -4, rgb: [201, 209, 217] }, // pale (var(--text))
];

function forceColor(mag) {
  const logF = Math.max(-4, Math.min(0, Math.log10(Math.max(mag, 1e-12))));
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

// Builds a face's projected screen-space boundary path. In "arcs" edge
// style, each side is subdivided into great-circle-arc segments (same
// slerp machinery edges.js uses) so the polygon renders as a genuine
// spherical tile bulging along the sphere's surface, rather than the flat
// polytope chord a straight line between two vertices would draw; "lines"
// and "none" styles keep the flat polytope face, matching how the edge
// layer itself only curves in "arcs" mode.
function buildFacePath(vertexIdxs, cx, cy, scale) {
  const useArcs = state.edgeStyle === "arcs";
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

function draw() {
  const wrap = document.getElementById("canvasWrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const scale = Math.min(w, h) * 0.36 * state.zoom; // origin-centered zoom only, no translation

  // wireframe sphere: latitude & longitude lines
  ctx.strokeStyle = "rgba(139,148,158,0.18)";
  ctx.lineWidth = 1;
  const NLAT = 6, NLON = 10, SEG = 48;
  for (let k = 1; k < NLAT; k++) {
    const lat = Math.PI * (k / NLAT - 0.5);
    const rr = Math.cos(lat), zz = Math.sin(lat);
    ctx.beginPath();
    for (let s = 0; s <= SEG; s++) {
      const lon = 2 * Math.PI * s / SEG;
      const p3 = rotate([rr * Math.cos(lon), rr * Math.sin(lon), zz], state.viewMatrix);
      const pr = project(p3, cx, cy, scale);
      if (s === 0) ctx.moveTo(pr.x, pr.y); else ctx.lineTo(pr.x, pr.y);
    }
    ctx.stroke();
  }
  for (let k = 0; k < NLON; k++) {
    const lon = Math.PI * k / NLON;
    ctx.beginPath();
    for (let s = 0; s <= SEG; s++) {
      const lat = Math.PI * (s / SEG - 0.5) * 2;
      const p3 = rotate([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)], state.viewMatrix);
      const pr = project(p3, cx, cy, scale);
      if (s === 0) ctx.moveTo(pr.x, pr.y); else ctx.lineTo(pr.x, pr.y);
    }
    ctx.stroke();
  }

  // Always compute the neighbour graph (cheap at N<=100) so state._nearest
  // (r0 per vertex) is available for the hover panel even when edges aren't
  // drawn; only render it when the edge style calls for it. This is always
  // the *true* graph over every point, hidden or not - hiding is display-
  // only and must never feed back into the physics or into r0/degree.
  const edgeList = computeEdges();
  state._edgeList = edgeList; // exposed for the degree-histogram stat

  const n = state.points.length;
  const isHidden = new Array(n).fill(false);
  if (state.hiddenDegrees.size > 0 && state._degree) {
    for (let i = 0; i < n; i++) isHidden[i] = state.hiddenDegrees.has(state._degree[i]);
  }
  // Shared by both the face and edge "non-local" recomputation below -
  // the indices of every point that's still visible, in visible-array
  // order (so a subset re-computation's own local indices can be mapped
  // straight back via visibleIdx[subIdx]).
  let visibleIdx = null;
  if (state.hiddenDegrees.size > 0) {
    visibleIdx = [];
    for (let i = 0; i < n; i++) if (!isHidden[i]) visibleIdx.push(i);
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
    faceCandidates.push({ vertices: face.vertices, sides: face.sides, area: face.area, nonLocal: false });
    localFaceKeys.add(vertexSetKey(face.vertices));
  }
  if (visibleIdx && visibleIdx.length >= 4) {
    const subPts = visibleIdx.map((i) => state.points[i]);
    const { faces: subFaces } = computeFacesForPoints(subPts);
    for (const sf of subFaces) {
      const mapped = sf.vertices.map((vi) => visibleIdx[vi]);
      if (localFaceKeys.has(vertexSetKey(mapped))) continue;
      faceCandidates.push({ vertices: mapped, sides: sf.sides, area: sf.area, nonLocal: true });
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
      facePaths.push({ sides: face.sides, area: face.area, vertices: face.vertices, nonLocal: face.nonLocal, path, avgZ });
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
      // sphere opacity (depthWithOpacity(0) = 0) a directly-rear face is
      // completely invisible, not just dimmed - "opaque" should mean the
      // sphere genuinely blocks it, not merely fades it.
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

  let edgePaths = [];
  if (state.edgeStyle !== "none") {
    const trueEdgeKeys = new Set();
    const edgeDescs = [];
    for (const [a, b] of edgeList) {
      if (isHidden[a] || isHidden[b]) continue;
      trueEdgeKeys.add(a + "," + b);
      edgeDescs.push({ i: a, j: b, nonLocal: false });
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
      const subPts = visibleIdx.map((i) => state.points[i]);
      const { edges: subEdges } = computeEdgesForPoints(subPts);
      for (const [sa, sb] of subEdges) {
        const a = visibleIdx[sa], b = visibleIdx[sb];
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (!trueEdgeKeys.has(`${lo},${hi}`)) edgeDescs.push({ i: lo, j: hi, nonLocal: true });
      }
    }
    edgePaths = computeEdgeScreenPaths(edgeDescs, cx, cy, scale);
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
    const mag = state._forces ? Math.hypot(...state._forces[pt.idx]) : 0;
    const tension = forceColor(mag);
    // background blue in the distance, tension colour up front
    const rC = bg[0] + (tension[0] - bg[0]) * depth;
    const gC = bg[1] + (tension[1] - bg[1]) * depth;
    const bC = bg[2] + (tension[2] - bg[2]) * depth;

    // Same full-block-at-full-opacity contract as faces/edges: at
    // depth=0 (depthWithOpacity(0)=0 when sphereOpacity=1) the vertex is
    // completely invisible, not merely small and dim.
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
