import * as THREE from 'three';
import {
  DEFAULT_SAMPLE_FPS,
  getBonePosition,
  getBoneQuaternion,
  type MotionData,
} from './motionData';

/**
 * Clip trimming and time remapping.
 *
 * Edits are always *derived*: the loaded clip and the baked dataset are never
 * mutated. Trimming produces a new `MotionData` slice, retiming produces a
 * resampled one, and GLB export builds a fresh `AnimationClip`. That keeps the
 * viewport authoritative — what you scrub is still the source motion — and lets
 * an edit be dialled back to nothing without reloading the file.
 */

/** Inclusive frame range within a baked dataset. */
export interface ClipRange {
  startFrame: number;
  endFrame: number;
}

export type EasingKind = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface ClipEdit {
  /** Frames to keep. `null` keeps the whole clip. */
  range?: ClipRange | null;
  /**
   * Output duration as a multiple of the trimmed duration. 2 plays half as
   * fast over twice the time; 0.5 plays twice as fast.
   */
  scale?: number;
  /**
   * How output time maps onto source time. `linear` is a uniform speed change;
   * the ease variants keep total duration but redistribute it, so the motion
   * accelerates or settles.
   */
  easing?: EasingKind;
}

export const EASING_LABELS: Record<EasingKind, string> = {
  linear: 'Linear',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in-out',
};

/**
 * Normalized easing curves, mapping output progress to source progress.
 *
 * Every curve satisfies f(0) = 0 and f(1) = 1, so an edit never drops or
 * repeats the end poses regardless of which curve is chosen.
 */
