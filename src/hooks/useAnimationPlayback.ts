import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { updateSkeletonLines } from '../utils/skeletonParser';
import {
  DEFAULT_SAMPLE_FPS,
  getBonePosition,
  restoreMixer,
  sampleMotionData,
  type MotionData,
} from '../utils/motionData';
import { withAuthoredSpace } from '../utils/presentationSpace';
import { bonesOf } from '../utils/overlayScene';
import { useStore } from '../store';
import type { ClipRange } from '../utils/clipEditing';
import type { AnimationControls } from '../types';

/**
 * Animation playback: the mixer and its action, the imperative control surface
 * the store drives, the once-per-load motion bake, and the per-frame step.
 *
 * Extracted from Scene alongside `useCameraRig` so the two things a WebXR
 * session has to take over — the camera and the frame loop — sit behind small
 * contracts. In XR three.js paces frames itself via
 * `renderer.setAnimationLoop`, so `step()` being a plain function called once
 * per frame, rather than owning its own `requestAnimationFrame`, is what makes
 * that swap a change of caller instead of a rewrite.
 *
 * The overlay pipeline (onion skin, trails, ghosts) deliberately stays in
 * Scene: it reads the buffers this bake produces, but it is a rendering
 * concern, and moving it would mean inventing a second contract for no gain.
 */

interface PlaybackDeps {
  scene: THREE.Scene | null;
  /**
   * The node the subject hangs under. Display placement is applied here, so the
   * bake below has to neutralize it.
   */
  presentationRoot: THREE.Object3D | null;
  model: THREE.Object3D | undefined;
  animationClip: THREE.AnimationClip | undefined;
  skeletonLines: THREE.Object3D | undefined;
  bonePairs: [THREE.Bone, THREE.Bone][] | undefined;
  jointMarkers: THREE.Group | undefined;
  playbackRange: ClipRange | null;
  /** Canvas size, for the fat-line materials the bake touches. */
  viewportSize: { width: number; height: number };
  onLoad?: () => void;
  onControlsReady?: (controls: AnimationControls | null) => void;
  onMotionData?: (data: MotionData) => void;
}

export interface Playback {
  /**
   * Advance the mixer, hold the trim, publish the playhead. Once per frame.
   *
   * `delta` is seconds since the previous frame, supplied by the frame owner.
   * This hook no longer keeps a clock of its own: two clocks reading the same
   * wall time is how a second loop went unnoticed, and in XR the frame owner is
   * the only thing that knows how long a frame actually took.
   */
  step: (delta: number) => void;
  /** The live action, for the overlay code that needs the current time. */
  actionRef: React.RefObject<THREE.AnimationAction | null>;
  /** Fat-line buffers, one per baked frame, for the onion skin and ghosts. */
  precomputedOnionLinesRef: React.RefObject<Float32Array[]>;
  /** Per-bone world positions, per frame, for the motion trails. */
  precomputedTrailsRef: React.RefObject<THREE.Vector3[][]>;
}

/**
 * The latest time a looping clip can be set to and stay there.
 *
 * A looping action wraps a time of exactly `duration` to 0, so seeking to the
 * last frame, or wrapping a reversed trim to an out-point on the clip's end,
 * would show frame 0 instead. Short clips whose last frame is the clip end
 * made this visible.
 */
const END_EPSILON = 1e-6;
const lastSeekable = (duration: number) => Math.max(0, duration - END_EPSILON);

