import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import {
  BoneIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  MeshIcon,
  OnionIcon,
  PauseIcon,
  PlayBackIcon,
  PlayIcon,
  StepBackIcon,
  StepForwardIcon,
  StopIcon,
  TargetIcon,
  TrailIcon,
} from './icons';
import './TabletARControls.css';

/**
 * The controls that sit over the camera view during a handheld AR session.
 *
 * This element is the session's `dom-overlay` root, and it is mounted at all
 * times whether or not a session is running: the runtime is handed it when the
 * session is requested, so it has to already exist and keep its identity.
 * Outside a session it renders nothing and takes no pointer events.
 *
 * Everything here drives the same store actions the page uses. There is no
 * second playhead and no second selection — whichever surface the user touches,
 * they are moving the same one. The trim and export editor is deliberately
 * absent: those change the clip, and a session is for looking at it.
 *
 * The layout is the page's own, rearranged for a camera view: the status and
 * the way out sit in a strip along the top, and once the subject is placed a
 * bar along the bottom carries the same transport, readout, overlay toggles and
 * speed field as the timeline bar, in the same order and with the same icons,
 * so nothing has to be relearned between the desk and the room.
 */

/** What to tell someone when a session will not start. */
const FAILURE_TEXT: Record<string, { title: string; detail: string }> = {
  'unsupported-browser': {
    title: 'This browser cannot show AR',
    detail: 'WebXR is unavailable here. Ordinary viewing is unaffected.',
  },
  'insecure-context': {
    title: 'This page is not on a secure origin',
    detail:
      'AR needs HTTPS, or a forwarded localhost address. The device itself may well be capable.',
  },
  'unsupported-mode': {
    title: 'This device cannot start an AR session',
    detail:
      'Camera passthrough, surface detection or the on-screen overlay is unavailable. An ARCore-certified device with Google Play Services for AR is required.',
  },
  refused: {
    title: 'AR did not start',
    detail:
      "If AR or the camera is blocked for this site, allow it in the site's settings (the icon beside the address), then try again. Otherwise this device is missing a feature AR needs.",
  },
  denied: {
    title: 'Camera access was not granted',
    // Once blocked, the browser does not ask again, so say where to undo it.
    detail:
      "AR needs the camera. Allow it in this site's settings (the icon beside the address), then try again.",
  },
  'no-dom-overlay': {
    title: 'Controls could not be shown over the camera',
    detail: 'The session was ended rather than leaving you without a way out of it.',
  },
  'start-failed': {
    title: 'The AR session could not start',
    detail: 'Ordinary viewing is unaffected. Try again.',
  },
};

/**
 * The sizes on offer. Life size is the default and the point of the exercise:
 * the subject is a measurement. The smaller two exist because a handheld
 * session puts one or two metres between the tablet and the floor in front of
 * it, and at that distance a standing figure does not fit in the frame. The
 * scale is applied about the authored origin, which is the floor between the
 * feet, so a smaller subject still stands on the surface it was placed on.
 */
const XR_SIZES: ReadonlyArray<{ scale: number; label: string; text: string }> = [
  { scale: 1, label: 'Life size', text: 'Life size' },
  { scale: 0.5, label: 'Half size', text: '½' },
  { scale: 0.25, label: 'Quarter size', text: '¼' },
];

export interface ARControlActions {
  onExit: () => void;
  onPlaceHere: () => void;
  onReposition: () => void;
  onCancelReposition: () => void;
}

/**
 * A control that must not also act on the scene behind it.
 *
 * Without this, one touch does two things: the button fires, and the runtime
 * also delivers a `select` to the session, which places the subject or picks a
 * joint under the finger. Cancelling `beforexrselect` is how a DOM overlay tells
 * the runtime that this touch was spoken for.
 *
 * Bound per control rather than on the overlay root, deliberately. Cancelling
 * across the whole overlay would swallow every tap on the camera view as well,
 * and the camera view is where placement and inspection happen.
 */
function useSuppressXRSelect<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (event: Event) => event.preventDefault();
    el.addEventListener('beforexrselect', stop);
    return () => el.removeEventListener('beforexrselect', stop);
  }, []);
  return ref;
}