export function easingFn(kind: EasingKind): (t: number) => number {
  switch (kind) {
    case 'easeIn':
      return (t) => t * t;
    case 'easeOut':
      return (t) => t * (2 - t);
    case 'easeInOut':
      return (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
    case 'linear':
    default:
      return (t) => t;
  }
}

/** True when the edit would leave the data unchanged. */
export function isIdentityEdit(edit: ClipEdit, data: MotionData): boolean {
  const scale = edit.scale ?? 1;
  const easing = edit.easing ?? 'linear';
  const range = edit.range;
  const fullRange =
    !range || (range.startFrame <= 0 && range.endFrame >= data.frameCount - 1);
  return fullRange && scale === 1 && easing === 'linear';
}

/** Clamp a range to the dataset and guarantee at least two frames. */
export function normalizeRange(range: ClipRange | null | undefined, data: MotionData): ClipRange {
  const last = Math.max(0, data.frameCount - 1);
  if (!range) return { startFrame: 0, endFrame: last };

  let start = Math.max(0, Math.min(Math.round(range.startFrame), last));
  let end = Math.max(0, Math.min(Math.round(range.endFrame), last));
  if (end < start) [start, end] = [end, start];
  // A one-frame clip has no duration and no derivatives; widen it.
  if (start === end) {
    if (end < last) end++;
    else if (start > 0) start--;
  }
  return { startFrame: start, endFrame: end };
}

/**
 * Copy out the frames inside `range` as a standalone dataset.
 *
 * Times are rebased so the slice starts at 0 — a trimmed clip should read as a
 * clip in its own right, not as an excerpt with an offset.
 */
export function sliceMotionData(data: MotionData, range: ClipRange): MotionData {
  const { startFrame, endFrame } = normalizeRange(range, data);
  const frameCount = endFrame - startFrame + 1;
  const { boneCount } = data;

  const positions = new Float32Array(frameCount * boneCount * 3);
  const quaternions = new Float32Array(frameCount * boneCount * 4);

  positions.set(
    data.positions.subarray(
      startFrame * boneCount * 3,
      (endFrame + 1) * boneCount * 3
    )
  );
  quaternions.set(
    data.quaternions.subarray(
      startFrame * boneCount * 4,
      (endFrame + 1) * boneCount * 4
    )
  );

  return {
    fps: data.fps,
    frameCount,
    duration: (frameCount - 1) / data.fps,
    boneNames: data.boneNames,
    boneCount,
    positions,
    quaternions,
  };
}

/**
 * Resample a dataset onto a new duration through an easing curve.
 *
 * Positions are interpolated linearly and rotations with slerp — lerping
 * quaternion components would shorten the path and drag the rotation off the
 * unit sphere, which shows up as a limb pinching towards the joint mid-turn.
 */
export function retimeMotionData(
  data: MotionData,
  options: { scale?: number; easing?: EasingKind } = {}
): MotionData {
  const scale = options.scale ?? 1;
  const easing = easingFn(options.easing ?? 'linear');

  if (data.frameCount < 2) return data;

  // Same sampling convention as `sampleMotionData`: the duration is the
  // clip's real length, the frame count covers it at the sample rate plus the
  // final sample, and that final sample is clamped to the duration rather than
  // stretching the data onto a whole-frame grid. Previously this rounded the
  // duration to a frame boundary, so a 0.583 s retime came out as 0.600 s here
  // while the applied clip, baked through `sampleMotionData`, was 0.583 s: the
  // analysis export of a pending edit disagreed with the same edit applied.
  const duration = data.duration * scale;
  const frameCount = Math.max(2, Math.ceil(duration * data.fps) + 1);
  const { boneCount } = data;

  const positions = new Float32Array(frameCount * boneCount * 3);
  const quaternions = new Float32Array(frameCount * boneCount * 4);

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();

  for (let frame = 0; frame < frameCount; frame++) {
    const time = Math.min(frame / data.fps, duration);
    const progress = duration > 0 ? time / duration : 0;
    // Where in the source this output frame reads from, in source frames.
    const sourcePos = easing(progress) * (data.frameCount - 1);
    const lower = Math.floor(sourcePos);
    const upper = Math.min(data.frameCount - 1, lower + 1);
    const blend = sourcePos - lower;

    for (let bone = 0; bone < boneCount; bone++) {
      getBonePosition(data, lower, bone, pA);
      getBonePosition(data, upper, bone, pB);
      pA.lerp(pB, blend);

      const pOffset = (frame * boneCount + bone) * 3;
      positions[pOffset] = pA.x;
      positions[pOffset + 1] = pA.y;
      positions[pOffset + 2] = pA.z;

      getBoneQuaternion(data, lower, bone, qA);
      getBoneQuaternion(data, upper, bone, qB);
      qA.slerp(qB, blend);

      const qOffset = (frame * boneCount + bone) * 4;
      quaternions[qOffset] = qA.x;
      quaternions[qOffset + 1] = qA.y;
      quaternions[qOffset + 2] = qA.z;
      quaternions[qOffset + 3] = qA.w;
    }
  }

  return {
    fps: data.fps,
    frameCount,
    duration,
    boneNames: data.boneNames,
    boneCount,
    positions,
    quaternions,
  };
}

/** Trim then retime, skipping the work entirely when the edit is a no-op. */
export function applyClipEdit(data: MotionData, edit: ClipEdit): MotionData {
  if (isIdentityEdit(edit, data)) return data;

  const range = normalizeRange(edit.range, data);
  const trimmed =
    range.startFrame === 0 && range.endFrame === data.frameCount - 1
      ? data
      : sliceMotionData(data, range);

  const scale = edit.scale ?? 1;
  const easing = edit.easing ?? 'linear';
  if (scale === 1 && easing === 'linear') return trimmed;

  return retimeMotionData(trimmed, { scale, easing });
}

/**
 * Build a trimmed and retimed copy of an `AnimationClip`, for export.
 *
 * Every track is resampled through its own interpolant rather than having its
 * keyframe times rescaled. Rescaling times is cheaper and correct for a uniform
 * speed change, but it cannot express a non-linear remap, and it would silently
 * ignore the easing curve. Going through the interpolant also means each track
 * type interpolates the way three.js intends — quaternion tracks slerp.
 */
export function buildEditedClip(
  clip: THREE.AnimationClip,
  edit: ClipEdit,
  sampleFps: number = DEFAULT_SAMPLE_FPS
): THREE.AnimationClip {
  const scale = edit.scale ?? 1;
  const easing = easingFn(edit.easing ?? 'linear');

  // The range is expressed in dataset frames, which are sampled at `sampleFps`.
  const range = edit.range;
  const sourceStart = range ? Math.max(0, range.startFrame / sampleFps) : 0;
  const sourceEnd = range
    ? Math.min(clip.duration, range.endFrame / sampleFps)
    : clip.duration;
  const sourceSpan = Math.max(sourceEnd - sourceStart, 1 / sampleFps);
  const duration = sourceSpan * scale;

  const frames = Math.max(2, Math.round(duration * sampleFps) + 1);
  const tracks: THREE.KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    const interpolant = trackInterpolant(track);
    const valueSize = track.getValueSize();
    const times = new Float32Array(frames);
    const values = new Float32Array(frames * valueSize);

    for (let i = 0; i < frames; i++) {
      const progress = i / (frames - 1);
      times[i] = progress * duration;
      const sourceTime = sourceStart + easing(progress) * sourceSpan;
      // evaluate() returns the interpolant's internal buffer, reused on every
      // call — copy it out before the next evaluation overwrites it.
      const sample = interpolant.evaluate(sourceTime);
      for (let v = 0; v < valueSize; v++) {
        values[i * valueSize + v] = sample[v];
      }
    }

    // Rebuild as the same track type so quaternion tracks stay quaternion tracks.
    const TrackType = track.constructor as new (
      name: string,
      times: ArrayLike<number>,
      values: ArrayLike<number>
    ) => THREE.KeyframeTrack;
    tracks.push(new TrackType(track.name, times, values));
  }

  const suffix = describeEdit(edit);
  return new THREE.AnimationClip(
    suffix ? `${clip.name || 'clip'}_${suffix}` : clip.name,
    duration,
    tracks
  );
}

