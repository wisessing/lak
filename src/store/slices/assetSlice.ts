import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  disposeSupersededAsset,
  fetchSampleFile,
  loadAsset,
  retireAsset,
} from '../../utils/assetLoader';
import { findSample, type SampleAsset } from '../../constants/sampleAssets';
import { disposeSkeletonBundle, parseSkeleton } from '../../utils/skeletonParser';
import { getIsModified } from '../derive';
import type { LoadingState, ErrorState, SkeletonData } from '../../types';
import type { SliceCreator } from '../index';

/**
 * The loaded asset — model, source clip, and the skeleton bundle that
 * `parseSkeleton` derives from it.
 *
 * `sourceClip` is the clip as loaded; the clip the app plays is derived
 * (`getWorkingClip`) so an applied edit never mutates what came from the file.
 */
export interface AssetSlice {
  fileName: string;
  sourceFormat: 'fbx' | 'glb' | null;
  model: THREE.Group | null;
  sourceClip: THREE.AnimationClip | null;
  skeleton: SkeletonData | null;
  skeletonLines: LineSegments2 | null;
  bonePairs: [THREE.Bone, THREE.Bone][] | null;
  jointMarkers: THREE.Group | null;
  loading: LoadingState;
  error: ErrorState;
  /**
   * Which bundled sample is on screen, or null for an imported file. Drives the
   * picker's active mark only; nothing derived depends on it.
   */
  activeSampleId: string | null;

  /**
   * Load a file, guarding a modified-in-memory clip behind a confirmation.
   * Format dispatch lives in `loadAsset`.
   */
  requestLoadFile: (file: File) => Promise<void>;
  /** Clear everything derived from the file, with the same guard. */
  requestClearModel: () => void;
  /** Load a bundled sample, behind the same modified-clip guard. */
  requestLoadSample: (id: string) => Promise<void>;
  /** The unguarded bodies — the discard dialog resumes through these. */
  loadFileNow: (file: File) => Promise<void>;
  loadSampleNow: (sample: SampleAsset) => Promise<void>;
  clearNow: () => void;
}

/**
 * Request identity for asset loading.
 *
 * Loading is asynchronous and the user can start another one at any moment, so
 * a finished load has to prove it is still the one that was asked for. Without
 * this, choosing sample A then B can show A's model under B's name: the two
 * parses race and the slower one wins whichever order they were started in.
 *
 * Module scope rather than store state on purpose — it is a concurrency token,
 * never rendered, and putting it in the snapshot would invite a component to
 * subscribe to it.
 */
let loadSeq = 0;

/** The in-flight sample download, aborted when a newer request supersedes it. */
let activeDownload: AbortController | null = null;


/**
 * The one asset-replacement body, shared by file import and sample selection.
 *
 * Ordering matters here. The new asset is only written into the store once it
 * has parsed, so a failed or superseded load leaves the previous model, file
 * name, and skeleton exactly as they were rather than half-replacing them. The
 * old code set `fileName` before loading, which left a failed import showing
 * the name of a file that is not on screen.
 */
