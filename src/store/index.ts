import { create, type StateCreator } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { createAssetSlice, type AssetSlice } from './slices/assetSlice';
import { createPlaybackSlice, type PlaybackSlice } from './slices/playbackSlice';
import { createEditSlice, type EditSlice } from './slices/editSlice';
import { createViewSlice, type ViewSlice } from './slices/viewSlice';
import { createXrSlice, type XrSlice } from './slices/xrSlice';
import { createMotionSlice, createUiSlice, type MotionSlice, type UiSlice } from './slices/uiSlice';
import { disposedAssetCounts } from '../utils/assetLoader';
import { publishDevHooks } from '../utils/devHooks';

/**
 * The single store — one snapshot for asset, bake, playback, edit, view and
 * UI state.
 *
 * One store rather than several is a correctness decision, not a style one:
 * the owner guards in `derive.ts` compare the edit state against the asset and
 * the bake *within the same snapshot*, which is what makes stale edits
 * impossible to observe. Splitting these into separate stores would reopen the
 * gap the guard closes.
 *
 * Conventions:
 * - Components read via narrow selectors; object-shaped selections go through
 *   `useShallow`.
 * - `controller` is reached via `useStore.getState()` in actions, never
 *   selected in a component.
 * - High-frequency playhead consumers use transient subscriptions
 *   (`useStore.subscribe(selector, cb)` — enabled by `subscribeWithSelector`)
 *   and write through refs instead of re-rendering.
 */
export type AppStore = AssetSlice &
  MotionSlice &
  PlaybackSlice &
  EditSlice &
  ViewSlice &
  XrSlice &
  UiSlice;

/** Slice factory type: full-store knowledge, middleware-aware. */
export type SliceCreator<T> = StateCreator<
  AppStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  T
>;

export const useStore = create<AppStore>()(
  subscribeWithSelector((...a) => ({
    ...createAssetSlice(...a),
    ...createMotionSlice(...a),
    ...createPlaybackSlice(...a),
    ...createEditSlice(...a),
    ...createViewSlice(...a),
    ...createXrSlice(...a),
    ...createUiSlice(...a),
  }))
);

/**
 * The store half of the development-only testing seam. See `devHooks.ts` for
 * what this is for and why it is guarded.
 */
publishDevHooks({ store: useStore, disposedAssetCounts });
