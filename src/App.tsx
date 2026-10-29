import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Scene } from './components/Scene';
import { TopBar } from './components/TopBar';
import { Dock } from './components/Dock';
import { Viewport } from './components/Viewport';
import { TimelineBar } from './components/TimelineBar';
import { StatusBar } from './components/StatusBar';
import { Dialogs } from './components/Dialogs';
import { Dialog } from './components/Dialog';
import { ViewGizmo } from './components/ViewGizmo';
import { LoadingScreen } from './components/LoadingScreen';
import { TabletARControls, XRFailureNotice } from './components/TabletARControls';
import { useStore } from './store';
import { useNarrowLayout } from './hooks/useNarrowLayout';
import { getActiveRange, getHasPendingEdit, getWorkingClip } from './store/derive';
import { AlertIcon, CheckIcon, CloseIcon } from './components/icons';
import type { CameraViewControls, XRSessionControls } from './types';
import './App.css';

/** Shortcuts, listed in one place because the sheet and the handlers drift. */
const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['← / →', 'Step one frame'],
  ['Shift + ← / →', 'Step ten frames'],
  ['I / O', 'Set trim in / out at the playhead'],
  ['[ / ]', 'Nudge the last-touched trim handle'],
  ['Esc', 'Leave the trim tool, or close a dialog'],
];

/**
 * The shell: toolbar, viewport with the dock beside it, timeline, status bar.
 *
 * Everything is in flow (CSS grid); the only overlays are the view gizmo, the
 * toast and modals. State lives in the store — this component composes.
 */
