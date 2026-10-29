import * as THREE from 'three';
import { isIdentityEdit, normalizeRange, type ClipEdit, type ClipRange } from '../utils/clipEditing';
import type { AppStore } from './index';

/**
 * Read-time derivations — the owner-guard pattern, store edition.
 *
 * Validity is decided at the moment of reading, never cleared by an effect: an
 * applied clip belongs to the source it was derived from, and a trim range
 * belongs to the dataset it was set against. Because asset, motion and edit
 * state live in one store snapshot, these guards evaluate atomically — when a
 * re-bake lands, every subscriber derives the reset values in the same pass,
 * and a stale edit can never reach a component even for a single render.
 */

export const NO_EDIT: ClipEdit = { range: null, scale: 1, easing: 'linear' };

/**
 * Signatures take the narrowest Pick of the snapshot they read, so components
 * can derive from their *subscribed* values (never `getState()`, which could
 * tear against a newer snapshot mid-render). Store actions pass full state —
 * structural typing accepts both.
 */
type EditFields = Pick<AppStore, 'applied' | 'sourceClip'>;
type PendingFields = Pick<AppStore, 'editState' | 'motion'>;

/** The applied edit, if it still belongs to the loaded clip. */
export function getActiveApplied(s: EditFields) {
  return s.applied && s.applied.source === s.sourceClip ? s.applied : null;
}

/** The clip the app should play and analyse: the source, or the applied edit. */
export function getWorkingClip(s: EditFields): THREE.AnimationClip | null {
  return getActiveApplied(s)?.clip ?? s.sourceClip;
}

/** True once an applied edit has replaced the loaded clip. */
export function getIsModified(s: EditFields): boolean {
  return getActiveApplied(s) !== null;
}

/** Increments per apply; 0 on the pristine clip. Stamps poses. */
export function getRevision(s: EditFields): number {
  return getActiveApplied(s)?.revision ?? 0;
}

/** The pending edit, if it was set against the current bake. */
export function getActiveEdit(s: PendingFields): ClipEdit {
  return s.editState.owner === s.motion ? s.editState.edit : NO_EDIT;
}

/** True when the pending edit would change anything. */
export function getHasPendingEdit(s: PendingFields): boolean {
  return s.motion ? !isIdentityEdit(getActiveEdit(s), s.motion) : false;
}

/** The pending range clamped to the current bake. Null before a bake. */
export function getActiveRange(s: PendingFields): ClipRange | null {
  return s.motion ? normalizeRange(getActiveEdit(s).range, s.motion) : null;
}

/**
 * The trim playback should preview. Non-null only while an edit is pending —
 * a component using this must memo on `editState`/`motion`, not call it in a
 * selector directly (it allocates).
 */
export function getPlaybackRange(s: PendingFields): ClipRange | null {
  return getHasPendingEdit(s) ? getActiveRange(s) : null;
}