/** A labelled button in the page's own `.btn` family. */
function ARButton({
  label,
  onClick,
  disabled,
  variant = 'default',
  pressed,
  className = '',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'ghost';
  pressed?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const ref = useSuppressXRSelect<HTMLButtonElement>();
  const tone = variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : '';
  return (
    <button
      ref={ref}
      type="button"
      className={`btn ${tone} ${pressed ? 'is-active' : ''} ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children ?? label}
    </button>
  );
}

/** An icon-only button, exactly the timeline bar's `.btn-icon`. */
function ARIconButton({
  label,
  onClick,
  pressed,
  disabled,
  className = '',
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useSuppressXRSelect<HTMLButtonElement>();
  return (
    <button
      ref={ref}
      type="button"
      className={`btn-icon ${pressed ? 'is-active' : ''} ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * Time and frame, written through transient subscriptions rather than renders,
 * the same way the timeline bar does it, so a playing clip costs the overlay no
 * React work at all.
 */
function ARReadout() {
  const duration = useStore((s) => s.duration);
  const frameCount = useStore((s) => s.motion?.frameCount ?? 0);
  const lastFrame = Math.max(0, frameCount - 1);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const paint = (time: number) => {
      if (timeRef.current) timeRef.current.textContent = time.toFixed(2);
    };
    paint(useStore.getState().playheadTime);
    return useStore.subscribe((s) => s.playheadTime, paint);
  }, []);

  useEffect(() => {
    const paint = (frame: number) => {
      if (frameRef.current) frameRef.current.textContent = `${Math.min(frame, lastFrame)}`;
    };
    paint(useStore.getState().playheadFrame);
    return useStore.subscribe((s) => s.playheadFrame, paint);
  }, [lastFrame]);

  // The current time and frame count up as the clip plays, so their digit
  // count changes. Each varying value gets a fixed slot wide enough for its
  // largest form — the full duration, the last frame — so the readout, and with
  // it the whole floating bar, keeps one width instead of jostling every frame.
  const timeSlot = `${duration.toFixed(2).length}ch`;
  const frameSlot = `${String(lastFrame).length}ch`;

  return (
    <div className="xr-readout" aria-label="Playhead">
      <span className="xr-time">
        <span className="xr-num" ref={timeRef} style={{ minWidth: timeSlot }}>
          0.00
        </span>{' '}
        / {duration.toFixed(2)}s
      </span>
      <span className="xr-frame">
        f
        <span className="xr-num" ref={frameRef} style={{ minWidth: frameSlot }}>
          0
        </span>
        /{lastFrame}
      </span>
    </div>
  );
}

/**
 * A scrub track, the same seek the desktop timeline drives, sized for a finger.
 *
 * The value is written through a transient subscription rather than a render,
 * so a playing clip moves the handle without costing React work, and it is left
 * alone while a drag is in progress so the seek does not fight the handle.
 */
function ARScrubber() {
  const frameCount = useStore((s) => s.motion?.frameCount ?? 0);
  const lastFrame = Math.max(0, frameCount - 1);
  const seekFrame = useStore((s) => s.seekFrame);
  const ref = useSuppressXRSelect<HTMLInputElement>();
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const paint = (frame: number) => {
      if (!draggingRef.current) el.value = `${Math.min(frame, lastFrame)}`;
    };
    paint(useStore.getState().playheadFrame);
    return useStore.subscribe((s) => s.playheadFrame, paint);
  }, [lastFrame, ref]);

  return (
    <input
      ref={ref}
      className="xr-scrub"
      type="range"
      min={0}
      max={lastFrame}
      step={1}
      defaultValue={0}
      aria-label="Timeline"
      onPointerDown={() => {
        draggingRef.current = true;
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
      onInput={(e) => seekFrame(Number(e.currentTarget.value))}
    />
  );
}

/** How long the overlay says a tap found nothing. */
const PICK_MISS_MS = 2500;

/**
 * The selected joint, or what to do to select one. A tap on the subject that
 * finds no joint says so for a moment instead of doing nothing visible.
 */
function ARSelected({ selected }: { selected: string | null }) {
  const misses = useStore((s) => s.xrPickMisses);
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (misses === 0) return;
    const timer = setTimeout(() => setSettled(misses), PICK_MISS_MS);
    return () => clearTimeout(timer);
  }, [misses]);
  const missed = misses > settled;

  return (
    <span className={`xr-selected${missed ? ' is-miss' : ''}`} role="status">
      {missed ? (
        'No joint there. Tap closer to a joint.'
      ) : selected ? (
        <>
          Selected <strong className="xr-selected__name">{selected}</strong>
        </>
      ) : (
        'Tap a joint to inspect it'
      )}
    </span>
  );
}

