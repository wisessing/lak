import {
  IDENTITY_PRESENTATION,
  clampPresentation,
  presentationEquals,
  type PresentationState,
} from '../../utils/presentationSpace';
import type { SliceCreator } from '../index';

/**
 * Viewport display toggles.
 *
 * The toggle couplings are deliberate UX, not incidental state: hiding the mesh
 * with no skeleton (or vice versa) leaves nothing on screen, and the onion skin
 * and trails read as skeleton decorations, so enabling them surfaces the
 * skeleton too.
 */
export interface ViewSlice {
  showSkeleton: boolean;
  showMesh: boolean;
  showGrid: boolean;
  showOnionSkin: boolean;
  showMotionTrail: boolean;

  toggleSkeleton: (visible: boolean) => void;
  toggleMesh: (visible: boolean) => void;
  toggleGrid: (visible: boolean) => void;
  toggleOnionSkin: (visible: boolean) => void;
  toggleMotionTrail: (visible: boolean) => void;

  /**
   * Where the subject is displayed. Display state only: it never reaches the
   * bake or an export, which is enforced in `presentationSpace.ts`.
   *
   * It lives in the store rather than in the scene so the page and an immersive
   * session move the same subject through the same action, instead of each
   * keeping a placement of its own. Tablet surface placement writes it through
   * `setPresentation` and the session controller snapshots and restores it
   * around a session.
   */
  presentation: PresentationState;
  setPresentation: (next: Partial<PresentationState>) => void;
  resetPresentation: () => void;

  /**
   * The selected joint, by asset-scoped identity, or null for no selection.
   *
   * One action for every input: the hierarchy row, a tap in the viewport, and
   * later a controller ray all call `selectJoint`. The identity comes from the
   * current rig, so it is retired when the asset changes and survives a clip
   * edit, which keeps the same rig. No selection means the existing all-joint
   * overlays, unchanged.
   */
  selectedJointId: string | null;
  selectJoint: (id: string) => void;
  clearSelection: () => void;
}

export const createViewSlice: SliceCreator<ViewSlice> = (set, get) => ({
  showSkeleton: false,
  showMesh: true,
  showGrid: true,
  showOnionSkin: false,
  showMotionTrail: false,

  toggleSkeleton: (visible) =>
    set(visible ? { showSkeleton: true } : { showSkeleton: false, showMesh: true }),

  toggleMesh: (visible) =>
    set(visible ? { showMesh: true } : { showMesh: false, showSkeleton: true }),

  toggleGrid: (visible) => set({ showGrid: visible }),

  // Ghost poses and trails draw on their own, so they leave the skeleton as it
  // is. They used to switch it on and never off again, which read as the
  // toggles changing something they were not asked to (user report).
  toggleOnionSkin: (visible) => set({ showOnionSkin: visible }),

  toggleMotionTrail: (visible) => set({ showMotionTrail: visible }),

  presentation: IDENTITY_PRESENTATION,

  setPresentation: (next) =>
    set((s) => {
      const merged = clampPresentation({ ...s.presentation, ...next });
      // Equality-guarded: a placement drag would otherwise publish a new object
      // every frame and re-render every subscriber.
      return presentationEquals(merged, s.presentation) ? {} : { presentation: merged };
    }),

  resetPresentation: () =>
    set((s) =>
      presentationEquals(s.presentation, IDENTITY_PRESENTATION)
        ? {}
        : { presentation: IDENTITY_PRESENTATION }
    ),

  selectedJointId: null,
  // Selecting shows the skeleton: the highlight lives on the joint markers,
  // and selecting a joint you then cannot see is not a selection anyone asked
  // for.
  selectJoint: (id) => {
    if (get().selectedJointId === id) return;
    set({ selectedJointId: id, showSkeleton: true });
    // Through the store's one polite live region rather than a second one in
    // the dock: two regions announce twice and break single-region queries.
    get().announce(`${id} selected.`);
  },
  clearSelection: () => {
    if (get().selectedJointId === null) return;
    set({ selectedJointId: null });
    get().announce('Selection cleared.');
  },
});
