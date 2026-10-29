import * as THREE from 'three';
import {
  frameToTime,
  getBonePosition,
  getBoneQuaternion,
  type MotionData,
} from './motionData';

/**
 * Quality checks over baked motion data.
 *
 * Mocap scale varies enormously between exporters — Mixamo works in
 * centimetres, other pipelines in metres — so every threshold here is either
 * dimensionless or measured against a robust statistic of the clip itself. A
 * fixed "5 units per frame is a pop" rule would fire on every frame of one file
 * and never on another.
 */

export type QualityIssueKind = 'pop' | 'jitter' | 'rotation';

export interface QualityIssue {
  kind: QualityIssueKind;
  boneIndex: number;
  boneName: string;
  /** Frame the issue is centred on. */
  frame: number;
  time: number;
  /** The measured value that tripped the threshold. Units depend on `kind`. */
  value: number;
  /** The threshold it tripped, in the same units as `value`. */
  threshold: number;
}

export interface QualityOptions {
  /**
   * A frame's positional step must exceed this multiple of the bone's *local*
   * median step to count as a pop. Local rather than global, so a genuinely
   * fast passage is not flagged wholesale.
   */
  popFactor?: number;
  /**
   * Curvature-to-travel ratio above which a window counts as jitter. Smooth
   * motion tends to 0; a pure frame-to-frame alternation tends to 2.
   */
  jitterRatio?: number;
  /** Angular speed, in degrees per second, treated as unnatural outright. */
  rotationDegPerSec?: number;
  /** Half-width, in frames, of the window used for local statistics. */
  window?: number;
  /** Cap on issues reported per bone per kind, so one bad bone cannot flood the list. */
  maxPerBone?: number;
}

const DEFAULTS: Required<QualityOptions> = {
  popFactor: 6,
  jitterRatio: 1,
  rotationDegPerSec: 1440,
  window: 15,
  maxPerBone: 3,
};

/**
 * Unsigned angle between two quaternions, in radians.
 *
 * `Math.abs` on the dot product folds q and -q together — they name the same
 * orientation, and raw quaternion tracks flip sign freely, which would otherwise
 * read as an instant 360° spin.
 */
