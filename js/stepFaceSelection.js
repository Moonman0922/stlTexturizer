/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * stepFaceSelection.js — select mesh triangles by their originating STEP
 * B-rep face, instead of by dihedral-angle flood fill or manual painting.
 *
 * STEP import (stepLoader.js, via meshStep) reports `faceOfTri`: one STEP
 * entity id per triangle, naming the exact CAD surface (a cylinder, a
 * fillet, a planar face, …) that triangle was tessellated from. That id is
 * ground truth the mesh itself doesn't carry — two triangles can be coplanar
 * and adjacent without belonging to the same CAD face (a split face from a
 * STEP export), and a single curved CAD face can span a dihedral angle no
 * flood-fill threshold would cross. Picking by faceOfTri sidesteps both
 * failure modes and needs no threshold at all: a face is a face.
 *
 * No Three.js/DOM dependency — pure array/Map bookkeeping — so this composes
 * with exclusion.js's existing triangle-Set-based masking pipeline
 * (buildFaceWeights, buildExclusionOverlayGeo) without touching either: a
 * selected CAD face becomes the same kind of triangle-index Set that
 * bucketFill()/brush painting already produce, and flows through the rest
 * of the app unchanged.
 */

import { QuantizedPointMap } from './meshIndex.js';

// Matches exclusion.js's weld grid (100 µm) so "the same point" is judged
// consistently across the app's edge-detection passes.
const QUANT = 1e4;

/**
 * Trace the true CAD-face boundaries: line-segment endpoints (6 floats per
 * edge — x1,y1,z1,x2,y2,z2) for every mesh edge whose two triangles belong
 * to different STEP faces. This is independent of geometric angle — a
 * fillet can curve smoothly across a 0° dihedral yet still be a separate
 * STEP face from its neighbor, and a flat split face can share a 0° dihedral
 * with the face next to it too — so no adjacency/threshold walk (like
 * exclusion.js's bucketFill) can find these edges; only faceOfTri can.
 *
 * Used to feed the split-view comparison pane (js/comparisonViewport.js)
 * so a user can see, side by side, how the CAD topology actually decomposes
 * the part versus how they've painted it.
 *
 * @param {THREE.BufferGeometry} geometry  non-indexed, aligned with faceOfTri
 * @param {Uint32Array} faceOfTri
 * @returns {Float32Array}
 */
export function buildFaceBoundaryEdges(geometry, faceOfTri) {
  const posAttr  = geometry.attributes.position;
  const triCount = posAttr.count / 3;

  // Same vertex-welding approach as exclusion.js's buildAdjacency: assign a
  // numeric id to each unique quantised position so shared edges can be
  // found without string keys or per-vertex allocation.
  const posToId = new QuantizedPointMap(QUANT, Math.min(triCount * 3, 1 << 22));
  let nextId = 0;
  const vertId = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const id = posToId.getOrSet(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), nextId);
    if (posToId.inserted) nextId++;
    vertId[i] = id;
  }

  const numEdgeKey = (a, b) => (a < b ? a * nextId + b : b * nextId + a);
  const edgePairs  = [0, 1, 0, 2, 1, 2]; // vertex-index pairs within a triangle
  const firstTriOfEdge = new Map(); // edge key -> triangle index first seen there

  const boundary = [];
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let e = 0; e < 6; e += 2) {
      const cornerA = base + edgePairs[e];
      const cornerB = base + edgePairs[e + 1];
      const key = numEdgeKey(vertId[cornerA], vertId[cornerB]);
      const first = firstTriOfEdge.get(key);
      if (first === undefined) {
        firstTriOfEdge.set(key, t);
        continue;
      }
      // Second triangle at this edge: resolve it now. A third triangle at
      // the same edge (non-manifold) is left alone rather than guessed at.
      if (first >= 0 && faceOfTri[first] !== faceOfTri[t]) {
        boundary.push(
          posAttr.getX(cornerA), posAttr.getY(cornerA), posAttr.getZ(cornerA),
          posAttr.getX(cornerB), posAttr.getY(cornerB), posAttr.getZ(cornerB),
        );
      }
      firstTriOfEdge.set(key, -1);
    }
  }
  return new Float32Array(boundary);
}

/**
 * Group triangle indices by their source STEP face id.
 * Call this once per loaded STEP model (alongside exclusion.js's
 * buildAdjacency) and reuse the result for every click/hover — O(triCount)
 * to build, O(1) lookup afterwards.
 *
 * @param {Uint32Array} faceOfTri  one STEP face id per triangle (stepLoader.js)
 * @returns {Map<number, Set<number>>}  faceId -> triangle indices belonging to it
 */
export function buildFaceIndex(faceOfTri) {
  const index = new Map();
  for (let t = 0; t < faceOfTri.length; t++) {
    const id = faceOfTri[t];
    let set = index.get(id);
    if (!set) { set = new Set(); index.set(id, set); }
    set.add(t);
  }
  return index;
}

/**
 * Resolve the whole CAD face under a clicked/hovered triangle. Mirrors
 * exclusion.js's bucketFill(seedTriIdx, adjacency, threshold) closely enough
 * that a call site can swap one for the other.
 *
 * @param {number} triIdx  triangle the cursor hit (index into the array
 *   buildFaceIndex(faceOfTri) was built from)
 * @param {Uint32Array} faceOfTri
 * @param {Map<number, Set<number>>} faceIndex  from buildFaceIndex()
 * @returns {Set<number>}  triangle indices sharing triIdx's STEP face
 */
export function triSetForFaceAt(triIdx, faceOfTri, faceIndex) {
  if (triIdx < 0 || triIdx >= faceOfTri.length) return new Set();
  const id = faceOfTri[triIdx];
  return faceIndex.get(id) || new Set([triIdx]);
}

/** Normalized meshStep surface type -> short display label. */
const TYPE_LABELS = {
  plane: 'Plane', cylinder: 'Cylinder', cone: 'Cone', sphere: 'Sphere',
  torus: 'Torus', bspline: 'Freeform', revolution: 'Revolution',
  extrusion: 'Extrusion', offset: 'Offset', other: 'Surface',
};

/**
 * Human-readable label for a hover tooltip or status line, e.g.
 * "Cylinder · 428 mm² · 96 tri". Falls back to a bare id if meshStep somehow
 * didn't report metadata for it.
 *
 * @param {number} faceId
 * @param {Map<number, object>|null} faces  FaceInfo map (step.faces from stepLoader.js)
 */
export function describeFace(faceId, faces) {
  const info = faces && faces.get(faceId);
  if (!info) return `Face #${faceId}`;
  const label = TYPE_LABELS[info.type] || TYPE_LABELS.other;
  const area  = info.area >= 100 ? Math.round(info.area).toLocaleString() : info.area.toFixed(1);
  return `${label} · ${area} mm² · ${info.triangleCount.toLocaleString()} tri`;
}

/**
 * Triangle indices for a whole batch of selected STEP faces — used to seed
 * excludedFaces from a set of previously-picked face ids (project restore,
 * or a future "select all cylinders" filter).
 *
 * @param {Iterable<number>} faceIds
 * @param {Map<number, Set<number>>} faceIndex
 * @returns {Set<number>}
 */
export function facesToTriangleSet(faceIds, faceIndex) {
  const out = new Set();
  for (const id of faceIds) {
    const set = faceIndex.get(id);
    if (set) for (const t of set) out.add(t);
  }
  return out;
}
