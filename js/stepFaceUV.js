/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * stepFaceUV.js — periodic/repeating displacement patterns that follow the
 * true CAD surface, instead of a world-space approximation (mapping.js's
 * cylindrical/spherical/triplanar projections).
 *
 * meshStep (via `parameterUVs: true`, see stepWorker.js) reports a per-
 * triangle-CORNER analytic (u,v) for every triangle whose face it could
 * project onto its own B-rep surface — a cylinder's u is the true azimuth,
 * a plane's (u,v) are true in-plane coordinates, etc. Two problems remain
 * before that's usable as a texture coordinate:
 *
 *  1. SCALE — each face's (u,v) is in that surface's own units (radians for
 *     an angular axis, mm for a linear one), not the app's absolute-mm tile
 *     size. computeFaceMetricScale derives the true mm-per-unit-u/v for each
 *     face directly from its tessellation (no per-surface-type special
 *     casing needed).
 *
 *  2. PHASE — even with scale correct, two adjacent faces' (u,v) origins are
 *     independent (a cylinder wall and the fillet blending into it have
 *     unrelated parameterizations), so a repeating pattern "restarts" at
 *     every CAD-face boundary. computeFacePhaseOffsets fixes an additive
 *     per-face offset (in tile units) that best aligns the pattern across
 *     every shared boundary edge, propagated outward from a seed face by
 *     breadth-first search over the face-adjacency graph — the same kind of
 *     best-effort seam alignment a UV unwrap tool does by hand, done here
 *     from the exact CAD topology instead.
 *
 * reconstructStepPatternUV then carries the result through subdivision.js
 * WITHOUT touching its splitting logic: every vertex subdivision ever
 * produces is an affine (barycentric) combination of its original parent
 * triangle's 3 corners (subdivision only ever inserts edge midpoints, and a
 * midpoint of two affine combinations is itself an affine combination), and
 * subdivision.js already tracks that parent via `faceParentId`. So the final
 * per-vertex UV is just the barycentric interpolation of the parent
 * triangle's 3 corner UVs — no new bookkeeping inside subdivision.js at all.
 *
 * This is an EXPORT/BAKE-time feature only (see exportPipeline.js): the live
 * GPU preview shader (previewMaterial.js) has no per-vertex UV attribute to
 * sample, so MODE_STEP_FACE_UV falls back to triplanar there and only the
 * exported/baked mesh gets the true stitched pattern.
 */

import { QuantizedPointMap } from './meshIndex.js';

// Matches stepFaceSelection.js's boundary-detection grid — "the same point"
// should mean the same thing across every STEP-derived pass in the app.
const QUANT = 1e4;

/**
 * Single pass over the ORIGINAL (pre-subdivision) triangle soup that builds
 * everything needed before pattern-scale is known:
 *   - per-face metric scale (mm of world travel per unit of raw u / raw v)
 *   - raw (u,v) correspondence sums at every welded CAD-face boundary vertex
 *
 * @param {Uint32Array} faceOfTri   one STEP face id per triangle
 * @param {Float32Array} positions  non-indexed soup, 9 floats/triangle
 * @param {Float32Array} uv         per-corner analytic UV, 6 floats/triangle
 *   (NaN where meshStep couldn't project that corner onto an analytic surface)
 * @returns {{ metricScale: Map<number,{mmPerU:number,mmPerV:number}>,
 *             adjacency: Array<{faceA:number,faceB:number,sumUa:number,
 *               sumVa:number,sumUb:number,sumVb:number,count:number}> }}
 */
