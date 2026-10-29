// Shared TypeScript interfaces for integration between features

import * as THREE from 'three';
import type { MotionData } from '../utils/motionData';
import type { ClipRange } from '../utils/clipEditing';


// Scene-related types
/**
 * What the 3D view is told from outside.
 *
 * The scene graph objects — model, skeleton lines, bone pairs, joint markers —
 * are deliberately absent. Scene reads those from the store itself, because it
 * mutates them: passing a mutable three.js node down as a prop and then writing
 * to it is a borrowed object being modified by the borrower.
 */
export interface SceneProps {
  animationClip?: THREE.AnimationClip;
  showSkeleton?: boolean;
  showMesh?: boolean;
  showGrid?: boolean;
  showOnionSkin?: boolean;
  showMotionTrail?: boolean;
  onLoad?: () => void;
  onError?: (error: Error) => void;
  onControlsReady?: (controls: AnimationControls | null) => void;
  onCameraReady?: (controls: CameraViewControls) => void;
  onFpsUpdate?: (fps: number) => void;
  /** Fires once per load with the baked motion dataset. */
  onMotionData?: (data: MotionData) => void;


  /** When set, playback and frame stepping stay inside this inclusive range. */
  playbackRange?: ClipRange | null;

  /**
   * The DOM element the runtime composites over the camera view in a handheld
   * AR session. Owned by the shell, because it must already be mounted when the
   * session is requested and must outlive any one session.
   */
  xrOverlayRef?: React.RefObject<HTMLDivElement | null>;
  /** Publishes the session controls upward, as `onCameraReady` does. */
  onXRReady?: (controls: XRSessionControls | null) => void;
}

/** What the shell can do with an immersive session. */
export interface XRSessionControls {
  probeSupport: () => Promise<boolean>;
  enter: () => void;
  exit: () => void;
  dismissError: () => void;
  placeHere: () => void;
  beginReposition: () => void;
  cancelReposition: () => void;
}

// Sidebar component interface
export interface SidebarProps {
  skeleton: SkeletonData | null;
  onFileSelect: (file: File) => void;
  isLoading: boolean;
  progress: number;
  showSkeleton: boolean;
  showMesh: boolean;
  showGrid: boolean;
  showOnionSkin: boolean;
  showMotionTrail: boolean;
  onToggleSkeleton: (visible: boolean) => void;
  onToggleMesh: (visible: boolean) => void;
  onToggleGrid: (visible: boolean) => void;
  onToggleOnionSkin: (visible: boolean) => void;
  onToggleMotionTrail: (visible: boolean) => void;
  onClearModel: () => void;
  fileName: string;

}

// Controls for camera transitioning
export interface CameraViewControls {
  setPreset: (preset: CameraPreset) => void;
  reset: () => void;
  focusModel: () => void;
  /**
   * Writes the camera's world-space basis into the supplied vectors so the
   * navigation gizmo can project the axis balls. Out-params rather than a
   * returned object because this is polled every frame. Returns false when the
   * camera is not ready yet.
   */
  readBasis: (right: THREE.Vector3, up: THREE.Vector3, back: THREE.Vector3) => boolean;
  /**
   * Orbits around the current pivot by angular deltas in radians, matching
   * OrbitControls' sign convention (drag right lowers azimuth). Abandons any
   * in-flight preset transition so a drag always wins.
   */
  orbitBy: (dAzimuth: number, dPolar: number) => void;
  /** Moves to an axis-aligned view, keeping the current pivot and distance. */
  snapToAxis: (axis: GizmoAxis) => void;
}

// Animation control interface
export interface AnimationControls {
  play: () => void;
  pause: () => void;
  stop: () => void;
  setTime: (time: number) => void;
  setSpeed: (speed: number) => void;
  getTime: () => number;
  getDuration: () => number;
  isPlaying: () => boolean;
  /** Rate motion data was baked at — the step size for frame stepping. */
  getSampleFps: () => number;
  /** Step forward (+1) or back (-1) whole frames; pauses playback. */
  stepFrame: (delta: number) => void;
  /** Current playhead as a frame index at the baked sample rate. */
  getFrame: () => number;
  /** The inclusive frame range playback is confined to, in sample frames. */
  getRange: () => { start: number; end: number };
  /** Jump to a frame index at the baked sample rate; pauses playback. */
  setFrame: (frame: number) => void;
}

// Camera preset types
export type CameraPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'perspective';

/** The six axis-aligned views reachable from the navigation gizmo. */
export type GizmoAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

// File upload types
export interface FBXFile {
  name: string;
  size: number;
  data: ArrayBuffer;
}

// Skeleton data types
export interface BoneData {
  /**
   * Asset-scoped joint identity. Derived from the normalized rig at load, so
   * it is stable for the life of that asset and meaningless once the asset is
   * replaced. The hierarchy, the viewport markers, and a future XR ray all
   * refer to a joint by this and nothing else.
   */
  id: string;
  name: string;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  children: BoneData[];
}

export interface SkeletonData {
  bones: BoneData[];
  boneCount: number;
  rootBone: string;
}

// Loading state
export interface LoadingState {
  isLoading: boolean;
  progress: number;
  message: string;
}

// Error state
export interface ErrorState {
  hasError: boolean;
  message: string;
  details?: string;
}

// Application state
export interface AppState {
  model: THREE.Object3D | null;
  animationClip: THREE.AnimationClip | null;
  skeleton: SkeletonData | null;
  skeletonLines: THREE.Object3D | null;
  bonePairs: [THREE.Bone, THREE.Bone][] | null;
  jointMarkers: THREE.Group | null;
  loading: LoadingState;
  error: ErrorState;
  showSkeleton: boolean;
  showMesh: boolean;
  showGrid: boolean;
  showOnionSkin: boolean;
  showMotionTrail: boolean;
  fileName: string;
}
