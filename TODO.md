# TODO — Riesz energy on S²

## On hold

- **Barnes-Hut spatial tree** for force/energy evaluation, to bring per-step cost
  down from `O(N²)` toward `O(N log N)`. Clearly deprioritized: adding more
  points just produces a finer triangular mesh, and at the current `N <= 100`
  cap the flat double loop is already sub-millisecond, so there's no latency
  problem to solve. Also generalizes cleanly here (Barnes-Hut just samples
  whatever `energyAndMagnitude()` kernel is active at a cluster centroid, so it
  works for both metrics and both energy branches with no kernel-specific
  math) - unlike FMM, whose `O(N)` bound depends on an analytic multipole
  expansion that doesn't exist in closed form for the general Riesz kernel
  `d^-p` at arbitrary non-integer `p`, or for `-ln d`. The real blocker if ever
  revisited: `stepPhysics()`'s Armijo backtracking compares energy to a
  `~1e-10`-relative tolerance, far tighter than Barnes-Hut's typical
  `~1e-2`-`1e-3` approximation error - would need the approximation confined
  to the force evaluation only, with the accept/reject energy test kept exact.

- **Spherical Delaunay (convex-hull) triangulation** for edge rendering, replacing
  the `EDGE_C = 1.3` nearest-neighbour-ratio heuristic in `js/edges.js`.
  - Would be `O(N log N)` via Quickhull-style incremental construction — cheaper
    than the current `O(N²)` all-pairs pass, not more expensive. Since every
    point already lies on the unit sphere, none are interior; the hull's facet
    structure is exactly the spherical Delaunay triangulation.
  - Not a free correctness win: raw hull output is simplicial (triangles only).
    Symmetric optima with literal quadrilateral faces (e.g. the square antiprism
    at N=8) have 4+ points exactly coplanar, and a hull algorithm arbitrarily
    picks one diagonal to split the square — reintroducing the same spurious
    "X across a square" artifact the current heuristic already has to avoid.
    A correct implementation needs a coplanar-facet-merge post-pass with its
    own numerical tolerance (same category of epsilon-tuning as `SIN_ZERO`).
  - Worth it for generic (non-symmetric) N, where it gives the exact,
    unambiguous neighbour graph; not worth it just to fix a handful of
    symmetric special cases unless the coplanar merge is also done properly.

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
