"use strict";

// ---------- hover info panel (vertices & edges, paused only) ----------
const hoverTooltip = document.getElementById("hoverTooltip");
let mouseInCanvas = false, mouseX = 0, mouseY = 0;
// Read by render.js's drawHoverHighlight() to ring/glow whatever's
// currently hovered. Written at the end of updateHover() each frame, so
// the on-canvas highlight lags the tooltip by exactly one animation frame
// (draw() renders using last frame's target, then computes this frame's) -
// imperceptible at 60fps with a stationary mouse, and far simpler than
// threading hit-testing ahead of the render passes it depends on.
let currentHoverTarget = null;

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  mouseInCanvas = true;
});
canvas.addEventListener("mouseleave", () => { mouseInCanvas = false; });

const VERTEX_HIT_R = 9; // px
const EDGE_HIT_R = 6;   // px, distance to nearest point on the rendered path
const FACE_BOUNDARY_HIT_R = 6; // px - lets a face's own boundary stroke resolve to that face

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

// Distance to the path, plus the depth (z) *at the actual closest point*
// rather than some coarse stand-in (e.g. an average of the edge's two
// endpoints) - matters most for "arcs" style and/or long (often non-local)
// edges, where a curving path can dip behind the sphere's horizon even
// when both endpoints happen to read as front-facing, or vice versa.
function closestPointOnPath(px, py, path) {
  let bestD = Infinity, bestZ = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const { d, t } = distToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; bestZ = a.z + (b.z - a.z) * t; }
  }
  return { d: bestD, z: bestZ };
}

function fmt(x, digits = 4) {
  return Number.isFinite(x) ? x.toFixed(digits) : "\u2014";
}

// Standard even-odd ray-casting point-in-polygon test against a projected
// screen-space path (array of {x,y}).
function pointInPolygon(px, py, path) {
  let inside = false;
  for (let k = 0, l = path.length - 1; k < path.length; l = k++) {
    const xk = path[k].x, yk = path[k].y, xl = path[l].x, yl = path[l].y;
    if ((yk > py) !== (yl > py) &&
        px < (xl - xk) * (py - yk) / (yl - yk) + xk) {
      inside = !inside;
    }
  }
  return inside;
}

