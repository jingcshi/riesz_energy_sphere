"use strict";

// ---------- hover info panel (vertices & edges, paused only) ----------
const hoverTooltip = document.getElementById("hoverTooltip");
let mouseInCanvas = false, mouseX = 0, mouseY = 0;

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  mouseInCanvas = true;
});
canvas.addEventListener("mouseleave", () => { mouseInCanvas = false; });

const VERTEX_HIT_R = 9; // px
const EDGE_HIT_R = 6;   // px, distance to nearest point on the rendered path

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPath(px, py, path) {
  let best = Infinity;
  for (let k = 1; k < path.length; k++) {
    best = Math.min(best, distToSegment(px, py, path[k - 1].x, path[k - 1].y, path[k].x, path[k].y));
  }
  return best;
}

function fmt(x, digits = 4) {
  return Number.isFinite(x) ? x.toFixed(digits) : "\u2014";
}

// Called once per frame from draw(), with the same projected points/edge
// paths it just rendered, so the hit-test always matches what's on screen.
function updateHover(projectedPoints, edgePaths) {
  if (state.playing || !mouseInCanvas) {
    hoverTooltip.classList.add("hidden");
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
      if ((ep.pa.z + ep.pb.z) / 2 < 0) continue; // front hemisphere only
      const d = distToPath(mouseX, mouseY, ep.path);
      if (d < EDGE_HIT_R && d < bestD) {
        bestD = d;
        best = { type: "edge", i: ep.i, j: ep.j, x: (ep.pa.x + ep.pb.x) / 2, y: (ep.pa.y + ep.pb.y) / 2 };
      }
    }
  }

  if (!best) {
    hoverTooltip.classList.add("hidden");
    return;
  }

  if (best.type === "vertex") {
    const i = best.idx;
    const mag = state._forces ? Math.hypot(...state._forces[i]) : NaN;
    const r0 = state._nearest ? state._nearest[i] : NaN;
    const energy = state._pointEnergy ? state._pointEnergy[i] : NaN;
    hoverTooltip.innerHTML = `
      <div class="hover-title">Vertex ${i}</div>
      <div class="hover-row"><span>Net force</span><span>${mag.toExponential(3)}</span></div>
      <div class="hover-row"><span>r&#8320; (nearest)</span><span>${fmt(r0)}</span></div>
      <div class="hover-row"><span>Potential energy</span><span>${fmt(energy)}</span></div>`;
  } else {
    const { i, j } = best;
    const u = state.points[i], v = state.points[j];
    let length;
    if (state.edgeStyle === "arcs") {
      const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
      length = Math.acos(dot);
    } else {
      const dx = u[0] - v[0], dy = u[1] - v[1], dz = u[2] - v[2];
      length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const force = pairForceMagnitude(i, j);
    hoverTooltip.innerHTML = `
      <div class="hover-title">Edge ${i}&ndash;${j}</div>
      <div class="hover-row"><span>Length</span><span>${fmt(length)}</span></div>
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