export function buildFaceUVIndex(faceOfTri, positions, uv) {
  const triCount = faceOfTri.length;

  // ── Per-face metric scale ────────────────────────────────────────────────
  // For each triangle, solve the 3×2 Jacobian M with M·(Δu,Δv) ≈ Δworld for
  // its two edges (closed form — 2×2 inverse), then |M's u-column| / |v-
  // column| is that triangle's local mm-per-unit-u / -v. Average over the
  // face, area-weighted so slivers from tessellation noise don't dominate.
  const scaleSumU = new Map(), scaleSumV = new Map(), scaleW = new Map();

  for (let t = 0; t < triCount; t++) {
    const b6 = t * 6;
    const u0 = uv[b6], v0 = uv[b6 + 1], u1 = uv[b6 + 2], v1 = uv[b6 + 3], u2 = uv[b6 + 4], v2 = uv[b6 + 5];
    if (!isFinite(u0) || !isFinite(v0) || !isFinite(u1) || !isFinite(v1) || !isFinite(u2) || !isFinite(v2)) continue;

    const b9 = t * 9;
    const ax = positions[b9],     ay = positions[b9 + 1], az = positions[b9 + 2];
    const bx = positions[b9 + 3], by = positions[b9 + 4], bz = positions[b9 + 5];
    const cx = positions[b9 + 6], cy = positions[b9 + 7], cz = positions[b9 + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const area = 0.5 * Math.hypot(e1y*e2z - e1z*e2y, e1z*e2x - e1x*e2z, e1x*e2y - e1y*e2x);
    if (area < 1e-12) continue;

    const d1u = u1 - u0, d1v = v1 - v0, d2u = u2 - u0, d2v = v2 - v0;
    const det = d1u * d2v - d2u * d1v;
    if (Math.abs(det) < 1e-9) continue; // degenerate in UV space — skip

    // Mu = ∂world/∂u, Mv = ∂world/∂v (see module doc for the derivation).
    const muX = (e1x*d2v - e2x*d1v) / det, muY = (e1y*d2v - e2y*d1v) / det, muZ = (e1z*d2v - e2z*d1v) / det;
    const mvX = (e2x*d1u - e1x*d2u) / det, mvY = (e2y*d1u - e1y*d2u) / det, mvZ = (e2z*d1u - e1z*d2u) / det;
    const mmPerU = Math.hypot(muX, muY, muZ);
    const mmPerV = Math.hypot(mvX, mvY, mvZ);
    if (!isFinite(mmPerU) || !isFinite(mmPerV)) continue;

    const fid = faceOfTri[t];
    scaleSumU.set(fid, (scaleSumU.get(fid) || 0) + mmPerU * area);
    scaleSumV.set(fid, (scaleSumV.get(fid) || 0) + mmPerV * area);
    scaleW.set(fid, (scaleW.get(fid) || 0) + area);
  }

  const metricScale = new Map();
  for (const [fid, w] of scaleW) {
    if (w <= 0) continue;
    metricScale.set(fid, { mmPerU: scaleSumU.get(fid) / w, mmPerV: scaleSumV.get(fid) / w });
  }

  // ── Face-adjacency raw UV correspondences ────────────────────────────────
  // Same welded-edge detection as stepFaceSelection.js's buildFaceBoundaryEdges,
  // but instead of collecting the edge for rendering, record — for every
  // boundary vertex — the (u,v) each side's own triangle reports at that
  // exact shared 3-D point. That pair is the ground truth for how face A's
  // pattern phase relates to face B's at the seam.
  const posToId = new QuantizedPointMap(QUANT, Math.min(triCount * 3, 1 << 22));
  let nextId = 0;
  const vertId = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const id = posToId.getOrSet(x, y, z, nextId);
    if (posToId.inserted) nextId++;
    vertId[i] = id;
  }

  const numEdgeKey = (a, b) => (a < b ? a * nextId + b : b * nextId + a);
  const edgePairs = [0, 1, 0, 2, 1, 2];
  // edge key -> { tri, cornerA, cornerB } of the first triangle seen there
  const firstAtEdge = new Map();
  // unordered face-pair key -> accumulator
  const adjAcc = new Map();

  // uv is stored in the same per-corner soup order as positions, so a global
  // (non-indexed) vertex index maps straight through: uv[i*2], uv[i*2+1].
  const uvAt = (globalVert) => [uv[globalVert * 2], uv[globalVert * 2 + 1]];

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let e = 0; e < 6; e += 2) {
      const cornerA = base + edgePairs[e];
      const cornerB = base + edgePairs[e + 1];
      const key = numEdgeKey(vertId[cornerA], vertId[cornerB]);
      const first = firstAtEdge.get(key);
      if (first === undefined) {
        firstAtEdge.set(key, { tri: t, cornerA, cornerB });
        continue;
      }
      if (first !== null && faceOfTri[first.tri] !== faceOfTri[t]) {
        // Match corners by weld id — winding order can run either way
        // between two triangles that share an edge.
        const [fCornerA, fCornerB] = vertId[first.cornerA] === vertId[cornerA]
          ? [first.cornerA, first.cornerB]
          : [first.cornerB, first.cornerA];

        const faceA = faceOfTri[first.tri], faceB = faceOfTri[t];
        const pairKey = faceA < faceB ? `${faceA}_${faceB}` : `${faceB}_${faceA}`;
        let acc = adjAcc.get(pairKey);
        if (!acc) {
          acc = { faceA, faceB, sumUa: 0, sumVa: 0, sumUb: 0, sumVb: 0, count: 0 };
          adjAcc.set(pairKey, acc);
        }
        // acc.faceA/faceB were fixed by whichever pair was seen first; if this
        // record's (first.tri, t) land on the opposite side, swap before adding.
        const aIsFirst = faceOfTri[first.tri] === acc.faceA;
        const aVerts = aIsFirst ? [fCornerA, fCornerB] : [cornerA, cornerB];
        const bVerts = aIsFirst ? [cornerA, cornerB] : [fCornerA, fCornerB];
        for (let k = 0; k < 2; k++) {
          const [ua, va] = uvAt(aVerts[k]);
          const [ub, vb] = uvAt(bVerts[k]);
          if (!isFinite(ua) || !isFinite(va) || !isFinite(ub) || !isFinite(vb)) continue;
          acc.sumUa += ua; acc.sumVa += va; acc.sumUb += ub; acc.sumVb += vb;
          acc.count++;
        }
      }
      // A third triangle at the same edge (non-manifold) is left alone.
      firstAtEdge.set(key, null);
    }
  }

  const adjacency = [...adjAcc.values()].filter(a => a.count > 0);
  return { metricScale, adjacency };
}