function quatAngle(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

/** Median of the first `count` entries of `values`. Does not mutate the input. */
function medianOf(values: ArrayLike<number>, count: number): number {
  if (count === 0) return 0;
  const slice = Array.prototype.slice.call(values, 0, count).sort((x: number, y: number) => x - y);
  const mid = count >> 1;
  return count % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
}

/**
 * Median step length across every bone and frame — a scale reference for the
 * clip, used as an absolute floor so numerical noise on a stationary bone is not
 * reported as motion.
 */
export function estimateMotionScale(data: MotionData): number {
  const { frameCount, boneCount } = data;
  if (frameCount < 2 || boneCount === 0) return 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const steps: number[] = [];

  // Sample at most ~4000 steps; the median does not need every frame.
  const stride = Math.max(1, Math.floor(((frameCount - 1) * boneCount) / 4000));
  let taken = 0;

  for (let frame = 1; frame < frameCount; frame++) {
    for (let bone = 0; bone < boneCount; bone++) {
      if (taken++ % stride !== 0) continue;
      getBonePosition(data, frame - 1, bone, a);
      getBonePosition(data, frame, bone, b);
      steps.push(b.distanceTo(a));
    }
  }

  return medianOf(steps, steps.length);
}

/**
 * Scan the clip for the three failure modes that matter in mocap review:
 *
 * - **pop** — a single-frame positional teleport, usually a marker swap or a
 *   solver hiccup. Detected as a step far above the bone's local median step.
 * - **jitter** — high-frequency tremor. Detected by curvature relative to
 *   travel: smooth motion barely changes direction between frames, jitter
 *   reverses constantly.
 * - **rotation** — an implausible angular jump, either a local spike or an
 *   outright absolute speed above `rotationDegPerSec`.
 *
 * Issues come back sorted worst-first by how far each exceeded its threshold, so
 * the head of the list is where a reviewer should look.
 */
export function detectQualityIssues(
  data: MotionData,
  options: QualityOptions = {}
): QualityIssue[] {
  const opts = { ...DEFAULTS, ...options };
  const { frameCount, boneCount } = data;
  const issues: QualityIssue[] = [];

  // Curvature needs a frame either side, so three frames is the minimum.
  if (frameCount < 3 || boneCount === 0) return issues;

  const scale = estimateMotionScale(data);
  // Below this, a "step" is float noise rather than movement.
  const floor = Math.max(scale * 1e-3, Number.EPSILON);

  const prev = new THREE.Vector3();
  const cur = new THREE.Vector3();
  const next = new THREE.Vector3();
  const curvatureVec = new THREE.Vector3();
  const qPrev = new THREE.Quaternion();
  const qCur = new THREE.Quaternion();

  const steps = new Float64Array(frameCount);
  const angles = new Float64Array(frameCount);

  for (let bone = 0; bone < boneCount; bone++) {
    // Frame-to-frame positional step and angular step for this bone.
    // Index f holds the change between f-1 and f; index 0 is unused.
    for (let frame = 1; frame < frameCount; frame++) {
      getBonePosition(data, frame - 1, bone, prev);
      getBonePosition(data, frame, bone, cur);
      steps[frame] = cur.distanceTo(prev);

      getBoneQuaternion(data, frame - 1, bone, qPrev);
      getBoneQuaternion(data, frame, bone, qCur);
      angles[frame] = THREE.MathUtils.radToDeg(quatAngle(qPrev, qCur));
    }
    steps[0] = 0;
    angles[0] = 0;

    for (const spike of collectSpikes(steps, frameCount, opts, floor).slice(0, opts.maxPerBone)) {
      issues.push({
        kind: 'pop',
        boneIndex: bone,
        boneName: data.boneNames[bone],
        frame: spike.frame,
        time: frameToTime(data, spike.frame),
        value: spike.value,
        threshold: spike.threshold,
      });
    }

    // Rotation: local spikes, plus an absolute ceiling on angular speed.
    const ceilingPerFrame = opts.rotationDegPerSec / data.fps;
    const rotSpikes = collectSpikes(angles, frameCount, opts, 1e-4).filter(
      // A local spike on an almost-static bone is not interesting on its own;
      // require it to be a real rotation as well as an outlier.
      (s) => s.value > ceilingPerFrame * 0.25
    );
    const overspeed: Spike[] = [];
    for (let frame = 1; frame < frameCount; frame++) {
      if (angles[frame] > ceilingPerFrame) {
        overspeed.push({
          frame,
          value: angles[frame],
          threshold: ceilingPerFrame,
          excess: angles[frame] / ceilingPerFrame,
        });
      }
    }

    for (const spike of dedupeByFrame([...rotSpikes, ...overspeed]).slice(0, opts.maxPerBone)) {
      issues.push({
        kind: 'rotation',
        boneIndex: bone,
        boneName: data.boneNames[bone],
        frame: spike.frame,
        time: frameToTime(data, spike.frame),
        // Report degrees per second — a rate is easier to judge than degrees per frame.
        value: spike.value * data.fps,
        threshold: spike.threshold * data.fps,
      });
    }

    // Jitter is a property of a stretch of frames, not one frame, so it is
    // measured per window and only the worst window per bone is reported.
    let worst: { frame: number; ratio: number } | null = null;

    for (let frame = 1; frame < frameCount - 1; frame++) {
      const from = Math.max(1, frame - opts.window);
      const to = Math.min(frameCount - 2, frame + opts.window);
      let curvature = 0;
      let travel = 0;
      let count = 0;

      for (let f = from; f <= to; f++) {
        getBonePosition(data, f - 1, bone, prev);
        getBonePosition(data, f, bone, cur);
        getBonePosition(data, f + 1, bone, next);
        // |p[f+1] - 2p[f] + p[f-1]| — the discrete second difference.
        curvature += curvatureVec.copy(next).addScaledVector(cur, -2).add(prev).length();
        travel += (steps[f] + steps[f + 1]) / 2;
        count++;
      }

      if (count === 0) continue;
      const meanTravel = travel / count;
      if (meanTravel <= floor) continue;

      const ratio = curvature / count / meanTravel;
      if (ratio > opts.jitterRatio && (!worst || ratio > worst.ratio)) {
        worst = { frame, ratio };
      }
    }

    if (worst) {
      issues.push({
        kind: 'jitter',
        boneIndex: bone,
        boneName: data.boneNames[bone],
        frame: worst.frame,
        time: frameToTime(data, worst.frame),
        value: worst.ratio,
        threshold: opts.jitterRatio,
      });
    }
  }

  // Worst first, measured by how far past the threshold each issue is, so the
  // ranking is comparable across kinds with different units.
  return issues.sort((a, b) => b.value / b.threshold - a.value / a.threshold);
}

interface Spike {
  frame: number;
  value: number;
  threshold: number;
  excess: number;
}

/**
 * Frames where `series` spikes above `popFactor` times the local median.
 *
 * The spike is excluded from its own window: a lone outlier barely moves a
 * median anyway, but leaving it out means it cannot raise the bar it has to clear.
 */
function collectSpikes(
  series: ArrayLike<number>,
  frameCount: number,
  opts: Required<QualityOptions>,
  floor: number
): Spike[] {
  const spikes: Spike[] = [];
  const scratch: number[] = [];

  for (let frame = 1; frame < frameCount; frame++) {
    const value = series[frame];
    if (value <= floor) continue;

    const from = Math.max(1, frame - opts.window);
    const to = Math.min(frameCount - 1, frame + opts.window);
    scratch.length = 0;
    for (let f = from; f <= to; f++) {
      if (f !== frame) scratch.push(series[f]);
    }

    const median = medianOf(scratch, scratch.length);
    // An otherwise-still window has no meaningful median to scale against; fall
    // back to the noise floor so a lone twitch still registers.
    const threshold = Math.max(median * opts.popFactor, floor * opts.popFactor);
    if (value > threshold) {
      spikes.push({ frame, value, threshold, excess: value / threshold });
    }
  }

  return spikes.sort((a, b) => b.excess - a.excess);
}

/** Keep the highest-excess spike per frame. */
function dedupeByFrame(spikes: Spike[]): Spike[] {
  const best = new Map<number, Spike>();
  for (const spike of spikes) {
    const existing = best.get(spike.frame);
    if (!existing || spike.excess > existing.excess) best.set(spike.frame, spike);
  }
  return [...best.values()].sort((a, b) => b.excess - a.excess);
}

/**
 * Downsample a series to at most `maxPoints` buckets, keeping each bucket's
 * minimum and maximum.
 *
 * Plotting every frame of a long clip throws away more than it draws — and a
 * naive stride can step straight over a one-frame pop, which is exactly the
 * feature a reviewer is looking for. Keeping both extremes preserves spikes.
 */
export function downsampleSeries(
  series: ArrayLike<number>,
  maxPoints: number
): Array<{ frame: number; min: number; max: number }> {
  const n = series.length;
  const out: Array<{ frame: number; min: number; max: number }> = [];
  if (n === 0) return out;

  const buckets = Math.min(maxPoints, n);
  const size = n / buckets;

  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(n, Math.max(start + 1, Math.floor((i + 1) * size)));
    let min = Infinity;
    let max = -Infinity;
    let maxAt = start;
    for (let f = start; f < end; f++) {
      const v = series[f];
      if (v < min) min = v;
      if (v > max) {
        max = v;
        maxAt = f;
      }
    }
    out.push({ frame: maxAt, min, max });
  }

  return out;
}
