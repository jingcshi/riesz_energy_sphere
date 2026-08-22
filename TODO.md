# TODO — Riesz energy on S²

## On hold

- **Barnes-Hut for the small-`p` regime.** What remains of the large-N work.
  The slider now reaches 1024, which covers the interesting range (the
  icosadeltahedral meshes at `N = 10T+2` for `T = h²+hk+k²`, i.e. 12, 32, 42,
  72, 92, 122, 132, 162, ...; and the literature-reported 5-7 disclination
  "scarring" crossover around `N ~ 500-1000` where exact icosadeltahedral
  symmetry stops being optimal). The hull half is cached, the large-`p` half is
  exactly truncated, and integer/half-integer exponents no longer pay for
  `Math.pow` (all three in "Done"), which leaves one gap: **small, non-integer
  `p` at large N**, where nothing above applies and the sum is genuinely
  long-range. `N=1024` at `p=2.5` costs ~7ms per pair-kernel call, ~17ms per
  step with the line search — playable but not comfortable, and quadratic, so
  it is the binding constraint on any future ceiling above 1024.

  - **Barnes-Hut spatial tree** for the force/energy sum itself, `O(N log N)`
    per step instead of `O(N²)`. Still generalizes cleanly to arbitrary `p`
    and both metrics (it just samples the pair kernel at a cluster
    centroid) — unlike FMM, whose `O(N)` bound needs a closed-form multipole
    expansion that doesn't exist for a general non-integer-exponent Riesz
    kernel. Main open question, softer than previously assumed: `stepPhysics()`'s
    Armijo backtracking currently compares *exact* energy to a `~1e-11`
    tolerance; a Barnes-Hut-approximated energy (typical error `~1e-2`-`1e-3`)
    would swamp that directly. But since both the pre- and post-step energy
    would go through the *same* tree/theta, the bias may largely cancel
    between the two readings — worth prototyping a tolerance that tracks the
    approximation's own error budget rather than assuming exact energy is
    unavoidable, before falling back to a full exact-energy accept/reject
    pass (which would erase most of the asymptotic win).
  - ~~**Scope it by `p` first.**~~ Done — see "Done" below. The cutoff turned
    out to bite only above `p ≈ 500` at `N = 1024`, since it needs
    `exp(746/p)` to fall below the sphere's own `d_max/d_min` ratio.
  - **Measured, and the answer was "neither".** ms per call on converged
    configurations, p=1 Euclidean:

    | N | one hull | edge layer | face layer | one physics step |
    |---|---|---|---|---|
    | 100 | 0.23 | 0.26 | 0.33 | 0.15 |
    | 400 | 2.30 | 2.52 | 2.79 | 2.14 |
    | 800 | 7.50 | 7.81 | 9.13 | 8.80 |
    | 1600 | 29.4 | 28.7 | 30.0 | 38.1 |

    Fitted slopes `O(N^1.87)` for the hull and `O(N^2.04)` for the step, so
    both halves are quadratic and within a factor of two of each other at
    every size. The rendering side only looked worse because it built *two*
    independent hulls per frame — now shared and cached (see "Done"), which
    leaves the physics as the larger half. So the tree is the right next
    target after all, and the hull's own `O(N²)` is not urgent.
  - ~~A monomorphic typed-array kernel may reach `N ≈ 1000` with no tree at
    all.~~ Tried, and on its own it does essentially nothing — see "Done".
  - **A conflict-graph hull is probably the wrong fix even when the hull does
    start to hurt.** The textbook `O(N log N)` rebuild competes against a
    much better option: the configuration moves only slightly per step, so
    the previous frame's triangulation is almost correct, and repairing it by
    edge flips (kinetic Delaunay) is roughly `O(N)` amortized. Recomputing
    from scratch at any complexity is the thing to avoid, not the constant.
  - Pressure-test around the reported 500-1000 crossover, now that the slider
    goes there.

