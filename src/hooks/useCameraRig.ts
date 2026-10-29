import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CAMERA_PRESETS, GIZMO_AXES } from '../constants/cameraPresets';
import { getBonePosition } from '../utils/motionData';
import { useStore } from '../store';
import type { CameraViewControls } from '../types';

/**
 * The camera rig: OrbitControls, the animated transitions between views, and
 * the control surface the navigation gizmo drives.
 *
 * Extracted from Scene so the two things an XR session has to take over — the
 * camera and the frame loop — are isolated behind a small contract rather than
 * tangled through a 800-line component. In XR the camera stops being ours
 * (`renderer.xr.getCamera()` returns per-eye cameras) and OrbitControls has no
 * role, so this hook is the seam where that swap will happen.
 *
 * The transition step is a function rather than its own rAF loop: it has to run
 * in the same frame as the mixer update, after it, or the camera would chase a
 * pose one frame stale.
 */

/**
 * Keeps an orbit from landing exactly on a pole, where the view direction is
 * parallel to `camera.up`, `lookAt` has no stable answer and the image flips.
 * Same hazard CAMERA_PRESETS.top sidesteps with its 0.01 nudge.
 */
const POLE_EPSILON = 1e-3;
/**
 * Sideways nudge, as a fraction of the orbit distance, applied when snapping to
 * the top or bottom view for the same reason. Invisible at any usable zoom.
 */
const POLE_NUDGE = 1e-3;

/** Scratch, module-level so the per-frame path allocates nothing. */
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _step = new THREE.Quaternion();

/**
 * How fast a view transition converges, per second.
 *
 * Time-based, not per-frame. The old code moved 8% of the remaining distance
 * every frame, which silently made the transition speed a function of the
 * frame rate: identical on a 60 Hz desktop, four times slower on a device
 * rendering at 15, and effectively stuck under software rendering. A second,
 * decoupled loop used to hide that, because it ran at full rate no matter how
 * slow the renderer was. With one loop the coupling is real, so the rate has to
 * be expressed in seconds.
 *
 * 5.0 reproduces the old feel at 60 fps: 1 - exp(-5/60) is about 0.08.
 */
const TRANSITION_RATE = 5.0;

export interface CameraRig {
  /**
   * Advance any in-flight transition. Call once per frame, after the mixer.
   * `delta` is seconds since the previous frame.
   */
  update: (delta: number) => void;
  /** OrbitControls, for callers that need to damp or read the pivot. */
  controlsRef: React.RefObject<OrbitControls | null>;
  /**
   * Abandon any transition in flight, leaving the camera where it is. For a
   * caller that has just written a pose back and needs it to hold.
   */
  cancelTransition: () => void;
}

