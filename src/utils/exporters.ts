import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  computeAccelerations,
  computeSpeeds,
  frameToTime,
  getBonePosition,
  getBoneQuaternion,
  summarizeSeries,
  type MotionData,
} from './motionData';

/**
 * Export formats.
 *
 * CSV and JSON carry *analysis data* — per-frame numbers meant for Excel,
 * pandas, R, or MATLAB. GLB carries the *scene* — geometry, skeleton, and
 * animation for another engine or DCC tool. They are not substitutes for each
 * other.
 *
 * FBX is handled separately in `fbxExporter.ts` — three.js ships `FBXLoader` but
 * no writer, so that one is written from scratch. It covers the same ground as
 * GLB: mesh, skin weights, skeleton and animation.
 */

/** Row layout for the CSV export. */
export type CsvLayout = 'long' | 'wide';

export interface CsvOptions {
  /**
   * `long` writes one row per frame per bone — the tidy layout pandas and R
   * expect. `wide` writes one row per frame with a column group per bone, which
   * is easier to eyeball in Excel but produces 3 columns per bone.
   */
  layout?: CsvLayout;
  /** Include world rotation quaternions. */
  includeRotations?: boolean;
  /** Include derived speed and acceleration magnitudes. */
  includeDerivatives?: boolean;
  /** Restrict output to these bone indices. Defaults to all bones. */
  boneIndices?: number[];
  /** Decimal places for floating point values. */
  precision?: number;
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Strip the extension off a source filename so exports can reuse the stem. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '') || 'motion';
}

/**
 * Serialize baked motion data as CSV.
 *
 * Positions and rotations are in world space, matching what the viewport draws.
 */
export function buildMotionCsv(data: MotionData, options: CsvOptions = {}): string {
  const {
    layout = 'long',
    includeRotations = false,
    includeDerivatives = true,
    precision = 6,
  } = options;

  const boneIndices = options.boneIndices ?? data.boneNames.map((_, i) => i);
  const speeds = includeDerivatives ? computeSpeeds(data) : null;
  const accels = includeDerivatives && speeds ? computeAccelerations(data, speeds) : null;

  const num = (v: number) => (Number.isFinite(v) ? v.toFixed(precision) : '');
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const rows: string[] = [];

  if (layout === 'long') {
    const header = ['frame', 'time', 'bone', 'x', 'y', 'z'];
    if (includeRotations) header.push('qx', 'qy', 'qz', 'qw');
    if (includeDerivatives) header.push('speed', 'acceleration');
    rows.push(header.join(','));

    for (let frame = 0; frame < data.frameCount; frame++) {
      const time = frameToTime(data, frame);
      for (const bone of boneIndices) {
        getBonePosition(data, frame, bone, pos);
        const cells = [
          String(frame),
          num(time),
          escapeCsv(data.boneNames[bone]),
          num(pos.x),
          num(pos.y),
          num(pos.z),
        ];
        if (includeRotations) {
          getBoneQuaternion(data, frame, bone, quat);
          cells.push(num(quat.x), num(quat.y), num(quat.z), num(quat.w));
        }
        if (includeDerivatives && speeds && accels) {
          const i = frame * data.boneCount + bone;
          cells.push(num(speeds[i]), num(accels[i]));
        }
        rows.push(cells.join(','));
      }
    }

    return rows.join('\n');
  }

  // Wide layout — one row per frame, a column group per bone.
  const header = ['frame', 'time'];
  for (const bone of boneIndices) {
    const name = data.boneNames[bone];
    header.push(`${name}_x`, `${name}_y`, `${name}_z`);
    if (includeRotations) {
      header.push(`${name}_qx`, `${name}_qy`, `${name}_qz`, `${name}_qw`);
    }
    if (includeDerivatives) {
      header.push(`${name}_speed`, `${name}_accel`);
    }
  }
  rows.push(header.map(escapeCsv).join(','));

  for (let frame = 0; frame < data.frameCount; frame++) {
    const cells = [String(frame), num(frameToTime(data, frame))];
    for (const bone of boneIndices) {
      getBonePosition(data, frame, bone, pos);
      cells.push(num(pos.x), num(pos.y), num(pos.z));
      if (includeRotations) {
        getBoneQuaternion(data, frame, bone, quat);
        cells.push(num(quat.x), num(quat.y), num(quat.z), num(quat.w));
      }
      if (includeDerivatives && speeds && accels) {
        const i = frame * data.boneCount + bone;
        cells.push(num(speeds[i]), num(accels[i]));
      }
    }
    rows.push(cells.join(','));
  }

  return rows.join('\n');
}

/** Quote a CSV field only when it needs it. */
function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface AnalysisReport {
  source: string;
  exportedAt: string;
  clip: {
    duration: number;
    sampleFps: number;
    frameCount: number;
    boneCount: number;
    rootBone: string | null;
  };
  bones: Array<{
    name: string;
    speed: { min: number; max: number; mean: number; maxFrame: number; maxTime: number };
  }>;
}

/**
 * Build the structured analysis report — clip metadata plus per-bone motion
 * statistics. This is the companion to the CSV: the CSV holds the raw series,
 * this holds the summary you would paste into a QC note.
 */
export function buildAnalysisReport(
  data: MotionData,
  source: string,
  rootBone: string | null,
  exportedAt: string
): AnalysisReport {
  const speeds = computeSpeeds(data);

  const bones = data.boneNames.map((name, index) => {
    const series = new Float32Array(data.frameCount);
    for (let frame = 0; frame < data.frameCount; frame++) {
      series[frame] = speeds[frame * data.boneCount + index];
    }
    const stats = summarizeSeries(series);
    return {
      name,
      speed: {
        min: stats.min,
        max: stats.max,
        mean: stats.mean,
        maxFrame: stats.maxFrame,
        maxTime: frameToTime(data, stats.maxFrame),
      },
    };
  });

  return {
    source,
    exportedAt,
    clip: {
      duration: data.duration,
      sampleFps: data.fps,
      frameCount: data.frameCount,
      boneCount: data.boneCount,
      rootBone,
    },
    bones,
  };
}

/**
 * Export the model — geometry, skeleton, and animation — as a binary glTF.
 *
 * Resolves to the .glb bytes; the caller decides whether to download them.
 */
export function exportGlb(
  model: THREE.Object3D,
  animations: THREE.AnimationClip[] = []
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      model,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error('Expected binary glTF output but received JSON.'));
        }
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      { binary: true, animations }
    );
  });
}
