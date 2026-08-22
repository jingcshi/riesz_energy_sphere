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

// Index range [first, last) of `hist` whose `step` lies within [lo, hi].
// `hist` is sorted by step, so both ends are binary searches. Shared with
// drawEnergyChart, which needs the same window to decide its y-axis units.
function sliceIndicesByStep(hist, lo, hi) {
  let a = 0, b = hist.length;
  while (a < b) { const m = (a + b) >> 1; if (hist[m].step < lo) a = m + 1; else b = m; }
  const first = a;
  let c = first, d = hist.length;
  while (c < d) { const m = (c + d) >> 1; if (hist[m].step <= hi) c = m + 1; else d = m; }
  return { first, last: c };
}

// Renders `hist` (an array of {step, ...}) as a line chart of `getValue(pt)`
// against `pt.step`. With `log: true`, the y-axis is log10-scaled and
// decorated with per-decade gridlines/labels instead of just min/max text.
// `xRange` is {lo, hi} in step units; points outside it are clipped.
//
// Non-finite values are tolerated throughout rather than assumed away. The
// energy history legitimately contains them: Math.exp(logEnergy) overflows to
// Infinity past logE~709, which happens for a whole run at large p and for the
// early part of a run at p~250, and p=0 stores logEnergy as NaN. Feeding either
// into the min/max scan used to poison the entire chart - Infinity max makes the
// 8% margin infinite, which sends both bounds to +/-Infinity, every y coordinate
// to NaN (so nothing draws at all) and both axis labels to the string
// "Infinity". Such points are now excluded from the scan and break the
// polyline instead of collapsing it.
function renderChart(canvas, ctx, hist, getValue,
                     { color, log = false, floor = 1e-12, xRange = null } = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!hist || hist.length < 2) return;

  // Determine the visible slice according to xRange
  let slice = hist;
  if (xRange) {
    const { first, last } = sliceIndicesByStep(hist, xRange.lo, xRange.hi);
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

  // Axis bounds come only from values that can actually be plotted.
  let minV = Infinity, maxV = -Infinity, finiteCount = 0;
  for (const pt of slice) {
    let v = getValue(pt);
    if (!Number.isFinite(v)) continue;
    if (log) v = Math.max(v, floor);
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    finiteCount++;
  }

  const axisOnly = () => {
    ctx.strokeStyle = "rgba(139,148,158,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, CHART_PAD.t);
    ctx.lineTo(CHART_PAD.l, CHART_PAD.t + plotH);
    ctx.lineTo(CHART_PAD.l + plotW, CHART_PAD.t + plotH);
    ctx.stroke();
    ctx.font = CHART_FONT;
    ctx.fillStyle = "#8b949e";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("\u2014", CHART_PAD.l - 4, CHART_PAD.t + plotH / 2);
  };

  // Nothing representable in this window: draw the frame and say so, rather
  // than emitting NaN geometry and "Infinity" labels.
  if (finiteCount === 0) { axisOnly(); return; }

  let yOf, drawYAxis;
  if (log) {
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

  // Lift the pen across unrepresentable stretches instead of drawing to NaN,
  // which would silently abort the whole path.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let penDown = false;
  let lastFinite = null;
  for (const pt of slice) {
    const v = getValue(pt);
    if (!Number.isFinite(v)) { penDown = false; continue; }
    const x = xOf(pt.step), y = yOf(v);
    if (penDown) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); penDown = true; }
    lastFinite = pt;
  }
  ctx.stroke();

  if (lastFinite) {
    ctx.beginPath();
    ctx.arc(xOf(lastFinite.step), yOf(getValue(lastFinite)), 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }
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
  let lo = 0, hi = 0;         // current window in step units
  let windowSize = WIN_WINDOW; // desired span; actual hi-lo may be smaller near step 0
  let _userMoved = false;      // irreversible (except reset): any interaction sets this
  let _loFixed  = false;       // lo no longer tracks hi; toggled by left-handle click
  let _hiFixed  = false;       // hi no longer tracks max; cleared only by right-edge hold

  let drag = null;             // null | "lo" | "hi" | "pan"
  let _mousedownX = 0;         // x at mousedown, for click-vs-drag detection
  let _hasDragged = false;     // set once mouse moves > 3 px during a drag
  let panAnchorX = 0, panAnchorLo = 0, panAnchorHi = 0;
  let _retrackTimer = null;    // right-edge 0.5 s hold → _hiFixed = false
  let _loPinTimer   = null;    // left-edge  0.5 s hold → _loFixed = true, lo = 0

  function clamp() {
    const max = Math.max(1, getMaxStep());
    lo = Math.max(0, Math.min(lo, max - 1));
    hi = Math.max(lo + 1, Math.min(hi, max));
  }

  function stepToX(s) {
    const max = Math.max(1, getMaxStep());
    return (s / max) * barCanvas.clientWidth;
  }
  function xToStep(x) {
    const max = Math.max(1, getMaxStep());
    return (x / barCanvas.clientWidth) * max;
  }

  // ── draw ──────────────────────────────────────────────────────────────────
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = barCanvas.clientWidth, h = barCanvas.clientHeight;
    if (barCanvas.width !== w * dpr || barCanvas.height !== h * dpr) {
      barCanvas.width  = w * dpr;
      barCanvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    const xLo = stepToX(lo), xHi = stepToX(hi);

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "rgba(30,38,48,0.6)";
    ctx.fillRect(0, 0, xLo, h);
    ctx.fillRect(xHi, 0, w - xHi, h);

    ctx.fillStyle = "rgba(56,139,253,0.12)";
    ctx.fillRect(xLo, 0, xHi - xLo, h);

    ctx.strokeStyle = "rgba(56,139,253,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(xLo + 0.5, 0.5, xHi - xLo - 1, h - 1);
    ctx.stroke();

    // Handle colours:
    //   amber   – over-drag timer is counting down  (feedback: "release to snap")
    //   blue    – actively being dragged
    //   bright grey – handle is "fixed" (_loFixed / _hiFixed)
    //   dim grey    – free / auto-tracking
    const handleDefs = [
      { sx: xLo, isLo: true  },
      { sx: xHi, isLo: false },
    ];
    for (const { sx, isLo } of handleDefs) {
      const timerActive = isLo ? _loPinTimer !== null : _retrackTimer !== null;
      const isActive    = drag === (isLo ? "lo" : "hi");
      const isFixed     = isLo ? _loFixed : _hiFixed;
      ctx.fillStyle = timerActive ? "#e3b341"
                    : isActive    ? "#58a6ff"
                    : isFixed     ? "#c9d1d9"
                    :               "rgba(139,148,158,0.7)";
      ctx.beginPath();
      ctx.roundRect(sx - HANDLE_W / 2, 2, HANDLE_W, h - 4, 2);
      ctx.fill();
    }

    const hy = h / 2;
    ctx.font = "8px system-ui, sans-serif";
    ctx.fillStyle = "#8b949e";
    ctx.textBaseline = "middle";
    const loX = xLo + HANDLE_W / 2 + 3;
    const hiX = xHi - HANDLE_W / 2 - 3;
    if (loX + 2 < xHi - 10) {
      ctx.textAlign = "left";
      ctx.fillText(String(Math.round(lo)), loX, hy);
    }
    if (hiX - 2 > xLo + 10) {
      ctx.textAlign = "right";
      ctx.fillText(String(Math.round(hi)), hiX, hy);
    }
  }

  // ── hit test ──────────────────────────────────────────────────────────────
  function hitTest(x) {
    const xLo = stepToX(lo), xHi = stepToX(hi);
    if (Math.abs(x - xLo) <= HANDLE_W + 2) return "lo";
    if (Math.abs(x - xHi) <= HANDLE_W + 2) return "hi";
    if (x > xLo && x < xHi) return "pan";
    return null;
  }

  // ── edge-hold timers ──────────────────────────────────────────────────────
  // Right-edge hold while dragging "hi": clears _hiFixed → hi resumes tracking.
  function _startRetrack() {
    if (_retrackTimer !== null) return;
    _retrackTimer = setTimeout(() => {
      _retrackTimer = null;
      _hiFixed = false;
      drag = null;
      draw();
      onChanged();
    }, 500);
  }
  function _cancelRetrack() {
    if (_retrackTimer !== null) { clearTimeout(_retrackTimer); _retrackTimer = null; }
  }

  // Left-edge hold while dragging "lo": sets _loFixed = true and snaps lo to 0.
  function _startLoPin() {
    if (_loPinTimer !== null) return;
    _loPinTimer = setTimeout(() => {
      _loPinTimer = null;
      _loFixed = true;
      lo = 0;
      windowSize = hi - lo;
      draw();
      onChanged();
    }, 500);
  }
  function _cancelLoPin() {
    if (_loPinTimer !== null) { clearTimeout(_loPinTimer); _loPinTimer = null; }
  }

  // ── mouse events ──────────────────────────────────────────────────────────
  function onMousedown(e) {
    const rect = barCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    drag = hitTest(x);
    if (!drag) return;
    _userMoved  = true;
    _mousedownX = x;
    _hasDragged = false;
    if (drag === "hi" || drag === "pan") _hiFixed = true; // rules 4 & 7
    if (drag === "pan") {
      panAnchorX  = x;
      panAnchorLo = lo;
      panAnchorHi = hi;
    }
    e.preventDefault();
    draw();
  }

  function onMousemove(e) {
    if (!drag) {
      const rect = barCanvas.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left);
      barCanvas.style.cursor = (hit === "lo" || hit === "hi") ? "ew-resize"
                              : hit === "pan"                  ? "grab"
                              :                                  "default";
      return;
    }
    const rect = barCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const s = xToStep(x);
    const max = Math.max(1, getMaxStep());

    if (!_hasDragged && Math.abs(x - _mousedownX) > 3) _hasDragged = true;

    if (drag === "lo") {
      lo = Math.max(0, Math.min(s, hi - 1));
      windowSize = hi - lo;
      // Left-edge hold: pins lo to 0 and sets _loFixed
      if (x <= 0) _startLoPin(); else _cancelLoPin();
    } else if (drag === "hi") {
      hi = Math.max(lo + 1, Math.min(s, max));
      windowSize = hi - lo;
      // Right-edge hold: clears _hiFixed, resumes auto-tracking
      if (x >= barCanvas.clientWidth) _startRetrack(); else _cancelRetrack();
    } else if (drag === "pan") {
      // rule 7: pan keeps _loFixed unchanged; _hiFixed already set in mousedown
      const ds   = xToStep(x - panAnchorX);
      const span = panAnchorHi - panAnchorLo;
      lo = Math.max(0, Math.min(panAnchorLo + ds, max - span));
      hi = lo + span;
      // windowSize unchanged — span is preserved
    }
    clamp();
    draw();
    onChanged();
  }

  function onMouseup(e) {
    _cancelRetrack();
    _cancelLoPin();
    if (!drag) return;
    const isClick = !_hasDragged;
    if (isClick && drag === "lo") _loFixed = !_loFixed;  // rule 2: toggle on click
    // rule 4: hi click sets _hiFixed (already done in mousedown); no toggle back here
    drag = null;
    draw();
  }

  // ── advance (called every chart redraw) ───────────────────────────────────
  // Pauses during active drag to avoid fighting the user's gesture.
  // When _userMoved is false the 1000-step cap is enforced on windowSize.
  // When _hiFixed is false, hi always equals the latest step; if _loFixed is
  // also false, lo trails hi by windowSize (expanding from 0 until windowSize
  // is reached, then sliding).
  function advance(maxStep) {
    if (drag) return;                       // don't fight an in-progress drag
    const max = Math.max(1, maxStep);
    if (!_userMoved) windowSize = Math.min(max, WIN_WINDOW);
    if (_hiFixed) return;
    hi = max;
    if (!_loFixed) lo = Math.max(0, hi - windowSize);
    clamp();
  }

  // ── reset (called on configuration change) ────────────────────────────────
  function reset() {
    _cancelRetrack();
    _cancelLoPin();
    lo = 0; hi = 0; windowSize = WIN_WINDOW;
    _userMoved = false; _loFixed = false; _hiFixed = false;
    drag = null;
  }

  return {
    get lo() { return lo; },
    get hi() { return hi; },
    draw, advance, reset,
    onMousedown, onMousemove, onMouseup,
  };
}

