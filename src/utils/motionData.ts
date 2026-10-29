import * as THREE from 'three';

/**
 * Motion data sampling and analysis.
 *
 * Animation is baked once at load into a flat, frame-indexed dataset. Everything
 * downstream — onion skin, motion trails, velocity graphs, quality checks, CSV
 * export — reads from that single sample rather than re-driving the mixer.
 */

/** Sampling rate used for baked motion data, in frames per second. */
export const DEFAULT_SAMPLE_FPS = 30;

/**
 * Seeking a looping action to exactly `duration` wraps it back to the start, so
 * the final frame would sample the *first* pose. Nudge the last sample just
 * inside the clip instead. Small enough that the sampled pose is the end pose
 * for any practical purpose — a microsecond at 30fps is 3e-5 of one frame.
 */
const END_EPSILON = 1e-6;

export interface MotionData {
  /** Rate the clip was sampled at. */
  fps: number;
  /** Number of sampled frames (includes the frame at `duration`). */
  frameCount: number;
  /** Clip duration in seconds. */
  duration: number;
  /** Bone names, in the same order as the position/quaternion strides. */
  boneNames: string[];
  boneCount: number;
  /** World positions, laid out as frameCount × boneCount × 3. */
  positions: Float32Array;
  /** World quaternions, laid out as frameCount × boneCount × 4. */
  quaternions: Float32Array;
}

/** Per-frame summary statistics for a scalar series. */
export interface SeriesStats {
  min: number;
  max: number;
  mean: number;
  /** Frame index where `max` occurs. */
  maxFrame: number;
}

/** Read a bone's world position at a given frame into `target`. */
export function getBonePosition(
  data: MotionData,
  frame: number,
  boneIndex: number,
  target: THREE.Vector3
): THREE.Vector3 {
  const offset = (frame * data.boneCount + boneIndex) * 3;
  return target.set(
    data.positions[offset],
    data.positions[offset + 1],
    data.positions[offset + 2]
  );
}

/** Read a bone's world quaternion at a given frame into `target`. */
export function getBoneQuaternion(
  data: MotionData,
  frame: number,
  boneIndex: number,
  target: THREE.Quaternion
): THREE.Quaternion {
  const offset = (frame * data.boneCount + boneIndex) * 4;
  return target.set(
    data.quaternions[offset],
    data.quaternions[offset + 1],
    data.quaternions[offset + 2],
    data.quaternions[offset + 3]
  );
}

/** Seconds elapsed at a given frame index. */
export function frameToTime(data: MotionData, frame: number): number {
  return Math.min(frame / data.fps, data.duration);
}

/** Frame index closest to a given time in seconds. */
export function timeToFrame(data: MotionData, time: number): number {
  const frame = Math.round(time * data.fps);
  return Math.max(0, Math.min(frame, data.frameCount - 1));
}

/**
 * Bake an animation clip into a flat motion dataset.
 *
 * Sampling drives `mixer` with `setTime`, which moves the live model. The caller
 * is responsible for restoring playback state afterwards (see `restoreMixer`).
 *
 * `onFrame` runs after the model matrices are updated for each sampled frame,
 * so callers can capture additional per-frame state in the same pass instead of
 * paying for a second one.
 */
export function sampleMotionData(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
  bones: THREE.Bone[],
  mixer: THREE.AnimationMixer,
  options: { fps?: number; onFrame?: (frame: number, time: number) => void } = {}
): MotionData {
  const fps = options.fps ?? DEFAULT_SAMPLE_FPS;
  const duration = clip.duration;
  // The tolerance, a thousandth of a frame, absorbs float noise: key times are
  // float32, so a 40-frame clip at 30 fps lasts 1.33333337 s, and × 30 that
  // lands just above 40, which a bare ceil turns into a duplicate end frame.
  const frameCount = Math.max(1, Math.ceil(duration * fps - 1e-3) + 1);
  const boneCount = bones.length;

  const positions = new Float32Array(frameCount * boneCount * 3);
  const quaternions = new Float32Array(frameCount * boneCount * 4);

  const worldPos = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();

  let sampled = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const time = Math.min(frame / fps, duration);

    mixer.setTime(Math.min(time, Math.max(0, duration - END_EPSILON)));
    model.updateMatrixWorld(true);

    for (let b = 0; b < boneCount; b++) {
      bones[b].getWorldPosition(worldPos);
      bones[b].getWorldQuaternion(worldQuat);

      const pOffset = (frame * boneCount + b) * 3;
      positions[pOffset] = worldPos.x;
      positions[pOffset + 1] = worldPos.y;
      positions[pOffset + 2] = worldPos.z;

      const qOffset = (frame * boneCount + b) * 4;
      quaternions[qOffset] = worldQuat.x;
      quaternions[qOffset + 1] = worldQuat.y;
      quaternions[qOffset + 2] = worldQuat.z;
      quaternions[qOffset + 3] = worldQuat.w;
    }

    options.onFrame?.(frame, time);
    sampled++;

    if (time >= duration) break;
  }

  return {
    fps,
    frameCount: sampled,
    duration,
    boneNames: bones.map((b) => b.name),
    boneCount,
    positions,
    quaternions,
  };
}

