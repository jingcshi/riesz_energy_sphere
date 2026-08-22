# Riesz Energy Simulator on S²

**[Live demo →](https://jingcshi.github.io/riesz_energy_sphere/)**

An interactive, dependency-free browser simulation of the classic *n-point
energy* problem on the sphere: given `N` points constrained to the surface of
`S²` (the unit sphere in `R³`), find the configuration that minimizes their
mutual repulsive energy. Points are driven apart live in the browser, by either
a physical gradient flow or a quasi-Newton optimizer, with full control over the
exponent, the distance metric, and how the result is visualized.

## What it simulates

The energy being minimized is

```
E(x) = Σ_{i<j} d(x_i, x_j)^(-p)
```

over configurations of `N` unit vectors `x_1, ..., x_N`, where:

- **p** (0 to 1000 across 87 stops on a pseudo-logarithmic slider, with a
  reserved `∞` as the 88th) is the Riesz exponent. `p = 1` under the Euclidean
  metric is ordinary Coulomb/Newtonian repulsion — the natural law for points
  that interact through the ambient 3D space, and the classical **Thomson
  problem**. `p = 0` is treated
  as its own case, the logarithmic energy `-ln d`, which is the `p → 0` limit of
  the Riesz family and the classic **Fekete point problem**. The steps are finest
  below `p = 2` and around `p ≈ 15`, where the small-`N` phase transitions live.
- **d(x_i, x_j)** is either the Euclidean chord distance `||x_i - x_j||`, or
  the geodesic (great-circle) angle `arccos(x_i · x_j)` — toggleable
  independently of `p`, modeling a universe where interactions can only
  propagate along the sphere's own surface rather than through an ambient
  3-space.
- **N** runs from 1 to 1024. The slider's stops widen with `N` — unit steps to
  64, then doubling at each power of two — since past a few hundred a single
  extra point is invisible; the readout beside it is a number input for any
  exact value the slider skips.

Large `p` works because the energy is never summed raw. Each pass finds the
closest pair and accumulates every other pair's weight *relative* to it,
`w = (d/d_min)^-p ∈ (0,1]`, recovering `E = Σw · d_min^-p` exactly, in log form
once that overflows. What is actually descended is `Ψ = (1/p)·log E`, which is
the same direction field as `∇E` times one positive scalar. That also makes high
`p` meaningful to watch: since `(Σ d^-p)^(-1/p) → min d`, minimizing `Ψ` *is*
maximizing the minimum separation, and `p = 1000` lands within 0.03° of the
rigorously known Tammes optima for small `N`.

## Optimizers

The **Methodology** section chooses how the minimum is reached. Both descend the
same objective, and differ in how fast they get there and in what the
intermediate frames mean.

- **Gradient descent** is a discretization of overdamped gradient flow. Each step
  projects the gradient onto the tangent plane at every point, takes an adaptive
  step (Armijo backtracking plus a trust-region multiplier that retunes itself to
  the local stiffness), and renormalizes back onto the sphere. Every point moves
  along its own force, so the trajectory is a physically meaningful relaxation.
- **L-BFGS** is a Riemannian quasi-Newton method: it builds a running
  approximation to the inverse Hessian from stored curvature pairs, transported
  between tangent spaces by projection, and takes approximate Newton steps. It
  converges in far fewer iterations — 26× fewer energy evaluations at
  `N=128, p=1`, and the `N=1024, p=1000` corner settles in about 10,000 steps
  where descent would not finish in a day. The cost is interpretability:
  `d = -H·g` is not a force field, so a point can move against its own force and
  the frames are optimizer iterates rather than states of a relaxing system.

Because one L-BFGS iteration does much more work than one descent step, **Steps**
is not comparable across the two. **Evaluations** counts pair sums, the dominant
cost, and means the same thing under both.

Convergence is judged by a scale-free **Residual** (the largest per-vertex
gradient of `Ψ`) plus a stagnation stop, rather than by raw force — the physical
force's magnitude grows like `e^O(p)`, so no absolute threshold works across the
exponent range.

## Features

**Display.** Edge rendering and a face-merging layer, independently toggleable
and drawn either as chords (the inscribed polytope) or great-circle arcs (a
tiling of the sphere itself). Vertex tension colouring, from pale (settled)
through mint, yellow and orange to red, scaled against the peak residual the run
has held so it stays a convergence proxy at every `p`. Origin-centered zoom
(25%–400%), adjustable sphere opacity, and free-drag rotation implemented with an
accumulated rotation matrix rather than Euler angles, to avoid gimbal lock.

**Geometry readout.** A live `V`, `E`, `F`, `χ` table over exactly what is drawn,
where an amber `+n` on `E` counts face-boundary edges the edge filter rejected.
Histograms of vertices by degree and faces by side count: clicking a degree row
cycles it through highlight and hide, which is how you find the 5- and 7-fold
disclination "scars" on a large relaxed mesh. Hiding is display-only and never
touches the simulation, and the edge and face layers are recomputed over just the
surviving points, so isolating the 12 pentagonal defects reveals *their own*
triangulation rather than a lattice full of holes; those recomputed connections
are drawn dashed and labelled non-local, since they are still real interacting
pairs.

**Instrumentation.** Steps, Evaluations, Energy (switching to `log E` when it
outgrows double precision), Max force, Residual and Min separation. Energy- and
residual-vs-step charts, the latter log-scaled, each with a draggable x-range
window that tracks the live end until you move it. A hover info panel while
paused, giving per-vertex, per-edge and per-face detail — force, residual,
degree, nearest-neighbour distance, edge length and dihedral angle, face area and
perimeter — with the hovered element highlighted on the canvas.

## Correctness

The `test/` directory holds headless Node checks, no framework required:

```bash
node test/gradient_check.js     # analytic gradients vs. finite differences
node test/optimizer_bench.js    # gradient descent vs. L-BFGS, by evaluation count
node test/topology.js           # hull manifoldness and V - E + F = 2 (slow, ~5 min)
node test/chart_render.js       # chart rendering against non-finite history
```

Both metrics and both energy branches agree with finite-difference gradients to
6+ significant figures, and the truncated large-`p` sums are bitwise equal to
untruncated ones.

## Running it

No build step, no dependencies. Either open `index.html` directly in a
browser, or serve the directory with anything static, e.g.:

```bash
python3 -m http.server
```

**When deploying, bump `ASSET_VERSION` in `index.html`.** Every stylesheet and
script is requested with it as a `?v=` query string, which is what stops a
returning visitor from running a freshly-fetched `index.html` against scripts
still cached from the previous deploy. Any string will do so long as it
changes; leaving it alone republishes the same URLs and the protection
lapses.

## Structure

```
index.html         markup, controls, help modal
css/style.css      styling
js/rng.js          seeded PRNG (mulberry32)
js/geometry.js     3D rotation matrices, projection, slerp
js/physics.js      energy/force computation, gradient descent, L-BFGS
js/hull.js         3D convex hull = spherical Delaunay triangulation, memoized
js/edges.js        neighbour graph from the hull, screen-space edge paths
js/faces.js        coplanar-triangle merging into flat n-gon faces
js/render.js       canvas drawing: sphere, points, edges, faces, tension colour
js/hover.js        hover hit-testing and info tooltip (paused only)
js/chart.js        energy / residual vs. step charts and their range windows
js/main.js         UI wiring, main animation loop
test/              headless Node checks (see above)
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

Note that any single run finds *a* local minimum, not necessarily *the* global
one, and the two optimizers routinely land in different ones from the same seed.
The landscape has exponentially many minima in `N`, which is why the literature
wraps a local minimizer in basin hopping.

## Known limitations

The force sum is still `O(N²)` for small, non-integer `p`, which is what caps
`N` at 1024; the geometry layers rebuild their triangulation from scratch
whenever the points move, so leaving edges or faces on while playing at that
size costs about three times the frame; and `p=∞` (Tammes) is the one slider
position where Play is disabled. See `TODO.md` for all three and for what each
would take.

## Authors

Jingchuan Shi + Claude
