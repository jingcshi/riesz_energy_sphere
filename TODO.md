# TODO — Riesz energy on S²

Shipped work is not listed here. The reasoning behind each landed change lives in
its commit message, which is written to carry it — `git log` is the record.

Rough order of value: the crossover survey is the point of the project and needs
no new code; Barnes-Hut is the only thing blocking N above 1024; the rest are
smaller.

## The science

- **Pressure-test the 5-7 disclination "scarring" crossover**, reported in the
  literature around `N ~ 500-1000`, where exact icosadeltahedral symmetry stops
  being optimal. The slider reaches it, L-BFGS makes the runs affordable, and the
  degree histogram with click-to-highlight is the instrument. Nothing needs
  building; this is a survey to run and record.

  Target sizes are the icosadeltahedral `N = 10T+2` for `T = h²+hk+k²`: 12, 32,
  42, 72, 92, 122, 132, 162, 192, 212, 252, 272, 282, 312, 372, 432, 482, 492,
  552, 642, 732, 762, 812, 842, 912, 972, 1002. Expect exactly 12 pentagonal
  defects below the crossover, and above it those 12 spreading into extended
  grain-boundary scars of alternating 5s and 7s.

  Caveat that matters for methodology: a single run finds *a* local minimum, not
  *the* global one, and gradient descent and L-BFGS routinely land in different
  ones. Any claim about the optimal defect structure needs several seeds per N,
  which is what basin hopping in the Thomson literature is for.

## Performance

- **Barnes-Hut for small, non-integer `p` at large N.** The one remaining gap in
  the force sum. The hull is cached, large `p` is exactly truncated past
  `d_min·exp(746/p)`, and integer and half-integer exponents avoid `Math.pow` —
  none of which applies here, so the sum is genuinely long-range and still
  `O(N²)`. `N=1024` at `p=2.5` costs ~7ms per kernel call and ~17ms per step with
  the line search: playable, but quadratic, and therefore what caps any ceiling
  above 1024.

  A tree, not FMM: `O(N log N)` generalizes cleanly to arbitrary `p` and both
  metrics because it only samples the pair kernel at a cluster centroid, whereas
  FMM's `O(N)` needs a closed-form multipole expansion that does not exist for a
  general non-integer-exponent Riesz kernel.

  The open design question is the accept/reject test. Armijo currently compares
  exact energy against a `~1e-11` tolerance, which an approximated energy (error
  `~1e-2`-`1e-3`) would swamp outright. But both the pre- and post-step readings
  would pass through the *same* tree and theta, so the bias may largely cancel.
  Prototype a tolerance that tracks the approximation's own error budget before
  falling back to an exact-energy accept pass, which would erase most of the win.

  The "Force evaluation" row in the Methodology section already exists with a
  Barnes-Hut option present and inert, so the UI side is done.

- **Kinetic Delaunay, so the geometry layers stop rebuilding from scratch.** The
  hull is memoized on its point array's identity, so a paused configuration is
  free, but any accepted step invalidates it and the rebuild is `O(N^1.87)` —
  about 30ms for the edge and face layers together at `N=1024`. Both layers are
  hidden by default, which is why this is not felt; turn edges on while playing
  at `N=1024` and the frame roughly triples.

  The fix is not a faster rebuild. A conflict-graph hull would buy `O(N log N)`
  and still recompute everything, when the configuration moves only slightly per
  step: the previous frame's triangulation is almost correct, and repairing it by
  edge flips is roughly `O(N)` amortized. Recomputing from scratch at any
  complexity is the thing to avoid.

  Sequencing note: the physics step and the hull are both quadratic and within a
  factor of two of each other at every size, so this is worth doing *after*
  Barnes-Hut unless a geometry layer is being left on.

## Optimization

- **Coarse-to-fine relaxation.** Relax at small N, subdivide, relax again. It
  attacks cold-start cost rather than convergence rate, so it composes with
  L-BFGS instead of competing with it, and it is the natural answer to "a huge
  `p` from a cold random start is needlessly stiff".

  What needs deciding before any code: how to inject the new points. Subdividing
  a relaxed configuration's Delaunay triangulation at edge midpoints is the
  obvious route and lands near-uniformly, but it multiplies N by roughly 4 and so
  only hits a sparse ladder of sizes — reaching an arbitrary target N means
  relaxing at the nearest rung and then adding the remainder at the emptiest
  spots, which needs a rule. Also worth measuring first whether it beats simply
  annealing `p` upward from a cold start, which is far less machinery for a
  possibly similar effect.

- **Momentum / Nesterov as a third optimizer.** Deliberately skipped when L-BFGS
  landed, and now a fidelity feature rather than a performance lever, since
  L-BFGS already took the step-count prize. The reason to still want it: it keeps
  the physical reading, being literally a heavy ball with friction, whereas
  L-BFGS's `d = -H·g` is not a force field and a point can move against its own
  force under it.

  Cheap to add — the Methodology segmented control, `state.method`, the shared
  stall tracking and the Evaluations counter are all in place and were built to
  take a third option.

## Presentation

- **`p = ∞` (Tammes), the one slider position where Play is disabled.** The
  solver question dissolved: minimizing `Ψ = (1/p)·log E` already *is* the
  soft-min with `β = p`, since `(Σ d^-p)^(-1/p) → min d`, and `p=1000` lands
  within **0.03°** of the rigorously known optima (N=4→109.4712°, 5→90°, 6→90°,
  7→77.8695°, 8→74.8585°, 9→70.5288°, 12→63.4349°, 24→43.6908°), always erring
  slightly low, exactly as the `log(pairs)/p` error term predicts.

  So what is left is a decision and some wiring:
  - Make `p=∞` anneal `p` upward over the run rather than starting stiff, and
    headline min separation instead of energy. One code path for all `p`.
  - Or cap the annealing where the softmin's weights underflow. Past
    `d_min·exp(700/p)` a pair's weight is exactly zero in double precision, so
    beyond that the objective genuinely *is* an active-set method over the
    closest pairs — the dedicated solver arrives without being written.
  - Either way `state.energy` is meaningless there (it overflows long before, and
    the panel already switches to `log E`), so the Energy row should read `—` and
    cede the spotlight to Min separation.
