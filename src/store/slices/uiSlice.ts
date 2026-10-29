import type { MotionData } from '../../utils/motionData';
import { NARROW_QUERY } from '../../hooks/useNarrowLayout';
import type { SliceCreator } from '../index';

/** Which dock tab is showing. New features become new values here. */
export type DockTab = 'scene' | 'display';

/**
 * Modal requests. A discriminated union rather than a set of booleans, because
 * only one dialog is ever open and the discard case carries a continuation:
 * `window.confirm` was synchronous, a real dialog is not, so the action that
 * was interrupted has to be resumable.
 */
export type DialogRequest =
  | { kind: 'export' }
  | { kind: 'discard'; message: string; onConfirm: () => void };

export interface UiSlice {
  dockTab: DockTab;
  setDockTab: (tab: DockTab) => void;
  /**
   * Dock visibility. Wide layouts show it beside the viewport and this hides
   * it; narrow layouts render it as a drawer and this opens it.
   */
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;

  /** The trim tool: reveals in/out handles on the persistent timeline. */
  trimMode: boolean;
  setTrimMode: (on: boolean) => void;

  /**
   * Whether the camera-gesture help is showing. Dismissible, and reopenable
   * from the same places it appears — a tablet user has no hover to fall back
   * on, so this must never be the only route to the instructions.
   */
  navHelpOpen: boolean;
  setNavHelpOpen: (open: boolean) => void;
  toggleNavHelp: () => void;

  dialog: DialogRequest | null;
  openDialog: (dialog: DialogRequest) => void;
  closeDialog: () => void;

  /**
   * Transient banner. It reports both outcomes — "GLB exported" and "export
   * failed" arrive through the same channel — so it carries a tone: styling
   * every message as an error made a successful export look like a problem.
   */
  toast: string | null;
  toastTone: 'info' | 'error';
  setToast: (message: string | null, tone?: 'info' | 'error') => void;

  /**
   * Politely announced status, for changes a sighted user sees but a screen
   * reader would otherwise miss — a clip finishing loading, an edit applied,
   * a revert. Separate from `toast`, which is assertive and visible.
   */
  announcement: string;
  announce: (message: string) => void;

  /** Renderer FPS, published ~once per second by useThreeScene. */
  rendererFps: number;
  setRendererFps: (fps: number) => void;
}

/** The baked dataset, set by Scene once per load or apply. */
export interface MotionSlice {
  motion: MotionData | null;
  setMotion: (motion: MotionData | null) => void;
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  dockTab: 'scene',
  setDockTab: (dockTab) => set({ dockTab }),
  // Seeded from the layout, not hardcoded: on a narrow screen the dock is a
  // drawer over the viewport, and opening one by default would hide the thing
  // the user came to look at. Reacting to *changes* in the breakpoint is not
  // enough — the very first render is not a change.
  dockOpen:
    typeof window === 'undefined' || !window.matchMedia(NARROW_QUERY).matches,
  setDockOpen: (dockOpen) => set({ dockOpen }),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),

  trimMode: false,
  // Leaving the trim tool abandons an unapplied trim — keeping it live while
  // the handles are hidden would confine playback to marks nobody can see.
  setTrimMode: (on) => {
    if (!on) get().resetEdit();
    set({ trimMode: on });
  },

  // Open on first load: the instructions are most useful before the user has
  // guessed at the gestures, and dismissing them is one tap.
  navHelpOpen: true,
  setNavHelpOpen: (navHelpOpen) => set({ navHelpOpen }),
  toggleNavHelp: () => set((s) => ({ navHelpOpen: !s.navHelpOpen })),

  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  toast: null,
  toastTone: 'info',
  setToast: (toast, tone = 'info') => set({ toast, toastTone: tone }),

  announcement: '',
  announce: (announcement) => set({ announcement }),

  rendererFps: 0,
  setRendererFps: (rendererFps) => set({ rendererFps }),
});

export const createMotionSlice: SliceCreator<MotionSlice> = (set) => ({
  motion: null,
  setMotion: (motion) => set({ motion }),
});