async function applyLoad(
  set: Parameters<SliceCreator<AssetSlice>>[0],
  get: Parameters<SliceCreator<AssetSlice>>[1],
  file: File | null,
  sample: SampleAsset | null
): Promise<void> {
  const token = ++loadSeq;
  const isCurrent = () => token === loadSeq;

  // A newer request supersedes any download still in flight.
  activeDownload?.abort();
  activeDownload = null;

  const label = sample ? sample.label : (file?.name ?? 'file');
  set({
    loading: { isLoading: true, progress: 0, message: `Loading ${label}…` },
    error: { hasError: false, message: '' },
  });

  const onProgress = (progress: number) => {
    if (!isCurrent()) return;
    set((s) => ({
      loading: { ...s.loading, progress, message: `Loading: ${progress.toFixed(0)}%` },
    }));
  };

  let group: THREE.Group | null = null;
  try {
    let source = file;
    if (sample) {
      const controller = new AbortController();
      activeDownload = controller;
      source = await fetchSampleFile(sample, { signal: controller.signal, onProgress });
      if (activeDownload === controller) activeDownload = null;
    }
    if (!source) throw new Error('No file to load.');

    const loaded = await loadAsset(source, onProgress);
    group = loaded.object;

    if (!isCurrent()) {
      // Superseded mid-parse. Release what was built and leave the newer
      // request to finish; touching the store here is what produced "model A
      // under name B".
      disposeSupersededAsset(group);
      return;
    }

    const { skeletonData, skeletonLines, bonePairs, jointMarkers } = parseSkeleton(group);

    // Hand back the outgoing asset's GPU resources. This is the moment the app
    // stops being able to reach them, and it is deliberately *not* done when a
    // clip is trimmed or reverted: those keep the same model and skeleton, and
    // releasing them there would blank the viewport.
    const previous = get();
    if (previous.model && previous.model !== group) {
      retireAsset(previous.model);
      disposeSkeletonBundle(previous.skeletonLines, previous.jointMarkers);
    }

    set({
      trimMode: false,
      // A selection names a joint of the outgoing rig. The new rig may share
      // the name, but it is a different asset, and identity does not carry
      // across loads.
      selectedJointId: null,
      model: group,
      fileName: source.name,
      sourceFormat: loaded.format,
      activeSampleId: sample?.id ?? null,
      skeleton: skeletonData,
      skeletonLines,
      bonePairs,
      jointMarkers,
      sourceClip: loaded.animations.length > 0 ? loaded.animations[0] : null,
      loading: { isLoading: false, progress: 100, message: 'Loaded successfully' },
    });
    // The toast has no timer: it stays until something replaces or dismisses
    // it. Clearing the error state alone therefore left "Could not load the
    // sample" on screen above the model that had just loaded on retry.
    // Only an error toast is cleared, so an export receipt is not swallowed.
    if (get().toastTone === 'error') get().setToast(null);
    get().announce(`${source.name} loaded, ${skeletonData?.boneCount ?? 0} bones.`);
  } catch (err) {
    // An abort is this code superseding itself, not a failure to report.
    const aborted = (err as Error)?.name === 'AbortError';
    if (group) disposeSupersededAsset(group);
    if (!isCurrent() || aborted) return;

    console.error('Model load error:', err);
    set({
      error: {
        hasError: true,
        message: sample ? `Could not load the ${sample.label} sample` : 'Failed to load file',
        details: (err as Error).message,
      },
      // The previous asset is still on screen and still named, so the only
      // thing to undo is the loading indicator.
      loading: { isLoading: false, progress: 0, message: '' },
    });
  }
}

export const createAssetSlice: SliceCreator<AssetSlice> = (set, get) => ({
  fileName: '',
  sourceFormat: null,
  model: null,
  sourceClip: null,
  skeleton: null,
  skeletonLines: null,
  bonePairs: null,
  jointMarkers: null,
  loading: { isLoading: false, progress: 0, message: '' },
  error: { hasError: false, message: '' },
  activeSampleId: null,

  requestLoadFile: async (file: File) => {
    // Discarding an applied edit is the one destructive act here: it exists
    // only in memory. Route through the dialog and resume on confirm.
    if (getIsModified(get())) {
      get().openDialog({
        kind: 'discard',
        message:
          'This clip has been edited, and the edit only exists in memory. Opening another file discards it.',
        onConfirm: () => void get().loadFileNow(file),
      });
      return;
    }
    await get().loadFileNow(file);
  },

  loadFileNow: async (file: File) => {
    await applyLoad(set, get, file, null);
  },

  requestLoadSample: async (id: string) => {
    const sample = findSample(id);
    if (!sample) {
      get().setToast(`Unknown sample "${id}".`, 'error');
      return;
    }
    if (getIsModified(get())) {
      get().openDialog({
        kind: 'discard',
        message:
          'This clip has been edited, and the edit only exists in memory. Opening a sample discards it.',
        onConfirm: () => void get().loadSampleNow(sample),
      });
      return;
    }
    await get().loadSampleNow(sample);
  },

  loadSampleNow: async (sample: SampleAsset) => {
    await applyLoad(set, get, null, sample);
  },

  requestClearModel: () => {
    if (getIsModified(get())) {
      get().openDialog({
        kind: 'discard',
        message:
          'This clip has been edited, and the edit only exists in memory. Clearing discards it.',
        onConfirm: () => get().clearNow(),
      });
      return;
    }
    get().clearNow();
  },

  clearNow: () => {
    // Anything still loading is now abandoned: a result arriving after a clear
    // would resurrect a model the user just removed.
    loadSeq++;
    activeDownload?.abort();
    activeDownload = null;
    // Clearing is a replacement with nothing on the other side, so the same
    // resources have to go back.
    const previous = get();
    if (previous.model) retireAsset(previous.model);
    disposeSkeletonBundle(previous.skeletonLines, previous.jointMarkers);
    get().announce('Model cleared.');
    set({
      fileName: '',
      activeSampleId: null,
      selectedJointId: null,
      sourceFormat: null,
      model: null,
      sourceClip: null,
      skeleton: null,
      skeletonLines: null,
      bonePairs: null,
      jointMarkers: null,
      loading: { isLoading: false, progress: 0, message: '' },
      error: { hasError: false, message: '' },
      motion: null,
      trimMode: false,
      applied: null,
    });
  },
});