function App() {
  // Asset / bake
  const model = useStore((s) => s.model);
  const sourceClip = useStore((s) => s.sourceClip);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const motion = useStore((s) => s.motion);
  const setMotion = useStore((s) => s.setMotion);
  const applied = useStore((s) => s.applied);
  const editState = useStore((s) => s.editState);

  // View
  const showSkeleton = useStore((s) => s.showSkeleton);
  const showMesh = useStore((s) => s.showMesh);
  const showGrid = useStore((s) => s.showGrid);
  const showOnionSkin = useStore((s) => s.showOnionSkin);
  const showMotionTrail = useStore((s) => s.showMotionTrail);

  // UI
  const narrow = useNarrowLayout();
  const dockOpen = useStore((s) => s.dockOpen);
  const setDockOpen = useStore((s) => s.setDockOpen);
  const trimMode = useStore((s) => s.trimMode);
  const setRendererFps = useStore((s) => s.setRendererFps);
  const toast = useStore((s) => s.toast);
  const toastTone = useStore((s) => s.toastTone);
  const setToast = useStore((s) => s.setToast);
  const announcement = useStore((s) => s.announcement);
  const xrPhase = useStore((s) => s.xrPhase);
  const xrPresenting = xrPhase === 'active' || xrPhase === 'ending';

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /*
   * The AR overlay root, owned here rather than by the session.
   *
   * The runtime is handed this element when the session is requested, so it has
   * to be in the document already and keep the same identity across sessions.
   * It renders nothing and takes no pointer events until a session is running.
   */
  const xrOverlayRef = useRef<HTMLDivElement | null>(null);
  const [xrControls, setXrControls] = useState<XRSessionControls | null>(null);
  const xrSupported = useStore((s) => s.xrSupported);

  // Memoized so the overlay is not rebuilt on every render of the shell.
  const xrActions = useMemo(
    () => ({
      onExit: () => xrControls?.exit(),
      onPlaceHere: () => xrControls?.placeHere(),
      onReposition: () => xrControls?.beginReposition(),
      onCancelReposition: () => xrControls?.cancelReposition(),
    }),
    [xrControls]
  );

  /*
   * Probe once there is something to place. Deliberately here and not in the
   * click handler: `requestSession` needs the transient activation from the
   * tap, and awaiting a probe first spends it.
   */
  useEffect(() => {
    if (!xrControls || !model || !motion) return;
    void xrControls.probeSupport();
  }, [xrControls, model, motion]);

  const workingClip = useMemo(
    () => getWorkingClip({ applied, sourceClip }),
    [applied, sourceClip]
  );

  // Playback previews the pending trim only while the trim tool is armed.
  const playbackRange = useMemo(() => {
    if (!trimMode || !getHasPendingEdit({ editState, motion })) return null;
    return getActiveRange({ editState, motion });
  }, [trimMode, editState, motion]);

  // The loader's error surfaces through the toast channel.
  useEffect(() => {
    if (error.hasError) setToast(error.message, 'error');
  }, [error, setToast]);

  // Keep a ref so onLoad always has the latest camControls (avoids stale closure)
  const [camControls, setCamControls] = useState<CameraViewControls | null>(null);
  const camControlsRef = useRef<CameraViewControls | null>(null);
  const handleCameraReady = useCallback((controls: CameraViewControls | null) => {
    camControlsRef.current = controls;
    setCamControls(controls);
  }, []);

  /**
   * Auto-focus on load — but only for a genuinely new model. Scene re-runs its
   * model effect whenever the clip changes (every apply); framing the camera
   * again then would yank the view mid-edit.
   *
   * Keyed on the bake rather than a timer. This used to fire 100ms after load
   * "to let three.js finish", which is a guess about how long a parse takes: on
   * the ten-second fixture the framing ran before the bake existed and the
   * camera was left at its start position. Framing also *wants* the bake, since
   * that is what covers the clip's limb excursions rather than one pose.
   */
  const focusedModelRef = useRef<THREE.Object3D | null>(null);
  useEffect(() => {
    if (!model || !motion) return;
    if (focusedModelRef.current === model) return;
    focusedModelRef.current = model;
    camControlsRef.current?.focusModel();
  }, [model, motion]);

  // "?" opens the shortcut sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // On a narrow screen the dock is a drawer, and it should start closed —
  // opening one over the viewport by default would hide the thing being viewed.
  const dockWasNarrow = useRef(narrow);
  useEffect(() => {
    if (dockWasNarrow.current !== narrow) {
      dockWasNarrow.current = narrow;
      setDockOpen(!narrow);
    }
  }, [narrow, setDockOpen]);

  return (
    <div className={`app ${narrow ? 'is-narrow' : ''}`}>
      <TopBar
        onShowShortcuts={() => setShortcutsOpen(true)}
        onEnterAR={xrSupported && xrControls ? xrControls.enter : null}
        narrow={narrow}
      />

      <div className="app-body">
        <Viewport>
          <Scene
            animationClip={workingClip || undefined}
            showSkeleton={showSkeleton}
            showMesh={showMesh}
            showGrid={showGrid}
            showOnionSkin={showOnionSkin}
            showMotionTrail={showMotionTrail}
            onCameraReady={handleCameraReady}
            onFpsUpdate={setRendererFps}
            onMotionData={setMotion}
            playbackRange={playbackRange}
            xrOverlayRef={xrOverlayRef}
            onXRReady={setXrControls}
          />
          {/* The gizmo describes a camera the user does not control in AR. */}
          {!xrPresenting && <ViewGizmo controls={camControls} />}
          <XRFailureNotice onDismiss={() => xrControls?.dismissError()} />
        </Viewport>

        {dockOpen && <Dock />}
        {narrow && dockOpen && (
          <button
            className="dock-scrim"
            aria-label="Close panel"
            onClick={() => setDockOpen(false)}
          />
        )}
      </div>

      <TimelineBar />
      <StatusBar />

      {toast && (
        <div className={`toast toast-${toastTone}`} role={toastTone === 'error' ? 'alert' : 'status'}>
          {toastTone === 'error' ? <AlertIcon size={16} /> : <CheckIcon size={16} />}
          <span>{toast}</span>
          <button className="btn-icon" onClick={() => setToast(null)} aria-label="Dismiss">
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {/* Politely announced state changes. Visually hidden, never focusable. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <Dialogs />

      {shortcutsOpen && (
        <Dialog title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)} width={380}>
          <dl className="shortcut-list">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys}>
                <dt className="mono">{keys}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </Dialog>
      )}

      <TabletARControls
        rootRef={xrOverlayRef}
        actions={xrActions}
      />

      <LoadingScreen isLoading={loading.isLoading} progress={loading.progress} />
    </div>
  );
}

export default App;
