"use strict";

// ---------- interaction: drag to rotate, with inertial spin ----------
const ROTATE_K = 0.008;
const DRAG_CLICK_THRESHOLD = 4; // px of total travel below which a mousedown/up counts as a plain click, not a drag
let dragging = false, lastX = 0, lastY = 0, dragTravel = 0;
// Exponentially-smoothed per-event pixel delta, used only to estimate a
// stable release velocity - the literal last mousemove event before
// mouseup is often a near-zero "settling" movement (mouse decelerating
// before the button lifts), which would otherwise make the resulting spin
// velocity wildly under-estimate how fast the user was actually dragging.
let smoothDx = 0, smoothDy = 0;
// Persistent (non-decaying) spin, in the same yaw/pitch-per-frame units
// `tick()` feeds into rotationY/rotationX below - "persistent" is literal
// here: nothing damps it over time, only a fresh drag (overwrite) or a
// plain click (explicit stop) ever changes it, mirroring the frictionless
// feel of the rest of the sim (no artificial energy loss).
let spinYaw = 0, spinPitch = 0;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  dragTravel = 0;
  smoothDx = 0; smoothDy = 0;
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (dragTravel > DRAG_CLICK_THRESHOLD) {
    // Real drag: overwrite whatever spin was already running with this
    // drag's (smoothed) release velocity, damped so the spin feels calmer
    // than a 1:1 continuation of the drag speed.
    const SPIN_DAMPING = 0.1;
    spinYaw = smoothDx * ROTATE_K * SPIN_DAMPING;
    spinPitch = smoothDy * ROTATE_K * SPIN_DAMPING;
  } else {
    // Plain click (negligible travel): explicitly stop any existing spin,
    // rather than leaving it running or replacing it with drag noise.
    spinYaw = 0;
    spinPitch = 0;
  }
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  dragTravel += Math.hypot(dx, dy);
  smoothDx = smoothDx * 0.7 + dx * 0.3;
  smoothDy = smoothDy * 0.7 + dy * 0.3;
  // Apply this drag's yaw/pitch in the *current* view frame (pre-multiply)
  // rather than accumulating into stored Euler angles - see geometry.js for
  // why that avoids the gimbal-lock "wall" the old rotX/rotY scheme hit.
  const delta = matMultiply(rotationY(dx * ROTATE_K), rotationX(dy * ROTATE_K));
  state.viewMatrix = matMultiply(delta, state.viewMatrix);
});

// ---------- UI wiring ----------
const nSlider = document.getElementById("nSlider");
const pSlider = document.getElementById("pSlider");
const seedInput = document.getElementById("seedInput");
const randomizeSeedBtn = document.getElementById("randomizeSeedBtn");
const speedSlider = document.getElementById("speedSlider");
const nInput = document.getElementById("nInput");
const pVal = document.getElementById("pVal");
const speedVal = document.getElementById("speedVal");
const playBtn = document.getElementById("playBtn");
const resetBtn = document.getElementById("resetBtn");
const energyVal = document.getElementById("energyVal");
const energyLabel = document.getElementById("energyLabel");
const stepVal = document.getElementById("stepVal");
const forceVal = document.getElementById("forceVal");
const forceLabel = document.getElementById("forceLabel");
const residualVal = document.getElementById("residualVal");
const minSepVal = document.getElementById("minSepVal");
const countV = document.getElementById("countV");
const countE = document.getElementById("countE");
const countEFiltered = document.getElementById("countEFiltered");
const countF = document.getElementById("countF");
const countChi = document.getElementById("countChi");
const degreeHistogramEl = document.getElementById("degreeHistogram");
const faceHistogramEl = document.getElementById("faceHistogram");
const edgeVisButtons = document.querySelectorAll("#edgeVisSegmented .seg");
const faceVisButtons = document.querySelectorAll("#faceVisSegmented .seg");
const shapeButtons = document.querySelectorAll("#shapeSegmented .seg");
const metricButtons = document.querySelectorAll("#metricSegmented .seg");
const zoomSlider = document.getElementById("zoomSlider");
const zoomVal = document.getElementById("zoomVal");
const opacitySlider = document.getElementById("opacitySlider");
const opacityVal = document.getElementById("opacityVal");

