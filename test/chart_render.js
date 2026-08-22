"use strict";

// Regression tests for renderChart's handling of non-finite history values.
//
// The reported failure: N=1024, p=1000 fills _energyHistory with energy =
// Infinity (logE ~ 6500, far past Math.exp's 709 ceiling). Switching to p=3
// left those points in the window while the newest point read finite, so the
// linear branch was chosen, the max came out Infinity, the 8% margin came out
// Infinity, both bounds went to +/-Infinity, every y coordinate became NaN and
// both axis labels rendered the string "Infinity".
//
// chart.js touches the DOM at load, so it is exercised through a stub canvas
// that records every fillText and path coordinate. That is enough to assert the
// two things that actually broke: no label ever reads Infinity/NaN, and no
// drawing command receives a non-finite coordinate.
//
// Run: node test/chart_render.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

// ---------- canvas / DOM stubs ----------
const texts = [];
const coords = [];

function makeCtx() {
  const rec = (...xs) => { for (const x of xs) coords.push(x); };
  return {
    clearRect: rec, fillRect: rec, strokeRect: rec,
    moveTo: rec, lineTo: rec,
    arc: (x, y, r) => rec(x, y, r),
    rect: rec, roundRect: rec,
    beginPath() {}, stroke() {}, fill() {}, setTransform() {},
    fillText(t) { texts.push(String(t)); },
    measureText: () => ({ width: 10 }),
    save() {}, restore() {},
    set fillStyle(v) {}, get fillStyle() { return ""; },
    set strokeStyle(v) {}, get strokeStyle() { return ""; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set font(v) {}, get font() { return ""; },
    set textAlign(v) {}, get textAlign() { return ""; },
    set textBaseline(v) {}, get textBaseline() { return ""; },
  };
}

function makeCanvas() {
  return {
    clientWidth: 320, clientHeight: 120, width: 320, height: 120,
    style: {},
    getContext: makeCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener() {},
  };
}

const elements = {};
function getEl(id) {
  if (!elements[id]) elements[id] = id.toLowerCase().includes("chart") || id.toLowerCase().includes("window")
    ? makeCanvas()
    : { textContent: "", style: {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
  return elements[id];
}

// Minimal `state` - chart.js only reads _energyHistory through the accessors.
const state = { _energyHistory: [] };

const sandbox = {
  console, Math, Number, Infinity, NaN, Float64Array, Int32Array, Array, Set, String,
  state,
  document: { getElementById: getEl },
  window: { devicePixelRatio: 1, addEventListener() {} },
  markChartsDirty: undefined,
};
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "chart.js"), "utf8"), ctx, { filename: "chart.js" });
const api = vm.runInContext(
  "({ renderChart, drawEnergyChart, drawResidualChart, markChartsDirty, energyWindow })", ctx);

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); }
  else console.log(`  ok    ${msg}`);
}

function badTexts() {
  return texts.filter((t) => /Infinity|NaN|undefined/.test(t));
}
function badCoords() {
  return coords.filter((c) => typeof c === "number" && !Number.isFinite(c));
}
function reset() { texts.length = 0; coords.length = 0; }

// ---------- the reported case ----------
// 300 steps at p=1000 (energy Infinity, logEnergy finite), then a switch to a
// small p producing finite energies, WITHOUT clearing the history - i.e. the
// pre-fix behaviour, which must now still render cleanly.
function mixedHistory() {
  const h = [];
  for (let s = 0; s < 300; s++) {
    h.push({ step: s, energy: Infinity, logEnergy: 6500 - s * 0.5, residual: 1e-2 / (1 + s) });
  }
  for (let s = 300; s < 700; s++) {
    h.push({ step: s, energy: 5.9e8 * Math.exp(-(s - 300) / 90), logEnergy: 20 - (s - 300) / 90, residual: 1e-3 / (1 + s) });
  }
  return h;
}

console.log("Energy chart with a window straddling Math.exp's overflow ceiling");
reset();
state._energyHistory = mixedHistory();
api.markChartsDirty();
api.drawEnergyChart();
check(badTexts().length === 0, `no Infinity/NaN axis labels (got ${JSON.stringify(badTexts())})`);
check(badCoords().length === 0, `no non-finite draw coordinates (${badCoords().length} bad)`);
check(texts.length > 0, "something was actually drawn");

console.log("\nAll-Infinity window (whole run at large p, linear units unusable)");
reset();
state._energyHistory = Array.from({ length: 400 }, (_, s) =>
  ({ step: s, energy: Infinity, logEnergy: 6500 - s * 0.5, residual: 1e-3 }));
api.markChartsDirty();
api.drawEnergyChart();
check(badTexts().length === 0, `no Infinity/NaN axis labels (got ${JSON.stringify(badTexts())})`);
check(badCoords().length === 0, `no non-finite draw coordinates (${badCoords().length} bad)`);

console.log("\nEnergy and logEnergy both unusable (p=0 stores logEnergy as NaN)");
reset();
state._energyHistory = Array.from({ length: 50 }, (_, s) =>
  ({ step: s, energy: Infinity, logEnergy: NaN, residual: 1e-3 }));
api.markChartsDirty();
api.drawEnergyChart();
check(badTexts().length === 0, `no Infinity/NaN axis labels (got ${JSON.stringify(badTexts())})`);
check(badCoords().length === 0, `no non-finite draw coordinates (${badCoords().length} bad)`);

console.log("\nResidual chart (log axis) with non-finite and zero entries");
reset();
state._energyHistory = Array.from({ length: 200 }, (_, s) => ({
  step: s,
  energy: 100 - s * 0.1,
  logEnergy: Math.log(100 - s * 0.1),
  residual: s < 20 ? NaN : (s < 40 ? 0 : 1e-3 * Math.exp(-s / 50)),
}));
api.markChartsDirty();
api.drawResidualChart();
check(badTexts().length === 0, `no Infinity/NaN axis labels (got ${JSON.stringify(badTexts())})`);
check(badCoords().length === 0, `no non-finite draw coordinates (${badCoords().length} bad)`);

console.log("\nOrdinary all-finite history still renders (no regression)");
reset();
state._energyHistory = Array.from({ length: 500 }, (_, s) =>
  ({ step: s, energy: 1000 * Math.exp(-s / 100) + 5, logEnergy: Math.log(1000 * Math.exp(-s / 100) + 5), residual: 1e-2 * Math.exp(-s / 80) }));
api.markChartsDirty();
api.drawEnergyChart();
api.drawResidualChart();
check(badTexts().length === 0, `no Infinity/NaN axis labels (got ${JSON.stringify(badTexts())})`);
check(badCoords().length === 0, `no non-finite draw coordinates (${badCoords().length} bad)`);
check(texts.some((t) => /e[+-]/.test(t)), `energy axis uses scientific notation (labels: ${JSON.stringify(texts.slice(0, 4))})`);

console.log(`\n${failures === 0 ? "All chart render checks passed" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
