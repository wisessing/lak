import * as THREE from 'three';
import { buildEditedClip, type ClipEdit } from '../../utils/clipEditing';
import type { MotionData } from '../../utils/motionData';
import { NO_EDIT, getActiveApplied, getActiveEdit, getHasPendingEdit, getWorkingClip } from '../derive';
import type { SliceCreator } from '../index';

/**
 * Clip editing — the fold of `useClipEditor` into the store.
 *
 * Raw state only; everything meaningful is derived at read time in
 * `store/derive.ts` so the owner guards stay atomic with the asset and motion
 * they guard against (see that file). Two notions of "changed" stay distinct:
 * *pending* (an unapplied edit, previewed by playback) and *modified* (an
 * applied edit that exists only in memory).
 */
export interface EditSlice {
  /** The applied edit, tied to the source clip it was derived from. */
  applied: {
    source: THREE.AnimationClip | null;
    clip: THREE.AnimationClip;
    revision: number;
  } | null;
  /** The pending edit, tied to the dataset it was set against. */
  editState: { owner: MotionData | null; edit: ClipEdit };

  setEdit: (edit: ClipEdit) => void;
  resetEdit: () => void;
  /** Bake the pending edit into the working clip. No-op when nothing pends. */
  applyEdit: () => void;
  /** Restore the identical source clip object — free, and cannot drift. */
  revertToSource: () => void;
}

export const createEditSlice: SliceCreator<EditSlice> = (set, get) => ({
  applied: null,
  editState: { owner: null, edit: NO_EDIT },

  setEdit: (edit) => set({ editState: { owner: get().motion, edit } }),

  resetEdit: () => set({ editState: { owner: get().motion, edit: NO_EDIT } }),

  applyEdit: () => {
    const s = get();
    const workingClip = getWorkingClip(s);
    if (!workingClip || !s.motion || !getHasPendingEdit(s)) return;

    const next = buildEditedClip(workingClip, getActiveEdit(s), s.motion.fps);
    set({
      applied: {
        source: s.sourceClip,
        clip: next,
        revision: (getActiveApplied(s)?.revision ?? 0) + 1,
      },
      // The new clip re-bakes into a new dataset, which retires this edit via
      // the owner guard; clearing eagerly keeps the frames before that honest.
      editState: { owner: null, edit: NO_EDIT },
    });
    s.announce('Edit applied. The clip has been replaced for this session.');
  },

  revertToSource: () => {
    set({ applied: null, editState: { owner: null, edit: NO_EDIT } });
    get().announce('Reverted to the original clip.');
  },
});