/**
 * Resolve each face's tile size (mm settings converted through its metric
 * scale) and an additive phase offset (in tile units) chosen so that, at
 * every shared CAD-face boundary, the two faces' patterns land on the same
 * phase — propagated by BFS from one seed face per connected component of
 * the face-adjacency graph. Faces with no valid UV data (not in
 * uvIndex.metricScale) are omitted from the result.
 *
 * @param {ReturnType<typeof buildFaceUVIndex>} uvIndex
 * @param {number} scaleU_mm  absolute tile size, U (settings.scaleU)
 * @param {number} scaleV_mm  absolute tile size, V (settings.scaleV)
 * @returns {Map<number, {tileU:number, tileV:number, offsetU:number, offsetV:number}>}
 */
export function computeFacePhaseOffsets(uvIndex, scaleU_mm, scaleV_mm) {
  const { metricScale, adjacency } = uvIndex;
  const phase = new Map();
  const tileOf = (fid) => {
    const m = metricScale.get(fid);
    return {
      tileU: Math.max(scaleU_mm / Math.max(m.mmPerU, 1e-9), 1e-9),
      tileV: Math.max(scaleV_mm / Math.max(m.mmPerV, 1e-9), 1e-9),
    };
  };

  // Adjacency list per face, in tile units (computed once tiles are known).
  const neighbors = new Map(); // faceId -> [{ other, du, dv }]
  for (const { faceA, faceB, sumUa, sumVa, sumUb, sumVb, count } of adjacency) {
    if (!metricScale.has(faceA) || !metricScale.has(faceB)) continue;
    const tA = tileOf(faceA), tB = tileOf(faceB);
    const du = (sumUa / count) / tA.tileU - (sumUb / count) / tB.tileU;
    const dv = (sumVa / count) / tA.tileV - (sumVb / count) / tB.tileV;
    if (!neighbors.has(faceA)) neighbors.set(faceA, []);
    if (!neighbors.has(faceB)) neighbors.set(faceB, []);
    // du/dv = uA/tileA − uB/tileB. Traversing FROM a visited face TO a new
    // one adds (visited face's own u/tile − new face's u/tile) to the
    // offset, so the entry stored under a face's own neighbor list is the
    // delta as seen FROM that face.
    neighbors.get(faceA).push({ other: faceB, du, dv });
    neighbors.get(faceB).push({ other: faceA, du: -du, dv: -dv });
  }

  // BFS per connected component, seeded (offset 0,0) at the largest-area
  // face of that component so the "reference" face is a stable, meaningful
  // one rather than whatever Map iteration happens to visit first.
  const areaOf = new Map();
  for (const [fid, m] of metricScale) areaOf.set(fid, m.mmPerU * m.mmPerV); // proxy, doesn't need to be exact

  const visited = new Set();
  const remaining = new Set(metricScale.keys());
  while (remaining.size > 0) {
    let seed = null, seedArea = -Infinity;
    for (const fid of remaining) {
      const a = areaOf.get(fid) || 0;
      if (a > seedArea) { seedArea = a; seed = fid; }
    }
    const t = tileOf(seed);
    phase.set(seed, { tileU: t.tileU, tileV: t.tileV, offsetU: 0, offsetV: 0 });
    visited.add(seed);
    remaining.delete(seed);

    const queue = [seed];
    while (queue.length > 0) {
      const cur = queue.shift();
      const curPhase = phase.get(cur);
      for (const { other, du, dv } of (neighbors.get(cur) || [])) {
        if (visited.has(other)) continue;
        visited.add(other);
        remaining.delete(other);
        const t2 = tileOf(other);
        phase.set(other, {
          tileU: t2.tileU, tileV: t2.tileV,
          offsetU: curPhase.offsetU + du, offsetV: curPhase.offsetV + dv,
        });
        queue.push(other);
      }
    }
  }
  return phase;
}

