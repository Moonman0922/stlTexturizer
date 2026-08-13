/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// comparisonViewport.js — the split-view "AB test" pane for CAD-face
// selection (see js/stepFaceSelection.js). Renders the SAME scene and
// camera object as the main viewer (js/viewer.js) into a second canvas, so
// orbiting/panning/zooming the primary view moves both panes together for
// free — there's only one camera, just two renderers pointed at it. The one
// thing this pane shows that the primary view doesn't is the CAD-face
// boundary line overlay; viewer.js owns making that overlay visible only
// during this pane's render pass (see setSecondaryRenderer in viewer.js).
//
// The renderer/WebGL context is created once and kept alive for the rest of
// the session — toggling "Compare" on/off just registers/unregisters the
// render callback and shows/hides the canvas, so flipping the toggle
// repeatedly doesn't repeatedly spend a WebGL context.

import * as THREE from 'three';
import { setSecondaryRenderer, setStepBoundaryResolution, requestRender } from './viewer.js';

let renderer = null;
let canvasEl = null;
let resizeObserver = null;

function _resize() {
  if (!renderer || !canvasEl) return;
  const el = canvasEl.parentElement;
  const w = el.clientWidth, h = el.clientHeight;
  if (w === 0 || h === 0) return; // pane is hidden — nothing to size against yet
  renderer.setSize(w, h, false);
  setStepBoundaryResolution(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  requestRender();
}

/** Create the second renderer bound to `canvas`. Call once at app startup. */
export function initComparisonViewport(canvas) {
  canvasEl = canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  resizeObserver = new ResizeObserver(_resize);
  resizeObserver.observe(canvas.parentElement);
}

/**
 * Turn the compare pane's rendering on/off. The caller is responsible for
 * showing/hiding the pane's own CSS (canvas.clientWidth is 0 while hidden,
 * so this re-measures on the next frame once the layout has settled).
 */
export function setComparisonActive(active) {
  setSecondaryRenderer(active ? (scene, camera) => renderer.render(scene, camera) : null);
  if (active) requestAnimationFrame(_resize);
}
