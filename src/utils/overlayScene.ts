import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ThreeHelpers } from './threeSetup';

/**
 * The motion overlays as scene-graph objects: ghost poses, per-joint trails,
 * and the visibility rules that apply to them.
 *
 * This lives outside the React tree on purpose. Building and showing these is
 * mutation of long-lived three.js nodes, which is exactly what a renderer is
 * supposed to do and exactly what a component is not: a component that writes
 * to an object it was handed is modifying something it borrowed, and the React
 * compiler is right to reject it. Scene calls in here instead, so ownership of
 * the mutation sits with the module that owns the objects.
 *
 * Coordinates: every buffer here holds *authored* positions and every node is
 * parented under the presentation root, so display placement is applied once by
 * that root. See `presentationSpace.ts`.
 */

/** Overlay history length, in baked frames. */
export const TRAIL_FRAMES = 30;
/** Number of ghost poses drawn behind the playhead. */
export const GHOST_COUNT = 5;
/** Frames between consecutive ghosts. */
export const GHOST_SPACING = 5;

/**
 * The bone list `parseSkeleton` stashes on the joint-marker InstancedMesh.
 * Reading it through one helper keeps the shape assumption in a single place.
 */
export function bonesOf(markers?: THREE.Group): THREE.Bone[] | undefined {
  const mesh = markers?.children[0] as THREE.InstancedMesh | undefined;
  return mesh?.userData?.bones as THREE.Bone[] | undefined;
}

export interface OverlayVisibility {
  showSkeleton: boolean;
  showOnionSkin: boolean;
  showMotionTrail: boolean;
  /**
   * Whether a joint is selected. With one, the ghosts narrow to that joint's
   * own past positions, as the trails narrow to its path: the full-body ghosts
   * are hidden and only the joint's ghost highlights remain.
   */
  focused?: boolean;
}

/**
 * Selection highlight colour. Amber, chosen against the cyan markers and
 * ghosts and the magenta trails so the selected joint is the one warm thing in
 * the picture, in both the dark and the grey theme.
 */
export const HIGHLIGHT_COLOR = 0xffb020;
/** Trail colour when no joint is selected, or for the unselected majority. */
export const TRAIL_COLOR = 0xff00e5;

/**
 * Width of the selected joint's trail, in CSS pixels. The thin trails are
 * WebGL lines, which most GPUs draw one pixel wide whatever is asked for; over
 * a camera image in AR that is all but invisible, so the trail that matters is
 * drawn as a fat line, wider still when it competes with the room.
 */
export const FOCUS_TRAIL_WIDTH = 4;
export const FOCUS_TRAIL_WIDTH_XR = 7;

export interface Overlays {
  ghosts: LineSegments2[];
  trailGroup: THREE.Group;
  trailLines: THREE.Line[];
  /** The selected joint's trail as a fat line, fading toward its tail. */
  focusTrail: LineSegments2;
  /** The selected joint, drawn over its marker. Hidden when nothing is selected. */
  highlight: THREE.Mesh;
  /** The selected joint at each ghost pose, so its context reads as one path. */
  ghostHighlights: THREE.InstancedMesh;
  /** Detach everything and release every geometry and material it created. */
  dispose: () => void;
}

/**
 * Attach the skeleton, markers and overlays to `parent`, and build the ghost
 * and trail objects sized to this rig.
 */