function setPlaying(playing) {
  state.playing = playing;
  playBtn.textContent = playing ? "Pause" : "Play";
  playBtn.classList.toggle("state-play", !playing);
  playBtn.classList.toggle("state-pause", playing);
}

nSlider.addEventListener("input", () => {
  state.N = N_VALUES[parseInt(nSlider.value, 10)];
  nInput.value = String(state.N);
  resetConfiguration();
});
// The slider only stops at N_VALUES, so anything in between has to be typed.
// Commit on change rather than input, so a partially typed number isn't taken
// as a request to rebuild the configuration on every keystroke.
nInput.addEventListener("change", () => {
  // A number input reports anything unparseable as the empty string, and
  // Number("") is 0, which would silently collapse the configuration to a
  // single point - so an empty or nonsensical entry restores the current N
  // rather than being clamped into range.
  const raw = nInput.value.trim();
  const wanted = raw === "" ? NaN : Math.round(Number(raw));
  const n = Number.isFinite(wanted) ? Math.min(N_MAX, Math.max(1, wanted)) : state.N;
  nInput.value = String(n);
  if (n === state.N) return;
  state.N = n;
  nSlider.value = String(nearestNIndex(n));
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
  resetConvergenceTracking(); // ...and the objective it was being compared against
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
edgeVisButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    edgeVisButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.edgesVisible = btn.dataset.vis;
  });
});
faceVisButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    faceVisButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.facesVisible = btn.dataset.vis;
  });
});
shapeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    shapeButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.shapeStyle = btn.dataset.shape;
  });
});
metricButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    metricButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.metric = btn.dataset.metric;
    state._trust = 1.0; // landscape stiffness changed with metric - retune step size
    resetConvergenceTracking();
    computeEnergyAndForce();
  });
});
zoomSlider.addEventListener("input", () => {
  state.zoom = parseFloat(zoomSlider.value) / 100;
  zoomVal.textContent = zoomSlider.value + "%";
});
opacitySlider.addEventListener("input", () => {
  state.sphereOpacity = parseFloat(opacitySlider.value) / 100;
  opacityVal.textContent = opacitySlider.value + "%";
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
const infoNavButtons = document.querySelectorAll("#infoNav .nav-item");
const infoPanels = document.querySelectorAll(".tab-panel");
const infoBody = document.querySelector(".modal-body");

infoBtn.addEventListener("click", () => infoOverlay.classList.remove("hidden"));
infoClose.addEventListener("click", () => infoOverlay.classList.add("hidden"));
infoOverlay.addEventListener("click", (e) => {
  if (e.target === infoOverlay) infoOverlay.classList.add("hidden");
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") infoOverlay.classList.add("hidden");
});
infoNavButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    infoNavButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    infoPanels.forEach((p) => p.classList.toggle("active", p.dataset.tab === btn.dataset.tab));
    // All panels share one scroll container, so without this a new section
    // would open already scrolled to wherever the previous one was left.
    infoBody.scrollTop = 0;
  });
});

// Sorted high-degree-first, since that's the more informative end for
// spotting defects (a lone degree-7 vertex among mostly-6 is a disclination;
// a lone low-degree one is comparatively unremarkable/expected near a
// 5-fold symmetric arrangement). Each row's "Degree x" label doubles as a
// 3-state toggle (delegated click handler below) cycling
// normal -> highlighted -> hidden -> normal, for spotting mesoscopic
// defects/scars (highlight) or isolating just them to see their own global
// arrangement (hide everything else).
//
// Only rebuilds the DOM when the rendered rows would actually differ - this
// was called every animation frame (~60/s), unconditionally replacing the
// whole innerHTML. That silently broke the click: a real click is a
// mousedown+mouseup pair on the *same* element, but the element under the
// cursor was being destroyed and replaced with a fresh one before the
// mouseup ever landed, so the browser never synthesized a "click" at all.
// V/E/F/chi for whatever the two geometry layers currently describe, hiding
// included - render.js does the counting (it already holds both candidate
// sets); this only formats. E reads "accepted +filtered", the second term in
// amber and omitted when zero, and chi is taken over their union so a closed
// surface always reports 2. See render.js for why the split is needed at all.
function updateGeometryCounts() {
  const c = state._counts;
  if (!c) return;
  countV.textContent = c.V;
  countE.textContent = c.E;
  countEFiltered.textContent = c.EFiltered > 0 ? `+${c.EFiltered}` : "";
  countF.textContent = c.F;
  const chi = c.V - (c.E + c.EFiltered) + c.F;
  countChi.textContent = chi;
  countChi.classList.toggle("euler-off", chi !== 2);
}