interface InterpolantLike {
  evaluate(time: number): ArrayLike<number>;
}

/**
 * The interpolant a track actually uses.
 *
 * `createInterpolant` is assigned per instance by `setInterpolation()` at
 * runtime and is absent from three's type declarations, so it is reached
 * through a cast. The fallback is the linear factory, which
 * `QuaternionKeyframeTrack` overrides to slerp — so a quaternion track still
 * interpolates correctly even on that path.
 */
function trackInterpolant(track: THREE.KeyframeTrack): InterpolantLike {
  const dynamic = (track as unknown as { createInterpolant?: () => InterpolantLike })
    .createInterpolant;
  return typeof dynamic === 'function'
    ? dynamic.call(track)
    : (track.InterpolantFactoryMethodLinear() as unknown as InterpolantLike);
}

/** Short slug describing an edit, for clip and file names. */
export function describeEdit(edit: ClipEdit): string {
  const parts: string[] = [];
  if (edit.range) parts.push(`f${edit.range.startFrame}-${edit.range.endFrame}`);
  if (edit.scale && edit.scale !== 1) parts.push(`x${edit.scale}`);
  if (edit.easing && edit.easing !== 'linear') parts.push(edit.easing);
  return parts.join('_');
}

/** Minimum kept width, in frames. Below two frames there is no duration to play. */
export const MIN_RANGE_FRAMES = 2;

/**
 * Pointer position along a track, as a ratio in 0..1, converted to a frame.
 *
 * Kept out of the timeline component so the drag arithmetic can be asserted
 * without a DOM.
 */
export function frameFromRatio(ratio: number, frameCount: number): number {
  if (frameCount < 2) return 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * (frameCount - 1));
}

/**
 * Move one handle of a range, keeping the result valid.
 *
 * The handles cannot cross and cannot close to less than `MIN_RANGE_FRAMES`.
 * Rather than swapping roles mid-drag — which makes a handle jump out from under
 * the pointer — the dragged handle is stopped and the other one holds still.
 */
export function moveHandle(
  range: ClipRange,
  which: 'start' | 'end',
  frame: number,
  frameCount: number
): ClipRange {
  const last = Math.max(0, frameCount - 1);
  const gap = MIN_RANGE_FRAMES - 1;
  const target = Math.max(0, Math.min(Math.round(frame), last));

  if (which === 'start') {
    return { startFrame: Math.min(target, Math.max(0, range.endFrame - gap)), endFrame: range.endFrame };
  }
  return { startFrame: range.startFrame, endFrame: Math.max(target, Math.min(last, range.startFrame + gap)) };
}

/** Output duration of an edit, in seconds. */
export function editedDuration(
  range: ClipRange,
  scale: number,
  fps: number
): number {
  const frames = Math.max(MIN_RANGE_FRAMES, range.endFrame - range.startFrame + 1);
  // The retimed clip's real length. `retimeMotionData` and the post-apply bake
  // both keep this exact duration and clamp their final sample to it, so this
  // is also what Export reports and what the status bar shows after Apply.
  return ((frames - 1) / fps) * (scale || 1);
}
