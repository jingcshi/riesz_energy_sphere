# TODO — Riesz energy on S²

## On hold

- **Large-N support (raise the N slider well past 100) via convex hull +
  Barnes-Hut.** No longer purely deprioritized — per a reference survey on
  spherical point configurations, the large-N regime is genuinely
  interesting (icosadeltahedral meshes at
  `N = 10T+2` for `T = h²+hk+k²`, i.e. 12, 32, 42, 72, 92, 122, 132, 162, ...;
  and a literature-reported 5-7 disclination "scarring" crossover around
  `N ~ 500-1000` where exact icosadeltahedral symmetry stops being optimal).
  Reaching that range needs the Barnes-Hut piece below; the convex-hull half
  is done (see "Done" below).

  - **Barnes-Hut spatial tree** for the force/energy sum itself, `O(N log N)`
    per step instead of `O(N²)`. Still generalizes cleanly to arbitrary `p`
    and both metrics (it just samples `energyAndMagnitude()` at a cluster
    centroid) — unlike FMM, whose `O(N)` bound needs a closed-form multipole
    expansion that doesn't exist for a general non-integer-exponent Riesz
    kernel. Main open question, softer than previously assumed: `stepPhysics()`'s
    Armijo backtracking currently compares *exact* energy to a `~1e-10`
    tolerance; a Barnes-Hut-approximated energy (typical error `~1e-2`-`1e-3`)
    would swamp that directly. But since both the pre- and post-step energy
    would go through the *same* tree/theta, the bias may largely cancel
    between the two readings — worth prototyping a tolerance that tracks the
    approximation's own error budget rather than assuming exact energy is
    unavoidable, before falling back to a full exact-energy accept/reject
    pass (which would erase most of the asymptotic win).
  - Once it lands, raise the N slider max and pressure-test around the
    reported 500-1000 crossover.

- **p → ∞ (Tammes / max-min distance) limit.** Added the slider position, but
  deliberately left unimplemented (Play is disabled there) — this is *not* a
  Riesz-energy limit, so it doesn't fit the current architecture as a drop-in:
  - `Σ d_ij^-p` has no meaningful pointwise limit as `p → ∞`: for any finite
    `p` it's still a diverging weighted sum dominated increasingly by the
    single closest pair, not a differentiable stand-in for "maximize the
    minimum pairwise distance" (the actual Tammes objective, a nested
    min-max with no natural gradient). This is also why the *finite* end of
    the slider is capped at 25 rather than climbing toward Infinity as
    originally sketched: numerical stability in `computeEnergyAndForce()`
    was already degrading by p~25 (maxForce stalling around 1e+3, not
    converging), well before `Math.pow` actually overflows. Fixing that
    for arbitrarily large finite p would need an arbitrary-precision numeric
    library (e.g. `ExpantaNum.js`, though that's built for far larger
    "googological" magnitudes than this actually needs) - not attempted, in
    favour of capping the range where the existing integrator is reliable
    and moving straight to the literal ∞ case as its own, differently-posed
    problem instead.
  - Most promising path: replace the true `min` over pairs with a smooth
    **soft-min** (e.g. `-1/β · log Σ exp(-β·d_ij)`), which is differentiable
    everywhere and converges to the true Tammes objective as `β → ∞`. This
    reuses the existing sum-based gradient-descent machinery (a different
    aggregation, not a different per-pair kernel) — but `β` likely needs to
    be *annealed* upward over the run rather than fixed, since a large fixed
    `β` would hit the same active-set/ill-conditioning problem already seen
    at large finite `p`. The Armijo backtracking criterion would also need
    rethinking, since "energy" here is a surrogate rather than the actual
    quantity being optimized.
  - Alternative: a dedicated active-set/local-search solver (repeatedly find
    the current closest pair(s) and push directly apart) closer to how
    Tammes solvers in the literature actually work, but a bigger structural
    departure — probably its own step function rather than a branch inside
    `stepPhysics()`.
  - Validate against a reference Tammes table (N=1-14, 24 rigorously
    known; e.g. N=5 -> 90°, N=7 -> ~77.87°, N=8 -> ~74.86° square antiprism)
    before trusting any implementation.

## Done

- Log energy (p=0, Fekete points) and geodesic/spherical metric, independently
  toggleable from Euclidean chord distance and from edge rendering.
