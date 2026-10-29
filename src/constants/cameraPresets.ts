import * as THREE from 'three';
import type { CameraPreset, GizmoAxis } from '../types';

export interface CameraConfiguration {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export const CAMERA_PRESETS: Record<CameraPreset, CameraConfiguration> = {
  front: {
    position: new THREE.Vector3(0, 1, 3),
    target: new THREE.Vector3(0, 0.8, 0)
  },
  back: {
    position: new THREE.Vector3(0, 1, -3),
    target: new THREE.Vector3(0, 0.8, 0)
  },
  left: {
    position: new THREE.Vector3(-3, 1, 0),
    target: new THREE.Vector3(0, 0.8, 0)
  },
  right: {
    position: new THREE.Vector3(3, 1, 0),
    target: new THREE.Vector3(0, 0.8, 0)
  },
  top: {
    position: new THREE.Vector3(0, 4, 0.01), // Slight offset to avoid gimbal lock/flip
    target: new THREE.Vector3(0, 0, 0)
  },
  bottom: {
    position: new THREE.Vector3(0, -2, 0.01),
    target: new THREE.Vector3(0, 0.8, 0)
  },
  perspective: {
    position: new THREE.Vector3(2.5, 2.5, 3.5),
    target: new THREE.Vector3(0, 0.5, 0)
  }
};

/** One of the six axis-aligned views the navigation gizmo can snap to. */
export interface GizmoAxisInfo {
  /** Unit direction from the pivot toward where the camera sits for this view. */
  direction: THREE.Vector3;
  /** Axis letter drawn on the ball. */
  letter: 'X' | 'Y' | 'Z';
  /** Human name, used for the tooltip and the accessible label. */
  label: string;
  /** Positive axes get a spoke and a letter; negative ones stay bare, as in Blender. */
  positive: boolean;
}

/**
 * Which world direction each gizmo ball parks the camera on. The names match
 * CAMERA_PRESETS: +Z is the front view, +X the right, +Y the top.
 */
export const GIZMO_AXES: Record<GizmoAxis, GizmoAxisInfo> = {
  '+x': { direction: new THREE.Vector3(1, 0, 0), letter: 'X', label: 'Right', positive: true },
  '-x': { direction: new THREE.Vector3(-1, 0, 0), letter: 'X', label: 'Left', positive: false },
  '+y': { direction: new THREE.Vector3(0, 1, 0), letter: 'Y', label: 'Top', positive: true },
  '-y': { direction: new THREE.Vector3(0, -1, 0), letter: 'Y', label: 'Bottom', positive: false },
  '+z': { direction: new THREE.Vector3(0, 0, 1), letter: 'Z', label: 'Front', positive: true },
  '-z': { direction: new THREE.Vector3(0, 0, -1), letter: 'Z', label: 'Back', positive: false }
};

/** Stable iteration order; the gizmo re-sorts by depth before drawing. */
export const GIZMO_AXIS_ORDER: GizmoAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