// Called once per frame from draw(), with the same projected points/edge
// paths/face paths it just rendered, so the hit-test always matches what's
// on screen. Strict priority front-vertex > front-edge > front-face -
// checked in that order, each only among *front-hemisphere* candidates, so
// a rear vertex/edge/face is never hoverable at all (matching how they
// visually sit behind the near side of the sphere) and a nearer element
// always wins over a farther one of the same or lower-priority type.
function updateHover(projectedPoints, edgePaths, facePaths) {
  if (state.playing || !mouseInCanvas) {
    hoverTooltip.classList.add("hidden");
    currentHoverTarget = null;
    return;
  }

  let best = null, bestD = Infinity;
  for (const pt of projectedPoints) {
    if (pt.z < 0) continue; // front hemisphere only
    const d = Math.hypot(mouseX - pt.x, mouseY - pt.y);
    if (d < VERTEX_HIT_R && d < bestD) {
      bestD = d;
      best = { type: "vertex", idx: pt.idx, x: pt.x, y: pt.y };
    }
  }
  if (!best) {
    for (const ep of edgePaths) {
      const { d, z } = closestPointOnPath(mouseX, mouseY, ep.path);
      if (z < 0) continue; // front hemisphere only, evaluated at the actual closest point
      if (d < EDGE_HIT_R && d < bestD) {
        bestD = d;
        best = { type: "edge", i: ep.i, j: ep.j, nonLocal: ep.nonLocal, x: (ep.pa.x + ep.pb.x) / 2, y: (ep.pa.y + ep.pb.y) / 2 };
      }
    }
  }
  if (!best && facePaths) {
    // Front faces can still overlap on screen once rear faces are drawn
    // too (e.g. a square antiprism's near-eclipsed far square) - collect
    // every front-facing match and keep the nearest (highest avgZ) rather
    // than the first one encountered, which - since facePaths is sorted
    // back-to-front for rendering - would otherwise silently pick the
    // *farthest* of any overlapping matches.
    let bestFaceZ = -Infinity;
    for (const fp of facePaths) {
      if (fp.avgZ < 0) continue; // front hemisphere only
      if (fp.avgZ <= bestFaceZ) continue;
      // A face's own boundary is drawn as its own stroke (see render.js's
      // faceStrokeColor) - it isn't an edge and has no entry in edgePaths,
      // so aiming right at that thin line, just outside the strict
      // point-in-polygon test, used to match nothing at all. Falling back
      // to "close enough to the boundary" closes that gap.
      const closed = fp.path.length > 1 ? fp.path.concat([fp.path[0]]) : fp.path;
      const onBoundary = closestPointOnPath(mouseX, mouseY, closed).d < FACE_BOUNDARY_HIT_R;
      if (pointInPolygon(mouseX, mouseY, fp.path) || onBoundary) {
        bestFaceZ = fp.avgZ;
        const cx = fp.path.reduce((s, p) => s + p.x, 0) / fp.path.length;
        const cy = fp.path.reduce((s, p) => s + p.y, 0) / fp.path.length;
        best = { type: "face", sides: fp.sides, vertices: fp.vertices, area: fp.area, nonLocal: fp.nonLocal, x: cx, y: cy };
      }
    }
  }

  if (!best) {
    hoverTooltip.classList.add("hidden");
    currentHoverTarget = null;
    return;
  }
  currentHoverTarget = best;

  if (best.type === "face") {
    // Vertex count always equals side count for a polygon, so it's not
    // worth its own row - the vertex list itself (in the face's boundary
    // order) is the more informative title, standing in for both at once.
    const { sides, vertices, area, nonLocal } = best;
    hoverTooltip.innerHTML = `
      <div class="hover-title">Face ${vertices.join("-")}${nonLocal ? " (non-local)" : ""}</div>
      <div class="hover-row"><span>Sides</span><span>${sides}</span></div>
      <div class="hover-row"><span>Circumference</span><span>${fmt(facePerimeter(vertices))}</span></div>
      <div class="hover-row"><span>Area</span><span>${fmt(area)}</span></div>`;
  } else if (best.type === "vertex") {
    const i = best.idx;
    // Degree comes straight from state._degree (the true, full-point-set
    // graph), not by recounting edgePaths incident to i - edgePaths can
    // include non-local edges (see render.js) when other vertices are
    // hidden, which would otherwise inflate this into a "visible-subset
    // degree".
    const degree = state._degree ? state._degree[i] : "\u2014";
    const mag = state._forces ? Math.hypot(...state._forces[i]) : NaN;
    const r0 = state._nearest ? state._nearest[i] : NaN;
    const energy = state._pointEnergy ? state._pointEnergy[i] : NaN;
    // Residual as well as force: it's the scale-free one, and the one this
    // vertex's colour is actually derived from (as a fraction of the
    // landscape's peak - see render.js), so without it the colour has no
    // visible number behind it at high p where the force reads ~1e+8.
    const residual = vertexResidual(i);
    hoverTooltip.innerHTML = `
      <div class="hover-title">Vertex ${i}</div>
      <div class="hover-row"><span>Degree</span><span>${degree}</span></div>
      <div class="hover-row"><span>Net force${state._forceUnitsRelative ? " (rel.)" : ""}</span><span>${mag.toExponential(3)}</span></div>
      <div class="hover-row"><span>Residual</span><span>${residual.toExponential(3)}</span></div>
      <div class="hover-row"><span>r&#8320; (nearest)</span><span>${fmt(r0)}</span></div>
      <div class="hover-row"><span>Potential energy${state._energyRelative ? " (rel.)" : ""}</span><span>${fmt(energy)}</span></div>`;
  } else {
    const { i, j, nonLocal } = best;
    const u = state.points[i], v = state.points[j];
    const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
    const arcAngleDeg = Math.acos(dot) * 180 / Math.PI;
    let length;
    if (state.shapeStyle === "arcs") {
      length = Math.acos(dot);
    } else {
      const dx = u[0] - v[0], dy = u[1] - v[1], dz = u[2] - v[2];
      length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    // Non-local edges (dashed - see render.js) are just as real a
    // physically-interacting pair as any other; they're only excluded from
    // the Delaunay triangulation over the currently-visible points, so
    // Force is reported the same way as for any other edge.
    const force = pairForceMagnitude(i, j);
    // Dihedral of the two faces meeting along this edge - how sharply the
    // polytope creases here, 180 degrees being flat. It's also the quantity
    // the face layer merges on (within ~1.8 degrees of 180), so a face that
    // hasn't merged wears its reason on its shared edges.
    const dihedralDeg = edgeDihedralDeg(i, j);
    hoverTooltip.innerHTML = `
      <div class="hover-title">Edge ${i}&ndash;${j}${nonLocal ? " (non-local)" : ""}</div>
      <div class="hover-row"><span>Length</span><span>${fmt(length)}</span></div>
      <div class="hover-row"><span>Arc angle</span><span>${fmt(arcAngleDeg, 2)}&deg;</span></div>
      <div class="hover-row"><span>Dihedral</span><span>${Number.isFinite(dihedralDeg) ? fmt(dihedralDeg, 2) + "&deg;" : "\u2014"}</span></div>
      <div class="hover-row"><span>Force</span><span>${fmt(force, 5)}</span></div>`;
  }

  hoverTooltip.classList.remove("hidden");
  positionTooltip(best.x, best.y);
}

function positionTooltip(px, py) {
  const wrap = document.getElementById("canvasWrap");
  const maxLeft = wrap.clientWidth - hoverTooltip.offsetWidth - 8;
  const maxTop = wrap.clientHeight - hoverTooltip.offsetHeight - 8;
  hoverTooltip.style.left = Math.max(8, Math.min(px + 14, maxLeft)) + "px";
  hoverTooltip.style.top = Math.max(8, Math.min(py + 14, maxTop)) + "px";
}