export function useAnimationPlayback({
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
}: PlaybackDeps): Playback {
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const animControlsRef = useRef<AnimationControls | null>(null);
  /** Seek helper owned by the model effect, reused by the per-frame step. */
  const applyTimeRef = useRef<((time: number) => void) | null>(null);

  const precomputedTrailsRef = useRef<THREE.Vector3[][]>([]);
  const precomputedOnionLinesRef = useRef<Float32Array[]>([]);

  // Mirrored into refs so the per-frame step can read them without the frame
  // loop re-subscribing on every change. Synced in an effect rather than during
  // render: a frame of lag is invisible here, since `step` runs after paint.
  const animationClipRef = useRef(animationClip);
  const playbackRangeRef = useRef(playbackRange);
  const viewportSizeRef = useRef(viewportSize);
  useEffect(() => {
    animationClipRef.current = animationClip;
  }, [animationClip]);
  useEffect(() => {
    playbackRangeRef.current = playbackRange;
  }, [playbackRange]);
  // Mirrored in an effect, not during render: the bake reads it, and a resize
  // must not re-run the bake.
  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  // Handle model and animation loading
  useEffect(() => {
    if (!scene || !model) {
      if (onControlsReady) onControlsReady(null);
      return;
    }

    let registeredControls: AnimationControls | null = null;

    // Set castShadow on all meshes in the model
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
      }
    });

    // Added with its own transform untouched, on purpose.
    //
    // This used to subtract the bounding-box centre — which, despite the comment
    // saying "origin bottom", put the *middle* of the character at y=0 and left
    // its feet 0.90 m under the grid. Worse, the offset is a node translation, so
    // `GLTFExporter` wrote it into every GLB: the exported character arrived in
    // Blender and Godot buried to the hips. Framing is the camera's job
    // (`focusModel` runs on load), and the bundled mannequin samples already
    // stand on y=0, so the viewer no longer moves what it is only supposed to
    // look at.
    //
    // The parent is the presentation root rather than the scene, so a display
    // placement moves the subject and its overlays together, exactly once.
    const subjectParent = presentationRoot ?? scene;
    subjectParent.add(model);

    if (animationClip) {
      const mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(animationClip);
      action.play();
      mixerRef.current = mixer;
      actionRef.current = action;

      // Seek without disturbing paused state — the mixer only applies a new
      // time while the action is running, so unpause across the update.
      const applyTime = (time: number) => {
        action.time = time;
        const wasPaused = action.paused;
        action.paused = false;
        mixer.update(0);
        action.paused = wasPaused;
      };
      applyTimeRef.current = applyTime;

      /** Inclusive frame range playback is confined to, in sample frames. */
      const activeRange = () => {
        const duration = animationClip.duration;
        const lastFrame = Math.max(0, Math.round(duration * DEFAULT_SAMPLE_FPS));
        const range = playbackRangeRef.current;
        const start = range ? Math.max(0, Math.min(range.startFrame, lastFrame)) : 0;
        const end = range ? Math.max(start, Math.min(range.endFrame, lastFrame)) : lastFrame;
        return { start, end, lastFrame, duration };
      };

      const frameToTime = (frame: number, duration: number) =>
        Math.min(frame / DEFAULT_SAMPLE_FPS, lastSeekable(duration));

      const currentFrame = () => {
        const duration = animationClip.duration;
        const wrapped = (action.time % duration) || 0;
        return Math.round((wrapped < 0 ? wrapped + duration : wrapped) * DEFAULT_SAMPLE_FPS);
      };

      const controls: AnimationControls = {
        play: () => { action.paused = false; },
        pause: () => { action.paused = true; },
        stop: () => {
          action.reset();
          action.paused = true;
          // Stop returns to the start of the *trimmed* clip, not frame 0 — the
          // range is what the user is working on.
          const { start, duration } = activeRange();
          if (start > 0) applyTime(frameToTime(start, duration));
        },
        setTime: applyTime,
        setSpeed: (speed: number) => { action.setEffectiveTimeScale(speed); },
        getTime: () => {
          return (action.time % animationClip.duration) || 0;
        },
        getDuration: () => animationClip.duration,
        isPlaying: () => !action.paused,
        getSampleFps: () => DEFAULT_SAMPLE_FPS,
        getFrame: currentFrame,
        getRange: () => {
          const { start, end } = activeRange();
          return { start, end };
        },
        setFrame: (frame: number) => {
          const { start, end, duration } = activeRange();
          const clamped = Math.max(start, Math.min(Math.round(frame), end));
          action.paused = true;
          applyTime(frameToTime(clamped, duration));
        },
        // Step by whole frames at the sampling rate, wrapping at the ends of the
        // active range. Stepping always pauses — you are inspecting a pose.
        stepFrame: (delta: number) => {
          const { start, end, duration } = activeRange();
          let frame = currentFrame() + delta;
          if (frame < start) frame = end;
          if (frame > end) frame = start;

          action.paused = true;
          applyTime(frameToTime(frame, duration));
        }
      };
      animControlsRef.current = controls;
      registeredControls = controls;

      if (onControlsReady) {
        onControlsReady(controls);
      }
      // The store is the second consumer: UI actions delegate through it, and
      // it is what replaced the per-component polling timers.
      useStore.getState().registerController(controls);

      // --- Bake the motion dataset ---
      // One sampling pass feeds the onion skin, the motion trails, and every
      // analysis/export feature downstream. It runs in authored space: the
      // caller neutralizes any presentation transform around this effect, so
      // display placement can never leak into the data or the exports.
      if (skeletonLines && bonePairs && jointMarkers) {
        const bones = bonesOf(jointMarkers);

        if (bones) {
          const pOnions: Float32Array[] = [];

          // Neutralized for the whole pass: the sampler and the ghost buffers
          // both read bone *world* positions, so a placement in effect here
          // would be written into the dataset that feeds CSV, JSON and every
          // overlay. Restored in a `finally` inside the helper.
          const motion = withAuthoredSpace(presentationRoot, () =>
            sampleMotionData(model, animationClip, bones, mixer, {
              fps: DEFAULT_SAMPLE_FPS,
              onFrame: () => {
                // Capture this pose's fat-line buffer in the same pass
                updateSkeletonLines(
                  skeletonLines as LineSegments2,
                  bonePairs,
                  viewportSizeRef.current
                );
                const startAttr = (skeletonLines as LineSegments2).geometry.attributes
                  .instanceStart as THREE.InterleavedBufferAttribute | undefined;
                if (startAttr) {
                  pOnions.push(new Float32Array(startAttr.data.array));
                }
              },
            })
          );

          // The trail renderer indexes positions per bone, then per frame
          const pTrails: THREE.Vector3[][] = bones.map(() => []);
          for (let frame = 0; frame < motion.frameCount; frame++) {
            for (let b = 0; b < bones.length; b++) {
              pTrails[b].push(getBonePosition(motion, frame, b, new THREE.Vector3()));
            }
          }

          precomputedTrailsRef.current = pTrails;
          precomputedOnionLinesRef.current = pOnions;

          if (onMotionData) onMotionData(motion);

          // Restore main mixer to frame 0 so the model starts correctly
          restoreMixer(model, mixer);
          action.paused = false;
        }
      }
    } else {
      if (onControlsReady) {
        onControlsReady(null);
      }
    }

    if (onLoad) {
      onLoad();
    }

    return () => {
      subjectParent.remove(model);
      if (mixerRef.current) {
        mixerRef.current.stopAllAction();
        mixerRef.current = null;
        actionRef.current = null;
      }
      applyTimeRef.current = null;
      precomputedTrailsRef.current = [];
      precomputedOnionLinesRef.current = [];
      if (onControlsReady) {
        onControlsReady(null);
      }
      // Identity-guarded: StrictMode's mount/cleanup/mount and mid-load
      // re-effects can interleave without a newer registration being nulled.
      if (registeredControls) {
        useStore.getState().deregisterController(registeredControls);
      }
    };
  }, [
    scene,
    presentationRoot,
    model,
    animationClip,
    skeletonLines,
    bonePairs,
    jointMarkers,
    onLoad,
    onControlsReady,
    onMotionData,
  ]);

  /**
   * One frame of playback, at the delta the frame owner measured.
   *
   * Called from `useThreeScene`'s loop rather than owning a loop, so the mixer,
   * the overlays and the camera all advance in a fixed order within the same
   * frame, and an immersive session can drive the same function.
   */
  const step = useCallback((delta: number) => {
      if (mixerRef.current) {
        mixerRef.current.update(delta);
      }

      // Confine playback to the trimmed range. Checked after the mixer update so
      // the clamp lands on the frame the range actually names.
      //
      // Direction matters: playing forward, leaving the range means passing the
      // out-point, so the wrap target is the in-point. Playing *backward* it is
      // the mirror image — always snapping to the in-point would drop the
      // playhead straight back onto the boundary it just crossed, and the clip
      // would judder at the in-handle instead of looping.
      const range = playbackRangeRef.current;
      const action = actionRef.current;
      const clip = animationClipRef.current;
      if (range && action && clip && applyTimeRef.current) {
        const duration = clip.duration;
        let wrapped = action.time % duration;
        if (wrapped < 0) wrapped += duration;
        const inTime = Math.min(range.startFrame / DEFAULT_SAMPLE_FPS, lastSeekable(duration));
        const outTime = Math.min(range.endFrame / DEFAULT_SAMPLE_FPS, lastSeekable(duration));
        const reverse = action.getEffectiveTimeScale() < 0;

        if (wrapped > outTime + 1e-6 || wrapped < inTime - 1e-6) {
          applyTimeRef.current(reverse ? outTime : inTime);
        }
      }

      // Publish the playhead into the store (equality-guarded there, so a
      // paused clip generates no traffic). This is what replaced the three
      // setInterval pollers.
      if (action && clip) {
        let wrappedNow = (action.time % clip.duration) || 0;
        if (wrappedNow < 0) wrappedNow += clip.duration;
        useStore
          .getState()
          .publishPlayhead(wrappedNow, Math.round(wrappedNow * DEFAULT_SAMPLE_FPS));
      }

  }, []);

  return { step, actionRef, precomputedOnionLinesRef, precomputedTrailsRef };
}
