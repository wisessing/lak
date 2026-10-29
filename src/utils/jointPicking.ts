import * as THREE from 'three';

/**
 * Resolve a ray to a joint identity.
 *
 * One resolver for every pointing device. The mouse and a finger produce a
 * ray from the camera through a screen point; a Quest controller produces one
 * from its grip. Both end up here, and both get back the same thing: the
 * asset-scoped ID of the joint they hit, or null.
 *
 * The answer is an identity, deliberately not an instance index. The markers
 * are an `InstancedMesh`, so a raycast reports `instanceId`, and it is
 * tempting to store that. But an index is only meaningful against one
 * particular marker mesh, and the selection has to outlive a clip edit and be
 * comparable with what the hierarchy selected. `parseSkeleton` stores the
 * identity list alongside the bone list for exactly this lookup.
 */

/** Screen-space pick tolerance, in CSS pixels. Markers are small; fingers are not. */
export const PICK_RADIUS_PX = 14;

/** What `parseSkeleton` leaves on the marker mesh. */
interface MarkerUserData {
  bones?: THREE.Bone[];
  jointIds?: string[];
}

export function markerMeshOf(markers: THREE.Object3D | null | undefined): THREE.InstancedMesh | null {
  const mesh = markers?.children[0] as THREE.InstancedMesh | undefined;
  return mesh?.isInstancedMesh ? mesh : null;
}

export function jointIdsOf(markers: THREE.Object3D | null | undefined): string[] {
  return (markerMeshOf(markers)?.userData as MarkerUserData | undefined)?.jointIds ?? [];
}

/** The marker index for an identity, or -1. */
export function jointIndexOf(markers: THREE.Object3D | null | undefined, id: string | null): number {
  if (!id) return -1;
  return jointIdsOf(markers).indexOf(id);
}

/**
 * Pick the joint a ray passes through.
 *
 * Nearest hit wins. The marker spheres are tiny, so `raycaster.params.Points`
 * style thresholds do not apply; the caller widens the effective target by
 * projecting a screen-space tolerance instead — see `pickJointAtScreenPoint`.
 */
export function pickJointAlongRay(
  raycaster: THREE.Raycaster,
  markers: THREE.Object3D | null | undefined
): string | null {
  const mesh = markerMeshOf(markers);
  if (!mesh) return null;
  const hits = raycaster.intersectObject(mesh, false);
  for (const hit of hits) {
    if (hit.instanceId === undefined) continue;
    const id = jointIdsOf(markers)[hit.instanceId];
    if (id) return id;
  }
  return null;
}

const _world = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _toJoint = new THREE.Vector3();

/**
 * Angular tolerance for a tap in AR, in radians: about a fingertip on a
 * handheld screen, or 14 cm on a subject two metres away.
 */
export const PICK_RAY_ANGLE = 0.07;

/**
 * Pick the joint nearest a ray, by angle, within `maxAngle`.
 *
 * The AR counterpart of `pickJointAtScreenPoint`. A screen tap in a session
 * arrives as a ray through the touched point, so the nearest joint to that ray
 * is the one under the finger. It reads the bones' live world positions rather
 * than the marker instances, because the markers are only kept current while
 * an overlay is drawn, and a tap has to work with the skeleton hidden too.
 */
export function pickJointNearRay(
  ray: THREE.Ray,
  markers: THREE.Object3D | null | undefined,
  maxAngle: number = PICK_RAY_ANGLE
): string | null {
  const bones = (markerMeshOf(markers)?.userData as MarkerUserData | undefined)?.bones;
  if (!bones?.length) return null;
  const ids = jointIdsOf(markers);

  let best: string | null = null;
  let bestAngle = maxAngle;
  bones.forEach((bone, i) => {
    bone.getWorldPosition(_world);
    _toJoint.subVectors(_world, ray.origin);
    const along = _toJoint.dot(ray.direction);
    // Behind the device: not a candidate.
    if (along <= 0) return;
    const off = Math.sqrt(Math.max(0, _toJoint.lengthSq() - along * along));
    const angle = Math.atan2(off, along);
    if (angle < bestAngle) {
      bestAngle = angle;
      best = ids[i] ?? null;
    }
  });
  return best;
}

/**
 * Pick the joint nearest a screen point, within `radiusPx`.
 *
 * Instead of relying on the sphere geometry being hit, which a finger cannot
 * do reliably on a 6 mm marker, project every marker to the screen and take
 * the closest one inside the tolerance. This is what makes touch selection
 * feel like it lands where you pointed rather than only where you were lucky.
 *
 * `x`/`y` are CSS pixels relative to the canvas; `width`/`height` are its CSS
 * size. Positions come from the bones' live world transforms, not the marker
 * instances: the markers are only kept current while an overlay is drawn, and
 * reading them made a tap select nothing whenever the skeleton was hidden.
 * Markers without bones (a bare marker mesh) fall back to the instances, which
 * carry authored coordinates and so take the mesh's `matrixWorld`.
 */
export function pickJointAtScreenPoint(
  camera: THREE.Camera,
  markers: THREE.Object3D | null | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  radiusPx: number = PICK_RADIUS_PX
): string | null {
  const mesh = markerMeshOf(markers);
  if (!mesh || width <= 0 || height <= 0) return null;
  const ids = jointIdsOf(markers);

  const bones = (mesh.userData as MarkerUserData).bones;

  mesh.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  let best: string | null = null;
  let bestDist = radiusPx * radiusPx;

  const count = bones?.length ?? mesh.count;
  for (let i = 0; i < count; i++) {
    if (bones) {
      bones[i].getWorldPosition(_world);
    } else {
      mesh.getMatrixAt(i, _matrix);
      // A zero-scale instance is a marker that has not been placed yet.
      if (_matrix.elements[0] === 0 && _matrix.elements[5] === 0) continue;
      _world.setFromMatrixPosition(_matrix).applyMatrix4(mesh.matrixWorld);
    }
    const projected = _world.project(camera);
    // Behind the camera: not a candidate.
    if (projected.z > 1) continue;
    const sx = ((projected.x + 1) / 2) * width;
    const sy = ((1 - projected.y) / 2) * height;
    const dx = sx - x;
    const dy = sy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = ids[i] ?? null;
    }
  }
  return best;
}
