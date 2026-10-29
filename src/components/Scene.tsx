import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import {
  FOCUS_TRAIL_WIDTH,
  FOCUS_TRAIL_WIDTH_XR,
  GHOST_COUNT,
  GHOST_SPACING,
  TRAIL_FRAMES,
  applyGhostHighlightVisibility,
  applyHelperVisibility,
  applyLineResolution,
  applyMeshVisibility,
  applyOverlayVisibility,
  applySelectionFocus,
  bonesOf,
  buildOverlays,
  updateFocusTrail,
  type Overlays,
} from '../utils/overlayScene';
import { jointIndexOf } from '../utils/jointPicking';
import { useJointPicking } from '../hooks/useJointPicking';
import { useXRSession } from '../hooks/useXRSession';
import { useThreeScene } from '../hooks/useThreeScene';
import { useCameraRig } from '../hooks/useCameraRig';
import { useAnimationPlayback } from '../hooks/useAnimationPlayback';
import { updateSkeletonLines } from '../utils/skeletonParser';
import {
  applyPresentation,
  authoredMatrixInto,
  createPresentationRoot,
  setPresentationVisible,
} from '../utils/presentationSpace';
import { publishDevScene } from '../utils/devHooks';
import { useStore } from '../store';
import type { SceneProps } from '../types';
import './Scene.css';

/**
 * The 3D view.
 *
 * Two things here are load-bearing.
 *
 * **There is one frame loop, and this component does not own it.** It registers
 * a callback with `useThreeScene`, which runs playback, overlays and camera in
 * that fixed order and then renders, once. Previously this component ran a
 * second `requestAnimationFrame` beside the renderer's own, with nothing
 * ordering the two.
 *
 * **The subject hangs under a presentation root.** Display placement is applied
 * there, once, to the model and every overlay together. The overlay buffers hold
 * *authored* coordinates, so anything read out of the live scene graph has to
 * have that placement removed again before it is written — see
 * `presentationSpace.ts`, which explains why both halves of that are necessary.
 *
 * The three.js objects are read from the store rather than taken as props. They
 * are mutable scene graph nodes and this component mutates them; owning that
 * read is what makes the mutation legitimate instead of a prop being written
 * through.
 */

/** Scratch, module level so the per-frame path allocates nothing. */
const _toAuthored = new THREE.Matrix4();
const _worldPos = new THREE.Vector3();
const _markerMatrix = new THREE.Matrix4();

