"use strict";

// ---------- interaction: drag to rotate ----------
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => dragging = false);
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  // Apply this drag's yaw/pitch in the *current* view frame (pre-multiply)
  // rather than accumulating into stored Euler angles - see geometry.js for
  // why that avoids the gimbal-lock "wall" the old rotX/rotY scheme hit.
  const k = 0.008;
  const delta = matMultiply(rotationY(dx * k), rotationX(dy * k));
  state.viewMatrix = matMultiply(delta, state.viewMatrix);
});

// ---------- UI wiring ----------
const nSlider = document.getElementById("nSlider");
const pSlider = document.getElementById("pSlider");
const seedInput = document.getElementById("seedInput");
const randomizeSeedBtn = document.getElementById("randomizeSeedBtn");
const speedSlider = document.getElementById("speedSlider");
const nVal = document.getElementById("nVal");
const pVal = document.getElementById("pVal");
const speedVal = document.getElementById("speedVal");
const playBtn = document.getElementById("playBtn");
const resetBtn = document.getElementById("resetBtn");
const energyVal = document.getElementById("energyVal");
const stepVal = document.getElementById("stepVal");
const forceVal = document.getElementById("forceVal");
const degreeHistogramEl = document.getElementById("degreeHistogram");
const edgeButtons = document.querySelectorAll("#edgeSegmented .seg");
const metricButtons = document.querySelectorAll("#metricSegmented .seg");
const zoomSlider = document.getElementById("zoomSlider");
const zoomVal = document.getElementById("zoomVal");

function setPlaying(playing) {
  state.playing = playing;
  playBtn.textContent = playing ? "Pause" : "Play";
  playBtn.classList.toggle("state-play", !playing);
  playBtn.classList.toggle("state-pause", playing);
}

nSlider.addEventListener("input", () => {
  state.N = parseInt(nSlider.value, 10);
  nVal.textContent = state.N;
  resetConfiguration();
});
// Native `disabled` suppresses hover/title tooltips in most browsers, which
// would hide the explanation - use a CSS class + a click guard instead.
function updatePInfinityUI() {
  const isInf = state.p === Infinity;
  playBtn.classList.toggle("disabled", isInf);
  playBtn.title = isInf ? "Tammes mode (p=\u221e) isn't implemented yet \u2013 see TODO.md" : "";
  if (isInf) setPlaying(false);
}

pSlider.addEventListener("input", () => {
  state.p = P_VALUES[parseInt(pSlider.value, 10)];
  pVal.textContent = formatP(state.p);
  state._trust = 1.0; // landscape stiffness changed with p - retune step size
  updatePInfinityUI();
  computeEnergyAndForce();
});
seedInput.addEventListener("change", () => {
  state.seed = parseInt(seedInput.value, 10) || 0;
  resetConfiguration();
});
randomizeSeedBtn.addEventListener("click", () => {
  const newSeed = Math.floor(Math.random() * 1000000); // 0..999999
  seedInput.value = newSeed;
  state.seed = newSeed;
  resetConfiguration();
});
speedSlider.addEventListener("input", () => {
  state.speed = parseFloat(speedSlider.value);
  speedVal.textContent = state.speed.toFixed(1) + "\u00d7";
});
edgeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    edgeButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.edgeStyle = btn.dataset.style;
  });
});
metricButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    metricButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.metric = btn.dataset.metric;
    state._trust = 1.0; // landscape stiffness changed with metric - retune step size
    computeEnergyAndForce();
  });
});
zoomSlider.addEventListener("input", () => {
  state.zoom = parseFloat(zoomSlider.value) / 100;
  zoomVal.textContent = zoomSlider.value + "%";
});
playBtn.addEventListener("click", () => {
  if (state.p === Infinity) return;
  setPlaying(!state.playing);
});
resetBtn.addEventListener("click", () => {
  setPlaying(false);
  resetConfiguration();
});

// ---------- info modal ----------
const infoBtn = document.getElementById("infoBtn");
const infoClose = document.getElementById("infoClose");
const infoOverlay = document.getElementById("infoOverlay");
const infoTabButtons = document.querySelectorAll("#infoTabs .tab");
const infoPanels = document.querySelectorAll(".tab-panel");

infoBtn.addEventListener("click", () => infoOverlay.classList.remove("hidden"));
infoClose.addEventListener("click", () => infoOverlay.classList.add("hidden"));
infoOverlay.addEventListener("click", (e) => {
  if (e.target === infoOverlay) infoOverlay.classList.add("hidden");
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") infoOverlay.classList.add("hidden");
});
infoTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    infoTabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    infoPanels.forEach((p) => p.classList.toggle("active", p.dataset.tab === btn.dataset.tab));
  });
});