- **p = ∞ (Tammes / max-min distance) limit.** Still the one slider position
  where Play is disabled, but most of the groundwork is now done and the
  original framing of this entry turned out to be wrong in an instructive
  way. It assumed the soft-min `-1/β · log Σ exp(-β·d_ij)` would be a
  *different objective* bolted alongside the Riesz energy. It isn't: the
  Riesz energy in log form already is that soft-min, with `β = p`. Since
  `(Σ d^-p)^(-1/p) → min d` as `p → ∞`, minimizing
  `Ψ = (1/p)·log E` (what `computeEnergyAndForce()` now actually descends —
  see "Done") *is* maximizing the minimum separation, to within
  `log(pairs)/p`. Empirically at `p=1000` that lands within **0.03°** of the
  rigorously known optima (N=4→109.4712°, 5→90°, 6→90°, 7→77.8695°,
  8→74.8585°, 9→70.5288°, 12→63.4349°, 24→43.6908°), always erring slightly
  low, exactly as that error term predicts.

  What's genuinely left is therefore small, and mostly about *presentation*
  rather than a new solver:
  - Decide what `p=∞` should *do*, given large finite `p` already does it.
    Most defensible: anneal `p` upward over the run (the β-annealing this
    entry originally proposed, which is still the right idea — a huge `p`
    from a cold random start is needlessly stiff, and `p=1000, N=100` takes
    ~15k steps) and report min separation rather than energy as the headline
    number. That keeps one code path for all p.
  - Alternatively cap the annealing where the softmin's weights underflow
    (past `d_min · exp(700/p)` a pair's weight is *exactly* zero in double
    precision, so beyond that point the objective genuinely is a pure
    active-set method over the closest pairs — the "dedicated active-set
    solver" alternative arrives on its own, without being written).
  - Either way `state.energy` is meaningless at `p=∞` (it overflows well
    before then and the panel already switches to `log E`), so the Energy
    row should probably read `—` and cede the spotlight to Min separation.

## Done

- **The face merge no longer swallows a vertex, which is what put χ above 2 at
  large N.** Reported as "s=933924, N≥992, the initial configuration reports χ=4,
  even after the filtered edges". Exact thresholds for that seed: χ=3 from N=981,
  χ=4 from N=993, so the slider stops at 992 and 1008 read 3 and 4.

  The hull is not at fault. Audited over N=984..1024 it is a clean closed
  triangulation every time — every point a vertex, every directed edge owned
  exactly once with its reverse present, every facet plane supporting the whole
  set to 5.6e-17, V−E+F=2. The fault is entirely in the face layer, and χ−2 turns
  out to equal, exactly, the number of *orphan* vertices: points that appear on no
  face boundary at all. Vertex 547 is the first, vertex 667 the second.

  The mechanism. Vertex 547 has degree 4, and each adjacent pair in its fan is
  within the 1.8° tolerance, so union-find merges all four triangles into one
  group. The traced boundary is the rim quadrilateral, and 547 — sitting 3.8e-4
  off that quadrilateral's plane — ends up strictly *inside* the merged face. It
  then belongs to no cell of the tiling: it contributes no boundary edge and no
  face, while `V` still counts it. A wheel of k triangles merging to one face
  drops F by k−1 and E by the k spokes, so each swallowed vertex raises χ by
  exactly +1. The filtered-edge count cannot absorb this, since it corrects a
  disagreement over *edges* and this is a vertex with no edges to disagree about.

  Why it appears only at large N, and why the merge is always wrong here. The
  sphere is locally flat, so the median dihedral defect between adjacent hull
  triangles on a random configuration falls from 16.9° at N=64 to 4.0° at N=1000,
  and the share of adjacent pairs inside the tolerance rises from 5% to 23%.
  Merging at N in the hundreds is routine and frequently accidental. The comment
  in faces.js asserting that "nothing merges" pre-convergence was written at small
  N and is corrected. That a group with an interior vertex is *always* an artifact
  is a fact about the sphere rather than a tolerance argument: coplanar points on
  a sphere are cocircular, the face's plane meets the sphere in exactly that
  circle, and a point strictly inside the polygon would be strictly inside the
  circle, hence strictly inside the sphere — which no point here can be. So a
  genuine flat face has no interior vertex at any N or p, and `swallowsVertex`
  rejects such a group outright, reusing the untraceable-boundary fallback that
  emits its triangles unmerged. The cost is negligible: at N=1000 it unmerges two
  groups of a handful of triangles each out of ~1300 faces, and the renderer does
  not draw 3-sided groups by default anyway.

  `test/topology.js` replaces the ad-hoc probes and carries both layers'
  invariants — hull manifoldness and V−E+F=2, then the face layer counted exactly
  as render.js counts it — over the reported range, six seeds × twelve N, relaxed
  configurations at four step counts, and every degree-hiding subset that
  render.js retriangulates. It asserts the orphan *list* is empty rather than just
  χ=2, so a future regression names the vertex. Confirmed to fail against the
  pre-fix `faces.js` with exactly the reported counts. The 493-case sweep quoted
  in render.js stopped at N=100, an order of magnitude short of where this
  appears, which is why it was missed.

- **Energy chart no longer breaks when the objective changes under it.** Reported
  as "N=1024, p=3, spherical, GD: the energy plot fails to render and the
  y-labels read Infinity, until the energy drops to ~3e6". The `p=3` energies are
  entirely finite (5.9e8 falling to 3.2e6 over 400 steps), so the exponent in the
  report was a red herring — the cause was the **previous** run at `p=1000`,
  where `logE ≈ 6500` puts `Math.exp` far past its 709 ceiling and every history
  entry stores `energy: Infinity`. Changing `p` reset the trust region and the
  convergence tracking but never `_energyHistory`, so those entries stayed in the
  window. `useLog` was then decided from the *newest* point alone, which now read
  finite, so the linear branch was chosen over a window containing Infinity:
  `maxV` became infinite, so did the 8% margin, both bounds went to ±Infinity,
  every `yOf` became `NaN` (nothing drawn) and both labels printed the string
  "Infinity". The "~3e6" threshold was just the trailing 1000-step window finally
  sliding past the stale points. Three fixes:
  - `resetEnergyHistory()`, called on a change of `p` or metric as well as from
    `resetConfiguration`. Correctness rather than tidiness: `E` is a different
    function at every `p`, so a curve spanning a change of `p` plots two
    incomparable quantities on one axis.
  - `useLog` now scans the whole visible window instead of its last point. The
    same straddle happens **within** a single run around `p ≈ 250`, where energy
    starts as Infinity and later drops below 1e308 — that instance was live and
    unreported.
  - `renderChart` tolerates non-finite values generally: they are excluded from
    the min/max scan, the polyline lifts the pen across them rather than drawing
    to `NaN` (which silently aborts the whole path), and a window with nothing
    representable draws the frame with an em-dash label. This caught two further
    latent cases — `p=0` stores `logEnergy` as `NaN`, which produced `"NaN"`
    labels, and the residual chart's log axis emitted non-finite coordinates on
    `NaN` residuals.

  `test/chart_render.js` covers all four situations through a recording canvas
  stub, asserting that no label ever reads Infinity/NaN and no draw command
  receives a non-finite coordinate. Confirmed to fail against the pre-fix
  `chart.js` with exactly the reported `["Infinity","-Infinity"]`.

- **Riemannian L-BFGS, as a second optimizer alongside gradient descent.** The
  step-count lever, which nothing before this had touched: every prior
  optimisation attacked the cost of a step, while plain projected descent with
  Armijo backtracking set how many steps were needed. Selected from a new
  **Methodology** section in the left panel (between Parameters and Animation),
  which is also where the Barnes-Hut choice above will live — its "Force
  evaluation" row already exists with Pairwise active and Barnes-Hut present but
  inert.

  Measured on `test/optimizer_bench.js`, counting `computeEnergyAndForce` calls
  (the only cost that matters, since the two-loop recursion is `O(m·N)` against
  `O(N²)` for one evaluation — the method is free per iteration):

  | case | GD evals | L-BFGS evals | ratio |
  |---|---|---|---|
  | N=24 p=1 euclidean | 444 | 122 | 3.6× |
  | N=64 p=1 euclidean | 2770 | 325 | 8.5× |
  | N=128 p=1 euclidean | 9167 | 348 | **26.3×** |
  | N=64 p=0 euclidean | 1011 | 281 | 3.6× |
  | N=64 p=6 euclidean | 6589 | 374 | 17.6× |
  | N=64 p=25 euclidean | 8385 | 869 | 9.7× |
  | N=64 p=100 euclidean | 10129 | 875 | 11.6× |
  | N=64 p=1 spherical | 20487 | 7660 | 2.7× |
  | N=32 p=2 spherical | 563 | 714 | 0.79× |

  The win grows with N, which is the right direction — it is the stiffening
  landscape that L-BFGS deflates. The one loss is a small spherical case where
  there was little conditioning to exploit and the line search still pays a
  backtrack or two.

  The extreme corner is the real headline: **N=1024, p=1000 converges in 10109
  steps and 20700 evaluations**, where gradient descent would not converge in a
  day. That combination stacks everything hostile at once — the stiffest
  landscape on the p scale, the largest N, and `E` overflowing double precision
  (`logE ≈ 6500`) so the whole run lives in the log-domain reformulation.

  Three things this needed beyond the textbook recipe:
  - **A vector transport.** The curvature pairs `(s_j, y_j)` are tangent vectors
    formed at different iterates, and `T_{x_j}M ≠ T_{x_k}M` as subspaces of
    `R^3N`, so they are unusable as stored. Transport by projection,
    `T_{x→z}(v) = P_z(v)`, is valid on the sphere and costs one dot product per
    point (Ring & Wirth 2012; Huang, Gallivan & Absil 2015). The retraction
    needed nothing new — `normalize(x+v)` is what `applyDisplacement` already
    did.
  - **A consistent objective gradient**, `state._objForce`. This was the real
    prerequisite and the easiest thing to get silently wrong. `state._forces`
    switches meaning at `P_PHYSICAL_MAX`: `-∇E` below, `-∇Ψ` above. Harmless for
    descent, which uses only the direction — fatal for L-BFGS, whose pairs are
    gradient *differences*, so a configuration-dependent factor `λ = p·E` would
    make `y_k` track the variation in `λ` rather than `Hess·s_k`, with a
    discontinuity at `p=64`. `test/gradient_check.js` verifies both halves: that
    `_objForce` is exactly `_forces` times the predicted scalar (`1`, `1/E` or
    `p`) to machine precision across 39 cases, and that it matches a
    central-difference directional derivative along the retraction.
  - **Restart on stagnation, not just a stall counter.** An ill-conditioned `H`
    gives a direction that is long and nearly orthogonal to the gradient; the
    arc cap then clamps the step, the objective moves by less than `STALL_REL`,
    and the shared stall test declares convergence at a non-critical point.
    Discarding the memory restores a guaranteed-downhill direction. Bounded by
    `LBFGS_MAX_RESTARTS` so a genuine precision floor still terminates.

  Two findings worth keeping, both of which look like bugs and are not:
  - The two optimizers **routinely settle in different local minima**, either
    way round. Inherent to a landscape with exponentially many minima —
    trajectories diverge within a handful of steps — and exactly why the
    Thomson literature wraps a local minimizer in basin hopping. A single run of
    either finds *a* minimum, not *the* one. The bench therefore asserts
    evaluation count and monotone decrease, and only sanity-bounds the objective
    gap.
  - On the spherical metric the **residual is not comparable between them** near
    an antipodally-symmetric optimum. At N=64, p=1 descent lands with 32 pairs
    inside `SIN_ZERO`, whose `1/sin θ` contributions are zeroed, reading
    `1.5e-7`; L-BFGS stops at gap `1.05e-6`, just outside, retaining them in
    full and reading `5.0e-5`. The objectives agree to `~1e-5`. That is the
    documented `SIN_ZERO` behaviour, not a difference in convergence quality.

  Deliberately not done: momentum/Nesterov. It is the cheaper win *and* keeps
  the physical reading (it is literally a heavy ball with friction), so it
  remains worth having as a third option — L-BFGS's `d = -H·g` is not a force
  field, which is why this is a mode rather than a replacement.

- **N now reaches 1024**, on a slider whose stops widen with N — unit steps to
  64, then the step doubles at each power of two (2 to 128, 4 to 256, 8 to 512,
  16 to 1024), 192 stops in all, indexed exactly the way the p slider indexes
  `P_VALUES`. Everything worth stepping through one point at a time is at small
  N, and past a few hundred a single extra point is invisible, so a uniform
  slider would spend most of its travel on distinctions nobody can see. The
  readout beside the label is itself a number input for the values the slider
  skips; it accepts any N in 1..1024, clamps out-of-range entries, and restores
  the current N on an empty or unparseable one (a `number` input reports junk as
  `""`, and `Number("") === 0`, which would otherwise collapse the
  configuration to a single point).

- **Split the pair-kernel acceleration by `p`, which is where the large-N cost
  actually went.** Three changes, in ascending order of how much they turned
  out to matter. Measured per `computeEnergyAndForce()` call at `N = 1024`,
  Euclidean unless stated:

  | | p=1 | p=2.5 | p=6 | p=6 spherical | p=1000 |
  |---|---|---|---|---|---|
  | before | 7.1 | 26.8 | 26.9 | 34.5 | 20.4 |
  | after | 6.1 | 7.1 | 6.7 | 13.2 | 0.42 |

  - **The flat `Float64Array` kernel did essentially nothing.** `state.points`
    is now mirrored into a flat buffer per call and forces accumulate into
    another, with the triples materialized only at the end — and at `p=1` that
    bought about 15%, within noise of the extra call the shared per-pair
    function costs. The premise was wrong: V8 already stores an array of
    `[x,y,z]` arrays as packed-double elements, so the layout was never the
    bottleneck. It is kept because the cell grid below wants flat coordinates
    anyway, not because it is faster on its own.
  - **`Math.pow` was the bottleneck, and most of the p slider's stops don't
    need it.** The `p=1` vs `p=2.5` gap in the "before" row is a factor of
    3.8 in a kernel that does exactly the same work either way — V8
    special-cases an exponent of 1 and pays a full transcendental for anything
    else. Since the slider is integers and halves almost everywhere,
    `powInt` does exponentiation by squaring on `q = dMin/d ∈ (0,1]`
    (half-integers via `sqrt(q)`), which is a handful of multiplies. That is
    the whole of the 4× at moderate p. Restricted to `p ≤ P_PHYSICAL_MAX`,
    partly because squaring compounds rounding by about `log2(p)` ulps and
    partly because above there the cutoff below does the work instead.
  - **The large-`p` cutoff is worth ~40× and is exact.** Past
    `d_min · exp(746/p)` the relative weight `(d/dMin)^-p` is not merely small
    but *exactly* zero in double precision, so those pairs contribute bitwise
    nothing — to the energy, the forces and the per-point energies alike — and
    a uniform cell grid (CSR buckets, 27-cell scan) may skip them with no
    accuracy tradeoff and no Armijo-tolerance worry. 746 rather than 709
    deliberately: the denormal limit, not the normal one, so the skipped terms
    are true zeros and not `1e-320`. `N=512` at `p=1000` went from ~5ms to
    0.5ms per step.

  Two details worth remembering. The closest-pair pass can use the same grid
  even though the cutoff isn't known until after it runs, because the minimum
  separation has an a-priori bound: `n` disjoint caps of angular radius `θ/2`
  have total area at most `4π`, so `n(1-cos(θ/2)) ≤ 2`, and with
  `chord = 2sin(θ/2)` that gives `d_min ≤ 4/√n` exactly — cells that size are
  guaranteed to hold the closest pair within adjacent cells. And the grid's
  bookkeeping is `O(cells)`, not `O(occupied cells)`, because the prefix sum
  sweeps all of them; a cutoff far below the minimum separation (which happens
  when a configuration is momentarily clustered) would otherwise allocate a
  volumetric grid vastly larger than the point set it sorts, so `cellSizeFloor`
  caps the resolution at `max(4096, 64N)` cells. Using cells *larger* than the
  cutoff is harmless — it only visits extra pairs, which the cutoff then finds
  to be zeros.

- **Memoized the convex hull on its point array's identity** (`_hullCache`, a
  `WeakMap` in `js/hull.js`), which needs no version counter and can't go
  stale: `physics.js` never mutates a point array in place, rebuilding
  `state.points` from scratch on every accepted step and on reset, so a given
  array holds the same coordinates for as long as it exists. Reaching a stale
  entry would require the array it's keyed on to have changed.

  Two separate wins, since the hull was being rebuilt for two different bad
  reasons. Within a frame, the edge layer and the face layer each asked for
  the hull of the same points, so one of the two was always redundant. Across
  frames, the triangulation depends on the points alone and not on the view,
  yet `draw()` rebuilt it unconditionally — so rotating, zooming or hovering a
  *paused* configuration recomputed two hulls per frame for points that hadn't
  moved. Per rendered frame (edge layer + face layer), ms:

  | N | before | after, playing | after, paused |
  |---|---|---|---|
  | 100 | 0.54 | 0.37 | 0.116 |
  | 400 | 4.66 | 2.69 | 0.559 |
  | 800 | 15.60 | 8.50 | 1.346 |

  1.8x while playing and 11.6x while paused at N=800, with the paused residue
  being the EDGE_C filter and the face merge, which still rerun. Verified
  identical edge lists, degrees and face boundaries against an unmemoized
  build across 120 consecutive steps at N=60. The visible-subset point list
  used when vertices are hidden is cached the same way (`_subsetCache` in
  `js/render.js`, keyed on the points array and the hidden-degree set),
  because rebuilding it per frame would allocate a fresh array each time and
  defeat the memo it feeds.

