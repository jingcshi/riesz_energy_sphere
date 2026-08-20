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

  let edgePaths = [];
  if (state.edgeStyle !== "none") {
    const trueEdgeKeys = new Set();
    const edgeDescs = [];
    for (const [a, b] of edgeList) {
      if (isHidden[a] || isHidden[b]) continue;
      trueEdgeKeys.add(a + "," + b);
      edgeDescs.push({ i: a, j: b, pseudo: false });
    }
    // Pseudo edges: rerun Delaunay+EDGE_C on just the surviving (visible)
    // points, so hiding away everything but e.g. the pentagonal defects
    // reveals *their own* triangulation - a fresh local r0 among just those
    // points - rather than only ever showing the true graph with some
    // edges erased. Only kept when they don't already coincide with a true
    // edge that's already being drawn solid.
    if (state.hiddenDegrees.size > 0) {
      const visibleIdx = [];
      for (let i = 0; i < n; i++) if (!isHidden[i]) visibleIdx.push(i);
      if (visibleIdx.length >= 2) {
        const subPts = visibleIdx.map((i) => state.points[i]);
        const { edges: subEdges } = computeEdgesForPoints(subPts);
        for (const [sa, sb] of subEdges) {
          const a = visibleIdx[sa], b = visibleIdx[sb];
          const lo = Math.min(a, b), hi = Math.max(a, b);
          if (!trueEdgeKeys.has(`${lo},${hi}`)) edgeDescs.push({ i: lo, j: hi, pseudo: true });
        }
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
    const depth = (pt.z + 1) / 2; // 0 (back) .. 1 (front)
    const radius = 3.5 + depth * 3.5;

    const bg = hslToRgb(212, 0.9, 0.45 + depth * 0.45); // existing depth-based blue
    const mag = state._forces ? Math.hypot(...state._forces[pt.idx]) : 0;
    const tension = forceColor(mag);
    // background blue in the distance, tension colour up front
    const rC = bg[0] + (tension[0] - bg[0]) * depth;
    const gC = bg[1] + (tension[1] - bg[1]) * depth;
    const bC = bg[2] + (tension[2] - bg[2]) * depth;

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
  }

  updateHover(projected, edgePaths);
}
