/**
 * The immersive session lifecycle, as a state machine with no framework in it.
 *
 * Everything this needs is injected: the `navigator.xr` it asks, the presenter
 * it hands a started session to, and the clock. That is deliberate and it is
 * the point of the file. A headset can demonstrate the one path that works; it
 * cannot conveniently demonstrate a denied permission, a request arriving while
 * another is in flight, a session the runtime ends by itself, or a visibility
 * change mid-session. Those are the paths that strand an application in a state
 * it cannot leave, and they are exercised here in Node, before any of it
 * reaches a device.
 *
 * States: idle, requesting, active, ending, error. The transitions are the
 * whole contract:
 *
 *   idle      --request-->  requesting --granted-->  active
 *   requesting --refused-->  error --dismiss--> idle
 *   active    --end/lost--> ending --settled--> idle
 *
 * Nothing here imports three.js or React. The renderer wiring lives behind
 * `XRPresenter`, so this file can be read as the answer to one question: what
 * is the application allowed to do next?
 */

export type XRPhase = 'idle' | 'requesting' | 'active' | 'ending' | 'error';

/**
 * Why immersion is unavailable or was refused.
 *
 * Kept separate from the message so the interface can decide what to say, and
 * so a test can assert the cause rather than matching prose.
 */
export type XRFailure =
  | 'unsupported-browser'
  | 'insecure-context'
  /**
   * The mode, or one of the features this session requires, is unavailable.
   * The runtime does not tell the two apart: `requestSession` rejects with
   * `NotSupportedError` either way.
   */
  | 'unsupported-mode'
  /**
   * The mode is supported here, yet the request was rejected as unsupported.
   * Chrome does this when the site's augmented-reality permission is blocked,
   * and that permission cannot be queried, so this is as precise as it gets.
   */
  | 'refused'
  | 'denied'
  | 'no-dom-overlay'
  | 'start-failed';

/**
 * Name the cause from the rejection, rather than assuming one.
 *
 * Calling every failed request a permission denial is wrong often enough to
 * matter: on a tablet without Play Services for AR, or one where `hit-test` is
 * unavailable, the user is told to grant a permission they have already
 * granted. The WebXR specification is specific about which error goes with
 * which cause, so read it.
 */
export function classifyRequestFailure(error: unknown): XRFailure {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotSupportedError') return 'unsupported-mode';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  return 'start-failed';
}

/**
 * A presenter's way of saying *why* it could not adopt a session.
 *
 * `attach` failures were all reported as `start-failed`, which made the
 * dedicated `no-dom-overlay` cause, and its user copy, unreachable: the one
 * failure a user can do nothing about was described as the one they should
 * retry. A presenter that knows the cause throws one of these instead.
 */
export interface XRAttachFailure extends Error {
  failure: XRFailure;
}

export function attachFailure(failure: XRFailure, message: string): XRAttachFailure {
  const err = new Error(message) as XRAttachFailure;
  err.name = 'XRAttachFailure';
  err.failure = failure;
  return err;
}

const FAILURES: ReadonlySet<string> = new Set<XRFailure>([
  'unsupported-browser',
  'insecure-context',
  'unsupported-mode',
  'refused',
  'denied',
  'no-dom-overlay',
  'start-failed',
]);

/** The cause a failed attach carried, or `start-failed` when it carried none. */
export function classifyAttachFailure(error: unknown): XRFailure {
  const failure = (error as { failure?: unknown } | null)?.failure;
  return typeof failure === 'string' && FAILURES.has(failure) ? (failure as XRFailure) : 'start-failed';
}

export interface XRStatus {
  phase: XRPhase;
  /** Set only in the error phase. */
  failure: XRFailure | null;
  /**
   * What `isSessionSupported` last said, or null before anything asked.
   * Distinct from `failure`: a browser can support the mode and still refuse a
   * particular request.
   */
  supported: boolean | null;
  /**
   * False while the runtime has hidden the session, for example when the user
   * opens a system menu. The session is still live and must not be torn down.
   */
  visible: boolean;
}