- **Raised the p ceiling from 25 to 1000** by minimizing the energy in log
  form. `computeEnergyAndForce()` no longer sums raw `d^-p` terms; it now
  makes one cheap pass to find the closest pair (only the largest dot
  product is needed — it identifies that pair under both metrics) and a
  second pass accumulating each pair's weight *relative* to that closest
  pair, `w = (d/d_min)^-p ∈ (0,1]`. The true energy comes back exactly as
  `sum_w · d_min^-p`, in log form when that overflows. Descending
  `Ψ = (1/p)·log E` instead of `E` is not a change of physics: `∇Ψ = ∇E/(p·E)`
  is the same direction field times one positive scalar, which the adaptive
  `dt` absorbs — verified by regression against pre-change converged
  energies (7 configurations across p=0/1/6/25, both metrics, agreeing to
  ~1e-12 relative, step counts within 3%).

  Two distinct bugs were hiding behind the single symptom "p>25 stalls at
  maxForce ~1e+3", and both had to go:
  1. **Conditioning.** At `E ~ 1e13` the Armijo test's `1e-10·(1+|E|)` slack
     came out to `~1e+3`, far larger than a real per-step energy change, so
     every trial step read as downhill regardless of whether it was. Fixed
     by comparing `log E` (a relative tolerance on `E` is an absolute one on
     `log E`, so the test now means the same thing at every p).
  2. **The convergence criterion was dimensionally wrong.** It tested an
     absolute threshold (`maxForce ≤ 1e-4`) against a quantity whose own
     scale grows like `e^O(p)`: at p=25 a *fully converged* N=40
     configuration still reports `maxForce ~5.6e+3`, so the run could never
     terminate however settled it was. Instrumenting it showed `log E`
     reaching its float-precision floor by step 2000 and `dlogE` hitting
     exactly 0 — it had converged 18000 steps before the loop noticed. Fixed
     by adding a scale-free `Residual` (`max_i |∇_i Ψ|`, shown in the panel)
     plus an `ftol`-style stagnation stop: 100 consecutive steps failing to
     improve on the best objective by more than `1e-14` relative. A
     scale-free force threshold alone would *not* have worked, because the
     achievable residual floor itself degrades with p (~1e-9 at p=1, ~1e-8
     at p=6, ~2e-6 at p=25). p=25/N=40 now converges in ~2800 steps.