export function Scene({
  animationClip,
  showSkeleton = false,
  showMesh = true,
  showGrid = true,
  showOnionSkin = false,
  showMotionTrail = false,
  onLoad,
  onControlsReady,
  onCameraReady,
  onFpsUpdate,
  onMotionData,
  playbackRange = null,
  xrOverlayRef,
  onXRReady,
}: SceneProps) {
  const {
    canvasRef,
    scene,
    camera,
    renderer,
    helpers,
    fps,
    viewportSize,
    setFrameCallback,
    resetFrameTiming,
    remeasureViewport,
  } = useThreeScene();

  // The scene graph objects this component mutates, owned here rather than
  // drilled through props.
  const model = useStore((s) => s.model) ?? undefined;
  const skeletonLines = useStore((s) => s.skeletonLines) ?? undefined;
  const bonePairs = useStore((s) => s.bonePairs) ?? undefined;
  const jointMarkers = useStore((s) => s.jointMarkers) ?? undefined;
  const presentation = useStore((s) => s.presentation);
  const selectedJointId = useStore((s) => s.selectedJointId);
  // Resolved once per render, not per frame: the frame loop only needs the
  // index, and the identity list does not change while an asset is loaded.
  const selectedIndex = jointIndexOf(jointMarkers, selectedJointId);

  /**
   * Created by a state initializer rather than in an effect: the playback hook
   * below parents the model to it, and hook effects run in call order, so an
   * effect declared here would be too late for the first load. A lazy
   * initializer runs exactly once and is safe to read during render, which a
   * ref written during render is not.
   */
  const [presentationRoot] = useState(createPresentationRoot);

  useEffect(() => {
    if (!scene) return;
    scene.add(presentationRoot);
    return () => {
      scene.remove(presentationRoot);
    };
  }, [scene, presentationRoot]);

  // Measurement seam, development builds only.
  useEffect(() => {
    if (!scene || !camera || !renderer) return;
    publishDevScene({ scene, camera, renderer, presentationRoot });
    return () => publishDevScene(null);
  }, [scene, camera, renderer, presentationRoot]);

  // Display placement. Applied to exactly one node.
  useEffect(() => {
    applyPresentation(presentationRoot, presentation);
  }, [presentationRoot, presentation]);

  // OrbitControls, the view transitions, and the gizmo's control surface.
  const cameraRig = useCameraRig(camera, renderer, model, viewportSize, onCameraReady);

  /*
   * The immersive session.
   *
   * It lives here because this is where the renderer, the camera and the orbit
   * controls are. The overlay element it hands to the runtime is owned by App,
   * because a `dom-overlay` root has to exist before the session is requested
   * and must outlive any one session.
   */
  // A stable stand-in for the shell's overlay ref, so the hook's dependency
  // does not change identity when the prop is absent.
  const emptyOverlayRef = useRef<HTMLDivElement | null>(null);
  const xrPhase = useStore((s) => s.xrPhase);
  const xrActive = xrPhase === 'active' || xrPhase === 'ending';
  // The camera stops the moment entry is requested, not when the session
  // becomes active: the pose snapshotted at attach is then the pose at the
  // tap, rather than a few frames further along whatever transition was
  // running. A refused request lets it resume.
  const xrSuspended = xrPhase !== 'idle' && xrPhase !== 'error';
  const xr = useXRSession({
    renderer,
    camera,
    controlsRef: cameraRig.controlsRef,
    overlayRootRef: xrOverlayRef ?? emptyOverlayRef,
    onTimingReset: resetFrameTiming,
    onRemeasure: remeasureViewport,
    onCameraRestored: cameraRig.cancelTransition,
    scene,
    markers: jointMarkers,
  });

  useEffect(() => {
    onXRReady?.(xr);
    return () => onXRReady?.(null);
  }, [onXRReady, xr]);

  /*
   * In a session the subject appears only once it has been given a place in the
   * room. Before that its transform is whatever the desktop left behind, which
   * would put a life-size figure at an arbitrary point relative to the viewer:
   * usually inside them. Repositioning keeps the current placement visible, so
   * cancelling has something to return to.
   */
  const xrPlacementMode = useStore((s) => s.xrPlacement);
  useEffect(() => {
    setPresentationVisible(
      presentationRoot,
      !xrActive || xrPlacementMode === 'placed' || xrPlacementMode === 'repositioning'
    );
  }, [presentationRoot, xrActive, xrPlacementMode]);

  // Tap or click a joint marker to select it; a drag to orbit does not. The
  // renderer's canvas is state, so this needs no ref read during render.
  //
  // Suspended during a session: in AR the same touch is an XR input event, and
  // processing it through both paths would select twice from one tap.
  useJointPicking(renderer?.domElement ?? null, camera, jointMarkers, !xrActive);

  /*
   * The ordinary viewer's furniture has no place in a real room. The grid, the
   * axes and the shadow plane describe a virtual ground that would float
   * through the actual floor, so they go for the duration and come back on
   * exit; `showGrid` is untouched, so the user's own choice is what returns.
   */
  useEffect(() => {
    if (helpers) applyHelperVisibility(helpers, showGrid && !xrActive);
  }, [helpers, showGrid, xrActive]);

  // The mixer, the bake, and the per-frame playback step.
  const playback = useAnimationPlayback({
    scene,
    presentationRoot,
    model,
    animationClip,
    skeletonLines,
    bonePairs,
    jointMarkers,
    playbackRange,
    viewportSize,
    onLoad,
    onControlsReady,
    onMotionData,
  });

  // Aliases so the overlay code below reads as it did before the split.
  const { actionRef, precomputedOnionLinesRef, precomputedTrailsRef } = playback;

  /*
   * No mirror refs.
   *
   * These values used to be copied into refs during render so the frame loop
   * could read them without restarting. Writing a ref during render is not
   * allowed, and it is not needed here: registering a frame callback is one
   * assignment and does not restart the loop, so the callback is simply rebuilt
   * when the values it closes over change.
   */

  // Report FPS up
  useEffect(() => {
    if (onFpsUpdate) onFpsUpdate(fps);
  }, [fps, onFpsUpdate]);

  // Build the overlays for this rig and attach them to the presentation root.
  const overlaysRef = useRef<Overlays | null>(null);
  useEffect(() => {
    if (!skeletonLines || !jointMarkers) return;
    const overlays = buildOverlays({
      parent: presentationRoot,
      skeletonLines,
      jointMarkers,
      boneCount: bonesOf(jointMarkers)?.length ?? 0,
    });
    overlaysRef.current = overlays;
    return () => {
      overlays.dispose();
      overlaysRef.current = null;
    };
  }, [presentationRoot, skeletonLines, jointMarkers]);

  // Toggle visibility flags
  useEffect(() => {
    applyOverlayVisibility(
      {
        skeletonLines,
        jointMarkers,
        ghosts: overlaysRef.current?.ghosts ?? [],
        trailGroup: overlaysRef.current?.trailGroup ?? null,
      },
      { showSkeleton, showOnionSkin, showMotionTrail, focused: selectedIndex >= 0 }
    );
  }, [skeletonLines, jointMarkers, showSkeleton, showOnionSkin, showMotionTrail, selectedIndex]);

  // Focus the overlays on the selection, or restore all-joint behaviour.
  useEffect(() => {
    applySelectionFocus(overlaysRef.current, selectedIndex);
    applyGhostHighlightVisibility(overlaysRef.current, showOnionSkin, selectedIndex);
  }, [selectedIndex, showOnionSkin, skeletonLines, jointMarkers]);

  // Keep every fat-line material's resolution matched to the canvas.
  //
  // LineMaterial converts its pixel line width using this, and each onion-skin
  // clone carries its own material — so a dock collapse or a window resize has
  // to reach all of them, not just the live skeleton.
  useEffect(() => {
    applyLineResolution(
      [skeletonLines, ...(overlaysRef.current?.ghosts ?? []), overlaysRef.current?.focusTrail],
      viewportSize
    );
  }, [viewportSize, skeletonLines]);

  // Handle mesh visibility — only target SkinnedMesh / regular Mesh, skip Bones
  useEffect(() => {
    if (model) applyMeshVisibility(model, showMesh);
  }, [model, showMesh]);

  /**
   * The frame: playback, overlays, camera. The frame owner renders after this
   * returns, so everything on screen belongs to the same instant.
   */
  useEffect(() => {
    const frame = (delta: number, xrFrame?: XRFrame) => {
      // The placement read comes first, because it is also how this frame
      // learns whether the viewer has a pose at all. Reticle before mixer costs
      // nothing: the ring describes the room, not the subject, and the render
      // still happens once, after everything.
      if (xrActive && xrFrame) xr.updateFromFrame(xrFrame);

      /*
       * Suspend effective advancement, not the intention. While the runtime has
       * hidden the session or tracking has dropped, nobody can see the clip, and
       * letting it run means the pose that greets them on return is seconds
       * away from the one they left. A zero delta holds the mixer in place and
       * keeps the playing/paused state untouched, so resumption is from here,
       * with no catch-up: the frame clock is reset when visibility returns.
       */
      const advance = !xrActive || xr.canAdvance();
      playback.step(advance ? delta : 0);

      if (showSkeleton || showOnionSkin || showMotionTrail || selectedIndex >= 0) {
        const lines = skeletonLines;
        const pairs = bonePairs;
        const markers = jointMarkers;

        // Bone world positions carry the display placement; these buffers hang
        // under the node that applies it. Take it back out exactly once.
        authoredMatrixInto(presentationRoot, _toAuthored);

        if (lines && pairs) {
          updateSkeletonLines(
            lines as LineSegments2,
            pairs,
            viewportSize,
            _toAuthored
          );
        }

        const pOnions = precomputedOnionLinesRef.current;
        const pTrails = precomputedTrailsRef.current;

        let currentFrame = 0;
        let validPrecompute = false;

        const action = actionRef.current;
        const clip = animationClip;
        if (action && pOnions.length > 0 && pTrails.length > 0 && clip) {
          const time = action.time;
          const duration = clip.duration;
          let wrappedTime = time % duration;
          if (wrappedTime < 0) wrappedTime += duration;
          // Precomputed at 30 fps
          currentFrame = Math.min(Math.floor(wrappedTime * 30), pOnions.length - 1);
          validPrecompute = true;
        }

        // Ghost poses: static frames from the precomputed buffers.
        if (showOnionSkin && validPrecompute) {
          for (let i = 0; i < GHOST_COUNT; i++) {
            let frame = currentFrame - (i + 1) * GHOST_SPACING;
            if (frame < 0) frame += pOnions.length;

            if (frame >= 0 && frame < pOnions.length) {
              const buffer = pOnions[frame];
              const mesh = overlaysRef.current?.ghosts[i];
              if (mesh) {
                const meshGeo = mesh.geometry as LineSegmentsGeometry;
                // Copy into the buffer this geometry already owns.
                //
                // `setPositions` builds a new InstancedInterleavedBuffer and two
                // new attributes every call, so calling it per ghost per frame
                // made three.js allocate a fresh GPU buffer per ghost per frame
                // and abandon the previous one to the garbage collector: with
                // ghosts on, roughly five new buffers every frame for as long as
                // the clip plays. It also recomputed bounds that these meshes do
                // not use, since they are never frustum culled.
                const startAttr = meshGeo.attributes.instanceStart as
                  | THREE.InterleavedBufferAttribute
                  | undefined;
                // Both arrays are the skeleton's fat-line buffer, so they match
                // by construction. They can differ for one frame while an asset
                // with a different bone count is being swapped in, and a throw
                // in here would stop the only frame loop.
                if (startAttr) {
                  const target = startAttr.data.array as Float32Array;
                  if (target.length === buffer.length) {
                    target.set(buffer);
                    startAttr.data.needsUpdate = true;
                  }
                }
              }
            }
          }
        }

        if (markers && markers.children[0]) {
          const instancedMesh = markers.children[0] as THREE.InstancedMesh;
          const bones = bonesOf(markers);
          if (bones) {
            bones.forEach((bone, i) => {
              bone.getWorldPosition(_worldPos);
              _worldPos.applyMatrix4(_toAuthored);
              _markerMatrix.makeTranslation(_worldPos.x, _worldPos.y, _worldPos.z);
              instancedMesh.setMatrixAt(i, _markerMatrix);

              // Motion trails, read straight out of the baked positions.
              if (showMotionTrail && validPrecompute) {
                const trailLine = overlaysRef.current?.trailLines[i];
                const historyAll = pTrails[i];
                if (trailLine && historyAll && historyAll.length > 0) {
                  const trailLength = Math.min(TRAIL_FRAMES, historyAll.length);
                  const positionAttribute = trailLine.geometry.attributes
                    .position as THREE.BufferAttribute;
                  const posArray = positionAttribute.array as Float32Array;

                  const alphaAttribute = trailLine.geometry.attributes
                    .transparency as THREE.BufferAttribute;
                  const alphaArray = alphaAttribute.array as Float32Array;

                  for (let j = 0; j < trailLength; j++) {
                    let frame = currentFrame - trailLength + j + 1;
                    if (frame < 0) frame += historyAll.length;

                    if (frame >= 0 && frame < historyAll.length) {
                      const p = historyAll[frame];
                      posArray[j * 3] = p.x;
                      posArray[j * 3 + 1] = p.y;
                      posArray[j * 3 + 2] = p.z;

                      // Non-linear fade so it vanishes smoothly
                      alphaArray[j] = Math.pow(j / Math.max(1, trailLength - 1), 1.5);
                    }
                  }
                  positionAttribute.needsUpdate = true;
                  alphaAttribute.needsUpdate = true;
                  trailLine.geometry.setDrawRange(0, trailLength);
                }
              }
            });
            instancedMesh.instanceMatrix.needsUpdate = true;

            // The selection highlight rides on the selected marker, and its
            // ghost context on that joint's baked position at each ghost
            // frame. Both in authored space, like everything else here.
            const overlays = overlaysRef.current;
            if (overlays && selectedIndex >= 0 && selectedIndex < bones.length) {
              instancedMesh.getMatrixAt(selectedIndex, _markerMatrix);
              overlays.highlight.position.setFromMatrixPosition(_markerMatrix);

              const history = pTrails[selectedIndex];
              if (validPrecompute && history && history.length > 0) {
                for (let g = 0; g < GHOST_COUNT; g++) {
                  let frame = currentFrame - (g + 1) * GHOST_SPACING;
                  if (frame < 0) frame += history.length;
                  const p = history[Math.max(0, Math.min(frame, history.length - 1))];
                  _markerMatrix.makeTranslation(p.x, p.y, p.z);
                  overlays.ghostHighlights.setMatrixAt(g, _markerMatrix);
                }
                overlays.ghostHighlights.instanceMatrix.needsUpdate = true;
                if (showMotionTrail) {
                  updateFocusTrail(
                    overlays.focusTrail,
                    history,
                    currentFrame,
                    xrActive ? FOCUS_TRAIL_WIDTH_XR : FOCUS_TRAIL_WIDTH
                  );
                }
              }
            }
          }
        }
      }

      // Advance any view transition and damp OrbitControls. Last in the frame,
      // after the mixer and the overlays, so the camera never chases a pose
      // that is one frame stale.
      //
      // Not during a session. The device owns the view there, and leaving this
      // running lets damping and any in-flight transition keep moving a camera
      // nobody is looking through — so the pose restored on exit is not the one
      // the user left, and the restoration looks like a bug in the exit.
      if (!xrSuspended) cameraRig.update(delta);
    };

    setFrameCallback(frame);
    return () => setFrameCallback(null);
  }, [
    setFrameCallback,
    presentationRoot,
    cameraRig,
    playback,
    actionRef,
    precomputedOnionLinesRef,
    precomputedTrailsRef,
    skeletonLines,
    bonePairs,
    jointMarkers,
    animationClip,
    showSkeleton,
    showOnionSkin,
    showMotionTrail,
    viewportSize,
    selectedIndex,
    xrActive,
    xrSuspended,
    xr,
  ]);

  return (
    <div className="scene-container" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