export function useCameraRig(
  camera: THREE.PerspectiveCamera | null,
  renderer: THREE.WebGLRenderer | null,
  model: THREE.Object3D | undefined,
  /** Canvas size, so framing can account for the viewport's actual shape. */
  viewportSize: { width: number; height: number },
  onCameraReady?: (controls: CameraViewControls) => void
): CameraRig {
  const controlsRef = useRef<OrbitControls | null>(null);
  // Read inside the framing callback, which must not be rebuilt on resize:
  // re-running that effect would dispose and recreate OrbitControls, throwing
  // away the user's current orbit every time the dock opened. Mirrored in an
  // effect rather than during render, which is not allowed and which the
  // dynamic import below used to hide from the analyzer.
  const viewportSizeRef = useRef(viewportSize);
  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  // Where a transition is heading. Null when the camera is at rest.
  const targetCamPosRef = useRef<THREE.Vector3 | null>(null);
  const targetOrbitRef = useRef<THREE.Vector3 | null>(null);
  /**
   * Set only by axis snaps, which hold their distance. Keeps the transition on
   * the orbit sphere instead of cutting across it — see `update` below.
   */
  const snapRadiusRef = useRef<number | null>(null);

  useEffect(() => {
    if (!camera || !renderer) return;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.8, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Zoom limits
    controls.minDistance = 0.5;
    controls.maxDistance = 20;

    controlsRef.current = controls;

    if (onCameraReady) {
      onCameraReady({
        // Statically imported. This used to be a dynamic `import()`, which
        // made the module boundary opaque to the React compiler and silently
        // suppressed every report in this file — including a genuine
        // ref-written-during-render error. It also produced an
        // INEFFECTIVE_DYNAMIC_IMPORT build warning, since the same module is
        // imported statically elsewhere, so it never split a chunk either.
        setPreset: (preset) => {
          const config = CAMERA_PRESETS[preset];
          if (config) {
            targetCamPosRef.current = config.position.clone();
            targetOrbitRef.current = config.target.clone();
            snapRadiusRef.current = null;
          }
        },
        readBasis: (right, up, back) => {
          if (!camera) return false;
          camera.updateMatrixWorld();
          camera.matrixWorld.extractBasis(right, up, back);
          return true;
        },
        orbitBy: (dAzimuth, dPolar) => {
          const orbit = controlsRef.current;
          if (!camera || !orbit) return;

          // A gizmo drag takes over from any preset transition still lerping,
          // otherwise the two fight for camera.position every frame.
          targetCamPosRef.current = null;
          targetOrbitRef.current = null;
          snapRadiusRef.current = null;

          const offset = camera.position.clone().sub(orbit.target);
          const spherical = new THREE.Spherical().setFromVector3(offset);

          // Signs match OrbitControls' own rotateLeft/rotateUp so dragging the
          // gizmo tumbles the view the same way dragging the viewport does.
          spherical.theta -= dAzimuth;
          spherical.phi = THREE.MathUtils.clamp(
            spherical.phi - dPolar,
            Math.max(orbit.minPolarAngle, POLE_EPSILON),
            Math.min(orbit.maxPolarAngle, Math.PI - POLE_EPSILON)
          );
          spherical.makeSafe();

          camera.position.copy(orbit.target).add(offset.setFromSpherical(spherical));
          camera.lookAt(orbit.target);
        },
        snapToAxis: (axis) => {
          const orbit = controlsRef.current;
          if (!camera || !orbit) return;

          const info = GIZMO_AXES[axis];
          // Keep the pivot and the current zoom, the way Blender's gizmo does —
          // snapping to a fixed preset distance would undo the user's framing.
          const distance = camera.position.distanceTo(orbit.target) || 3;
          const offset = info.direction.clone().multiplyScalar(distance);
          if (Math.abs(info.direction.y) > 0.99) {
            offset.z += distance * POLE_NUDGE;
          }

          // The pivot is copied, not changed, so the target lerp is a no-op and
          // a pan the user made before snapping survives.
          targetOrbitRef.current = orbit.target.clone();
          targetCamPosRef.current = orbit.target.clone().add(offset);
          snapRadiusRef.current = distance;
        },
        reset: () => {
          targetCamPosRef.current = new THREE.Vector3(0, 1, 3);
          targetOrbitRef.current = new THREE.Vector3(0, 0.8, 0);
          snapRadiusRef.current = null;
        },
        focusModel: () => {
          if (!model || !camera || !controlsRef.current) return;
          const orbit = controlsRef.current;

          const box = new THREE.Box3();
          model.updateMatrixWorld(true);

          const expand = (root: THREE.Object3D) => {
            root.traverse((child) => {
              if ((child as THREE.Bone).isBone) {
                const pos = new THREE.Vector3();
                child.getWorldPosition(pos);
                box.expandByPoint(pos);
              } else if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
                // A skinned mesh's geometry box is its bind pose, which for a
                // T-posed rig is the arm span whatever the clip does, so Focus
                // framed every clip the same and too wide. The posed box is
                // the skin as it stands on screen.
                const mesh = child as THREE.SkinnedMesh;
                mesh.computeBoundingBox();
                if (mesh.boundingBox) box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
              } else if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                const mesh = child as THREE.Mesh;
                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                if (mesh.geometry.boundingBox) {
                  const meshBox = mesh.geometry.boundingBox.clone();
                  meshBox.applyMatrix4(mesh.matrixWorld);
                  box.union(meshBox);
                }
              }
            });
          };

          expand(model);

          if (box.isEmpty()) {
            box.setFromObject(model);
          }

          /*
           * Include the whole clip, not just the pose on screen.
           *
           * Framing the current pose means a kick that extends a leg a metre
           * sideways leaves the frame the moment it plays, and the framing
           * changes depending on which frame happened to be showing when Focus
           * was pressed. The bake already holds every bone position for every
           * frame, so union those in and the result is stable and covers the
           * excursions. The current-pose box stays in the union because it is
           * the only thing that accounts for the skin around the bones.
           *
           * Baked positions are authored; the box is in world space, so they go
           * through the subject's presentation ancestor on the way in.
           */
          const motion = useStore.getState().motion;
          if (motion && motion.frameCount > 0) {
            const toWorld = model.parent?.matrixWorld;
            const point = new THREE.Vector3();
            for (let frame = 0; frame < motion.frameCount; frame++) {
              for (let bone = 0; bone < motion.boneCount; bone++) {
                getBonePosition(motion, frame, bone, point);
                if (toWorld) point.applyMatrix4(toWorld);
                box.expandByPoint(point);
              }
            }
          }

          const center = box.getCenter(new THREE.Vector3());

          /*
           * Frame against both viewport axes, not just the vertical one.
           *
           * `fov` is the *vertical* field of view, so distance derived from it
           * alone only guarantees the subject's height fits. On a portrait
           * tablet the horizontal field is much narrower — at 820x1180 it is
           * about 0.69 of the vertical — and a kick or an outstretched arm
           * leaves the frame. Taking the larger of the two required distances
           * fits whichever axis is actually the tight one.
           *
           * The horizontal extent uses the larger of x and z because the camera
           * orbits: whichever way it ends up facing, that is the width it may
           * have to fit.
           */
          const { width, height } = viewportSizeRef.current;
          const aspect =
            width > 0 && height > 0 ? width / height : (camera as THREE.PerspectiveCamera).aspect;

          // The direction the camera will look from. Framing depends on it, so
          // it has to be known before the distance is computed rather than
          // applied to a distance derived from axis-aligned dimensions.
          const direction = camera.position.clone().sub(orbit.target).normalize();
          if (direction.lengthSq() === 0) direction.set(0, 0, 1);

          /*
           * Fit the bounds as seen from that direction, including depth.
           *
           * Measuring the box's own x, y and z extents answers a different
           * question: how big the subject is along the world axes. What matters
           * is how big it is across the screen, which depends on where the
           * camera is. From the rear view of the old Mixamo kick fixture the two differ
           * enough to push a foot a third of a screen below the bottom edge.
           *
           * Depth matters for the same reason. A perspective camera sees a
           * smaller frustum closer in, so a limb thrown toward the camera needs
           * more distance than one the same size at the subject's centre. For a
           * camera at `centre + dir * d`, a corner at offset (x, y, z) in the
           * camera basis sits at depth `d - z`, and fits when
           * `|x| <= (d - z) * tanH` and `|y| <= (d - z) * tanV`. Solving each
           * corner for `d` and taking the largest is exact.
           */
          const up = new THREE.Vector3(0, 1, 0);
          // Near the poles the world up is parallel to the view and the cross
          // product collapses; any perpendicular axis will do there.
          if (Math.abs(direction.y) > 0.999) up.set(0, 0, 1);
          const right = new THREE.Vector3().crossVectors(up, direction).normalize();
          const camUp = new THREE.Vector3().crossVectors(direction, right).normalize();

          const fov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180);
          const tanV = Math.tan(fov / 2);
          const tanH = tanV * Math.max(aspect, 1e-3);

          const min = box.min;
          const max = box.max;
          const corner = new THREE.Vector3();
          let required = 0;
          for (let i = 0; i < 8; i++) {
            corner.set(
              i & 1 ? max.x : min.x,
              i & 2 ? max.y : min.y,
              i & 4 ? max.z : min.z
            );
            corner.sub(center);
            const x = Math.abs(corner.dot(right));
            const y = Math.abs(corner.dot(camUp));
            const z = corner.dot(direction);
            required = Math.max(required, x / tanH + z, y / tanV + z);
          }

          // 10% of breathing room on top of an exact fit.
          let cameraDistance = required * 1.1;
          if (!isFinite(cameraDistance) || cameraDistance <= 0) cameraDistance = 3;
          cameraDistance = Math.max(cameraDistance, orbit.minDistance + 1e-3);

          targetOrbitRef.current = center.clone();
          targetCamPosRef.current = center.clone().add(direction.multiplyScalar(cameraDistance));
          snapRadiusRef.current = null;
        }
      });
    }

    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, renderer, onCameraReady, model]);


  /**
   * Advance an in-flight transition. No-op when the camera is at rest.
   */
  const update = useCallback((delta: number) => {
      // Exponential convergence, frame-rate independent: a long frame covers
      // proportionally more ground rather than being left behind.
      const alpha = 1 - Math.exp(-TRANSITION_RATE * Math.max(delta, 0));
      if (camera && controlsRef.current && targetCamPosRef.current && targetOrbitRef.current) {
        const pivot = controlsRef.current.target;

        if (snapRadiusRef.current !== null) {
          // An axis snap holds its distance, so it turns along the orbit sphere
          // instead of lerping the raw position. Lerping positions would cut the
          // chord, and for an exactly opposite view that chord runs through the
          // pivot: rescaling it back to the held radius lands on the start
          // again, a fixed point where the transition never moves at all.
          pivot.lerp(targetOrbitRef.current, alpha);
          _from.copy(camera.position).sub(pivot).normalize();
          _to.copy(targetCamPosRef.current).sub(pivot).normalize();

          if (_from.angleTo(_to) < 1e-3) {
            camera.position.copy(targetCamPosRef.current);
            targetCamPosRef.current = null;
            targetOrbitRef.current = null;
            snapRadiusRef.current = null;
          } else {
            // At 180 degrees setFromUnitVectors picks a stable perpendicular
            // axis, so the swing has a defined direction rather than stalling.
            _turn.setFromUnitVectors(_from, _to);
            _step.identity().slerp(_turn, alpha);
            camera.position
              .copy(_from.applyQuaternion(_step).multiplyScalar(snapRadiusRef.current))
              .add(pivot);
          }
        } else {
          camera.position.lerp(targetCamPosRef.current, alpha);
          pivot.lerp(targetOrbitRef.current, alpha);

          // Stop lerping when close enough
          if (camera.position.distanceTo(targetCamPosRef.current) < 0.01 &&
              pivot.distanceTo(targetOrbitRef.current) < 0.01) {
            targetCamPosRef.current = null;
            targetOrbitRef.current = null;
          }
        }
      }

    // OrbitControls' own damping has to run every frame, transition or not.
    controlsRef.current?.update();
  }, [camera]);

  /**
   * Abandon any transition in flight, leaving the camera exactly where it is.
   *
   * A session that begins while the post-load framing is still converging
   * snapshots the camera mid-curve. Restoring that pose on exit and then
   * letting the old transition resume would lerp the camera forward from a
   * point it was never computed for, so the restored pose does not hold, and
   * every check that compares against it flickers with frame timing. The
   * session controller calls this after it writes the pose back.
   */
  const cancelTransition = useCallback(() => {
    targetCamPosRef.current = null;
    targetOrbitRef.current = null;
    snapRadiusRef.current = null;
  }, []);

  return { update, controlsRef, cancelTransition };
}
