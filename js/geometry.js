"use strict";

// ---------- 3D helpers shared by physics and rendering ----------

// The view orientation is stored as a full 3x3 rotation matrix (row-major,
// flat length-9 array) rather than a pair of Euler angles. Composing
// rotations as Ry(yaw) * Rx(pitch) with two persistent angles hits gimbal
// lock as pitch approaches +-90 degrees: there, a further "yaw" rotation
// acts almost entirely like a roll around the viewing axis, so horizontal
// drag appears to do nothing. Accumulating a matrix and always applying new
// drag rotations in the *current* view frame (pre-multiplying) sidesteps
// this entirely - there is no privileged pole, so no clamp is needed either.
function matMultiply(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3 + 0] * b[0 * 3 + j] + a[i * 3 + 1] * b[1 * 3 + j] + a[i * 3 + 2] * b[2 * 3 + j];
    }
  }
  return r;
}

function rotationX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotationY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function rotate(pt, m) {
  const [x, y, z] = pt;
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function project(pt, cx, cy, scale) {
  const [x, y, z] = pt;
  const focal = 3.2;
  const f = focal / (focal - z);
  return { x: cx + x * scale * f, y: cy - y * scale * f, z, f };
}

// Information/clarity trade-off ("sphere opacity"): rather than rewriting
// every depth-fade/blend formula in render.js/edges.js, this remaps the raw
// depth (0=back..1=front) each of them already takes as input, and every
// downstream alpha/colour/radius formula keeps working unmodified. At
// opacity=0 it returns 1 ("as if front") for everything, so every element
// renders at full clarity/size regardless of true depth - nothing is hidden,
// but front/back layering becomes illegible.
//
// Above 0 the sphere is treated as what it looks like: a ball of absorbing
// medium. Two things follow, and they apply to different hemispheres.
//
// Nothing lies between the eye and a point on the *front* hemisphere, so
// optically it shouldn't be attenuated at all. The linear ramp kept here for
// it is therefore frank artistic licence - aerial perspective, the haze that
// makes distant things read as distant - and it's what makes the front-face
// depth ordering legible at all.
//
// A point on the *rear* hemisphere is seen through the ball, so Beer-Lambert
// applies: transmittance decays exponentially in the path length through the
// medium. Under the orthographic projection here that path length is exactly
// 2|z|, since the view ray leaves a rear point at z and exits the front
// surface at -z. Reading the slider as the fraction absorbed across one full
// diameter (L=2) pins the extinction coefficient, and the whole exponential
// collapses to (1-op)^|z| - no exp() needed, and at opacity=1 it is
// identically zero over the entire rear hemisphere. That is the point: an
// opaque ball hides everything behind it, not merely the antipode, and the
// hard cut this leaves at the silhouette is what an opaque ball actually
// looks like rather than an artifact.
//
// The two branches meet continuously at the limb for every opacity below 1.
function depthWithOpacity(rawDepth) {
  const op = state.sphereOpacity;
  const aerial = 1 - op * (1 - rawDepth);
  if (rawDepth >= 0.5) return aerial; // front hemisphere: nothing in the way
  const absZ = 1 - 2 * rawDepth;      // path length / 2, i.e. |z|
  return (1 - op / 2) * Math.pow(1 - op, absZ);
}

// Spherical linear interpolation between two unit vectors, tracing the great
// circle arc between them. `omega` is the angle between u and v, `sinOmega`
// its sine (passed in so callers computing several waypoints don't redo it).
function slerp(u, v, t, omega, sinOmega) {
  if (sinOmega < 1e-6) {
    // nearly coincident or antipodal: the arc's direction is ill-defined,
    // fall back to a linear blend and re-project onto the sphere
    const x = u[0] + (v[0] - u[0]) * t, y = u[1] + (v[1] - u[1]) * t, z = u[2] + (v[2] - u[2]) * t;
    const norm = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / norm, y / norm, z / norm];
  }
  const a = Math.sin((1 - t) * omega) / sinOmega, b = Math.sin(t * omega) / sinOmega;
  return [a * u[0] + b * v[0], a * u[1] + b * v[1], a * u[2] + b * v[2]];
}