- **Vertex tension colouring made scale-free**, as a follow-up to the above:
  it was still reading raw net-force magnitude against fixed 1e0..1e-4 stops,
  so at p=25 (physical force ~1e+8 throughout) every vertex pinned to red for
  the entire run, converged configurations included — the colouring had
  stopped being a convergence proxy at exactly the exponents the log-domain
  work opened up. It now takes each vertex's residual as a *fraction of the
  peak residual this landscape has held* (`vertexTensionRatio()` in
  `render.js`, `state._residualPeak`), so red means "as tense as it ever was"
  and pale means "four or more decades quieter". Measured across p=0/1/6/25/200
  and both metrics, every run now traverses red→...→pale and ends pale.
  The two simpler candidates both fail and it's recorded in the code why: raw
  force isn't scale-free at all, and the *absolute* residual is scale-free but
  badly distributed (start values 2e-1 at p=1 vs ~1e+1 for p≥6; converged
  values from 1e-4 at p=0/p>64 down to 5e-9 at p=6), so no fixed four-decade
  window covers both ends at every p. The peak is updated from accepted steps
  only, since a trial point mid-backtrack can put two vertices almost on top
  of each other and permanently inflate it. Vertex hover also now reports
  Residual alongside Net force, so the colour has a visible number behind it.