let _degreeHistogramSig = null;
function updateDegreeHistogram() {
  const degree = state._degree || [];
  const counts = new Map();
  for (const d of degree) counts.set(d, (counts.get(d) || 0) + 1);
  const rows = Array.from(counts.entries()).sort((a, b) => b[0] - a[0]);
  const sig = rows.map(([d, c]) => `${d}:${c}`).join(",") + "|" +
    Array.from(state.highlightedDegrees).sort().join(",") + "|" +
    Array.from(state.hiddenDegrees).sort().join(",");
  if (sig === _degreeHistogramSig) return;
  _degreeHistogramSig = sig;
  degreeHistogramEl.innerHTML = rows
    .map(([deg, count]) => {
      const stateClass = state.highlightedDegrees.has(deg) ? " active"
        : state.hiddenDegrees.has(deg) ? " state-hidden"
        : "";
      return `<div class="stat"><span class="degree-toggle${stateClass}" data-degree="${deg}">Degree ${deg}</span><span class="v">${count}</span></div>`;
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
  if (state.highlightedDegrees.has(deg)) {
    state.highlightedDegrees.delete(deg);
    state.hiddenDegrees.add(deg);
  } else if (state.hiddenDegrees.has(deg)) {
    state.hiddenDegrees.delete(deg);
  } else {
    state.highlightedDegrees.add(deg);
  }
  _degreeHistogramSig = null; // force the next frame to re-render with the new state
});

// The left panel's Faces Hide/Show segmented control is the coarse master
// switch for the whole layer; this histogram is the fine-grained control
// underneath it. Each row defaults to "standard" (shown, once the master
// switch is on) and toggles to a dim strikethrough ("hidden") on click -
// membership in state.hiddenFaceSides, which is deliberately independent
// of (and persists across) the master switch, so flipping Hide/Show back
// and forth in the left panel never forgets which individual side-counts
// you'd already chosen to suppress. Sorted side-count descending, same
// convention as the vertex-degree histogram, and rebuilt only on signature
// change for the same click-reliability reason (see updateDegreeHistogram
// above).
let _faceHistogramSig = null;
function updateFaceHistogram() {
  const faces = state._faces || [];
  const counts = new Map();
  for (const f of faces) counts.set(f.sides, (counts.get(f.sides) || 0) + 1);
  const rows = Array.from(counts.entries()).sort((a, b) => b[0] - a[0]);
  const sig = rows.map(([s, c]) => `${s}:${c}`).join(",") + "|" +
    Array.from(state.hiddenFaceSides).sort().join(",");
  if (sig === _faceHistogramSig) return;
  _faceHistogramSig = sig;
  faceHistogramEl.innerHTML = rows
    .map(([sides, count]) => {
      const stateClass = state.hiddenFaceSides.has(sides) ? " state-hidden" : "";
      const swatch = faceStrokeColor(sides);
      const label = faceSidesName(sides);
      return `<div class="stat"><span class="face-toggle${stateClass}" data-sides="${sides}">` +
        `<span class="face-swatch" style="background:${swatch}"></span>${label}</span><span class="v">${count}</span></div>`;
    })
    .join("");
}
faceHistogramEl.addEventListener("mousedown", (e) => {
  const target = e.target.closest("[data-sides]");
  if (!target) return;
  const sides = parseInt(target.dataset.sides, 10);
  if (state.hiddenFaceSides.has(sides)) state.hiddenFaceSides.delete(sides);
  else state.hiddenFaceSides.add(sides);
  _faceHistogramSig = null;
});

// ---------- main loop ----------
// `speed` is a playback-rate multiplier on physics steps per rendered frame,
// not a physics timestep multiplier (see physics.js) - at speed=1 this runs
// one step/frame (the old fixed behaviour); slower settings skip frames,
// faster settings run several steps before the next redraw. The fractional
// accumulator lets non-integer speeds (e.g. 0.2x) average out correctly.
const MAX_SUBSTEPS_PER_FRAME = 50;
const CONVERGED_FORCE = 1e-4;
// Two independent stopping conditions, because one alone can't cover the p
// range: the force threshold is absolute, so it's unreachable at large p
// where a fully-settled configuration still reports maxForce ~1e+3 (the
// force's own scale grows like e^O(p)), while `stalled` - the objective
// having stopped improving to within double precision - catches exactly that
// case. See physics.js for why a scale-free force threshold can't replace
// either of them.
function isConverged() {
  return state.maxForce <= CONVERGED_FORCE || state.stalled;
}

// Large energies (p past ~15 puts E in the millions and up) read better in
// exponential form than as a long fixed-point string.
function formatEnergy(e) {
  return Math.abs(e) >= 1e7 ? e.toExponential(4) : e.toFixed(4);
}

function tick() {
  // Inertial spin: only while the user isn't actively dragging (which
  // drives the view directly via the mousemove handler above).
  if (!dragging && (spinYaw !== 0 || spinPitch !== 0)) {
    const delta = matMultiply(rotationY(spinYaw), rotationX(spinPitch));
    state.viewMatrix = matMultiply(delta, state.viewMatrix);
  }
  if (state.playing) {
    state._stepAccum += state.speed;
    let iters = 0;
    while (state._stepAccum >= 1 && !isConverged() && iters < MAX_SUBSTEPS_PER_FRAME) {
      stepPhysics();
      state._stepAccum -= 1;
      iters++;
    }
    // Genuinely stop, not just skip stepping: flips Play/Pause back to Play
    // so the button reflects the true (paused) state instead of silently
    // idling as "Pause" forever once the configuration has settled.
    if (isConverged()) setPlaying(false);
  }
  draw();
  stepVal.textContent = state.step;
  // Energy is shown in log form once it overflows double precision, which it
  // does past roughly p=250 - the log is the quantity the integrator actually
  // compares anyway (see physics.js), so nothing is lost but the label.
  if (Number.isFinite(state.energy)) {
    energyLabel.textContent = "Energy";
    energyVal.textContent = formatEnergy(state.energy);
  } else if (Number.isFinite(state._logEnergy)) {
    energyLabel.textContent = "log Energy";
    energyVal.textContent = state._logEnergy.toFixed(4);
  } else {
    energyLabel.textContent = "Energy";
    energyVal.textContent = "\u2014";
  }
  forceLabel.textContent = state._forceUnitsRelative ? "Max force (rel.)" : "Max force";
  forceVal.textContent = state.maxForce.toExponential(2);
  residualVal.textContent = Number.isFinite(state._residual) ? state._residual.toExponential(2) : "\u2014";
  minSepVal.textContent = Number.isFinite(state._minSeparation)
    ? (state._minSeparation * 180 / Math.PI).toFixed(3) + "\u00b0"
    : "\u2014";
  updateGeometryCounts();
  updateDegreeHistogram();
  updateFaceHistogram();
  drawEnergyChart();
  drawResidualChart();
  requestAnimationFrame(tick);
}

// ---------- init ----------
// Derived from P_VALUES/N_VALUES rather than trusted from the markup, so
// extending either scale can't silently leave the top of it unreachable.
pSlider.max = String(P_VALUES.length - 1);
nSlider.max = String(N_VALUES.length - 1);
nInput.max = String(N_MAX);
state.N = N_VALUES[parseInt(nSlider.value, 10)];
nInput.value = String(state.N);
state.p = P_VALUES[parseInt(pSlider.value, 10)];
state.seed = parseInt(seedInput.value, 10);
state.speed = parseFloat(speedSlider.value);
state.zoom = parseFloat(zoomSlider.value) / 100;
state.sphereOpacity = parseFloat(opacitySlider.value) / 100;
updatePInfinityUI();
resizeCanvas();
resizeEnergyChart();
resizeResidualChart();
resetConfiguration();
requestAnimationFrame(tick);
