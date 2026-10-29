import type { AnimationControls } from '../../types';
import type { SliceCreator } from '../index';

/**
 * Playback state and the bridge to the mixer.
 *
 * The mixer lives inside Scene, whose seek/clamp semantics are verified — so
 * commands delegate to the `AnimationControls` object Scene registers here,
 * and Scene's rAF publishes the playhead back after each `mixer.update`.
 *
 * Read discipline:
 * - `controller` is non-reactive by convention: actions reach it through
 *   `get()`; components must not select it.
 * - `playheadTime` / `playheadFrame` are primitives published at up to 60Hz.
 *   High-frequency consumers (the scrubber needle) use a transient
 *   `useStore.subscribe` writing through a ref; text readouts select the
 *   integer `playheadFrame` so they re-render at most at bake granularity.
 */
export interface PlaybackSlice {
  controller: AnimationControls | null;
  isPlaying: boolean;
  speed: number;
  /** Playback direction; effective mixer timeScale is `speed * direction`. */
  direction: 1 | -1;
  duration: number;
  sampleFps: number;
  playheadTime: number;
  playheadFrame: number;

  /** Scene's model effect registers its controls object here. */
  registerController: (c: AnimationControls) => void;
  /** Identity-guarded, so StrictMode mount/cleanup/mount interleaves safely. */
  deregisterController: (c: AnimationControls) => void;
  /** Scene's rAF, after mixer.update. Equality-guarded: paused = no traffic. */
  publishPlayhead: (time: number, frame: number) => void;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stopPlayback: () => void;
  seekTime: (time: number) => void;
  seekFrame: (frame: number) => void;
  stepFrame: (delta: number) => void;
  setSpeed: (speed: number) => void;
  setDirection: (direction: 1 | -1) => void;
}

export const createPlaybackSlice: SliceCreator<PlaybackSlice> = (set, get) => ({
  controller: null,
  isPlaying: false,
  speed: 1,
  direction: 1,
  duration: 0,
  sampleFps: 30,
  playheadTime: 0,
  playheadFrame: 0,

  registerController: (c) => {
    set({
      controller: c,
      duration: c.getDuration(),
      sampleFps: c.getSampleFps(),
      isPlaying: c.isPlaying(),
      playheadTime: c.getTime(),
      playheadFrame: c.getFrame(),
    });
  },

  deregisterController: (c) => {
    set((s) =>
      s.controller === c
        ? { controller: null, isPlaying: false, duration: 0, playheadTime: 0, playheadFrame: 0 }
        : {}
    );
  },

  publishPlayhead: (time, frame) => {
    const s = get();
    if (s.playheadTime === time && s.playheadFrame === frame) return;
    set({ playheadTime: time, playheadFrame: frame });
  },

  play: () => {
    const { controller, speed, direction } = get();
    if (!controller) return;

    // Starting *backward* from the beginning has nowhere to go: the playhead is
    // already at the first frame, and three.js also mishandles the first
    // zero-crossing of a freshly started reverse action. Jump to the end of the
    // active range first, which is what "play backward from here" means when
    // "here" is the start.
    if (direction === -1) {
      const { start, end } = controller.getRange();
      if (controller.getFrame() <= start) controller.setFrame(end);
    }

    controller.setSpeed(speed * direction);
    controller.play();
    set({
      isPlaying: true,
      playheadTime: controller.getTime(),
      playheadFrame: controller.getFrame(),
    });
  },

  pause: () => {
    get().controller?.pause();
    set({ isPlaying: false });
  },

  // Space always means "play forward or stop" — a keyboard toggle that
  // sometimes resumed backward would be a trap.
  togglePlay: () => {
    if (get().isPlaying) {
      get().pause();
      return;
    }
    get().setDirection(1);
    get().play();
  },

  stopPlayback: () => {
    const { controller } = get();
    if (!controller) return;
    controller.stop();
    set({ isPlaying: false, playheadTime: controller.getTime(), playheadFrame: controller.getFrame() });
  },

  // Echo the (clamped) result immediately rather than waiting a frame, so the
  // UI never shows the pre-seek value while paused.
  seekTime: (time) => {
    const { controller, duration } = get();
    if (!controller) return;
    // Seeking a looping action to exactly `duration` wraps it to 0 (the
    // longstanding clip-wrap gotcha), so the slider's end stop lands just
    // inside the clip instead of snapping the playhead back to the start.
    const clamped = duration > 0 ? Math.min(time, duration - 1e-4) : time;
    controller.setTime(Math.max(0, clamped));
    set({ playheadTime: controller.getTime(), playheadFrame: controller.getFrame() });
  },

  seekFrame: (frame) => {
    const { controller } = get();
    if (!controller) return;
    controller.setFrame(frame); // clamps to the active range and pauses
    set({ isPlaying: false, playheadTime: controller.getTime(), playheadFrame: controller.getFrame() });
  },

  stepFrame: (delta) => {
    const { controller } = get();
    if (!controller) return;
    controller.stepFrame(delta); // pauses — stepping inspects a pose
    set({ isPlaying: false, playheadTime: controller.getTime(), playheadFrame: controller.getFrame() });
  },

  setSpeed: (speed) => {
    const { controller, direction } = get();
    controller?.setSpeed(speed * direction);
    set({ speed });
  },

  setDirection: (direction) => {
    const { controller, speed } = get();
    controller?.setSpeed(speed * direction);
    set({ direction });
  },
});