- **Min separation** added to the statistics panel (the closest pair's
  angular separation), free from the pass above. This is the quantity the
  Tammes problem maximizes, and the one that makes high p meaningful to look
  at when the energy has become an unreadable `e+124`. Display degrades
  gracefully as p climbs: Energy switches to `log Energy` (panel row and
  chart title) once `E` overflows double precision, and Max force switches
  to dimensionless relative units above `P_PHYSICAL_MAX = 64`, where the
  physical force's `p·d_min^-p` factor no longer fits in a double. That
  threshold is a fixed constant rather than a check on the current `d_min`
  precisely so the displayed units can't flip back and forth mid-run as a
  transient near-collision forms and resolves.
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
  out of sync with each other. Initially shipped non-functional: the
  histogram's `innerHTML` was unconditionally rebuilt every animation frame,
  which destroyed and replaced the exact `<span>` a click landed on between
  its mousedown and mouseup, so the browser never fired a "click" at all.
  Fixed by only rebuilding when the rendered rows actually change (a
  cheap signature check), plus switching the listener to "mousedown" as a
  second line of defence against the same failure mode.
- Widened the font stack to also cover non-Apple platforms explicitly, then
  found `-apple-system` alone isn't actually reliable on Mac: on at least
  one real Mac/browser combination it silently fell through past
  `-apple-system` (unrecognized in that engine/version) all the way to
  Roboto, simply because Roboto happened to be installed locally (common -
  it ships bundled with plenty of cross-platform apps) while "Segoe UI"
  wasn't. Fixed by leading with the standardized `system-ui` keyword
  (universally well-supported since ~2017-2021 across engines, and the
  actual source of truth for "give me this OS's UI font" - see MDN/caniuse),
  keeping `-apple-system`/`BlinkMacSystemFont` only as legacy-engine
  fallbacks behind it: `system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Bumped the degree-highlight ring from 1.2x to 1.25x the vertex's display
  radius, per visual testing.
- Added a third vertex state, "hidden" (display-only - never touches the
  simulation), joining "highlighted" in a 3-way cycle on each degree
  histogram row: normal -> highlighted -> hidden -> normal. Hiding
  interacts with edge rendering rather than just erasing edges that touch
  a hidden vertex: `computeEdgesForPoints()` (the Delaunay+EDGE_C core,
  factored out of `computeEdges()` for this) reruns on just the currently-
  visible points, so isolating e.g. the 12 pentagonal defects on a large
  relaxed mesh reveals *their own* triangulation (a locally-recomputed r0
  among just those 12 points) instead of a lattice full of holes. These
  are rendered dashed and named "non-local" (not "pseudo") in the hover
  panel and code, since a pair excluded from the Delaunay triangulation is
  still a real, physically-interacting one under the Riesz/log potential -
  Force is reported for them exactly like any other edge. Also fixed a
  latent bug this surfaced: the vertex hover panel's Degree readout
  recounted `edgePaths` incident to the hovered vertex, which would have
  double-counted once these edges could appear there - switched to reading
  `state._degree` directly instead.
- Added a purely visual face-rendering layer (`js/faces.js`). Adjacent hull
  triangles (sharing an edge) whose outward normals agree to within
  `FACE_COPLANAR_DOT = 0.9995` (~1.8°) are union-find merged into a single
  flat n-gon; requiring *adjacency*, not just parallel normals, is what
  distinguishes a genuine flat face from a merely-coplanar non-face like an
  octahedron's internal diagonal plane (whose two triangles aren't even
  hull faces, let alone adjacent to each other). Boundary edges of each
  merged group are chained into an ordered polygon loop using the hull's
  existing consistent CCW winding; a convex hull's intersection with a
  supporting plane is always itself convex, so this can never produce a
  self-intersecting (bowtie) loop - only a defensive fallback for float-
  precision edge cases, never expected to trigger. Ordinary triangles fall
  out of the same algorithm as 3-sided singleton groups, so the messy,
  generically-asymmetric triangulation seen early in a run (or in any
  configuration without exact flat faces) needs no special-casing: it's
  simply the generic case where nothing merges. Nothing is rendered by
  default (a new "Faces by side count" panel, mirroring the vertex-degree
  histogram but with a simpler 2-state show/hide toggle per row rather than
  the vertices' 3-state highlight/hide cycle, since faces have no "always
  visible" base state to begin with) - the user opts into seeing a given
  side count, coloured consistently by a hue keyed to that count, and named
  in English (Triangle, Quadrilateral, ..., Icosagon at 20 sides, "N-gon"
  beyond - `faceSidesName()` in `js/faces.js`). Hovering a shown face
  (paused only) reports its side count and area (summed from the original
  simplicial triangles' flat areas, pre-merge); the title itself is the
  vertex list "v1-v2-...-vk" rather than a separate vertex-count row, since
  that count is always redundant with the side count for a polygon.
- Extended vertex hiding to faces with the same full treatment edges
  already got: a face touching a hidden vertex is dropped, and
  `computeFacesForPoints()` (already subset-capable, mirroring
  `computeEdgesForPoints()`) reruns on just the visible points, surfacing
  any "non-local" faces - flat regions that only exist once the hiding
  vertex is gone - deduplicated against the full-set faces and drawn
  dashed, exactly like non-local edges. Also: in "Arcs" edge style, face
  boundaries are now subdivided into the same slerp arcs edges use instead
  of flat chords, so a shown face renders as a genuine spherical tile
  rather than a flat polytope facet in that mode (`buildFacePath()` in
  `js/render.js`); "Lines"/"None" style still draws the flat polytope face.
- Added a left-panel "Faces" Hide/Show segmented control (`state.facesVisible`)
  as the master switch for the whole face layer, right below Edges -
  defaults to Hide, matching the layer's original declutter-by-default
  intent. The right panel's per-side-count histogram is now the *fine*
  control underneath it: each row's default appearance is "shown" (no
  special styling) and toggles to a dim strikethrough on click
  (`state.hiddenFaceSides`, reusing the vertex-degree histogram's
  `state-hidden` look), so e.g. triangles can be individually suppressed
  while other side-counts stay visible once the master switch is on. That
  per-side-count set is intentionally independent of, and persists across,
  the master switch. Also fixed a related staleness bug while making this
  change: the histogram was reading `state._faces` from the raw full-point-
  set `computeFaces()` result rather than the post-hiding/non-local
  `faceCandidates` list, so its counts didn't update when vertices were
  hidden even though the 3D rendering itself already did.
- Face colours switched from a generated hue ramp to a fixed, named
  6-colour palette (turquoise/teal-blue, yellow, salmon-pink, green,
  orange, purple), cycling starting at 4 sides so triangles - the
  overwhelming majority, especially pre-convergence - get a deliberately
  muted, non-intrusive neutral (matching the app's own `--muted` grey-blue)
  instead of competing for attention with a vivid hue; every other
  side-count gets one of the 6 vivid colours, distinct from that neutral
  and from each other (`FACE_TRIANGLE_COLOR`/`FACE_COLOR_PALETTE` in
  `js/render.js`). Also switched from culling rear-facing faces entirely to
  drawing them too - back-to-front painter's-algorithm sorted and
  depth-faded (0.35 at the far back to 1.0 at the front), the same idea as
  the existing vertex tension colouring - so e.g. a snub cube's rear square
  faces are visible (faded) rather than silently dropped.
- Split the statistics panel's vertex/face histograms out into their own
  "Geometry" section, separate from the numeric Steps/Energy/Max force
  stats above and the Graphs section below.
- Added an on-canvas hover highlight for whichever vertex/edge/face the
  tooltip is currently describing (a bright ring for a vertex, a thicker
  bright stroke for an edge, a light fill + bright stroke for a face -
  `drawHoverHighlight()` in `js/render.js`), rather than only surfacing the
  hovered element's details in the tooltip with no on-canvas cue.
  Implemented via a one-frame-lagged read of hover.js's hit-test result
  (`currentHoverTarget`, written at the end of the *previous* frame's
  `updateHover()` call) rather than threading hit-testing ahead of the
  render passes it depends on - imperceptible in practice since the mouse
  is stationary between frames at 60fps, and far simpler than a full
  compute/render split.
- Fixed hover priority/depth bugs surfaced by rendering rear faces: the
  face hit-test had no depth check at all, and iterated `facePaths` (sorted
  back-to-front for painter's-algorithm rendering) breaking on the *first*
  polygon match - so once a rear face could overlap a front one on screen
  (e.g. a square antiprism's far square nearly eclipsed by the near one),
  hovering would silently lock onto the rear face instead. Now: vertex >
  edge > face priority is checked strictly among *front-hemisphere*
  candidates only at every level (rear elements are never hoverable, full
  stop), and if several front faces still overlap on screen, the nearest
  (highest avgZ) one wins rather than whichever came first in the sorted
  array. Also switched the edge hit-test's front/back check from a coarse
  average of the two endpoints' z to the z *at the actual closest point on
  the path* (`closestPointOnPath()`), fixing misclassification for curving
  "arcs"-style paths and especially longer non-local edges, whose endpoints
  can both read as front-facing while the arc's midpoint dips behind the
  horizon (or vice versa).
- Diagnosed a separate source of "edges are hard to hover" confusion: a
  face's own boundary is drawn with its own stroke (`faceStrokeColor()`,
  dashed identically to non-local edges when the face itself is non-local)
  but in that side-count's palette colour, not the edges' fixed blue - so a
  dashed line in any colour *other* than blue is a face outline, not an
  edge, and has no entry in `edgePaths` at all. Aiming exactly at that thin
  stroke also used to miss the face's own hover, since it sits just outside
  the strict point-in-polygon interior test. Added a boundary-distance
  fallback (`FACE_BOUNDARY_HIT_R`) so hovering a face's outline itself, not
  just its interior, resolves to that face.