/** Return the mixer to the start of the clip after sampling. */
export function restoreMixer(model: THREE.Object3D, mixer: THREE.AnimationMixer): void {
  mixer.setTime(0);
  model.updateMatrixWorld(true);
}

/**
 * Per-frame speed magnitude for every bone, in scene units per second.
 * Layout matches the dataset: frameCount × boneCount.
 *
 * Uses a central difference on interior frames and a one-sided difference at the
 * ends, so the series has no artificial zeroes at the boundaries.
 */
export function computeSpeeds(data: MotionData): Float32Array {
  const { frameCount, boneCount } = data;
  const speeds = new Float32Array(frameCount * boneCount);
  if (frameCount < 2) return speeds;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let frame = 0; frame < frameCount; frame++) {
    const prev = Math.max(0, frame - 1);
    const next = Math.min(frameCount - 1, frame + 1);
    const dt = (next - prev) / data.fps;
    if (dt === 0) continue;

    for (let bone = 0; bone < boneCount; bone++) {
      getBonePosition(data, prev, bone, a);
      getBonePosition(data, next, bone, b);
      speeds[frame * boneCount + bone] = b.sub(a).length() / dt;
    }
  }

  return speeds;
}

/**
 * Per-frame acceleration magnitude for every bone, in scene units per second².
 * Derived from the speed series so it stays consistent with the graphs.
 */
export function computeAccelerations(data: MotionData, speeds?: Float32Array): Float32Array {
  const series = speeds ?? computeSpeeds(data);
  const { frameCount, boneCount } = data;
  const accel = new Float32Array(frameCount * boneCount);
  if (frameCount < 2) return accel;

  for (let frame = 0; frame < frameCount; frame++) {
    const prev = Math.max(0, frame - 1);
    const next = Math.min(frameCount - 1, frame + 1);
    const dt = (next - prev) / data.fps;
    if (dt === 0) continue;

    for (let bone = 0; bone < boneCount; bone++) {
      const v0 = series[prev * boneCount + bone];
      const v1 = series[next * boneCount + bone];
      accel[frame * boneCount + bone] = (v1 - v0) / dt;
    }
  }

  return accel;
}

/** Extract one bone's slice out of a frameCount × boneCount series. */
export function extractBoneSeries(
  data: MotionData,
  series: Float32Array,
  boneIndex: number
): Float32Array {
  const out = new Float32Array(data.frameCount);
  for (let frame = 0; frame < data.frameCount; frame++) {
    out[frame] = series[frame * data.boneCount + boneIndex];
  }
  return out;
}

/** Distance between two bones on every frame, in scene units. */
export function computeJointDistance(
  data: MotionData,
  boneA: number,
  boneB: number
): Float32Array {
  const out = new Float32Array(data.frameCount);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let frame = 0; frame < data.frameCount; frame++) {
    getBonePosition(data, frame, boneA, a);
    getBonePosition(data, frame, boneB, b);
    out[frame] = a.distanceTo(b);
  }

  return out;
}

/** Min / max / mean of a scalar series, plus where the max occurs. */
export function summarizeSeries(series: ArrayLike<number>): SeriesStats {
  if (series.length === 0) {
    return { min: 0, max: 0, mean: 0, maxFrame: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let maxFrame = 0;

  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v < min) min = v;
    if (v > max) {
      max = v;
      maxFrame = i;
    }
    sum += v;
  }

  return { min, max, mean: sum / series.length, maxFrame };
}
