import { useSyncExternalStore } from 'react';

/**
 * True when the window is too narrow for a side-by-side dock.
 *
 * 900px is the point where a 272px dock leaves the viewport too little to work
 * in — most tablets in portrait, and a small laptop with the browser not
 * maximised. Below it the dock becomes a slide-over drawer.
 *
 * `useSyncExternalStore` rather than state-plus-effect: `matchMedia` *is* an
 * external store, and subscribing to it directly avoids the mount-time
 * re-render that syncing it into state would cause.
 */

export const NARROW_QUERY = '(max-width: 900px)';

const query = typeof window !== 'undefined' ? window.matchMedia(NARROW_QUERY) : null;

function subscribe(onChange: () => void): () => void {
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

const getSnapshot = () => query?.matches ?? false;

export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * True when the viewport is taller than it is wide.
 *
 * Handheld AR is entered upright on purpose: the subject is a standing figure,
 * and a WebXR session cannot be turned once it has started, so the orientation
 * it begins in is the orientation it keeps. The entry control reads this to
 * stand down in landscape. `matchMedia` again, for the same reason as above.
 *
 * The default is `true` so that anything without `matchMedia` — a server
 * render, a test shim — does not spuriously block entry.
 */
const PORTRAIT_QUERY = '(orientation: portrait)';

const portraitQuery = typeof window !== 'undefined' ? window.matchMedia(PORTRAIT_QUERY) : null;

function subscribePortrait(onChange: () => void): () => void {
  portraitQuery?.addEventListener('change', onChange);
  return () => portraitQuery?.removeEventListener('change', onChange);
}

const getPortrait = () => portraitQuery?.matches ?? true;

export function useIsPortrait(): boolean {
  return useSyncExternalStore(subscribePortrait, getPortrait, () => true);
}
