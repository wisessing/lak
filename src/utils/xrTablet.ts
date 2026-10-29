/**
 * The tablet handheld-AR session profile.
 *
 * Kept apart from `xrLifecycle.ts`, which is deliberately generic, and apart
 * from the React hook, so the three decisions that are easy to get wrong can be
 * asserted in Node: which features the session asks for, which reference space
 * it settles on, and whether the DOM overlay was actually granted.
 */

import type { XRSessionLike } from './xrLifecycle';

/**
 * Required, because the workflow does not exist without them.
 *
 * `hit-test` is what puts the subject on a real surface rather than at whatever
 * arbitrary point the session origin happens to be. `dom-overlay` is what keeps
 * the page's own controls on screen over the camera view, which is the whole
 * reason a handheld needs no second interface. Asking for them as required is
 * also the only way to find out whether they are available: there is no
 * per-feature support API, and `isSessionSupported` answers about the mode
 * alone. A rejection here is the answer.
 */
export const TABLET_REQUIRED_FEATURES = ['hit-test', 'dom-overlay'] as const;

/**
 * Optional, because a handheld that cannot offer floor-level tracking should
 * still run. See `acquireReferenceSpace`.
 */
export const TABLET_OPTIONAL_FEATURES = ['local-floor'] as const;

export interface TabletSessionInit {
  requiredFeatures: string[];
  optionalFeatures: string[];
  domOverlay: { root: Element };
}

export function buildTabletSessionInit(overlayRoot: Element): TabletSessionInit {
  return {
    requiredFeatures: [...TABLET_REQUIRED_FEATURES],
    optionalFeatures: [...TABLET_OPTIONAL_FEATURES],
    // The element must already be in the document when the session is
    // requested; the runtime composites this subtree over the camera view.
    domOverlay: { root: overlayRoot },
  };
}

/** The reference spaces this application will work in, best first. */
export type XRReferenceSpaceKind = 'local-floor' | 'local';
const PREFERENCE: XRReferenceSpaceKind[] = ['local-floor', 'local'];

export interface AcquiredReferenceSpace<S> {
  space: S;
  type: XRReferenceSpaceKind;
}

interface ReferenceSpaceProvider<S> {
  requestReferenceSpace(type: string): Promise<S>;
}

/**
 * Take the best reference space this session will give, in one session.
 *
 * `local-floor` puts the origin on the physical floor, which is what a subject
 * standing in a room wants. A handheld runtime may refuse it even when it
 * granted the optional feature, so the fallback is not decoration. Which one
 * was granted has to be recorded rather than assumed, because the placement
 * maths and three.js both need to agree with it.
 */
export async function acquireReferenceSpace<S>(
  session: ReferenceSpaceProvider<S>
): Promise<AcquiredReferenceSpace<S>> {
  let lastError: unknown = null;
  for (const type of PREFERENCE) {
    try {
      return { space: await session.requestReferenceSpace(type), type };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no usable reference space');
}

/**
 * Did the runtime actually grant the overlay?
 *
 * `dom-overlay` can be listed as required and the session still start without a
 * usable overlay on some runtimes, which leaves every control invisible behind
 * the camera feed with no way out of the session. Checking `domOverlayState`
 * is the only way to know, and a session without it is not one this application
 * can present.
 */
export function hasDomOverlay(session: XRSessionLike): boolean {
  const state = (session as { domOverlayState?: { type?: unknown } | null }).domOverlayState;
  return !!state && typeof state.type === 'string' && state.type.length > 0;
}
