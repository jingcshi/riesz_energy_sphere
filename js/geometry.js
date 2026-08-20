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