// ---------- dirty-flag helpers ----------
// Each chart only redraws when the history has grown or the window has moved.
// The flag is set by the caller whenever either changes.
let _energyDirty = true, _residualDirty = true;
// isReset=true is passed by resetConfiguration() so the windows return to
// auto-tracking mode for the new run.
function markChartsDirty(isReset) {
  _energyDirty = true;
  _residualDirty = true;
  if (isReset) { energyWindow.reset(); residualWindow.reset(); }
}

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

  // Choose the units from the whole visible window, not just its last point.
  // Deciding from the last point alone breaks whenever the window straddles
  // logE~709, where Math.exp overflows: the newest energy reads finite so the
  // linear branch is chosen, while older entries in the same window are
  // Infinity. That happens within one run around p~250, and across a change of
  // p at any exponent large enough to have overflowed before.
  let useLog = false;
  if (last !== null) {
    const { first, last: end } = sliceIndicesByStep(hist, energyWindow.lo, energyWindow.hi);
    let anyEnergyBad = false, allLogGood = true;
    for (let i = first; i < end; i++) {
      if (!Number.isFinite(hist[i].energy)) anyEnergyBad = true;
      if (!Number.isFinite(hist[i].logEnergy)) allLogGood = false;
    }
    useLog = anyEnergyBad && allLogGood;
  }
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
  window.addEventListener("mouseup", (e) => win.onMouseup(e));
}
wireWindowEvents(energyWindowCanvas, energyWindow);
wireWindowEvents(residualWindowCanvas, residualWindow);
