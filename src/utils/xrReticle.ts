import * as THREE from 'three';

/**
 * The ring that shows where the subject would stand.
 *
 * It lives in the session's own space, not under the presentation root: it
 * describes a place in the room, and parenting it to the thing being placed
 * would move it with what it is meant to be positioning.
 *
 * Built once per session and reused every frame. Nothing here allocates in the
 * frame path, which runs at device rate.
 */

/** Outer radius in metres. Big enough to read at arm's length, small enough to aim. */
const OUTER = 0.13;
const INNER = 0.1;

export interface Reticle {
  object: THREE.Object3D;
  /** Move it onto a surface pose. */
  place(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createReticle(): Reticle {
  // Drawn flat on the surface: a ring in the XY plane, laid down by the -90
  // degree X rotation that the hit pose's own orientation then replaces.
  const geometry = new THREE.RingGeometry(INNER, OUTER, 40);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffb020,
    transparent: true,
    opacity: 0.9,
    // Over the camera image rather than fighting it for depth: there is no
    // depth buffer describing the real room unless depth sensing is on, and it
    // is deliberately not required.
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1001;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.name = 'XRPlacementReticle';

  return {
    object: mesh,
    place(position, quaternion) {
      mesh.position.copy(position);
      mesh.quaternion.copy(quaternion);
      mesh.updateMatrixWorld(true);
    },
    setVisible(visible) {
      mesh.visible = visible;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
