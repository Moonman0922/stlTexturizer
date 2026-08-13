# Domain concepts — stlTexturizer

## Vertex welding (`js/meshIndex.js`)

The pipeline works on **non-indexed triangle soup**: every triangle carries its
own copy of each corner, so "the same point" exists many times with possible
float noise. **Welding** maps each position, quantised onto a grid, to one
small integer id. All modules do this through `QuantizedPointMap` /
`weldVertices` in `js/meshIndex.js` — an open-addressing hash table over typed
arrays (no string keys, no per-vertex allocation).

### Weld grids (quantisation)

The grid decides which points count as "the same". The app deliberately uses
three grids; **do not change a call site's grid casually** — it changes
watertightness behaviour:

| Grid | Cell    | Used by | Why |
|------|---------|---------|-----|
| 1e4  | 100 µm  | export (3MF), meshRepair, meshValidation, exclusion/adjacency, main.js masking | matches the 4-decimal precision exports are written with |
| 1e5  | 10 µm   | subdivision, regularize, displacement | fine enough to keep small fillet vertices distinct (1e4 merged them → needle artifacts); coarse enough to absorb float32 noise |
| 1e6  | 1 µm    | decimation (own packed-key welder in decimation.js) | collapse positioning needs the finest grid |

`resolveTJunctions` (meshRepair.js) **snaps** coordinates onto the 1e4 grid
before export, so the exporter's weld only merges grid-identical points and the
export's decimal rounding is a no-op.

### Known issue link

A handful of residual non-manifold edges in exports trace back to
decimation/bottom-snap folds; the cross-module grid differences above are a
suspected contributor. If unifying grids is ever attempted, it is a
behaviour change — verify with the export→import round-trip, not the
in-memory mesh.

## STEP CAD-face selection (`js/stepFaceSelection.js`)

For STL/OBJ/3MF the app only ever sees a triangle soup — there is no such
thing as "a surface", only triangles and the dihedral angle between them
(`exclusion.js`'s `bucketFill`/brush tools). STEP is different: `meshStep`
(the B-rep tessellator behind `js/stepLoader.js`) tessellates a real CAD
model, and `importStep()` already reports, for free, which STEP entity
(`faceOfTri`) and which analytic surface (`faces`: type, area, mean normal)
each triangle came from. `js/stepFaceSelection.js` turns that into "click
once to select the whole CAD face" instead of a dihedral-angle flood fill —
exact, no threshold, immune to how finely the face got tessellated.

That per-triangle lineage is fragile in two specific ways, both handled
deliberately rather than by accident:

- **Triangle-cleanup alignment.** `stlLoader.js`'s `validateAndCleanGeometry`
  compacts out NaN/degenerate triangles in place. If `faceOfTri` weren't
  compacted through the *exact same* keep/drop decisions, a dropped triangle
  would silently desync every id after it from the geometry. `setupGeometry`
  takes `faceOfTri`/`solidOfTri` as optional `companionArrays` for this
  reason — see `stepLoader.js`'s `loadSTEPText`.
- **Mesh re-authoring.** Subdivision/decimation/displacement baking produce
  a triangle set `faceOfTri` no longer describes at all. CAD-face selection
  only ever needs to be valid on the *freshly loaded, pre-subdivision* mesh
  (`currentGeometry` in `main.js`, before export-time processing) — exactly
  where `excludedFaces` (the manual-painting selection) already lives, since
  a picked CAD face is converted straight into that same triangle-index Set
  and rides the rest of the masking pipeline unchanged. `main.js` nulls
  `stepFaceData`/`stepFaceIndex` on every model load and again in
  `adoptBakedGeometry` so a stale mapping can never get picked against.