export function buildOverlays({
  parent,
  skeletonLines,
  jointMarkers,
  boneCount,
}: {
  parent: THREE.Object3D;
  skeletonLines: THREE.Object3D;
  jointMarkers: THREE.Group;
  boneCount: number;
}): Overlays {
  parent.add(skeletonLines);
  jointMarkers.renderOrder = 999;
  parent.add(jointMarkers);

  // Built hidden and unsized. The caller applies visibility and line resolution
  // immediately afterwards from the live values, which keeps this function free
  // of inputs that change far more often than the objects it creates: a resize
  // must never rebuild a GPU buffer.
  skeletonLines.visible = false;
  jointMarkers.visible = false;

  const geometry = (skeletonLines as LineSegments2).geometry as LineSegmentsGeometry;
  // instanceStart is interleaved: start and end are two views on one buffer.
  const startAttr = geometry.attributes.instanceStart as
    | THREE.InterleavedBufferAttribute
    | undefined;
  const bufferLength = startAttr ? startAttr.data.array.length : 0;

  /** Empty fat-line overlay matching the skeleton's segment count. */
  const makeGhost = (color: number, opacity: number, order: number) => {
    const geo = new LineSegmentsGeometry();
    if (bufferLength) geo.setPositions(new Float32Array(bufferLength));
    const mat = new LineMaterial({
      color,
      linewidth: 2,
      transparent: true,
      opacity,
      depthTest: false,
      worldUnits: false,
    });
    const mesh = new LineSegments2(geo, mat);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.visible = false;
    parent.add(mesh);
    return mesh;
  };

  const ghosts: LineSegments2[] = [];
  for (let i = 0; i < GHOST_COUNT; i++) {
    ghosts.push(makeGhost(0x00e5ff, 0.15 - i * 0.02, 998 - i));
  }

  const trailGroup = new THREE.Group();
  trailGroup.renderOrder = 998;
  const trailLines: THREE.Line[] = [];

  for (let i = 0; i < boneCount; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(TRAIL_FRAMES * 3), 3)
    );
    geo.setAttribute(
      'transparency',
      new THREE.BufferAttribute(new Float32Array(TRAIL_FRAMES), 1)
    );
    geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(TRAIL_COLOR) } },
      vertexShader: `
        attribute float transparency;
        varying float vAlpha;
        void main() {
          vAlpha = transparency;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(color, vAlpha * 0.8);
        }
      `,
      transparent: true,
      depthTest: false,
    });

    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    trailGroup.add(line);
    trailLines.push(line);
  }

  // The focused trail: one fat line for the selected joint, drawn over its thin
  // counterpart. LineMaterial has no per-vertex alpha, so a fade value rides on
  // each segment end and scales the fragment's alpha.
  const segments = TRAIL_FRAMES - 1;
  const focusGeo = new LineSegmentsGeometry();
  focusGeo.setPositions(new Float32Array(segments * 6));
  const fade = new THREE.InstancedInterleavedBuffer(new Float32Array(segments * 2), 2, 1);
  focusGeo.setAttribute('instanceFadeStart', new THREE.InterleavedBufferAttribute(fade, 1, 0));
  focusGeo.setAttribute('instanceFadeEnd', new THREE.InterleavedBufferAttribute(fade, 1, 1));
  focusGeo.instanceCount = 0;
  const focusMat = new LineMaterial({
    color: HIGHLIGHT_COLOR,
    linewidth: FOCUS_TRAIL_WIDTH,
    transparent: true,
    depthTest: false,
    worldUnits: false,
  });
  focusMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      [
        'attribute float instanceFadeStart;',
        'attribute float instanceFadeEnd;',
        'varying float vFade;',
        'void main() {',
        '  vFade = ( position.y < 0.5 ) ? instanceFadeStart : instanceFadeEnd;',
      ].join('\n')
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vFade;\nvoid main() {')
      .replace(
        'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        'gl_FragColor = vec4( diffuseColor.rgb, alpha * vFade );'
      );
  };
  focusMat.customProgramCacheKey = () => 'lak-focus-trail';
  const focusTrail = new LineSegments2(focusGeo, focusMat);
  focusTrail.renderOrder = 999;
  focusTrail.frustumCulled = false;
  focusTrail.visible = false;
  trailGroup.add(focusTrail);

  trailGroup.visible = false;
  parent.add(trailGroup);

  // The selection highlight: a larger sphere at the selected marker, and a
  // smaller one at that joint's position in each ghost pose. Sized from the
  // marker geometry so it scales with the rig the same way the markers do.
  //
  // The multipliers are large on purpose. A marker is about 6 mm on a human
  // rig, roughly one pixel at a normal viewing distance; a highlight at twice
  // that passed its "is visible" assertion and could not be found in a single
  // screenshot. Five times gives a 3 cm sphere, which reads as a marker at
  // arm's length and still sits inside the joint it names.
  const markerGeometry = (jointMarkers.children[0] as THREE.InstancedMesh | undefined)
    ?.geometry as THREE.SphereGeometry | undefined;
  const markerRadius = markerGeometry?.parameters?.radius ?? 0.006;
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const highlight = new THREE.Mesh(
    new THREE.SphereGeometry(markerRadius * 5, 14, 14),
    highlightMaterial
  );
  highlight.renderOrder = 1000;
  highlight.frustumCulled = false;
  highlight.visible = false;
  parent.add(highlight);

  const ghostHighlightMaterial = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    depthTest: false,
    transparent: true,
    opacity: 0.45,
  });
  const ghostHighlights = new THREE.InstancedMesh(
    new THREE.SphereGeometry(markerRadius * 3, 10, 10),
    ghostHighlightMaterial,
    GHOST_COUNT
  );
  ghostHighlights.renderOrder = 999;
  ghostHighlights.frustumCulled = false;
  ghostHighlights.visible = false;
  parent.add(ghostHighlights);

  return {
    ghosts,
    trailGroup,
    trailLines,
    focusTrail,
    highlight,
    ghostHighlights,
    dispose: () => {
      parent.remove(skeletonLines);
      parent.remove(jointMarkers);
      parent.remove(highlight);
      highlight.geometry.dispose();
      highlightMaterial.dispose();
      parent.remove(ghostHighlights);
      ghostHighlights.geometry.dispose();
      ghostHighlightMaterial.dispose();
      // An InstancedMesh owns one more GPU buffer than its geometry and
      // material account for: `instanceMatrix`. Only `InstancedMesh.dispose`
      // releases it, and nothing in `renderer.info.memory` counts it, so the
      // leak is invisible to a geometry-and-texture tally.
      ghostHighlights.dispose();
      for (const ghost of ghosts) {
        parent.remove(ghost);
        ghost.geometry.dispose();
        (ghost.material as LineMaterial).dispose();
      }
      // A geometry and a shader material per bone. Removing the group alone
      // leaked both on every reload, which is the kind of growth the repeat-load
      // resource check is meant to catch.
      for (const line of trailLines) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      focusGeo.dispose();
      focusMat.dispose();
      parent.remove(trailGroup);
    },
  };
}

