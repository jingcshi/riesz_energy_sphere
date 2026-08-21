"use strict";

// ---------- shared line-chart renderer (energy & max-force vs. step) ----------
const CHART_PAD = { l: 40, r: 8, t: 8, b: 16 };
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
function renderChart(canvas, ctx, hist, getValue, { color, log = false, floor = 1e-12 } = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!hist || hist.length < 2) return;

  const plotW = w - CHART_PAD.l - CHART_PAD.r, plotH = h - CHART_PAD.t - CHART_PAD.b;
  const minStep = hist[0].step, maxStep = hist[hist.length - 1].step;
  const stepRange = Math.max(1, maxStep - minStep);
  const xOf = (s) => CHART_PAD.l + ((s - minStep) / stepRange) * plotW;

  let yOf, drawYAxis;
  if (log) {
    let minV = Infinity, maxV = -Infinity;
    for (const pt of hist) {
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
        // Cap at 5 gridlines: a long-converging run can span a dozen+
        // decades, and one label per decade would clutter the axis solid.
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
    for (const pt of hist) {
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
      ctx.fillText(maxV.toFixed(2), CHART_PAD.l - 4, CHART_PAD.t + 4);
      ctx.fillText(minV.toFixed(2), CHART_PAD.l - 4, CHART_PAD.t + plotH - 4);
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
  ctx.moveTo(xOf(hist[0].step), yOf(getValue(hist[0])));
  for (let i = 1; i < hist.length; i++) ctx.lineTo(xOf(hist[i].step), yOf(getValue(hist[i])));
  ctx.stroke();

  const last = hist[hist.length - 1];
  ctx.beginPath();
  ctx.arc(xOf(last.step), yOf(getValue(last)), 2.5, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------- energy-vs-step chart ----------
const energyChartCanvas = document.getElementById("energyChart");
const { ctx: energyChartCtx, resize: resizeEnergyChart } = setupChartCanvas(energyChartCanvas);

// At large p the energy overflows double precision, so plot log E instead
// once that happens - an unplottable Infinity would blank the chart out
// entirely. The choice is made per-render from the latest sample rather than
// per-sample, so the curve never mixes the two scales in one line.
const energyChartTitle = document.getElementById("energyChartTitle");
function drawEnergyChart() {
  const hist = state._energyHistory;
  const last = hist && hist.length ? hist[hist.length - 1] : null;
  const useLog = last !== null && !Number.isFinite(last.energy) && Number.isFinite(last.logEnergy);
  if (energyChartTitle) energyChartTitle.textContent = useLog ? "log Energy vs. step" : "Energy vs. step";
  renderChart(energyChartCanvas, energyChartCtx, hist, (pt) => (useLog ? pt.logEnergy : pt.energy), { color: "#58a6ff" });
}

// ---------- max-force-vs-step chart ----------
// Log scale: maxForce decays across many orders of magnitude as the system
// settles (that's the whole point of the "converged" state), so a linear
// axis would flatten the last, most interesting 99% of the run into a line
// hugging zero.
const forceChartCanvas = document.getElementById("forceChart");
const { ctx: forceChartCtx, resize: resizeForceChart } = setupChartCanvas(forceChartCanvas);

function drawForceChart() {
  renderChart(forceChartCanvas, forceChartCtx, state._energyHistory, (pt) => pt.maxForce, { color: "#ffa657", log: true, floor: 1e-9 });
}