/** The part of `XRSession` this lifecycle touches. */
export interface XRSessionLike {
  addEventListener(type: 'end' | 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'end' | 'visibilitychange', listener: () => void): void;
  end(): Promise<void>;
  /** 'visible' | 'visible-blurred' | 'hidden' in the specification. */
  visibilityState?: string;
}

/** The part of `navigator.xr` this lifecycle touches. */
export interface XRSystemLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, options?: unknown): Promise<XRSessionLike>;
}

/**
 * Whatever puts the session on screen, and takes it off again.
 *
 * `attach` may throw or reject: a renderer that cannot adopt the session leaves
 * the application holding a live session nobody is drawing, so the lifecycle
 * ends it rather than pretending it started. `detach` must not throw for a
 * session that was never attached.
 */
export interface XRPresenter {
  attach(session: XRSessionLike): void | Promise<void>;
  detach(): void;
}

export interface XRLifecycleOptions {
  /** `navigator.xr`, or null/undefined where the browser has none. */
  xr?: XRSystemLike | null;
  /** `window.isSecureContext`. WebXR is unavailable without one. */
  isSecureContext?: boolean;
  presenter: XRPresenter;
  mode?: string;
  /**
   * Session options, or a function returning them. A function is resolved at
   * request time, which is what lets the caller name a DOM overlay element that
   * is mounted now rather than one that was mounted when the lifecycle was
   * built.
   */
  sessionInit?: unknown | (() => unknown);
  onChange?: (status: XRStatus) => void;
  /** Reported rather than thrown, so a failed teardown cannot strand the app. */
  onError?: (error: unknown) => void;
  /**
   * The camera permission's state, or null where it cannot be read. Asked only
   * after a request fails as unsupported; see `request`.
   */
  cameraPermission?: () => Promise<PermissionState | null>;
}

/** The Permissions API's answer for the camera, where there is one. */
async function queryCameraPermission(): Promise<PermissionState | null> {
  try {
    const permissions = (globalThis as { navigator?: Navigator }).navigator?.permissions;
    if (!permissions) return null;
    const result = await permissions.query({ name: 'camera' as PermissionName });
    return result.state;
  } catch {
    return null;
  }
}

/** `immersive-ar` is the passthrough mode; `immersive-vr` would occlude the room. */
const DEFAULT_MODE = 'immersive-ar';

/**
 * Nothing is required by default, and `local-floor` in particular is not.
 *
 * Requiring it looks harmless and is not: `requestSession` rejects outright
 * where the runtime cannot offer floor-level tracking, so a handheld that would
 * have worked perfectly well in `local` never starts at all. Preference belongs
 * in the reference-space request, where a fallback is possible, not in the
 * session request, where it is fatal. Callers with real requirements pass
 * `sessionInit` explicitly; see `xrTablet.ts`.
 */
const DEFAULT_SESSION_INIT = {
  optionalFeatures: ['local-floor'],
};

export interface XRLifecycle {
  getStatus(): XRStatus;
  /** Ask whether the mode exists here. Safe to call repeatedly. */
  checkSupport(): Promise<boolean>;
  /** Must be called from a user gesture. Resolves when the attempt settles. */
  request(): Promise<void>;
  /** End an active session. A no-op in any other phase. */
  end(): Promise<void>;
  /** Leave the error phase without starting anything. */
  dismissError(): void;
  /** Release listeners. Ends a live session first. */
  dispose(): Promise<void>;
}

