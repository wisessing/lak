import * as THREE from 'three';

/**
 * Authored space versus presentation space.
 *
 * The viewer has to be able to put the subject somewhere convenient — on a
 * table in front of you in mixed reality, a step to the left, half size — and
 * none of that may reach the motion data or an export. A placement is a display
 * decision. The file on disk is a measurement.
 *
 * Two coordinate frames, then:
 *
 * - **Authored space** is the file's own frame, exactly as loaded. The bake, the
 *   CSV and JSON, the GLB and FBX, and every overlay buffer live here.
 * - **Presentation space** is authored space with the display placement applied
 *   once, by a single root node.
 *
 * Two failure modes make this worth stating explicitly, because both produce
 * plausible-looking pictures:
 *
 * 1. **Transforming twice.** The overlays hold *world* positions read off the
 *    bones. Parenting those buffers under a moved root applies the placement to
 *    coordinates that already include it, so the skeleton drifts away from the
 *    mesh at exactly twice the offset. Overlay buffers must therefore hold
 *    authored coordinates, and the root supplies the placement — see
 *    `worldToAuthored`.
 * 2. **Baking the placement in.** Sampling or exporting while the root is moved
 *    writes the placement into the data. That is the same class of bug as the
 *    old viewport centring that shipped a character buried to the hips in every
 *    GLB. Wrap those transactions in `withAuthoredSpace`.
 */

/** Display placement. Position in metres, yaw in radians, uniform scale. */
export interface PresentationState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export const IDENTITY_PRESENTATION: PresentationState = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  scale: 1,
};

/** Bounds for the uniform scale, so a stray input cannot lose the subject. */
export const MIN_PRESENTATION_SCALE = 0.1;
export const MAX_PRESENTATION_SCALE = 5;

export function clampPresentation(state: PresentationState): PresentationState {
  return {
    ...state,
    scale: THREE.MathUtils.clamp(state.scale, MIN_PRESENTATION_SCALE, MAX_PRESENTATION_SCALE),
  };
}

export function presentationEquals(a: PresentationState, b: PresentationState): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.scale === b.scale;
}

/** True when this placement has no visible effect. */
export function isIdentityPresentation(state: PresentationState): boolean {
  return presentationEquals(state, IDENTITY_PRESENTATION);
}

/**
 * The single node the placement is applied to.
 *
 * The subject and every overlay that belongs to it are its children, so the
 * transform is applied exactly once no matter how many overlays exist.
 */
export function createPresentationRoot(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'PresentationRoot';
  return root;
}

/** Write a placement onto the root. Yaw only: pitch and roll would tip the floor. */
export function applyPresentation(root: THREE.Object3D, state: PresentationState): void {
  const clamped = clampPresentation(state);
  root.position.set(clamped.x, clamped.y, clamped.z);
  root.rotation.set(0, clamped.yaw, 0);
  root.scale.setScalar(clamped.scale);
  root.updateMatrixWorld(true);
}

/**
 * Show or hide the subject and everything hanging under it.
 *
 * A module function rather than an assignment in a component, for the reason
 * recorded against `overlayScene.ts`: a component that writes to an object it
 * was handed is mutating something it borrowed, and the React compiler is right
 * to reject it. Ownership of the mutation belongs with the module that owns the
 * node.
 */
export function setPresentationVisible(root: THREE.Object3D, visible: boolean): void {
  root.visible = visible;
}

const _inverse = new THREE.Matrix4();

/**
 * Convert a world-space point to authored space.
 *
 * For the per-frame overlay readers: a bone's world position includes the
 * presentation transform, and the buffer it is written into is a child of the
 * presentation root, so the transform has to come back out before it goes in.
 * With an identity placement this is exactly the identity, which is why the
 * ordinary desktop path is unaffected.
 */
export function worldToAuthored(root: THREE.Object3D | null, point: THREE.Vector3): THREE.Vector3 {
  if (!root) return point;
  _inverse.copy(root.matrixWorld).invert();
  return point.applyMatrix4(_inverse);
}

/**
 * Fill `target` with the matrix that takes world-space points into authored
 * space, and return it.
 *
 * Writes into a caller-owned matrix rather than returning a new one: this runs
 * once per frame in the overlay path, and that path is required to allocate
 * nothing.
 */
export function authoredMatrixInto(
  root: THREE.Object3D | null,
  target: THREE.Matrix4
): THREE.Matrix4 {
  if (!root) return target.identity();
  return target.copy(root.matrixWorld).invert();
}

/**
 * Run `fn` with the placement temporarily removed, then restore it.
 *
 * For baking and exporting: both read the scene graph, and both must see the
 * file's own coordinates. The restore is in a `finally`, so a throwing bake
 * cannot strand the subject at the origin.
 *
 * Nothing renders between the neutralize and the restore — this is called
 * synchronously inside an effect or a frame callback — so there is no visible
 * flicker, and the playback state is untouched.
 */
export function withAuthoredSpace<T>(root: THREE.Object3D | null, fn: () => T): T {
  if (!root) return fn();

  const position = root.position.clone();
  const quaternion = root.quaternion.clone();
  const scale = root.scale.clone();

  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.setScalar(1);
  root.updateMatrixWorld(true);

  try {
    return fn();
  } finally {
    root.position.copy(position);
    root.quaternion.copy(quaternion);
    root.scale.copy(scale);
    root.updateMatrixWorld(true);
  }
}
