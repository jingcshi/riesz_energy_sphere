"use strict";

// ---------- shared line-chart renderer (energy & residual vs. step) ----------
const CHART_PAD = { l: 52, r: 8, t: 8, b: 16 };
const CHART_FONT = "9px system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif";

function setupChartCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  window.addEventListener("resize", resize);
  return { ctx, resize };
}

// Renders `hist` (an array of {step, ...}) as a line chart of `getValue(pt)`
// against `pt.step`. With `log: true`, the y-axis is log10-scaled and
// decorated with per-decade gridlines/labels instead of just min/max text.
// `xRange` is {lo, hi} in step units; points outside it are clipped.
function renderChart(canvas, ctx, hist, getValue,
                     { color, log = false, floor = 1e-12, xRange = null } = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!hist || hist.length < 2) return;

  // Determine the visible slice according to xRange
  let slice = hist;
  if (xRange) {
    const { lo, hi } = xRange;
    // Binary search for the first point at or after lo
    let a = 0, b = hist.length;
    while (a < b) { const m = (a + b) >> 1; if (hist[m].step < lo) a = m + 1; else b = m; }
    const first = a;
    let c = first, d = hist.length;
    while (c < d) { const m = (c + d) >> 1; if (hist[m].step <= hi) c = m + 1; else d = m; }
    const last = c;
    slice = hist.slice(first, last);
  }
  if (slice.length < 2) {
    // Still draw an axis even if the window is empty
    slice = hist.slice(-2);
  }

  const plotW = w - CHART_PAD.l - CHART_PAD.r, plotH = h - CHART_PAD.t - CHART_PAD.b;
  const minStep = slice[0].step, maxStep = slice[slice.length - 1].step;
  const stepRange = Math.max(1, maxStep - minStep);
  const xOf = (s) => CHART_PAD.l + ((s - minStep) / stepRange) * plotW;

  let yOf, drawYAxis;
  if (log) {
    let minV = Infinity, maxV = -Infinity;
    for (const pt of slice) {
      const v = Math.max(getValue(pt), floor);
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    let loLog = Math.log10(minV), hiLog = Math.log10(maxV);
    if (hiLog - loLog < 1e-6) { loLog -= 0.5; hiLog += 0.5; }
    const margin = (hiLog - loLog) * 0.08;
    loLog -= margin; hiLog += margin;
    yOf = (v) => CHART_PAD.t + (1 - (Math.log10(Math.max(v, floor)) - loLog) / (hiLog - loLog)) * plotH;

    drawYAxis = () => {
      const kLo = Math.ceil(loLog), kHi = Math.floor(hiLog);
      ctx.font = CHART_FONT;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      if (kHi >= kLo) {
        const MAX_TICKS = 5;
        const decStep = Math.max(1, Math.ceil((kHi - kLo + 1) / MAX_TICKS));
        for (let k = kLo; k <= kHi; k += decStep) {
          const y = yOf(Math.pow(10, k));
          ctx.strokeStyle = "rgba(139,148,158,0.15)";
          ctx.beginPath(); ctx.moveTo(CHART_PAD.l, y); ctx.lineTo(CHART_PAD.l + plotW, y); ctx.stroke();
          ctx.fillStyle = "#8b949e";
          ctx.fillText(`1e${k}`, CHART_PAD.l - 4, y);
        }
      } else {
        ctx.fillStyle = "#8b949e";
        ctx.fillText(maxV.toExponential(1), CHART_PAD.l - 4, CHART_PAD.t + 4);
        ctx.fillText(minV.toExponential(1), CHART_PAD.l - 4, CHART_PAD.t + plotH - 4);
      }
    };
  } else {
    let minV = Infinity, maxV = -Infinity;
    for (const pt of slice) {
      const v = getValue(pt);
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (minV === maxV) { minV -= 1; maxV += 1; }
    const margin = (maxV - minV) * 0.08;
    minV -= margin; maxV += margin;
    yOf = (v) => CHART_PAD.t + (1 - (v - minV) / (maxV - minV)) * plotH;

    drawYAxis = () => {
      ctx.font = CHART_FONT;
      ctx.fillStyle = "#8b949e";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      // Scientific notation with 2 decimal places
      ctx.fillText(maxV.toExponential(2), CHART_PAD.l - 4, CHART_PAD.t + 4);
      ctx.fillText(minV.toExponential(2), CHART_PAD.l - 4, CHART_PAD.t + plotH - 4);
    };
  }

  ctx.strokeStyle = "rgba(139,148,158,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CHART_PAD.l, CHART_PAD.t);
  ctx.lineTo(CHART_PAD.l, CHART_PAD.t + plotH);
  ctx.lineTo(CHART_PAD.l + plotW, CHART_PAD.t + plotH);
  ctx.stroke();

  drawYAxis();

  ctx.font = CHART_FONT;
  ctx.fillStyle = "#8b949e";
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillText(String(maxStep), CHART_PAD.l + plotW, CHART_PAD.t + plotH + 3);
  ctx.textAlign = "left";
  ctx.fillText(String(minStep), CHART_PAD.l, CHART_PAD.t + plotH + 3);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xOf(slice[0].step), yOf(getValue(slice[0])));
  for (let i = 1; i < slice.length; i++) ctx.lineTo(xOf(slice[i].step), yOf(getValue(slice[i])));
  ctx.stroke();

  const last = slice[slice.length - 1];
  ctx.beginPath();
  ctx.arc(xOf(last.step), yOf(getValue(last)), 2.5, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------- x-range window controller ----------
// Renders and manages a thin draggable scrubber bar below a chart canvas.
// The window [lo, hi] is expressed in step units matching the history.
// Callers read .lo and .hi; call .draw() to paint the bar; wire mouse events
// by calling .onMousedown, .onMousemove, .onMouseup.
//
// Layout: the bar sits in a separate <canvas> below the chart canvas. The
// full width maps to [0, maxStep]. Two handles mark lo and hi; the region
// between them is highlighted. Dragging either handle moves only that bound;
// dragging the filled region pans the window; dragging outside does nothing.
const WINDOW_H = 18;   // bar canvas height in CSS px
const HANDLE_W = 6;    // hit/drawn half-width of each handle
const WIN_WINDOW = 1000; // default window width in steps

function makeChartWindow(barCanvas, getMaxStep, onChanged) {
  const ctx = barCanvas.getContext("2d");
  let lo = 0, hi = 0;       // current window, in step units
  let _prevMax = 0;          // max seen on the last advance() call
  let drag = null;           // null | "lo" | "hi" | "pan"
  let panAnchorX = 0, panAnchorLo = 0, panAnchorHi = 0;

  // Snap lo/hi to valid range and ensure a minimum width of 1 step
  function clamp() {
    const max = Math.max(1, getMaxStep());
    lo = Math.max(0, Math.min(lo, max - 1));
    hi = Math.max(lo + 1, Math.min(hi, max));
  }

  function stepToX(s) {
    const max = Math.max(1, getMaxStep());
    const w = barCanvas.clientWidth;
    return (s / max) * w;
  }
  function xToStep(x) {
    const max = Math.max(1, getMaxStep());
    const w = barCanvas.clientWidth;
    return (x / w) * max;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = barCanvas.clientWidth, h = barCanvas.clientHeight;
    if (barCanvas.width !== w * dpr || barCanvas.height !== h * dpr) {
      barCanvas.width = w * dpr;
      barCanvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(1, getMaxStep());
    const xLo = stepToX(lo), xHi = stepToX(hi);

    // Track background
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    // Out-of-window regions dimmer
    ctx.fillStyle = "rgba(30,38,48,0.6)";
    ctx.fillRect(0, 0, xLo, h);
    ctx.fillRect(xHi, 0, w - xHi, h);

    // Window fill
    ctx.fillStyle = "rgba(56,139,253,0.12)";
    ctx.fillRect(xLo, 0, xHi - xLo, h);

    // Window border
    ctx.strokeStyle = "rgba(56,139,253,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(xLo + 0.5, 0.5, xHi - xLo - 1, h - 1);
    ctx.stroke();

    // Handles
    const hy = h / 2;
    for (const [sx, isActive] of [[xLo, drag === "lo"], [xHi, drag === "hi"]]) {
      ctx.fillStyle = isActive ? "#58a6ff" : "rgba(139,148,158,0.7)";
      ctx.beginPath();
      ctx.roundRect(sx - HANDLE_W / 2, 2, HANDLE_W, h - 4, 2);
      ctx.fill();
    }

    // Step labels inside the bar
    ctx.font = "8px system-ui, sans-serif";
    ctx.fillStyle = "#8b949e";
    ctx.textBaseline = "middle";
    const loLabel = String(Math.round(lo)), hiLabel = String(Math.round(hi));
    ctx.textAlign = "left";
    const loX = xLo + HANDLE_W / 2 + 3;
    if (loX + 2 < xHi - 10) ctx.fillText(loLabel, loX, hy);
    ctx.textAlign = "right";
    const hiX = xHi - HANDLE_W / 2 - 3;
    if (hiX - 2 > xLo + 10) ctx.fillText(hiLabel, hiX, hy);
  }

  function hitTest(x) {
    const xLo = stepToX(lo), xHi = stepToX(hi);
    if (Math.abs(x - xLo) <= HANDLE_W + 2) return "lo";
    if (Math.abs(x - xHi) <= HANDLE_W + 2) return "hi";
    if (x > xLo && x < xHi) return "pan";
    return null;
  }

  function onMousedown(e) {
    const rect = barCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    drag = hitTest(x);
    if (drag === "pan") {
      panAnchorX = x;
      panAnchorLo = lo;
      panAnchorHi = hi;
    }
    if (drag) { e.preventDefault(); draw(); }
  }

  function onMousemove(e) {
    if (!drag) {
      // Update cursor
      const rect = barCanvas.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left);
      barCanvas.style.cursor = hit === "lo" || hit === "hi" ? "ew-resize"
                             : hit === "pan" ? "grab" : "default";
      return;
    }
    const rect = barCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const s = xToStep(x);
    const max = Math.max(1, getMaxStep());
    if (drag === "lo") {
      lo = Math.max(0, Math.min(s, hi - 1));
    } else if (drag === "hi") {
      hi = Math.max(lo + 1, Math.min(s, max));
    } else if (drag === "pan") {
      const ds = xToStep(x - panAnchorX);
      const span = panAnchorHi - panAnchorLo;
      lo = Math.max(0, Math.min(panAnchorLo + ds, max - span));
      hi = lo + span;
    }
    clamp();
    draw();
    onChanged();
  }

  function onMouseup() {
    if (drag) { drag = null; draw(); }
  }

  // Called by the chart layer each time the history grows, so the window
  // auto-advances to track the latest steps unless the user has anchored it
  // by moving a handle.
  function advance(maxStep) {
    const max = Math.max(1, maxStep);
    // Two conditions keep the window pinned to the live end:
    //   • hi was at (or very near) the end of the previous max - user hasn't
    //     deliberately scrolled back, so follow the growing run.
    //   • hi is within the last 5% of a window-width of the current max - the
    //     usual steady-state case once the run is long.
    // Tracking _prevMax (not just checking against the current max) is what
    // lets the window jump forward when it was correctly at step=1 on page
    // load and the run later grows to step=3000: hi=1 would fail the second
    // check alone, but it does equal _prevMax=1.
    const wasAtEnd = hi >= max - WIN_WINDOW * 0.05 || hi >= _prevMax;
    _prevMax = max;
    if (wasAtEnd || hi === 0) {
      // Preserve the user's chosen span; only initialise to WIN_WINDOW the
      // very first time (hi===0). Resetting to WIN_WINDOW on every tracking
      // frame would fight any lo the user had dragged.
      const span = hi === 0 ? WIN_WINDOW : hi - lo;
      hi = max;
      lo = Math.max(0, max - span);
    }
    clamp();
  }

  // Public API
  return {
    get lo() { return lo; },
    get hi() { return hi; },
    draw,
    advance,
    onMousedown,
    onMousemove,
    onMouseup,
  };
}

// ---------- dirty-flag helpers ----------
// Each chart only redraws when the history has grown or the window has moved.
// The flag is set by the caller whenever either changes.
let _energyDirty = true, _residualDirty = true;
function markChartsDirty() { _energyDirty = true; _residualDirty = true; }

// ---------- energy-vs-step chart ----------
const energyChartCanvas = document.getElementById("energyChart");
const energyWindowCanvas = document.getElementById("energyWindow");
const { ctx: energyChartCtx, resize: resizeEnergyChart } = setupChartCanvas(energyChartCanvas);

const energyChartTitle = document.getElementById("energyChartTitle");

const energyWindow = makeChartWindow(
  energyWindowCanvas,
  () => state._energyHistory && state._energyHistory.length
    ? state._energyHistory[state._energyHistory.length - 1].step : 0,
  () => { _energyDirty = true; }
);

function drawEnergyChart() {
  const hist = state._energyHistory;
  const last = hist && hist.length ? hist[hist.length - 1] : null;
  if (last) energyWindow.advance(last.step);
  if (!_energyDirty) return;
  _energyDirty = false;

  const useLog = last !== null && !Number.isFinite(last.energy) && Number.isFinite(last.logEnergy);
  if (energyChartTitle) energyChartTitle.textContent = useLog ? "log Energy vs. step" : "Energy vs. step";
  renderChart(energyChartCanvas, energyChartCtx, hist,
    (pt) => (useLog ? pt.logEnergy : pt.energy),
    { color: "#58a6ff", xRange: { lo: energyWindow.lo, hi: energyWindow.hi } });
  energyWindow.draw();
}

// ---------- residual-vs-step chart ----------
const residualChartCanvas = document.getElementById("residualChart");
const residualWindowCanvas = document.getElementById("residualWindow");
const { ctx: residualChartCtx, resize: resizeResidualChart } = setupChartCanvas(residualChartCanvas);

const residualWindow = makeChartWindow(
  residualWindowCanvas,
  () => state._energyHistory && state._energyHistory.length
    ? state._energyHistory[state._energyHistory.length - 1].step : 0,
  () => { _residualDirty = true; }
);

function drawResidualChart() {
  const hist = state._energyHistory;
  const last = hist && hist.length ? hist[hist.length - 1] : null;
  if (last) residualWindow.advance(last.step);
  if (!_residualDirty) return;
  _residualDirty = false;

  renderChart(residualChartCanvas, residualChartCtx, hist,
    (pt) => pt.residual,
    { color: "#ffa657", log: true, floor: 1e-14, xRange: { lo: residualWindow.lo, hi: residualWindow.hi } });
  residualWindow.draw();
}

// ---------- wire window mouse events ----------
function wireWindowEvents(barCanvas, win) {
  barCanvas.addEventListener("mousedown", (e) => win.onMousedown(e));
  window.addEventListener("mousemove", (e) => win.onMousemove(e));
  window.addEventListener("mouseup", () => win.onMouseup());
}
wireWindowEvents(energyWindowCanvas, energyWindow);
wireWindowEvents(residualWindowCanvas, residualWindow);
