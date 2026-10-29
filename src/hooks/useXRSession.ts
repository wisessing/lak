import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  attachFailure,
  createXRLifecycle,
  type XRLifecycle,
  type XRSessionLike,
  type XRSystemLike,
} from '../utils/xrLifecycle';
import type { PresentationState } from '../utils/presentationSpace';
import {
  acquireReferenceSpace,
  buildTabletSessionInit,
  hasDomOverlay,
  type XRReferenceSpaceKind,
} from '../utils/xrTablet';
import { createReticle, type Reticle } from '../utils/xrReticle';
import { placementFromHit } from '../utils/xrPlacement';
import { pickJointAlongRay, pickJointNearRay } from '../utils/jointPicking';
import { useStore } from '../store';
import { withWebGLLayer } from '../utils/xrLayers';

/**
 * The session controller: everything about an immersive session that a store
 * must not hold.
 *
 * The session itself, its reference spaces, its hit-test source and its
 * listeners live in refs here, because they are resources with an order of
 * release rather than values to render from. What the interface renders from
 * goes through `xrSlice`, which holds only serializable state.
 *
 * The desktop viewer's own state is snapshotted on entry and restored on exit,
 * including the failure paths. Three.js takes over the camera during a session
 * and hands it back changed, and placement moves the presentation root;
 * without the snapshot, leaving AR would drop the user somewhere they never
 * chose to be, in front of a subject that had been moved out from under them.
 */

/** What the renderer needs to present a session. Narrowed for testability. */
export interface XRRenderTarget {
  xr: {
    enabled: boolean;
    setReferenceSpaceType(type: string): void;
    setSession(session: XRSessionLike | null): Promise<void> | void;
    isPresenting?: boolean;
  };
}

/** Scratch, module-level: the frame path below must not allocate. */
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _normal = new THREE.Vector3();
const _rayMatrix = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();

/**
 * Hold the handheld session upright.
 *
 * The subject is a standing figure and reads best in a tall frame, and a
 * WebXR session's orientation is otherwise fixed to however the device happened
 * to be held at entry and cannot be turned afterwards. The DOM overlay puts the
 * page in fullscreen, which is the state the Screen Orientation API needs, so
 * the session can be pinned to portrait for its whole life and released on the
 * way out. It is best-effort: a platform without the API, or one that refuses
 * the lock, simply keeps whatever orientation it started in.
 */
type OrientationLockTarget = 'portrait' | 'landscape' | 'natural' | 'any';
interface LockableOrientation {
  lock?: (orientation: OrientationLockTarget) => Promise<void>;
  unlock?: () => void;
}
function lockSessionOrientation(target: OrientationLockTarget): void {
  const orientation = (screen as Screen & { orientation?: LockableOrientation }).orientation;
  try {
    const result = orientation?.lock?.(target);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Not available, or refused because the platform will not turn the display.
  }
}
function unlockSessionOrientation(): void {
  const orientation = (screen as Screen & { orientation?: LockableOrientation }).orientation;
  try {
    orientation?.unlock?.();
  } catch {
    // Nothing to release, or the API is absent.
  }
}

/**
 * Everything the ordinary viewer had before a session, so exit can put it back.
 *
 * Presentation is in here deliberately. A placement writes the same transform
 * the desktop uses, so without restoring it the subject is left wherever the
 * room's floor happened to be, and the desktop camera is pointing at nothing.
 */
interface SessionSnapshot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  near: number;
  far: number;
  target: THREE.Vector3 | null;
  presentation: PresentationState;
}

export interface UseXRSessionOptions {
  renderer: XRRenderTarget | null;
  camera: THREE.PerspectiveCamera | null;
  /**
   * OrbitControls and the overlay element are passed as refs, not as values.
   * Both are read only inside the presenter and the callbacks below, which run
   * outside render; reading `.current` during render is what this codebase
   * already had to correct once in the camera rig.
   */
  controlsRef: React.RefObject<{ enabled: boolean; target: THREE.Vector3 } | null>;
  /** The stable element the runtime composites over the camera view. */
  overlayRootRef: React.RefObject<Element | null>;
  /** Reset the frame clock; a session change is not elapsed time. */
  onTimingReset?: () => void;
  /** Measure the page again once the runtime lets go of the render target. */
  onRemeasure?: () => void;
  /** Called after the camera pose is written back, so a restored pose holds. */
  onCameraRestored?: () => void;
  /** The session's own space, where the reticle lives. Not the subject's. */
  scene: THREE.Scene | null;
  /** The joint markers, for screen-ray selection. */
  markers: THREE.Object3D | null | undefined;
}

