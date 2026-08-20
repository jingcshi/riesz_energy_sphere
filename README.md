# Riesz Energy Simulator on S²

**[Live demo →](https://jingcshi.github.io/riesz_energy_sphere/)**

An interactive, dependency-free browser simulation of the classic *n-point
energy* problem on the sphere: given `N` points constrained to the surface of
`S²` (the unit sphere in `R³`), find the configuration that minimizes their
mutual repulsive energy. Points are pushed apart by projected gradient
descent, live, in the browser, with full control over the exponent, the
distance metric, and how the result is visualized.

## What it simulates

The energy being minimized is

```
E(x) = Σ_{i<j} d(x_i, x_j)^(-p)
```

over configurations of `N` unit vectors `x_1, ..., x_N`, where:

- **p** (0 to 2) is the Riesz exponent. `p = 1` under the Euclidean metric is
  ordinary Coulomb/Newtonian repulsion — the natural law for points that
  interact through the ambient 3D space. `p = 0` is treated as its own case,
  the logarithmic energy `-ln d`, which is the `p → 0` limit of the Riesz
  family and the classic **Fekete point problem**.
- **d(x_i, x_j)** is either the Euclidean chord distance `||x_i - x_j||`, or
  the geodesic (great-circle) angle `arccos(x_i · x_j)` — toggleable
  independently of `p`, modeling a universe where interactions can only
  propagate along the sphere's own surface rather than through an ambient
  3-space.

Each step projects the energy gradient onto the tangent plane at every point,
takes an adaptive step (Armijo backtracking + a trust-region multiplier that
retunes itself to the local landscape's stiffness), and renormalizes back
onto the sphere. Both metrics and both energy branches were checked against
finite-difference gradients to 6+ significant figures.

## Features

- Sliders for `N` (1–100), `p` (0–2, step 0.05), animation speed (0.1×–5×),
  a Euclidean/spherical metric toggle, and a random seed (with a one-click
  randomizer).
- Edge rendering (straight lines or great-circle arcs) connecting each point
  to its near neighbours, as a quick visual check for "settled into a
  lattice" vs. "one point still wiggling."
- Vertex tension colouring: each point is coloured by its current net force,
  from pale (settled) through mint, yellow, and orange to red (still moving
  fast), independent of the edge display.
- A hover info panel (while paused) showing per-vertex and per-edge
  numeric detail — force, nearest-neighbour distance, potential energy,
  edge length.
- Live energy- and max-force-vs-step charts (the latter log-scaled, since
  force typically decays across several orders of magnitude on the way to
  convergence).
- Origin-centered zoom (25%–400%) and free-drag rotation, implemented with an
  accumulated rotation matrix rather than stored Euler angles, to avoid
  gimbal lock at the poles.

## Running it

No build step, no dependencies. Either open `index.html` directly in a
browser, or serve the directory with anything static, e.g.:

```bash
python3 -m http.server
```

## Structure

```
index.html        markup, controls, info modal
css/style.css      styling
js/rng.js          seeded PRNG (mulberry32)
js/geometry.js     3D rotation matrices, projection, slerp
js/physics.js      energy/force computation, adaptive-step integrator
js/edges.js        nearest-neighbour edge graph, screen-space edge paths
js/render.js       canvas drawing: sphere, points, tension colouring
js/hover.js        hover hit-testing and info tooltip (paused only)
js/chart.js        energy / max-force vs. step line charts
js/main.js         UI wiring, main animation loop
```

## Known optimal configurations for small N

For most of the pairwise potentials this simulator covers — Coulomb (`p=1`),
general Riesz `p>0`, and the logarithmic/Fekete limit `p=0` — the globally
optimal configuration for small `N` is one of the following. Try seeding a
run at each `N` below (a few random seeds if it doesn't land on the first
try) and let it play to convergence to see it emerge:

| N | Configuration | Symmetry |
|---|---|---|
| 1 | trivial (no pairwise energy) | — |
| 2 | antipodal pair | D∞h |
| 3 | equilateral triangle on a great circle | D3h |
| 4 | regular tetrahedron | Td |
| 5 | triangular bipyramid | D3h |
| 6 | regular octahedron | Oh |
| 7 | pentagonal bipyramid | D5h |
| 8 | square antiprism (**not** the cube — the cube is only a local minimum) | D4d |
| 9 | tricapped trigonal prism | D3h |
| 10 | gyroelongated square bipyramid | D4d |
| 11 | irregular — no simple named polyhedron | C2v |
| 12 | regular icosahedron | Ih |

Only three of these are backed by a proof that holds for *every* reasonable
potential simultaneously: Cohn & Kumar (2007) showed the tetrahedron (N=4),
octahedron (N=6), and icosahedron (N=12) are **universally optimal** — minimal
for every completely monotonic function of squared distance, which covers
every Riesz exponent and the log-energy limit at once. The rest of the table
is the configuration most commonly reported for the classical Thomson
(`p=1`) and Fekete (`p=0`) problems specifically; it isn't proven to be
exponent-independent, so it's conceivable (if unusual) for some other `p` to
prefer a different local optimum at those `N`. That makes this simulator a
reasonable way to probe the question directly by sweeping `p` live.

## Known limitations

See `TODO.md` for two on-hold ideas (a proper spherical Delaunay
triangulation for edges, and a Barnes-Hut tree for the force sum) along with
why they aren't currently worth the added complexity at this scale.

## Authors

Jingchuan Shi + Claude
