# TODO — Riesz energy on S²

## On hold

- **Large-N support (raise the N slider well past 100) via convex hull +
  Barnes-Hut.** No longer purely deprioritized — per
  `~/Downloads/spherical_point_configurations_codex_handoff.pdf`, the
  large-N regime is genuinely interesting (icosadeltahedral meshes at
  `N = 10T+2` for `T = h²+hk+k²`, i.e. 12, 32, 42, 72, 92, 122, 132, 162, ...;
  and a literature-reported 5-7 disclination "scarring" crossover around
  `N ~ 500-1000` where exact icosadeltahedral symmetry stops being optimal).
  Reaching that range needs both pieces below; neither alone is enough.

  - **Convex hull (spherical Delaunay), repurposing `EDGE_C` as a filter
    rather than the primary detector.** Since every point already lies on
    the unit sphere, the 3D convex hull's facets *are* the spherical Delaunay
    triangulation directly (no interior points to discard). A Quickhull-style
    incremental hull is `O(N log N)` expected, versus the current all-pairs
    `O(N²)` distance matrix in `computeEdges()`.
    - Raw hull output is simplicial (triangles only), so a literal
      quadrilateral face (e.g. the square antiprism's two square faces at
      N=8) comes back as two triangles joined by an arbitrary diagonal —
      the same spurious "X across a square" artifact discussed previously.
      The fix: once the hull gives each vertex its actual incident edges
      (avg. degree ~6, since a triangulation has `E ~ 3V` by Euler's
      formula), reuse the old `EDGE_C = 1.3` ratio test *locally* — for each
      vertex, drop any incident hull edge longer than `EDGE_C` times that
      vertex's shortest incident edge. This is exactly the diagonal-vs-side
      test needed to un-triangulate a coplanar quad, but now applied to
      ~6 candidates per vertex instead of all `N-1` others: `O(6N)` total
      instead of `O(N²)`, i.e. the heuristic's role flips from "find the
      edges" (expensive, approximate) to "filter a small, already-correct
      candidate set" (cheap, only resolves the coplanar-diagonal ambiguity).
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
  - Once both land, raise the N slider max, update the Edges/Controls info
    tabs, and pressure-test around the reported 500-1000 crossover.

- **p → ∞ (Tammes / max-min distance) limit.** Added the slider position, but
  deliberately left unimplemented (Play is disabled there) — this is *not* a
  Riesz-energy limit, so it doesn't fit the current architecture as a drop-in:
  - `Σ d_ij^-p` has no meaningful pointwise limit as `p → ∞`: for any finite
    `p` it's still a diverging weighted sum dominated increasingly by the
    single closest pair, not a differentiable stand-in for "maximize the
    minimum pairwise distance" (the actual Tammes objective, a nested
    min-max with no natural gradient).
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
  - Validate against the reference PDF's Tammes table (N=1-14, 24 rigorously
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
- Widened and re-scaled the p slider: 75 discrete values from 0 to 400 on a
  coarsening (pseudo-log) scale, fine enough near p~15 to resolve the known
  N=5 triangular-bipyramid -> square-pyramid phase transition
  (Schwartz, `s* ~ 15.048`), plus a literal p=∞ position reserved for the
  Tammes limit (see "On hold" above for why it isn't wired up yet).