export interface UseXRSessionResult {
  /**
   * Advance the reticle and the hit test. Called from the one frame callback
   * with that frame's `XRFrame`, never from a loop of its own.
   */
  updateFromFrame: (frame: XRFrame) => void;
  /**
   * Whether the clip may advance this frame.
   *
   * False while the runtime has hidden the session or the frame carried no
   * viewer pose. The playing intention is untouched; only the effective
   * advancement stops, and it resumes without catching up.
   */
  canAdvance: () => boolean;
  /** Commit the reticle's current pose. Ignored without a valid surface. */
  placeHere: () => void;
  /** Put the reticle back up, keeping the current placement until committed. */
  beginReposition: () => void;
  /** Abandon a reposition and keep the placement it started from. */
  cancelReposition: () => void;
  /** Probe mode support. Call when the page is ready, never inside the gesture. */
  probeSupport: () => Promise<boolean>;
  /** Must be called directly from a user gesture. */
  enter: () => void;
  exit: () => void;
  dismissError: () => void;
  /** The active reference space, for the frame loop. Null outside a session. */
  referenceSpaceRef: React.RefObject<XRReferenceSpace | null>;
  sessionRef: React.RefObject<XRSession | null>;
}

export function useXRSession({
  renderer,
  camera,
  controlsRef,
  overlayRootRef,
  onTimingReset,
  onRemeasure,
  onCameraRestored,
  scene,
  markers,
}: UseXRSessionOptions): UseXRSessionResult {
  const sessionRef = useRef<XRSession | null>(null);
  const referenceSpaceRef = useRef<XRReferenceSpace | null>(null);
  const referenceKindRef = useRef<XRReferenceSpaceKind | null>(null);
  const snapshotRef = useRef<SessionSnapshot | null>(null);
  const lifecycleRef = useRef<XRLifecycle | null>(null);

  // Placement resources. All session-scoped, all released on detach.
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const viewerSpaceRef = useRef<XRReferenceSpace | null>(null);
  const reticleRef = useRef<Reticle | null>(null);
  /** The last hit good enough to stand on, or null. Never a stale one. */
  const validHitRef = useRef<{ position: THREE.Vector3; normal: THREE.Vector3 } | null>(null);
  const viewerPositionRef = useRef(new THREE.Vector3());
  const raycasterRef = useRef(new THREE.Raycaster());
  /** Whether the most recent frame carried a viewer pose. */
  const poseAvailableRef = useRef(true);
  /** Mirrors the lifecycle's visibility, for the frame path to read cheaply. */
  const visibleRef = useRef(true);
  /** The asset the session was entered with. A different one ends it. */
  const modelAtEntryRef = useRef<unknown>(null);
  /**
   * Incremented by every detach. An attach that resumes from an await and finds
   * the count has moved knows the session it was setting up is already gone,
   * and must give back whatever it just acquired rather than install it.
   */
  const attachGenerationRef = useRef(0);
  // The select listener is built inside the presenter, which is created before
  // the callbacks below exist. A ref is what bridges that, without rebuilding
  // the lifecycle every time a callback identity changes.
  const placeHereRef = useRef<(() => void) | null>(null);
  /** Bound once each, so removal by identity actually removes them. */
  const onXRSelectRef = useRef<((event: XRInputSourceEvent) => void) | null>(null);
  const onSpaceResetRef = useRef<(() => void) | null>(null);
  const previousPlacementRef = useRef<PresentationState | null>(null);
  const sceneRef = useRef(scene);
  const markersRef = useRef(markers);

  // Read through refs inside the presenter, which is built once: the presenter
  // outlives any single render, and closing over a stale renderer would attach
  // the session to something that has been disposed.
  const rendererRef = useRef(renderer);
  const cameraRef = useRef(camera);
  const timingResetRef = useRef(onTimingReset);
  const remeasureRef = useRef(onRemeasure);
  const cameraRestoredRef = useRef(onCameraRestored);

  // Mirrors are written in an effect, not during render.
  useEffect(() => {
    sceneRef.current = scene;
    markersRef.current = markers;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    timingResetRef.current = onTimingReset;
    remeasureRef.current = onRemeasure;
    cameraRestoredRef.current = onCameraRestored;
  });

  const setXrStatus = useStore((s) => s.setXrStatus);
  const setXrHasSurface = useStore((s) => s.setXrHasSurface);
  const setXrPlacement = useStore((s) => s.setXrPlacement);
  const setXrSupported = useStore((s) => s.setXrSupported);
  const setXrSession = useStore((s) => s.setXrSession);

  /**
   * Put the ordinary viewer back exactly as it was. Safe to call twice: the
   * snapshot is consumed on the first call, so a second restores nothing and
   * cannot undo a change the user made in between.
   */
  const restoreDesktop = useCallback(() => {
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    const cam = cameraRef.current;
    const orbit = controlsRef.current;
    if (orbit) orbit.enabled = true;
    if (snapshot) {
      if (cam) {
        cam.position.copy(snapshot.position);
        cam.quaternion.copy(snapshot.quaternion);
        cam.fov = snapshot.fov;
        cam.near = snapshot.near;
        cam.far = snapshot.far;
        cam.updateProjectionMatrix();
        if (snapshot.target && orbit) orbit.target.copy(snapshot.target);
        // A transition that was in flight when the session began must not
        // resume against a pose it was never computed from.
        cameraRestoredRef.current?.();
      }
      // The pre-session display transform, never the AR placement: that
      // belonged to a floor in a room the desktop cannot see.
      useStore.getState().setPresentation(snapshot.presentation);
    }
    timingResetRef.current?.();
    // The page may have changed shape while sizing was suppressed. Nothing else
    // will replay that observation, so ask for it here — but after three.js has
    // finished ending the session. This runs inside the session's `end` event,
    // before three.js's own handler clears `isPresenting` and restores the
    // drawing buffer; the resize path is a no-op while presenting, so a
    // remeasure now would be dropped. A microtask runs once the event's
    // listeners have all completed, by which point the renderer is back to its
    // ordinary state and the measurement takes.
    queueMicrotask(() => remeasureRef.current?.());
  }, [controlsRef]);

  /** Drop any placement in progress. The subject follows the placement mode. */
  const clearPlacement = useCallback(() => {
    validHitRef.current = null;
    reticleRef.current?.setVisible(false);
    setXrHasSurface(false);
  }, [setXrHasSurface]);

  /**
   * Resolve a screen tap in AR to a joint, through the same resolver the page
   * uses.
   *
   * Two attempts, in order. The target ray is exact and is what a precise tap
   * deserves. Where it misses, the screen-space fallback widens the target to a
   * finger's width — the same tolerance the page applies, and the reason a 6 mm
   * marker is selectable at all. The fallback is given the *session's* camera
   * and the overlay's own size: using the saved desktop projection would
   * resolve against a view nobody is looking through.
   */
  const selectJointFromRay = useCallback(
    (event: XRInputSourceEvent) => {
      const space = referenceSpaceRef.current;
      const found = markersRef.current;
      if (!space || !found) return;

      const pose = event.frame?.getPose?.(event.inputSource.targetRaySpace, space);
      if (!pose) return;

      _rayMatrix.fromArray(pose.transform.matrix);
      _origin.setFromMatrixPosition(_rayMatrix);
      // The target ray points down its own -Z, as every XR pose does.
      _direction
        .set(0, 0, -1)
        .applyQuaternion(_quaternion.setFromRotationMatrix(_rayMatrix))
        .normalize();
      raycasterRef.current.set(_origin, _direction);

      // The target ray of a screen tap passes through the touched point, so
      // the joint nearest it, by angle, is the one under the finger. The
      // centre of the view is not: aiming there made every tap away from the
      // middle a miss on the device.
      const id =
        pickJointAlongRay(raycasterRef.current, found) ??
        pickJointNearRay(raycasterRef.current.ray, found);

      if (id) useStore.getState().selectJoint(id);
      else useStore.getState().noteXrPickMiss();
    },
    []
  );

  useEffect(() => {
    const xr = (navigator as unknown as { xr?: XRSystemLike }).xr ?? null;

    const lifecycle = createXRLifecycle({
      xr,
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : true,
      mode: 'immersive-ar',
      // A function, not a value: it is resolved when the session is requested,
      // so the overlay named is the element mounted at that moment.
      sessionInit: () => {
        const root = overlayRootRef.current;
        return root ? buildTabletSessionInit(root) : undefined;
      },
      presenter: {
        async attach(session) {
          const target = rendererRef.current;
          const cam = cameraRef.current;
          if (!target) throw new Error('no renderer to present with');

          /*
           * Every await below is a place the session can be ended or the
           * component unmounted. `detach` moves the generation; an attach that
           * finds it moved gives back what it holds and stops, without ever
           * installing a dead session on the renderer or publishing it as live.
           * The lifecycle's own stale-session check then detaches once more,
           * which is idempotent here.
           */
          const generation = attachGenerationRef.current;
          const stale = () => attachGenerationRef.current !== generation;

          // The overlay has to be real before anything else is committed: a
          // session the user cannot see controls in, and cannot leave, is worse
          // than one that never started.
          if (!hasDomOverlay(session)) {
            throw attachFailure('no-dom-overlay', 'the runtime did not grant a DOM overlay');
          }

          const live = session as unknown as XRSession;
          const { space, type } = await acquireReferenceSpace(
            live as unknown as { requestReferenceSpace(t: string): Promise<XRReferenceSpace> }
          );
          if (stale()) return;

          // Snapshot before three.js touches the camera and before any
          // placement touches the presentation, not after either.
          if (cam) {
            snapshotRef.current = {
              position: cam.position.clone(),
              quaternion: cam.quaternion.clone(),
              fov: cam.fov,
              near: cam.near,
              far: cam.far,
              target: controlsRef.current ? controlsRef.current.target.clone() : null,
              presentation: { ...useStore.getState().presentation },
            };
          }
          if (controlsRef.current) controlsRef.current.enabled = false;
          modelAtEntryRef.current = useStore.getState().model;

          /*
           * The hit test comes from `viewer` space, not from the world space
           * above: what the user aims is the device, so the ray is the one
           * straight out of the screen. The result is then read back in the
           * rendering space, which is the only frame the placement may be
           * expressed in.
           */
          const viewerSpace = await live.requestReferenceSpace('viewer');
          if (stale()) return;
          const hitTestSource = await live.requestHitTestSource?.({ space: viewerSpace });
          if (stale()) {
            // Acquired for a session that is already gone. Nothing else knows
            // this source exists, so nothing else will ever cancel it.
            hitTestSource?.cancel?.();
            return;
          }

          referenceSpaceRef.current = space;
          referenceKindRef.current = type;
          viewerSpaceRef.current = viewerSpace;
          hitTestSourceRef.current = hitTestSource ?? null;
          sessionRef.current = live;
          poseAvailableRef.current = true;

          const reticle = createReticle();
          reticleRef.current = reticle;
          sceneRef.current?.add(reticle.object);
          previousPlacementRef.current = { ...useStore.getState().presentation };

          /*
           * A touch on the camera view arrives as `select` from a transient
           * input source whose target ray mode is `screen`. It means one of two
           * things depending on what the user is doing: commit the reticle, or
           * pick a joint. It never means both, and it is never also processed
           * by the page's pointer path, which is suspended for the duration.
           *
           * A touch on an overlay control does not reach here at all: the
           * control cancels `beforexrselect` so the runtime withholds the event.
           */
          const onSelect = (event: XRInputSourceEvent) => {
            if (event.inputSource?.targetRayMode !== 'screen') return;
            const mode = useStore.getState().xrPlacement;
            if (mode === 'unplaced' || mode === 'repositioning') {
              placeHereRef.current?.();
              return;
            }
            selectJointFromRay(event);
          };
          onXRSelectRef.current = onSelect;
          live.addEventListener('select', onSelect as EventListener);

          /*
           * A reference-space `reset` means the runtime has moved its origin:
           * tracking recovered somewhere else, or the user asked for a recentre.
           * A placement expressed in the old frame now describes nowhere in
           * particular, so it is withdrawn and the user is asked to place again.
           * A screen rotation is not this event and does not clear anything.
           */
          const onReset = () => {
            clearPlacement();
            previousPlacementRef.current = null;
            setXrPlacement('unplaced');
          };
          onSpaceResetRef.current = onReset;
          space.addEventListener('reset', onReset);

          // Order matters: three.js reads the reference-space type when the
          // session is set, and its installed default is `local-floor`. Setting
          // it afterwards leaves the first frames in the wrong space.
          target.xr.setReferenceSpaceType(type);
          target.xr.enabled = true;
          await withWebGLLayer(() => target.xr.setSession(session));
          if (stale()) return;

          // Fullscreen is in force now that the overlay session is set, which
          // is what the orientation lock needs. Pin it upright for a standing
          // subject; released in detach.
          lockSessionOrientation('portrait');

          setXrSession({ domOverlay: true, referenceSpace: type });
          timingResetRef.current?.();
        },

        detach() {
          attachGenerationRef.current++;
          // Give the display back to the system's own rotation.
          unlockSessionOrientation();
          const target = rendererRef.current;
          // Placement resources first: they are session-scoped and a hit-test
          // source outliving its session is a leak nothing else will collect.
          const liveSession = sessionRef.current;
          if (liveSession && onXRSelectRef.current) {
            liveSession.removeEventListener('select', onXRSelectRef.current as EventListener);
          }
          onXRSelectRef.current = null;
          const space = referenceSpaceRef.current;
          if (space && onSpaceResetRef.current) {
            space.removeEventListener('reset', onSpaceResetRef.current);
          }
          onSpaceResetRef.current = null;
          hitTestSourceRef.current?.cancel?.();
          hitTestSourceRef.current = null;
          viewerSpaceRef.current = null;
          validHitRef.current = null;
          reticleRef.current?.dispose();
          reticleRef.current = null;
          referenceSpaceRef.current = null;
          referenceKindRef.current = null;
          sessionRef.current = null;
          modelAtEntryRef.current = null;
          poseAvailableRef.current = true;
          if (target) {
            /*
             * Do not null the renderer's session here.
             *
             * A session's `end` event drives two listeners: three.js's own,
             * which nulls its internal session, stops the XR animation loop,
             * restores the drawing-buffer size and restarts the ordinary loop;
             * and this one. This listener runs first, because it was registered
             * before three.js adopted the session. Calling `setSession(null)`
             * from here nulls three.js's session out from under it, so its
             * handler then dereferences a null and throws, and the renderer is
             * left presenting with a dead session and a stopped loop — the
             * subject vanishes on exit. Letting three.js's own handler run is
             * what restores ordinary rendering, so this only marks the manager
             * disabled, which its handler does not touch and which cannot throw.
             */
            target.xr.enabled = false;
          }
          restoreDesktop();
        },
      },
      onChange: (status) => {
        // Coming back from hidden is a fresh start, not a long frame.
        if (status.visible && !visibleRef.current) timingResetRef.current?.();
        visibleRef.current = status.visible;
        setXrStatus({
          phase: status.phase,
          failure: status.failure,
          visible: status.visible,
        });
        if (status.phase === 'active') setXrSupported(true);
      },
      onError: (err) => {
        if (import.meta.env.DEV) console.warn('[xr]', err);
      },
    });

    lifecycleRef.current = lifecycle;

    /*
     * An asset that changes identity during a session ends it.
     *
     * The placement belongs to the subject that was placed. Its replacement is
     * a different rig at a different scale and origin, and standing it where
     * the old one stood is not a placement anyone made. Ending the session
     * restores the pre-session presentation, which is the desktop's, not the
     * room's. A clip edit keeps the same model object and passes through.
     */
    const unsubscribeModel = useStore.subscribe(
      (s) => s.model,
      (model) => {
        if (lifecycle.getStatus().phase !== 'active') return;
        if (model !== modelAtEntryRef.current) void lifecycle.end();
      }
    );

    // A rotation changes the runtime's views, not the page's, and the frame
    // that follows one should not be charged for the time the rotation took.
    const onOrientation = () => {
      if (lifecycle.getStatus().phase === 'active') timingResetRef.current?.();
    };
    window.addEventListener('orientationchange', onOrientation);

    return () => {
      window.removeEventListener('orientationchange', onOrientation);
      unsubscribeModel();
      lifecycleRef.current = null;
      void lifecycle.dispose();
    };
  }, [
    clearPlacement,
    controlsRef,
    overlayRootRef,
    restoreDesktop,
    selectJointFromRay,
    setXrPlacement,
    setXrSession,
    setXrStatus,
    setXrSupported,
  ]);

  /*
   * One frame of placement work, called from the single frame callback.
   *
   * Everything here is read from *this* frame. A hit cached from an earlier one
   * is worthless the moment tracking moves or drops: committing it would stand
   * the subject where the surface used to appear to be.
   */
  const updateFromFrame = useCallback(
    (frame: XRFrame) => {
      const space = referenceSpaceRef.current;
      const reticle = reticleRef.current;
      const source = hitTestSourceRef.current;
      const mode = useStore.getState().xrPlacement;
      if (!space || !reticle) return;

      const aiming = mode === 'unplaced' || mode === 'repositioning';

      // No viewer pose means tracking is lost. Placement and picking stop until
      // it returns; the existing placement stays exactly where it was.
      const viewerPose = frame.getViewerPose(space);
      poseAvailableRef.current = !!viewerPose;
      if (!viewerPose) {
        clearPlacement();
        return;
      }
      const t = viewerPose.transform.position;
      viewerPositionRef.current.set(t.x, t.y, t.z);

      if (!aiming || !source) {
        clearPlacement();
        return;
      }

      const results = frame.getHitTestResults(source);
      const pose = results.length > 0 ? results[0].getPose(space) : null;
      if (!pose) {
        clearPlacement();
        return;
      }

      const p = pose.transform.position;
      const o = pose.transform.orientation;
      _position.set(p.x, p.y, p.z);
      _quaternion.set(o.x, o.y, o.z, o.w);
      // A hit pose's own up axis is the surface normal.
      _normal.set(0, 1, 0).applyQuaternion(_quaternion);

      const candidate = placementFromHit({
        hit: { x: _position.x, y: _position.y, z: _position.z },
        normal: { x: _normal.x, y: _normal.y, z: _normal.z },
        viewer: viewerPositionRef.current,
      });

      if (!candidate) {
        // A wall or a ceiling is a hit, and not a place to stand.
        clearPlacement();
        return;
      }

      validHitRef.current = {
        position: _position.clone(),
        normal: _normal.clone(),
      };
      reticle.place(_position, _quaternion);
      reticle.setVisible(true);
      setXrHasSurface(true);
    },
    [clearPlacement, setXrHasSurface]
  );

  const canAdvance = useCallback(() => visibleRef.current && poseAvailableRef.current, []);

  /**
   * Commit the reticle's current pose.
   *
   * The single guarded path: the overlay's button and a tap on the camera view
   * both call this, so they cannot disagree about what counts as a valid
   * surface or about where the subject ends up.
   */
  const placeHere = useCallback(() => {
    const hit = validHitRef.current;
    if (!hit) return;
    const placement = placementFromHit({
      hit: { x: hit.position.x, y: hit.position.y, z: hit.position.z },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      viewer: viewerPositionRef.current,
      // The size the user chose for this session; life size unless they did.
      scale: useStore.getState().xrScale,
    });
    if (!placement) return;
    useStore.getState().setPresentation(placement);
    setXrPlacement('placed');
    clearPlacement();
  }, [clearPlacement, setXrPlacement]);

  // In an effect, not during render: writing a ref while rendering is the
  // error this codebase already had to correct in the camera rig.
  useEffect(() => {
    placeHereRef.current = placeHere;
  }, [placeHere]);

  const beginReposition = useCallback(() => {
    // The subject stays exactly where it is until a new spot is committed, so
    // cancelling has something to go back to.
    previousPlacementRef.current = { ...useStore.getState().presentation };
    setXrPlacement('repositioning');
  }, [setXrPlacement]);

  const cancelReposition = useCallback(() => {
    const previous = previousPlacementRef.current;
    // Back to where it was, at whatever size is current: a size chosen while
    // re-aiming is a choice about viewing, not part of the placement being
    // abandoned.
    if (previous) useStore.getState().setPresentation({ ...previous, scale: useStore.getState().xrScale });
    setXrPlacement('placed');
    clearPlacement();
  }, [clearPlacement, setXrPlacement]);

  const probeSupport = useCallback(async () => {
    const supported = (await lifecycleRef.current?.checkSupport()) ?? false;
    setXrSupported(supported);
    return supported;
  }, [setXrSupported]);

  // Deliberately not async and deliberately not awaited by the caller: the
  // click handler must reach `requestSession` in the same task as the gesture.
  const enter = useCallback(() => {
    void lifecycleRef.current?.request();
  }, []);

  const exit = useCallback(() => {
    void lifecycleRef.current?.end();
  }, []);

  const dismissError = useCallback(() => {
    lifecycleRef.current?.dismissError();
  }, []);

  // Memoized, because the shell publishes this object upward in an effect. A
  // fresh object every render makes that effect fire every render, which sets
  // state, which renders again: React stops it with "Maximum update depth
  // exceeded", and the whole session never gets off the ground.
  return useMemo(
    () => ({
      probeSupport,
      enter,
      exit,
      dismissError,
      updateFromFrame,
      canAdvance,
      placeHere,
      beginReposition,
      cancelReposition,
      referenceSpaceRef,
      sessionRef,
    }),
    [
      probeSupport,
      enter,
      exit,
      dismissError,
      updateFromFrame,
      canAdvance,
      placeHere,
      beginReposition,
      cancelReposition,
    ]
  );
}