/** Show or hide the overlays. */
export function applyOverlayVisibility(
  objects: {
    skeletonLines?: THREE.Object3D;
    jointMarkers?: THREE.Object3D;
    ghosts: LineSegments2[];
    trailGroup: THREE.Group | null;
  },
  visibility: OverlayVisibility
): void {
  if (objects.skeletonLines) objects.skeletonLines.visible = visibility.showSkeleton;
  if (objects.jointMarkers) objects.jointMarkers.visible = visibility.showSkeleton;
  for (const ghost of objects.ghosts) {
    ghost.visible = visibility.showOnionSkin && !visibility.focused;
  }
  if (objects.trailGroup) objects.trailGroup.visible = visibility.showMotionTrail;
}

/**
 * Ghost-context highlights only make sense alongside the ghosts themselves.
 * Called after both visibility and selection have been applied.
 */
export function applyGhostHighlightVisibility(
  overlays: Overlays | null,
  showOnionSkin: boolean,
  selectedIndex: number
): void {
  if (!overlays) return;
  overlays.ghostHighlights.visible = showOnionSkin && selectedIndex >= 0;
  for (const ghost of overlays.ghosts) ghost.visible = showOnionSkin && selectedIndex < 0;
}

/**
 * Focus the trails on one joint, or restore all of them.
 *
 * With a selection, every other trail is hidden rather than dimmed: the review
 * finding was that all-joint trails obscure the body, and a dimmed forest is
 * still a forest. The full-body ghost poses narrow the same way (see
 * `applyGhostHighlightVisibility`), so a selection shows one joint's past and
 * path while the live body remains as context. `selectedIndex` of -1 means no
 * selection, which is the unchanged v1 behaviour.
 */