export function createXRLifecycle(options: XRLifecycleOptions): XRLifecycle {
  const {
    xr,
    isSecureContext = true,
    presenter,
    mode = DEFAULT_MODE,
    sessionInit = DEFAULT_SESSION_INIT,
    onChange,
    onError,
    cameraPermission = queryCameraPermission,
  } = options;

  let phase: XRPhase = 'idle';
  let failure: XRFailure | null = null;
  let supported: boolean | null = null;
  let visible = true;
  let session: XRSessionLike | null = null;
  let disposed = false;

  // Bound once so add and remove refer to the same function objects. A listener
  // removed by identity is only removed if it is the identity that was added.
  let onSessionEnd: (() => void) | null = null;
  let onVisibilityChange: (() => void) | null = null;

  const status = (): XRStatus => ({ phase, failure, supported, visible });

  const emit = () => {
    // A subscriber that throws is a subscriber's problem. Letting it escape
    // here would abort a transition halfway and leave the phase lying about
    // what the session is doing.
    try {
      onChange?.(status());
    } catch (err) {
      onError?.(err);
    }
  };

  const moveTo = (next: XRPhase, cause: XRFailure | null = null) => {
    phase = next;
    failure = next === 'error' ? cause : null;
    emit();
  };

  const detachListeners = () => {
    if (session) {
      if (onSessionEnd) session.removeEventListener('end', onSessionEnd);
      if (onVisibilityChange) session.removeEventListener('visibilitychange', onVisibilityChange);
    }
    onSessionEnd = null;
    onVisibilityChange = null;
  };

  /**
   * Return to idle from wherever we were.
   *
   * Used by the normal exit, by a session the runtime ended, and by a failed
   * attach. Detaching the presenter is unconditional: it is the only way to be
   * sure the renderer is not left in its XR path with no session behind it.
   */
  const settle = () => {
    detachListeners();
    session = null;
    visible = true;
    try {
      presenter.detach();
    } catch (err) {
      onError?.(err);
    }
    moveTo('idle');
  };

  const checkSupport = async (): Promise<boolean> => {
    // The origin is read first, and that order is the point. A browser withholds
    // `navigator.xr` entirely on an insecure origin, so testing for the object
    // first concludes "this device cannot do AR" about a device that can. The
    // operator then goes looking for a tablet, when what they needed was
    // `adb reverse` or HTTPS.
    if (!isSecureContext) {
      supported = false;
      return false;
    }
    if (!xr) {
      supported = false;
      return false;
    }
    try {
      supported = await xr.isSessionSupported(mode);
    } catch (err) {
      // A throwing probe is a browser that cannot answer, which is the same
      // outcome for the user as a no.
      onError?.(err);
      supported = false;
    }
    return supported;
  };

  const request = async (): Promise<void> => {
    if (disposed) return;
    // One request at a time. Two entry taps in quick succession used to be the
    // reliable way to end up with a session nobody holds a reference to.
    if (phase !== 'idle' && phase !== 'error') return;

    moveTo('requesting');

    // The origin first, for the reason given on `checkSupport`.
    if (!isSecureContext) {
      supported = false;
      moveTo('error', 'insecure-context');
      return;
    }
    if (!xr) {
      supported = false;
      moveTo('error', 'unsupported-browser');
      return;
    }

    /*
     * Straight to `requestSession`, with no probe awaited on the way.
     *
     * `requestSession` requires transient user activation, and awaiting
     * anything first spends it: the promise resolves in a later task, by which
     * time the activation from the tap is gone and the request is rejected for
     * a reason that has nothing to do with the device. The support probe is a
     * preflight the interface runs when the asset is ready, and its answer is
     * what decides whether the control is offered at all. A cached `false` is
     * honoured here; a cached `null` means nobody probed, and the rejection
     * below will say why far more accurately than a guess would.
     */
    if (supported === false) {
      moveTo('error', 'unsupported-mode');
      return;
    }

    let started: XRSessionLike;
    try {
      const init = typeof sessionInit === 'function' ? (sessionInit as () => unknown)() : sessionInit;
      started = await xr.requestSession(mode, init);
    } catch (err) {
      onError?.(err);
      let cause = classifyRequestFailure(err);
      /*
       * A block can arrive dressed as an unsupported device.
       *
       * Chrome on Android rejects with `NotSupportedError`, not
       * `NotAllowedError`, when the site's AR or camera permission is blocked,
       * so the user was told their tablet cannot do AR (found on the device,
       * 29 October 2026). A blocked camera can be read and is called a denial.
       * The AR permission cannot be queried, but if the support probe already
       * said this mode exists here, a block is the likely cause, and the copy
       * says so. Asked only now, after the request: awaiting anything before
       * it would spend the activation.
       */
      if (cause === 'unsupported-mode') {
        if ((await cameraPermission()) === 'denied') cause = 'denied';
        else if (supported === true) cause = 'refused';
      }
      moveTo('error', cause);
      return;
    }

    // Disposed while the request was in flight: nobody is going to draw this,
    // so give it straight back rather than leaking a live session. The phase
    // has to come back to idle with it — `dispose` ran while this was still
    // `requesting` and could not clear a session it had not been handed, so
    // leaving it here would strand the lifecycle in the one phase that refuses
    // every subsequent request. Set directly rather than through `moveTo`, as
    // `dispose` does: a disposed lifecycle has no business emitting.
    if (disposed) {
      await started.end().catch((err) => onError?.(err));
      phase = 'idle';
      failure = null;
      return;
    }

    session = started;
    onSessionEnd = () => {
      // The runtime can end a session without being asked: the user leaves
      // through the browser's own affordance, or a system action takes it. This
      // is the same path as a deliberate exit, which is why both go through
      // `settle`.
      //
      // Unconditional, and not only from `active`. The end can arrive while
      // `attach` is still awaiting a reference space, when the phase is still
      // `requesting`; ignoring it there left the dead session in place and the
      // attach that followed announced it as live.
      if (session === started) settle();
    };
    onVisibilityChange = () => {
      visible = (session?.visibilityState ?? 'visible') === 'visible';
      emit();
    };
    session.addEventListener('end', onSessionEnd);
    session.addEventListener('visibilitychange', onVisibilityChange);

    try {
      await presenter.attach(started);
    } catch (err) {
      // A renderer that cannot adopt the session leaves a live session with
      // nothing drawing it. End it and report, rather than sitting in `active`
      // with a black display.
      onError?.(err);
      detachListeners();
      session = null;
      await started.end().catch((endErr) => onError?.(endErr));
      try {
        presenter.detach();
      } catch (detachErr) {
        onError?.(detachErr);
      }
      moveTo('error', classifyAttachFailure(err));
      return;
    }

    /*
     * Attach can take a while — it acquires a reference space — and two things
     * can happen inside it. The component can unmount, or the runtime can end
     * the session. Either way `settle` or `dispose` has already run and put us
     * back to idle, and announcing `active` now would publish a session that no
     * longer exists: the interface would show an exit control for nothing, and
     * the renderer would be left attached to a dead session. `session` is the
     * witness, because both paths clear it.
     */
    if (disposed || session !== started) {
      // `dispose` ends the session it finds and `settle` runs when the runtime
      // ends one, so by here the session is already accounted for and the phase
      // is already back to idle. All that is left is to undo the half-finished
      // attach, and to say nothing.
      try {
        presenter.detach();
      } catch (detachErr) {
        onError?.(detachErr);
      }
      return;
    }

    visible = (started.visibilityState ?? 'visible') === 'visible';
    moveTo('active');
  };

  const end = async (): Promise<void> => {
    if (phase !== 'active') return;
    const live = session;
    moveTo('ending');
    try {
      await live?.end();
    } catch (err) {
      onError?.(err);
    }
    // Ending a session fires its `end` event, and that listener settles us. So
    // by the time the await returns this is usually already done, and settling
    // twice would detach the presenter twice. `settle` clears the session, so
    // still holding one is exactly the case where the event did not arrive —
    // which is also the condition TypeScript can check, where a phase
    // comparison here looks unreachable to it.
    if (session) settle();
  };

  const dismissError = () => {
    if (phase === 'error') moveTo('idle');
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    // Keyed on holding a session, not on the phase. A session exists from the
    // moment `requestSession` resolves, which is before the phase reaches
    // `active`: unmounting inside `attach` used to fall through the phase test
    // and leave a live session running with nothing drawing it.
    const live = session;
    detachListeners();
    session = null;
    if (live) {
      try {
        await live.end();
      } catch (err) {
        onError?.(err);
      }
      try {
        presenter.detach();
      } catch (err) {
        onError?.(err);
      }
    }
    phase = 'idle';
    failure = null;
    visible = true;
  };

  return { getStatus: status, checkSupport, request, end, dismissError, dispose };
}