/**
 * Carry the phase-aligned pattern UV through subdivision via faceParentId
 * (see module doc for why barycentric reconstruction is exact here).
 *
 * @param {Float32Array} subPositions   subdivided, non-indexed soup (9/tri)
 * @param {Int32Array}   faceParentId   subdivide()'s output — one entry per
 *   subdivided triangle, indexing into the ORIGINAL pre-subdivision triangle
 *   array (origPositions/origFaceOfTri/origUV)
 * @param {Float32Array} origPositions  pre-subdivision soup (9/tri)
 * @param {Uint32Array}  origFaceOfTri  pre-subdivision, 1/tri
 * @param {Float32Array} origUV         pre-subdivision, 6/tri (corner UV)
 * @param {Map} facePhase   from computeFacePhaseOffsets()
 * @returns {Float32Array}  2 floats per non-indexed vertex (subTriCount*6),
 *   pre-fract tile-space coordinates. NaN where the parent face had no usable
 *   UV data — callers must fall back to the procedural projection there.
 */
export function reconstructStepPatternUV(subPositions, faceParentId, origPositions, origFaceOfTri, origUV, facePhase) {
  const subTriCount = faceParentId.length;
  const out = new Float32Array(subTriCount * 6).fill(NaN);

  for (let st = 0; st < subTriCount; st++) {
    const parent = faceParentId[st];
    const fid = origFaceOfTri[parent];
    const ph = facePhase.get(fid);
    if (!ph) continue;

    const ob = parent * 9;
    const ax = origPositions[ob], ay = origPositions[ob + 1], az = origPositions[ob + 2];
    const bx = origPositions[ob + 3], by = origPositions[ob + 4], bz = origPositions[ob + 5];
    const cx = origPositions[ob + 6], cy = origPositions[ob + 7], cz = origPositions[ob + 8];
    const v0x = bx - ax, v0y = by - ay, v0z = bz - az;
    const v1x = cx - ax, v1y = cy - ay, v1z = cz - az;
    const d00 = v0x*v0x + v0y*v0y + v0z*v0z;
    const d01 = v0x*v1x + v0y*v1y + v0z*v1z;
    const d11 = v1x*v1x + v1y*v1y + v1z*v1z;
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-18) continue; // degenerate parent triangle

    const ub = parent * 6;
    const u0 = origUV[ub], vv0 = origUV[ub + 1];
    const u1 = origUV[ub + 2], vv1 = origUV[ub + 3];
    const u2 = origUV[ub + 4], vv2 = origUV[ub + 5];
    if (!isFinite(u0) || !isFinite(vv0) || !isFinite(u1) || !isFinite(vv1) || !isFinite(u2) || !isFinite(vv2)) continue;

    const sb = st * 9, ob2 = st * 6;
    for (let c = 0; c < 3; c++) {
      const px = subPositions[sb + c*3] - ax, py = subPositions[sb + c*3+1] - ay, pz = subPositions[sb + c*3+2] - az;
      const d20 = px*v0x + py*v0y + pz*v0z;
      const d21 = px*v1x + py*v1y + pz*v1z;
      const beta  = (d11 * d20 - d01 * d21) / denom;
      const gamma = (d00 * d21 - d01 * d20) / denom;
      const alpha = 1 - beta - gamma;

      const u = alpha*u0 + beta*u1 + gamma*u2;
      const v = alpha*vv0 + beta*vv1 + gamma*vv2;
      out[ob2 + c*2]     = u / ph.tileU + ph.offsetU;
      out[ob2 + c*2 + 1] = v / ph.tileV + ph.offsetV;
    }
  }
  return out;
}