export function applySelectionFocus(overlays: Overlays | null, selectedIndex: number): void {
  if (!overlays) return;
  const focused = selectedIndex >= 0;
  overlays.trailLines.forEach((line, i) => {
    const isSelected = i === selectedIndex;
    line.visible = !focused || isSelected;
    // The focused trail takes the highlight colour, so the joint and its path
    // read as one thing rather than an amber dot beside a magenta line.
    const material = line.material as THREE.ShaderMaterial;
    material.uniforms.color.value.setHex(isSelected ? HIGHLIGHT_COLOR : TRAIL_COLOR);
  });
  overlays.focusTrail.visible = focused;
  overlays.highlight.visible = focused;
  overlays.ghostHighlights.visible = focused;
}

/**
 * Write the selected joint's last `TRAIL_FRAMES` baked positions into the fat
 * trail, in place. `setPositions` would allocate a new GPU buffer every frame,
 * which is how the ghosts once leaked; the existing buffer is filled instead.
 */
export function updateFocusTrail(
  trail: LineSegments2,
  history: readonly { x: number; y: number; z: number }[],
  currentFrame: number,
  linewidth: number
): void {
  const n = Math.min(TRAIL_FRAMES, history.length);
  const geo = trail.geometry;
  const start = geo.attributes.instanceStart as THREE.InterleavedBufferAttribute;
  const fadeAttr = geo.attributes.instanceFadeStart as THREE.InterleavedBufferAttribute;
  const pos = start.data.array as Float32Array;
  const fade = fadeAttr.data.array as Float32Array;
  const at = (j: number) => {
    let frame = currentFrame - n + j + 1;
    if (frame < 0) frame += history.length;
    return history[Math.max(0, Math.min(frame, history.length - 1))];
  };
  for (let j = 0; j < n - 1; j++) {
    const a = at(j);
    const b = at(j + 1);
    const o = j * 6;
    pos[o] = a.x;
    pos[o + 1] = a.y;
    pos[o + 2] = a.z;
    pos[o + 3] = b.x;
    pos[o + 4] = b.y;
    pos[o + 5] = b.z;
    // Gentler than the thin trails' fade: the head is solid, the tail still visible.
    fade[j * 2] = 0.15 + 0.85 * (j / (n - 1));
    fade[j * 2 + 1] = 0.15 + 0.85 * ((j + 1) / (n - 1));
  }
  start.data.needsUpdate = true;
  fadeAttr.data.needsUpdate = true;
  geo.instanceCount = Math.max(0, n - 1);
  (trail.material as LineMaterial).linewidth = linewidth;
}

/** Show or hide the ground plane, grid and axes together. */
export function applyHelperVisibility(helpers: ThreeHelpers, visible: boolean): void {
  helpers.grid.visible = visible;
  helpers.axes.visible = visible;
  helpers.shadowPlane.visible = visible;
}

/** Show or hide the skin, leaving bones alone. */
export function applyMeshVisibility(model: THREE.Object3D, visible: boolean): void {
  model.traverse((child) => {
    const asMesh = child as THREE.Mesh;
    if (asMesh.isMesh && !(child as THREE.Bone).isBone) {
      asMesh.visible = visible;
    }
  });
}

/**
 * Match every fat-line material's resolution to the canvas.
 *
 * `LineMaterial` converts its pixel line width with this, and each ghost
 * carries its own material, so a dock collapse has to reach all of them.
 */
export function applyLineResolution(
  meshes: (THREE.Object3D | undefined)[],
  size: { width: number; height: number }
): void {
  if (size.width === 0 || size.height === 0) return;
  for (const mesh of meshes) {
    const mat = (mesh as LineSegments2 | undefined)?.material as LineMaterial | undefined;
    if (mat?.resolution) mat.resolution.set(size.width, size.height);
  }
}