// Sorted high-degree-first, since that's the more informative end for
// spotting defects (a lone degree-7 vertex among mostly-6 is a disclination;
// a lone low-degree one is comparatively unremarkable/expected near a
// 5-fold symmetric arrangement). Each row's "Degree x" label doubles as a
// toggle button (delegated click handler below) that rings every vertex of
// that degree on the canvas, for spotting mesoscopic defects/scars.
//
// Only rebuilds the DOM when the rendered rows would actually differ - this
// was called every animation frame (~60/s), unconditionally replacing the
// whole innerHTML. That silently broke the click: a real click is a
// mousedown+mouseup pair on the *same* element, but the element under the
// cursor was being destroyed and replaced with a fresh one before the
// mouseup ever landed, so the browser never synthesized a "click" at all.
let _degreeHistogramSig = null;
function updateDegreeHistogram() {
  const degree = state._degree || [];
  const counts = new Map();
  for (const d of degree) counts.set(d, (counts.get(d) || 0) + 1);
  const rows = Array.from(counts.entries()).sort((a, b) => b[0] - a[0]);
  const sig = rows.map(([d, c]) => `${d}:${c}`).join(",") + "|" +
    Array.from(state.highlightedDegrees).sort().join(",");
  if (sig === _degreeHistogramSig) return;
  _degreeHistogramSig = sig;
  degreeHistogramEl.innerHTML = rows
    .map(([deg, count]) => {
      const active = state.highlightedDegrees.has(deg);
      return `<div class="stat"><span class="degree-toggle${active ? " active" : ""}" data-degree="${deg}">Degree ${deg}</span><span class="v">${count}</span></div>`;
    })
    .join("");
}
// Delegated once (rows are still occasionally rebuilt from scratch, so
// listeners attached directly to them would eventually be lost). "mousedown"
// rather than "click" is a further guard against the same class of bug -
// it fires on whatever's under the cursor right now, with no dependency on
// a later mouseup landing on that exact, possibly-already-replaced, node.
degreeHistogramEl.addEventListener("mousedown", (e) => {
  const target = e.target.closest("[data-degree]");
  if (!target) return;
  const deg = parseInt(target.dataset.degree, 10);
  if (state.highlightedDegrees.has(deg)) state.highlightedDegrees.delete(deg);
  else state.highlightedDegrees.add(deg);
  _degreeHistogramSig = null; // force the next frame to re-render with the new active state
});

// ---------- main loop ----------
// `speed` is a playback-rate multiplier on physics steps per rendered frame,
// not a physics timestep multiplier (see physics.js) - at speed=1 this runs
// one step/frame (the old fixed behaviour); slower settings skip frames,
// faster settings run several steps before the next redraw. The fractional
// accumulator lets non-integer speeds (e.g. 0.2x) average out correctly.
const MAX_SUBSTEPS_PER_FRAME = 50;
const CONVERGED_FORCE = 1e-4;
function tick() {
  if (state.playing) {
    state._stepAccum += state.speed;
    let iters = 0;
    while (state._stepAccum >= 1 && state.maxForce > CONVERGED_FORCE && iters < MAX_SUBSTEPS_PER_FRAME) {
      stepPhysics();
      state._stepAccum -= 1;
      iters++;
    }
    // Genuinely stop, not just skip stepping: flips Play/Pause back to Play
    // so the button reflects the true (paused) state instead of silently
    // idling as "Pause" forever once the configuration has settled.
    if (state.maxForce <= CONVERGED_FORCE) setPlaying(false);
  }
  draw();
  stepVal.textContent = state.step;
  energyVal.textContent = state.energy.toFixed(4);
  forceVal.textContent = state.maxForce.toExponential(2);
  updateDegreeHistogram();
  drawEnergyChart();
  drawForceChart();
  requestAnimationFrame(tick);
}

// ---------- init ----------
state.N = parseInt(nSlider.value, 10);
state.p = P_VALUES[parseInt(pSlider.value, 10)];
state.seed = parseInt(seedInput.value, 10);
state.speed = parseFloat(speedSlider.value);
state.zoom = parseFloat(zoomSlider.value) / 100;
updatePInfinityUI();
resizeCanvas();
resizeEnergyChart();
resizeForceChart();
resetConfiguration();
requestAnimationFrame(tick);
