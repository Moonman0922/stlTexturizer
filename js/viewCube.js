/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// viewCube.js — the 26-region navigation cube (Fusion 360 / SolidWorks
// style): click a face for an orthogonal view, an edge for a 45° view, a
// corner for an isometric-style view. Pure geometry/labeling/math lives
// here; js/viewer.js owns rendering it as a screen-space corner overlay
// (via renderer.setViewport/setScissor on the existing canvas — no second
// WebGL context) and animating the camera when a region is clicked.
//
// All 26 regions are built the same way: for a direction like (1,0,0) (a
// face), (1,1,0) (an edge) or (1,1,1) (a corner), each nonzero axis occupies
// the thin OUTER shell of the cube on that side, and each zero axis spans
// the full INNER width — so one loop generates faces, edges, and corners
// from the same box-bounds formula, no special-casing per region type.

import * as THREE from 'three';

const HALF   = 0.5;   // cube half-extent, in the gizmo's own local units
const INSET  = 0.32;  // where the "outer shell" begins — bigger gap = fatter edge/corner regions

/** The 6 principal directions this app's Z-up axes resolve to (X=red, Y=green, Z=blue —
 * see buildAxesIndicator in viewer.js). The default starting camera
 * (orthoCamera.position.set(120,-200,100) in initViewer) looks toward the
 * origin from +X/-Y/+Z, so FRONT is defined as the -Y direction — what
 * greets you by default. Exact label semantics matter less than every
 * click landing somewhere consistent; this is a reasonable, common CAD
 * convention, not the only valid one.
 */
export const FACE_LABELS = {
  '0,-1,0': 'FRONT',
  '0,1,0':  'BACK',
  '1,0,0':  'RIGHT',
  '-1,0,0': 'LEFT',
  '0,0,1':  'TOP',
  '0,0,-1': 'BOTTOM',
};

function boundsForDir(dx, dy, dz) {
  const axis = (d) => d === 0 ? [-INSET, INSET] : d > 0 ? [INSET, HALF] : [-HALF, -INSET];
  const [x0, x1] = axis(dx), [y0, y1] = axis(dy), [z0, z1] = axis(dz);
  return { x0, x1, y0, y1, z0, z1 };
}

/**
 * Build the 26 clickable regions (as one merged-look but individually
 * raycastable group of small boxes) plus canvas-texture labels on the 6
 * face plates. Returns { group, regions } — regions is a flat array of
 * { mesh, dir: THREE.Vector3 (unit), kind: 'face'|'edge'|'corner', label? }
 * for hit-testing and hover/home comparisons.
 *
 * @param {{ faceColor: number, edgeColor: number, cornerColor: number,
 *           hoverColor: number, textColor: string, strokeColor: number }} palette
 *   theme-derived colors (see viewer.js's setViewerTheme) — kept out of
 *   this module's own defaults so it never silently drifts from the app's
 *   light/dark palette.
 */
export function buildViewCubeGroup(palette) {
  const group = new THREE.Group();
  const regions = [];

  const faceMat   = new THREE.MeshBasicMaterial({ color: palette.faceColor });
  const edgeMat   = new THREE.MeshBasicMaterial({ color: palette.edgeColor });
  const cornerMat = new THREE.MeshBasicMaterial({ color: palette.cornerColor });

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const nonZero = (dx !== 0) + (dy !== 0) + (dz !== 0);
        if (nonZero === 0) continue; // the cube's interior — not a region

        const { x0, x1, y0, y1, z0, z1 } = boundsForDir(dx, dy, dz);
        const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
        const geo = new THREE.BoxGeometry(sx, sy, sz);
        const kind = nonZero === 1 ? 'face' : nonZero === 2 ? 'edge' : 'corner';
        const baseMat = kind === 'face' ? faceMat : kind === 'edge' ? edgeMat : cornerMat;

        const dir = new THREE.Vector3(dx, dy, dz).normalize();
        let mesh;
        if (kind === 'face') {
          // Face plates get their own material (for the text label texture)
          // — six unique materials, not shared, so labeling one doesn't
          // paint text onto its neighbors.
          const label = FACE_LABELS[[dx, dy, dz].join(',')];
          mesh = new THREE.Mesh(geo, buildFaceMaterial(label, palette));
        } else {
          mesh = new THREE.Mesh(geo, baseMat);
        }
        mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        mesh.userData.viewDir = dir;
        mesh.userData.kind = kind;
        group.add(mesh);
        regions.push({ mesh, dir, kind });
      }
    }
  }

  // Thin edge lines tracing the cube's silhouette — purely cosmetic, makes
  // the 26 separate boxes read as one solid cube instead of a loose cluster.
  // raycast is a no-op: Raycaster's default line-picking threshold is huge
  // relative to this gizmo's ~1-unit size, so without this the wireframe
  // swallows clicks meant for the region boxes underneath it.
  const wire = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2)),
    new THREE.LineBasicMaterial({ color: palette.strokeColor, transparent: true, opacity: 0.5 }),
  );
  wire.raycast = () => {};
  group.add(wire);

  return { group, regions };
}

/** Six-sided label texture, reusing the same canvas-text-sprite technique
 * viewer.js's axis indicator already uses, so the gizmo's type style matches. */
function buildFaceMaterial(label, palette) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = palette.faceCss;
  ctx.fillRect(0, 0, 128, 128);
  if (label) {
    ctx.fillStyle = palette.textCss;
    ctx.font = 'bold 22px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex });
}

/**
 * The "up" vector to use when looking along -dir (dir is the direction FROM
 * the orbit target TO the camera). World Z can't be a screen-space "up"
 * when the view direction IS ±Z (top/bottom), so those two poles borrow
 * world Y instead — sign-flipped between them so bottom isn't a mirrored
 * top. Every other direction just uses world Z, matching this app's Z-up
 * convention everywhere else (OrbitControls, the default camera, etc).
 */
export function viewUpFor(dir) {
  if (Math.abs(dir.z) > 0.999) {
    return new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0);
  }
  return new THREE.Vector3(0, 0, 1);
}

/** Nearest of the 26 directions to the camera's current viewing direction,
 * or null if not close to any (used to decide whether the cube should show
 * an "at a snapped view" state). `dot` closer to 1 = better match. */
export function nearestRegionDir(regions, viewDirFromTarget) {
  let best = null, bestDot = -Infinity;
  for (const r of regions) {
    const d = r.dir.dot(viewDirFromTarget);
    if (d > bestDot) { bestDot = d; best = r; }
  }
  return { region: best, dot: bestDot };
}