- Numerical robustness: floored-magnitude/exact-direction split (no collapse
  on near-collisions), Armijo backtracking + trust-region step sizing,
  antipodal-vs-coincident degenerate-direction handling in the spherical
  metric branch.
- View rotation switched from a two-angle Euler scheme to an accumulated 3×3
  rotation matrix (`state.viewMatrix` in `js/physics.js`, ops in
  `js/geometry.js`) — fixes a gimbal-lock "wall" where drag lost effect near
  the old `rotX` clamp.
- Dedicated info modal (icon button next to the title, tabbed: Energy / Edges
  / Controls), replacing the old static hint paragraph.
- UI polish: single font stack (`-apple-system` / Helvetica fallback) applied
  to buttons and inputs as well as body text; Play/Pause button now
  green/yellow by state, Reset given a neutral grey fill distinct from the
  default button background.
- Vertex tension colouring (net-force -> colour, log scale), hover info
  panel for vertices/edges while paused, origin-centered zoom slider,
  randomize-seed button, and energy/max-force-vs-step charts (the latter
  log-scaled).
- Fixed the animation-speed slider having near-zero visible effect: the
  trust-region multiplier (needed for numerical stability, up to 64x) was
  dwarfing whatever `speed` scaled inside `dt`. Decoupled them - `dt` is now
  purely the numerically-adaptive quantity, and `speed` instead controls how
  many physics steps run per rendered frame.
- Widened and re-scaled the p slider: 71 discrete values from 0 to 25 on a
  coarsening (pseudo-log) scale, fine enough near p~15 to resolve the known
  N=5 triangular-bipyramid -> square-pyramid phase transition
  (Schwartz, `s* ~ 15.048`; verified empirically at p=14.5 vs. p=15.0), plus
  a literal p=∞ position reserved for the Tammes limit (see "On hold" above
  for both why the range stops at 25 and why ∞ isn't wired up yet).
- Capped the max-force chart's log-scale y-axis at 5 gridlines regardless of
  how many decades a run spans, and gave the info modal's tab body a fixed
  height so switching tabs no longer shifts the tabs/modal position on
  screen (shorter tabs just leave blank space below their text instead).
- Replaced `computeEdges()`'s all-pairs distance matrix with a real 3D
  convex hull (`js/hull.js`, classic incremental algorithm) plus a local
  `EDGE_C = 1.3` ratio filter over each vertex's hull-incident edges only,
  as sketched in the (now-resolved) "On hold" entry above. Verified against
  Euler's formula and known small-N configs (octahedron: 12/12 edges kept;
  icosahedron: 30/30; square antiprism: the hull's 2 spurious triangulated-
  square diagonals correctly dropped, 16 of 18 kept) - see git history for
  the Node test harness. Falls back to the old all-pairs method only when
  the hull degenerates (N<4 or coplanar points). Visibility tests are
  against the full current face list each insertion (`O(N)` faces x `O(N)`
  insertions), not a conflict-graph, so this is `O(N²)` rather than the
  textbook `O(N log N)` - still a real win in practice (dot products
  instead of sqrt'd distances, ~6 candidates per vertex to filter instead of
  N-1), and a fine incremental step toward the Barnes-Hut work above, but
  worth revisiting if that O(N²) becomes the new bottleneck once N grows
  into the hundreds.
- Added Degree (vertex) and Arc angle in degrees (edge) to the hover info
  panel.
- Split the single side panel into two: Controls (left, Parameters +
  Animation sections) and Statistics (right, Statistics + Graphs sections,
  including a new vertex-count-by-degree histogram sorted high to low).
  Reset given a slightly lighter/higher-opacity fill to read as more
  distinct from the default button background. Also fixed the
  auto-converged case not actually pausing: `state.playing` stayed true (and
  the button stuck on "Pause") once `maxForce` dropped below the stop
  threshold, since the old check only skipped *stepping*, not playback
  state - now calls the same `setPlaying(false)` a manual pause uses.
- Click-to-highlight by degree: each "Degree x" row in the statistics
  histogram is now a toggle (delegated click handler, since rows are
  re-rendered from scratch every frame) that rings every vertex of that
  degree in yellow on the canvas - a quick way to spot the mesoscopic
  5-/7-fold "scars" mentioned in the large-N survey referenced above.
  `computeEdges()` now also populates `state._degree` (per-vertex degree
  from the final, EDGE_C-filtered edge list) alongside the edges themselves,
  shared by both the histogram and the canvas highlight so they can't drift
  out of sync with each other.
