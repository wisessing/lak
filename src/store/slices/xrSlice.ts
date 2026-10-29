import type { XRFailure, XRPhase } from '../../utils/xrLifecycle';
import type { XRReferenceSpaceKind } from '../../utils/xrTablet';
import type { SliceCreator } from '../index';

/**
 * What the interface needs to know about an immersive session, and nothing more.
 *
 * The session, its reference spaces, its hit-test sources and its listeners are
 * not here. They are not serializable, they change many times a second, and a
 * store is the wrong place to own a resource that has to be released in a
 * particular order. Those live in the session controller's refs. What lives
 * here is the handful of values a control has to render from, each of which
 * changes rarely and means something to a person.
 *
 * Playback, overlays and selection are deliberately absent too: an AR control
 * calls the same existing actions as the page, so there is exactly one source
 * of truth for what is playing and what is selected, whichever interface the
 * user happens to be touching.
 */

/** Where the user is in the business of putting the subject somewhere. */
export type XRPlacementMode =
  /** No subject in the room yet; the reticle is looking for a surface. */
  | 'unplaced'
  /** Placed, and being inspected. */
  | 'placed'
  /** Placed, but the reticle is back up and a new spot is being chosen. */
  | 'repositioning';

/**
 * True from the entry gesture until the session is fully gone. This is the one
 * predicate the ordinary import, sample, trim and export paths read to stand
 * down: on a device none of them is even visible during a session, since only
 * the overlay is composited, but a keyboard or a stale page can still reach
 * them, and an asset swap under a live session is exactly the case the
 * behaviour table forbids.
 */
export const isXrBusy = (phase: XRPhase): boolean =>
  phase === 'requesting' || phase === 'active' || phase === 'ending';

export interface XrSlice {
  /** Result of the last `isSessionSupported` probe; null before anyone asked. */
  xrSupported: boolean | null;
  xrPhase: XRPhase;
  xrFailure: XRFailure | null;
  /** False while the runtime has hidden the session. Still live; do not tear down. */
  xrVisible: boolean;
  /** Whether the runtime actually granted the DOM overlay. */
  xrDomOverlay: boolean;
  /** The reference space the session settled on, not the one that was asked for. */
  xrReferenceSpace: XRReferenceSpaceKind | null;
  xrPlacement: XRPlacementMode;
  /**
   * Whether the reticle currently has a valid surface under it. Written from
   * the frame loop through a plain setter, so it changes at most when the answer
   * changes rather than every frame.
   */
  xrHasSurface: boolean;
  /**
   * The display scale the user chose for the session, 1 for life size. A
   * placement is committed at this scale, and changing it while placed rescales
   * the subject about its feet. It is a viewing convenience and never reaches
   * the motion data or an export, for the same reason the presentation itself
   * does not.
   */
  xrScale: number;
  /**
   * How many taps in this session landed on no joint. The overlay says so for a
   * moment after each one, because a tap on the subject that does nothing reads
   * as a broken screen.
   */
  xrPickMisses: number;

  setXrSupported: (supported: boolean | null) => void;
  setXrStatus: (status: {
    phase: XRPhase;
    failure: XRFailure | null;
    visible: boolean;
  }) => void;
  setXrSession: (info: {
    domOverlay: boolean;
    referenceSpace: XRReferenceSpaceKind | null;
  }) => void;
  setXrPlacement: (mode: XRPlacementMode) => void;
  setXrHasSurface: (has: boolean) => void;
  setXrScale: (scale: number) => void;
  noteXrPickMiss: () => void;
}

export const createXrSlice: SliceCreator<XrSlice> = (set, get) => ({
  xrSupported: null,
  xrPhase: 'idle',
  xrFailure: null,
  xrVisible: true,
  xrDomOverlay: false,
  xrReferenceSpace: null,
  xrPlacement: 'unplaced',
  xrHasSurface: false,
  xrScale: 1,
  xrPickMisses: 0,

  setXrSupported: (supported) => set({ xrSupported: supported }),

  setXrStatus: ({ phase, failure, visible }) => {
    set({ xrPhase: phase, xrFailure: failure, xrVisible: visible });
    // Leaving a session resets what belonged to it. Every new session starts
    // unplaced: a placement is a pose in that session's reference space, and
    // carrying it into the next one would put the subject somewhere arbitrary.
    if (phase === 'idle' || phase === 'error') {
      set({
        xrDomOverlay: false,
        xrReferenceSpace: null,
        xrPlacement: 'unplaced',
        xrHasSurface: false,
        // Life size is the documented default, so each session starts there.
        xrScale: 1,
        xrPickMisses: 0,
      });
    }
  },

  setXrSession: ({ domOverlay, referenceSpace }) =>
    set({ xrDomOverlay: domOverlay, xrReferenceSpace: referenceSpace }),

  setXrPlacement: (mode) => set({ xrPlacement: mode }),

  // Guarded so a per-frame call with an unchanged answer does not re-render.
  setXrHasSurface: (has) => {
    if (get().xrHasSurface !== has) set({ xrHasSurface: has });
  },

  // A size chosen while the subject is placed applies at once, about the
  // authored origin, so the feet stay on the surface. Chosen before placing,
  // it is what the next placement is committed at.
  setXrScale: (scale) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    set({ xrScale: scale });
    const s = get();
    if (s.xrPlacement === 'placed' || s.xrPlacement === 'repositioning') {
      s.setPresentation({ ...s.presentation, scale });
    }
  },

  noteXrPickMiss: () => set({ xrPickMisses: get().xrPickMisses + 1 }),
});