/** Playback, overlays, size and selection, driving the page's own actions. */
function ARInspection({ onReposition }: { onReposition: () => void }) {
  const isPlaying = useStore((s) => s.isPlaying);
  const direction = useStore((s) => s.direction);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const stepFrame = useStore((s) => s.stepFrame);
  const setDirection = useStore((s) => s.setDirection);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);

  const showMesh = useStore((s) => s.showMesh);
  const showSkeleton = useStore((s) => s.showSkeleton);
  const showOnionSkin = useStore((s) => s.showOnionSkin);
  const showMotionTrail = useStore((s) => s.showMotionTrail);
  const toggleMesh = useStore((s) => s.toggleMesh);
  const toggleSkeleton = useStore((s) => s.toggleSkeleton);
  const toggleOnionSkin = useStore((s) => s.toggleOnionSkin);
  const toggleMotionTrail = useStore((s) => s.toggleMotionTrail);

  const selected = useStore((s) => s.selectedJointId);
  const clearSelection = useStore((s) => s.clearSelection);

  const xrScale = useStore((s) => s.xrScale);
  const setXrScale = useStore((s) => s.setXrScale);

  const speedRef = useSuppressXRSelect<HTMLSelectElement>();

  const playingForward = isPlaying && direction === 1;
  const playingBackward = isPlaying && direction === -1;

  /*
   * Minimized, the bar is one slim row: play, the scrub track, and a way back.
   *
   * The full bar covered nearly half of a phone's screen in portrait, where
   * the subject has to be seen (Galaxy S24 Ultra, 29 October 2026). Phones start minimized; a tablet has the
   * room and starts expanded. Either can be switched.
   */
  const [minimized, setMinimized] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 560px)').matches
  );

  if (minimized) {
    return (
      <div className="xr-inspect is-minimized">
        <ARIconButton
          label={isPlaying ? 'Pause' : 'Play'}
          pressed={isPlaying}
          onClick={() => {
            if (isPlaying) {
              pause();
              return;
            }
            setDirection(1);
            play();
          }}
        >
          {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </ARIconButton>
        <ARScrubber />
        <ARIconButton label="Show all controls" onClick={() => setMinimized(false)}>
          <ChevronUpIcon size={18} />
        </ARIconButton>
      </div>
    );
  }

  return (
    <div className="xr-inspect">
      <div className="xr-inspect__head">
        <ARScrubber />
        <ARIconButton label="Minimize controls" onClick={() => setMinimized(true)}>
          <ChevronDownIcon size={18} />
        </ARIconButton>
      </div>

      <div className="xr-bar__row">
        {/* The timeline bar's transport, control for control. Two play
            buttons, one per direction, each toggling its own, so the lit one
            says what is happening. */}
        <div className="xr-transport" role="group" aria-label="Playback">
          <ARIconButton label="Previous frame" onClick={() => stepFrame(-1)}>
            <StepBackIcon size={18} />
          </ARIconButton>
          <ARIconButton
            label={playingBackward ? 'Pause' : 'Play backward'}
            pressed={playingBackward}
            onClick={() => {
              if (playingBackward) {
                pause();
                return;
              }
              setDirection(-1);
              play();
            }}
          >
            {playingBackward ? <PauseIcon size={18} /> : <PlayBackIcon size={18} />}
          </ARIconButton>
          <ARIconButton
            label={playingForward ? 'Pause' : 'Play'}
            pressed={playingForward}
            onClick={() => {
              if (playingForward) {
                pause();
                return;
              }
              setDirection(1);
              play();
            }}
          >
            {playingForward ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </ARIconButton>
          <ARIconButton label="Next frame" onClick={() => stepFrame(1)}>
            <StepForwardIcon size={18} />
          </ARIconButton>
          <ARIconButton label="Stop" onClick={stopPlayback}>
            <StopIcon size={18} />
          </ARIconButton>
        </div>

        <ARReadout />

        <div className="xr-overlays" role="group" aria-label="Motion overlays">
          <ARIconButton label="Skin" pressed={showMesh} onClick={() => toggleMesh(!showMesh)}>
            <MeshIcon size={18} />
          </ARIconButton>
          <ARIconButton label="Skeleton" pressed={showSkeleton} onClick={() => toggleSkeleton(!showSkeleton)}>
            <BoneIcon size={18} />
          </ARIconButton>
          <ARIconButton
            label="Ghost poses"
            pressed={showOnionSkin}
            onClick={() => toggleOnionSkin(!showOnionSkin)}
          >
            <OnionIcon size={18} />
          </ARIconButton>
          <ARIconButton
            label="Motion trails"
            pressed={showMotionTrail}
            onClick={() => toggleMotionTrail(!showMotionTrail)}
          >
            <TrailIcon size={18} />
          </ARIconButton>
          {selected && (
            <ARIconButton label="Clear selection" className="xr-clear" onClick={clearSelection}>
              <CloseIcon size={18} />
            </ARIconButton>
          )}
        </div>

        <label className="xr-speed-label">
          <span>Playback speed</span>
          <select
            ref={speedRef}
            className="field xr-speed"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            aria-label="Playback speed"
          >
            <option value="0.25">0.25×</option>
            <option value="0.5">0.5×</option>
            <option value="0.75">0.75×</option>
            <option value="1">1×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select>
        </label>
      </div>

      <div className="xr-bar__row xr-bar__row--secondary">
        <div className="xr-size" role="group" aria-label="Subject size">
          <span className="xr-size__label">Size</span>
          <div className="xr-seg">
            {XR_SIZES.map((size) => (
              <ARButton
                key={size.scale}
                label={size.label}
                pressed={Math.abs(xrScale - size.scale) < 1e-9}
                onClick={() => setXrScale(size.scale)}
                className="xr-seg__btn"
              >
                {size.text}
              </ARButton>
            ))}
          </div>
        </div>

        <ARButton label="Reposition" onClick={onReposition}>
          <TargetIcon size={16} />
          Reposition
        </ARButton>

        <ARSelected selected={selected} />
      </div>
    </div>
  );
}

export function TabletARControls({
  rootRef,
  actions,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  actions: ARControlActions;
}) {
  const phase = useStore((s) => s.xrPhase);
  const visible = useStore((s) => s.xrVisible);
  const referenceSpace = useStore((s) => s.xrReferenceSpace);
  const placement = useStore((s) => s.xrPlacement);
  const hasSurface = useStore((s) => s.xrHasSurface);

  const presenting = phase === 'active' || phase === 'ending';
  const aiming = placement === 'unplaced' || placement === 'repositioning';

  const state = !visible ? 'hidden' : aiming ? (hasSurface ? 'ready' : 'searching') : 'placed';
  const status =
    state === 'hidden'
      ? 'Paused while the session is hidden'
      : state === 'searching'
        ? 'Move the tablet to find a flat surface'
        : state === 'ready'
          ? 'Aim the ring at the floor, then place'
          : referenceSpace === 'local'
            ? 'Placed. Floor level was unavailable on this device.'
            : 'Placed. Walk around to inspect.';

  const onPlace = useCallback(() => actions.onPlaceHere(), [actions]);

  return (
    <div
      ref={rootRef}
      id="xr-overlay-root"
      className={`xr-overlay ${presenting ? 'is-presenting' : ''}`}
      // Inert until a session is running, so nothing here can intercept a
      // pointer meant for the ordinary viewport.
      aria-hidden={!presenting}
    >
      {presenting && (
        <>
          <header className="xr-top" role="group" aria-label="AR session">
            <p className="xr-overlay__status" role="status">
              <span className="xr-dot" data-state={state} aria-hidden="true" />
              {status}
              {referenceSpace === 'local' && aiming && (
                <span className="xr-overlay__note"> Floor level unavailable on this device.</span>
              )}
            </p>
            <ARButton label="Exit AR" variant="ghost" className="xr-exit" onClick={actions.onExit}>
              <CloseIcon size={16} />
              Exit AR
            </ARButton>
          </header>

          {aiming && (
            <div className="xr-overlay__place xr-place">
              <ARButton
                label="Place here"
                variant="primary"
                className="xr-place__cta"
                onClick={onPlace}
                disabled={!hasSurface}
              />
              {placement === 'repositioning' && (
                <ARButton label="Cancel" onClick={actions.onCancelReposition} />
              )}
            </div>
          )}

          {placement === 'placed' && (
            <div className="xr-bar">
              <ARInspection onReposition={actions.onReposition} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The failure notice, shown in the ordinary page rather than in the overlay:
 * when a session does not start there is no overlay to show it in.
 */
export function XRFailureNotice({ onDismiss }: { onDismiss: () => void }) {
  const phase = useStore((s) => s.xrPhase);
  const failure = useStore((s) => s.xrFailure);
  if (phase !== 'error' || !failure) return null;
  const text = FAILURE_TEXT[failure] ?? FAILURE_TEXT['start-failed'];
  return (
    <div className="xr-failure" role="alert">
      <div>
        <strong>{text.title}</strong>
        <p>{text.detail}</p>
      </div>
      <button type="button" className="btn" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
