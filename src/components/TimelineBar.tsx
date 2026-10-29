import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeSpeeds } from '../utils/motionData';
import { detectQualityIssues, downsampleSeries, type QualityIssue } from '../utils/motionAnalysis';
import {
  EASING_LABELS,
  editedDuration,
  frameFromRatio,
  moveHandle,
  type EasingKind,
} from '../utils/clipEditing';
import { useStore } from '../store';
import { isXrBusy } from '../store/slices/xrSlice';
import { getActiveEdit, getActiveRange, getHasPendingEdit } from '../store/derive';
import {
  BoneIcon,
  CloseIcon,
  MarkInIcon,
  MarkOutIcon,
  OnionIcon,
  PauseIcon,
  PlayBackIcon,
  PlayIcon,
  RevertIcon,
  ScissorsIcon,
  StepBackIcon,
  StepForwardIcon,
  StopIcon,
  TrailIcon,
} from './icons';
import './TimelineBar.css';

/**
 * The one timeline. There is no edit mode.
 *
 * The bar never swaps: the same track scrubs, and the Trim tool reveals in/out
 * handles on it plus a second row of numeric controls. That is the fix for the
 * old flow, where entering edit mode replaced the whole dock and the user lost
 * their place.
 *
 * The playhead is driven by a transient store subscription writing a CSS
 * custom property, so playback moves the needle without re-rendering React.
 */

type DragTarget = 'start' | 'end' | 'playhead' | null;

/**
 * What each diagnostic category means, in words a reviewer can act on.
 *
 * "Possible" is deliberate throughout. The detector compares a bone's step to
 * its own median and flags outliers; that is a place worth looking, not a
 * verified defect. Describing these as errors would make the timeline claim
 * more than the algorithm knows.
 */
const ISSUE_MEANING: Record<QualityIssue['kind'], { label: string; meaning: string }> = {
  pop: {
    label: 'Pop',
    meaning: 'A sudden jump in position between two frames. Possible marker swap or solver slip.',
  },
  jitter: {
    label: 'Jitter',
    meaning: 'Rapid direction changes over a few frames. Possible tremor or noisy tracking.',
  },
  rotation: {
    label: 'Rotation',
    meaning: 'An unusually fast turn of the joint. Possible flipped or mis-solved rotation.',
  },
};

/**
 * Issue markers that would land within one hit target of each other are drawn
 * as one. The hit target is the thing that must not overlap, so the grouping
 * distance is measured in pixels of track and converted to frames.
 */
const MARKER_HIT_PX_FINE = 16;
const MARKER_HIT_PX_COARSE = 44;

interface MarkerCluster {
  /** Representative frame, the mean of the members. */
  frame: number;
  issues: QualityIssue[];
  /** The most frequent kind, which colours the marker. */
  kind: QualityIssue['kind'];
}

function clusterIssues(issues: QualityIssue[], frameCount: number, trackPx: number): MarkerCluster[] {
  if (issues.length === 0 || frameCount < 2) return [];
  const hitPx =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
      ? MARKER_HIT_PX_COARSE
      : MARKER_HIT_PX_FINE;
  const pxPerFrame = trackPx > 0 ? trackPx / (frameCount - 1) : 1;
  // Ceil, not round: a span rounded down leaves two representatives a pixel
  // closer than the hit width, and the buttons overlap by that pixel.
  const span = Math.max(1, Math.ceil(hitPx / pxPerFrame));

  const sorted = [...issues].sort((a, b) => a.frame - b.frame);
  let clusters: MarkerCluster[] = [];
  let current: QualityIssue[] = [];
  for (const issue of sorted) {
    if (current.length && issue.frame - current[0].frame > span) {
      clusters.push(finishCluster(current));
      current = [];
    }
    current.push(issue);
  }
  if (current.length) clusters.push(finishCluster(current));

  // The representative is the mean of its members, which can sit near the end
  // of one group and the start of the next. Merge until every pair of
  // neighbours is at least a full span apart; that is the property the hit
  // targets actually need.
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    const next: MarkerCluster[] = [];
    for (const cluster of clusters) {
      const prev = next[next.length - 1];
      if (prev && cluster.frame - prev.frame < span) {
        next[next.length - 1] = finishCluster([...prev.issues, ...cluster.issues]);
        merged = true;
      } else {
        next.push(cluster);
      }
    }
    clusters = next;
  }
  return clusters;
}

function finishCluster(members: QualityIssue[]): MarkerCluster {
  const counts: Record<string, number> = {};
  for (const m of members) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  const kind = (Object.keys(counts) as QualityIssue['kind'][]).sort(
    (a, b) => counts[b] - counts[a]
  )[0];
  const frame = Math.round(members.reduce((sum, m) => sum + m.frame, 0) / members.length);
  return { frame, issues: members, kind };
}

/**
 * How close a pointer must be to a trim mark to grab it, in CSS pixels.
 *
 * Pixels rather than a fraction of the track: a fraction shrinks the grab zone
 * on exactly the narrow screens where fingers need it largest. A coarse pointer
 * gets a zone wide enough for a fingertip, which is also why the two marks
 * enforce a minimum separation — otherwise their zones would overlap and one
 * would become unreachable.
 */
const GRAB_PX_FINE = 10;
const GRAB_PX_COARSE = 24;

function grabRadius(): number {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    ? GRAB_PX_COARSE
    : GRAB_PX_FINE;
}

export function TimelineBar() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragTarget>(null);
  const lastHandleRef = useRef<'start' | 'end'>('start');
  /** Which marker cluster's details are open, by representative frame. */
  const [openMarker, setOpenMarker] = useState<number | null>(null);
  /** Track width in CSS pixels, for grouping markers by hit target. */
  const [trackPx, setTrackPx] = useState(0);

  const hasController = useStore((s) => s.controller !== null);
  const motion = useStore((s) => s.motion);
  const isPlaying = useStore((s) => s.isPlaying);
  const direction = useStore((s) => s.direction);
  const speed = useStore((s) => s.speed);
  const duration = useStore((s) => s.duration);

  const togglePlay = useStore((s) => s.togglePlay);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const stepFrame = useStore((s) => s.stepFrame);
  const seekFrame = useStore((s) => s.seekFrame);
  const setSpeed = useStore((s) => s.setSpeed);
  const setDirection = useStore((s) => s.setDirection);

  // Overlay toggles, the same store fields the Display tab drives. They sit
  // here so a tablet user with the drawer closed can still turn the skeleton,
  // ghosts and trails on, and clear a selection, without opening anything.
  const showSkeleton = useStore((s) => s.showSkeleton);
  const showOnionSkin = useStore((s) => s.showOnionSkin);
  const showMotionTrail = useStore((s) => s.showMotionTrail);
  const toggleSkeleton = useStore((s) => s.toggleSkeleton);
  const toggleOnionSkin = useStore((s) => s.toggleOnionSkin);
  const toggleMotionTrail = useStore((s) => s.toggleMotionTrail);
  const selectedJointId = useStore((s) => s.selectedJointId);
  const clearSelection = useStore((s) => s.clearSelection);

  const trimMode = useStore((s) => s.trimMode);
  const setTrimMode = useStore((s) => s.setTrimMode);
  const inXrSession = useStore((s) => isXrBusy(s.xrPhase));
  const editState = useStore((s) => s.editState);
  const setEdit = useStore((s) => s.setEdit);
  const applyEdit = useStore((s) => s.applyEdit);
  const setToast = useStore((s) => s.setToast);

  const edit = getActiveEdit({ editState, motion });
  const range = getActiveRange({ editState, motion });
  const hasPendingEdit = getHasPendingEdit({ editState, motion });

  const playingForward = isPlaying && direction === 1;
  const playingBackward = isPlaying && direction === -1;

  const scale = edit.scale ?? 1;
  const easing = edit.easing ?? 'linear';

  // --- Playhead: transient subscription, no React re-render per frame -------
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const frameLabelRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const paint = (time: number) => {
      const pct = duration > 0 ? Math.min(1, Math.max(0, time / duration)) * 100 : 0;
      playheadRef.current?.style.setProperty('--playhead', `${pct}%`);
      if (timeLabelRef.current) timeLabelRef.current.textContent = time.toFixed(2);
    };
    paint(useStore.getState().playheadTime);
    return useStore.subscribe((s) => s.playheadTime, paint);
  }, [duration]);

  // The frame readout is written the same way, through a transient
  // subscription rather than a render, so a playing clip costs no React work.
  // Zero-based, 0 through frameCount minus 1, matching every frame number the
  // app shows elsewhere.
  const frameCount = motion?.frameCount ?? 0;
  const lastFrame = Math.max(0, frameCount - 1);
  useEffect(() => {
    const paint = (frame: number) => {
      if (frameLabelRef.current) {
        frameLabelRef.current.textContent = `${Math.min(frame, lastFrame)}`;
      }
    };
    paint(useStore.getState().playheadFrame);
    return useStore.subscribe((s) => s.playheadFrame, paint);
  }, [lastFrame]);

  // Track width, for grouping issue markers into non-overlapping targets.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTrackPx(el.clientWidth));
    observer.observe(el);
    setTrackPx(el.clientWidth);
    return () => observer.disconnect();
  }, [motion]);

  // --- Track backdrop: whole-body speed envelope + quality ticks ------------
  const envelope = useMemo(() => {
    if (!motion || motion.frameCount < 2) return null;
    const speeds = computeSpeeds(motion);
    const perFrame = new Float32Array(motion.frameCount);
    for (let f = 0; f < motion.frameCount; f++) {
      let sum = 0;
      for (let b = 0; b < motion.boneCount; b++) sum += speeds[f * motion.boneCount + b];
      perFrame[f] = motion.boneCount ? sum / motion.boneCount : 0;
    }
    const buckets = downsampleSeries(perFrame, 420);
    let peak = 0;
    for (const b of buckets) peak = Math.max(peak, b.max);
    const scaleY = peak > 0 ? peak : 1;
    const pts = buckets
      .map((b, i) => {
        const x = buckets.length > 1 ? (i / (buckets.length - 1)) * 1000 : 0;
        return `${x.toFixed(1)},${(100 - (b.max / scaleY) * 94).toFixed(1)}`;
      })
      .join(' ');
    return `0,100 ${pts} 1000,100`;
  }, [motion]);

  const issues = useMemo(() => (motion ? detectQualityIssues(motion) : []), [motion]);
  const clusters = useMemo(
    () => clusterIssues(issues, frameCount, trackPx),
    [issues, frameCount, trackPx]
  );
  const issueCounts = useMemo(() => {
    const counts = { pop: 0, jitter: 0, rotation: 0 };
    for (const issue of issues) counts[issue.kind]++;
    return counts;
  }, [issues]);
  const openCluster = openMarker === null ? null : clusters.find((c) => c.frame === openMarker) ?? null;

  const pct = useCallback(
    (frame: number) => (lastFrame > 0 ? (frame / lastFrame) * 100 : 0),
    [lastFrame]
  );

  const frameAt = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || frameCount < 2) return 0;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return 0;
      return frameFromRatio((clientX - rect.left) / rect.width, frameCount);
    },
    [frameCount]
  );

  /**
   * Move a trim mark. Reads the live store rather than closing over `edit` and
   * `range`, which are freshly allocated every render — a callback depending on
   * them could never stay stable, and a stale closure here would silently undo
   * whichever mark moved last.
   */
  const setHandle = useCallback((which: 'start' | 'end', target: number) => {
    const s = useStore.getState();
    const liveRange = getActiveRange(s);
    if (!liveRange || !s.motion || s.motion.frameCount < 2) return;
    s.setEdit({
      ...getActiveEdit(s),
      range: moveHandle(liveRange, which, target, s.motion.frameCount),
    });
    lastHandleRef.current = which;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el || frameCount < 2) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;

    let target: DragTarget = 'playhead';
    if (trimMode && range && lastFrame > 0) {
      const radius = grabRadius();
      const startX = (range.startFrame / lastFrame) * rect.width;
      const endX = (range.endFrame / lastFrame) * rect.width;
      const dStart = Math.abs(x - startX);
      const dEnd = Math.abs(x - endX);
      if (dStart <= radius && dStart <= dEnd) target = 'start';
      else if (dEnd <= radius) target = 'end';
    }

    dragRef.current = target;
    el.setPointerCapture(e.pointerId);
    const f = frameAt(e.clientX);
    if (target === 'playhead') seekFrame(f);
    else setHandle(target, f);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = dragRef.current;
    if (!target) return;
    const f = frameAt(e.clientX);
    if (target === 'playhead') seekFrame(f);
    else setHandle(target, f);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    trackRef.current?.releasePointerCapture(e.pointerId);
  };

  // --- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? '';

      // Typing takes every key.
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      // A focused button already treats Space as "activate me", so letting it
      // through would both press the button and toggle playback. Every *other*
      // shortcut still works — arrows after clicking a transport button, for
      // instance, which is the common case.
      if (tag === 'BUTTON' && e.code === 'Space') return;

      if (useStore.getState().dialog) return;
      // Playback keys stay live in a session, since the AR overlay exposes the
      // same actions. The trim keys do not: they open an editor that is not
      // mounted in AR and would change the clip under a placed subject.
      const inXr = isXrBusy(useStore.getState().xrPhase);

      const frame = () => useStore.getState().playheadFrame;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepFrame(e.shiftKey ? -10 : -1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepFrame(e.shiftKey ? 10 : 1);
      } else if (inXr && (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O' || e.key === '[' || e.key === ']')) {
        return;
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        if (!useStore.getState().trimMode) setTrimMode(true);
        setHandle('start', frame());
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        if (!useStore.getState().trimMode) setTrimMode(true);
        setHandle('end', frame());
      } else if (e.key === '[' || e.key === ']') {
        if (!useStore.getState().trimMode || !range) return;
        e.preventDefault();
        const which = lastHandleRef.current;
        const from = which === 'start' ? range.startFrame : range.endFrame;
        setHandle(which, from + (e.key === '[' ? -1 : 1));
      } else if (e.key === 'Escape' && useStore.getState().trimMode) {
        e.preventDefault();
        setTrimMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stepFrame, setHandle, setTrimMode, range]);

  /**
   * Apply the pending edit. No confirmation: this replaces the working copy in
   * memory, never a file, and "Revert to original" in the Scene tab undoes it.
   * A dialog here asked permission for something reversible that touches no
   * disk — friction on the app's most-repeated action, since a trim is normally
   * nudged and re-applied several times before it looks right.
   *
   * The toast is the receipt, and it names the way back.
   */
  const applyEditNow = () => {
    applyEdit();
    // The trim is baked into the clip now; leaving the tool armed would confine
    // playback to marks that no longer mean anything.
    setTrimMode(false);
    setToast('Edit applied to the working clip — Revert to original in the Scene tab');
  };

  if (!hasController || !motion) return null;

  const keptSource = range ? (range.endFrame - range.startFrame) / motion.fps : 0;
  const keptOut = range ? editedDuration(range, scale, motion.fps) : 0;

  return (
    <div className={`timeline-bar ${trimMode ? 'is-trimming' : ''}`}>
      <div className="tl-row">
        {/* Transport buttons give up focus after a *pointer* press.
            Without this, Space afterwards re-activates whichever button was
            clicked — press "play backward", then Space, and you get backward
            again instead of the global play/pause. Keyboard activation is left
            alone, so a keyboard user keeps their place and Space still means
            "press this button" the way it should. */}
        <div
          className="tl-transport"
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
              (e.target as HTMLElement).closest('button')?.blur();
            }
          }}
        >
          <button className="btn-icon" onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame (←)">
            <StepBackIcon />
          </button>
          {/* Two play buttons, one per direction, each toggling its own. The
              pair reads as a state — whichever is lit is what is happening —
              rather than a direction setting hidden behind a separate control. */}
          <button
            className={`btn-icon ${playingBackward ? 'is-active' : ''}`}
            onClick={() => {
              if (playingBackward) {
                pause();
                return;
              }
              setDirection(-1);
              play();
            }}
            aria-label={playingBackward ? 'Pause' : 'Play backward'}
            aria-pressed={playingBackward}
            title="Play backward"
          >
            {playingBackward ? <PauseIcon /> : <PlayBackIcon />}
          </button>
          <button
            className={`btn-icon ${playingForward ? 'is-active' : ''}`}
            onClick={() => {
              if (playingForward) {
                pause();
                return;
              }
              setDirection(1);
              play();
            }}
            aria-label={playingForward ? 'Pause' : 'Play'}
            aria-pressed={playingForward}
            title={playingForward ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playingForward ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="btn-icon" onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame (→)">
            <StepForwardIcon />
          </button>
          <button className="btn-icon" onClick={stopPlayback} aria-label="Stop" title="Stop">
            <StopIcon />
          </button>
        </div>

        <div
          className="tl-track"
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {envelope && (
            <svg className="tl-envelope" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={envelope} />
            </svg>
          )}

          {trimMode && range && (
            <>
              <div className="tl-discard" style={{ left: 0, width: `${pct(range.startFrame)}%` }} />
              <div className="tl-discard" style={{ left: `${pct(range.endFrame)}%`, right: 0 }} />
              <div
                className="tl-kept"
                style={{
                  left: `${pct(range.startFrame)}%`,
                  width: `${pct(range.endFrame) - pct(range.startFrame)}%`,
                }}
              />
            </>
          )}

          {/* Issue markers. Buttons, so they take a tap and keyboard focus,
              and grouped so their hit targets never overlap. The pointer
              handlers stop at the button: opening details must not also seek,
              which is what the track's own pointerdown would do. */}
          {clusters.map((cluster) => (
            <button
              key={cluster.frame}
              type="button"
              className={`tl-marker ${cluster.kind} ${openMarker === cluster.frame ? 'is-open' : ''}`}
              style={{ left: `${pct(cluster.frame)}%` }}
              aria-label={`${cluster.issues.length} possible ${cluster.issues.length === 1 ? 'issue' : 'issues'} near frame ${cluster.frame}`}
              aria-expanded={openMarker === cluster.frame}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMarker((open) => (open === cluster.frame ? null : cluster.frame));
              }}
            >
              <span className="tl-marker-tick" aria-hidden="true" />
              {cluster.issues.length > 1 && (
                <span className="tl-marker-count" aria-hidden="true">{cluster.issues.length}</span>
              )}
            </button>
          ))}

          <div className="tl-playhead" ref={playheadRef} />

          {trimMode && range && (
            <>
              <div
                className="tl-handle in"
                style={{ left: `${pct(range.startFrame)}%` }}
                title={`In point — frame ${range.startFrame}`}
              >
                <span>{range.startFrame}</span>
              </div>
              <div
                className="tl-handle out"
                style={{ left: `${pct(range.endFrame)}%` }}
                title={`Out point — frame ${range.endFrame}`}
              >
                <span>{range.endFrame}</span>
              </div>
            </>
          )}
        </div>

        <span className="tl-time mono">
          <span ref={timeLabelRef}>0.00</span> / {duration.toFixed(2)}s
        </span>
        {/* Current frame, zero-based, beside the time. Its own element so the
            time text stays exactly what it was. */}
        <span className="tl-frame mono" title="Current frame, counting from 0">
          f<span className="tl-frame-num" ref={frameLabelRef}>0</span>/{lastFrame}
        </span>

        {/* Compact overlay controls. Icon buttons with pressed state, not
            checkboxes: this row is the one place guaranteed to be on screen
            on a tablet, and it has no room for labels. The full labelled
            toggles remain in the Display tab and share this state. */}
        <div className="tl-overlays" role="group" aria-label="Motion overlays">
          <button
            className={`btn-icon ${showSkeleton ? 'is-active' : ''}`}
            onClick={() => toggleSkeleton(!showSkeleton)}
            aria-pressed={showSkeleton}
            aria-label="Skeleton"
            title="Skeleton"
          >
            <BoneIcon />
          </button>
          <button
            className={`btn-icon ${showOnionSkin ? 'is-active' : ''}`}
            onClick={() => toggleOnionSkin(!showOnionSkin)}
            aria-pressed={showOnionSkin}
            aria-label="Ghost poses"
            title="Ghost poses"
          >
            <OnionIcon />
          </button>
          <button
            className={`btn-icon ${showMotionTrail ? 'is-active' : ''}`}
            onClick={() => toggleMotionTrail(!showMotionTrail)}
            aria-pressed={showMotionTrail}
            aria-label="Motion trails"
            title="Motion trails"
          >
            <TrailIcon />
          </button>
          {selectedJointId && (
            <button
              className="btn-icon tl-clear-selection"
              onClick={clearSelection}
              aria-label="Clear joint selection"
              title={`Clear selection (${selectedJointId})`}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {/* Named on screen, not only for assistive tech, because the trim row
            has a second speed control that does something different. This one
            changes how fast you watch; that one changes the clip. */}
        <label className="tl-speed-label">
          <span>Playback speed</span>
          <select
            className="field tl-speed"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            aria-label="Playback speed"
            title="Viewing speed only. Does not change the clip or any export."
          >
          <option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option>
          <option value="0.75">0.75×</option>
          <option value="1">1×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2×</option>
          </select>
        </label>

        <button
          className={`btn ${trimMode ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTrimMode(!trimMode)}
          aria-pressed={trimMode}
          // The editor is not mounted in AR, and a retime under a placed subject
          // would change the clip the user is standing next to. Entry is already
          // blocked while the tool is open, so this closes the other direction.
          disabled={inXrSession}
          title={inXrSession ? 'Leave AR to trim or retime' : 'Trim and retime (I / O set the marks)'}
        >
          <ScissorsIcon />
          Trim
        </button>
      </div>

      {/* What the track is showing. Always visible: on a tablet there is no
          hover to reveal it, and the coloured ticks mean nothing on their own. */}
      <div className="tl-legend" aria-label="Timeline legend">
        <span className="tl-legend-item">
          <span className="tl-swatch envelope" aria-hidden="true" />
          Motion activity, relative average joint speed
        </span>
        {(['pop', 'jitter', 'rotation'] as const).map((kind) => (
          <span className="tl-legend-item" key={kind}>
            <span className={`tl-swatch ${kind}`} aria-hidden="true" />
            {ISSUE_MEANING[kind].label}
            <span className="tl-legend-count">{issueCounts[kind]}</span>
          </span>
        ))}
        <span className="tl-legend-note">Ticks mark possible issues to inspect, not confirmed defects.</span>
      </div>

      {openCluster && (
        <div className="tl-details" role="region" aria-label="Issue details">
          <div className="tl-details-head">
            <span className="section-label">
              {openCluster.issues.length === 1 ? 'Possible issue' : `${openCluster.issues.length} possible issues`} near frame {openCluster.frame}
            </span>
            <button className="btn-icon" onClick={() => setOpenMarker(null)} aria-label="Close issue details">
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <ul className="tl-details-list">
            {openCluster.issues.map((issue, i) => (
              <li key={`${issue.kind}-${issue.boneIndex}-${issue.frame}-${i}`} className="tl-details-item">
                <span className={`tl-swatch ${issue.kind}`} aria-hidden="true" />
                <span className="tl-details-text">
                  <strong>{ISSUE_MEANING[issue.kind].label}</strong> on <strong>{issue.boneName}</strong>, frame {issue.frame} at {issue.time.toFixed(2)}s.
                  <em> {ISSUE_MEANING[issue.kind].meaning}</em>
                </span>
                {/* Seeking is a separate, explicit action. Opening the details
                    never moved the playhead; this does, and says so. */}
                <button
                  className="btn btn-ghost tl-goto"
                  onClick={() => {
                    pause();
                    seekFrame(issue.frame);
                  }}
                >
                  Go to frame {issue.frame}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {trimMode && range && (
        <div className="tl-row tl-trim-row">
          <label className="tl-field">
            <span>In</span>
            <input
              className="field"
              type="number"
              min={0}
              max={lastFrame}
              value={range.startFrame}
              onChange={(e) => setHandle('start', Number(e.target.value))}
            />
          </label>
          <button
            className="btn-icon"
            onClick={() => setHandle('start', useStore.getState().playheadFrame)}
            aria-label="Set in point at playhead"
            title="Set in point at playhead (I)"
          >
            <MarkInIcon />
          </button>

          <label className="tl-field">
            <span>Out</span>
            <input
              className="field"
              type="number"
              min={0}
              max={lastFrame}
              value={range.endFrame}
              onChange={(e) => setHandle('end', Number(e.target.value))}
            />
          </label>
          <button
            className="btn-icon"
            onClick={() => setHandle('end', useStore.getState().playheadFrame)}
            aria-label="Set out point at playhead"
            title="Set out point at playhead (O)"
          >
            <MarkOutIcon />
          </button>

          {/* The result of Apply, stated before it happens: kept span of the
              source, and the output duration after retiming. The same number
              appears in Export, so what you see here is what you get. */}
          <span className="tl-readout mono" title="Kept span of the source, and the clip length after retiming">
            keep {keptSource.toFixed(2)}s
            {scale !== 1 ? <> → output {keptOut.toFixed(2)}s</> : <> · output {keptOut.toFixed(2)}s</>}
          </span>

          <label className="tl-field tl-field-wide" title="Changes the working clip and every export. Not the same as Playback speed.">
            <span>Retime clip {(1 / scale).toFixed(2)}×</span>
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.05}
              value={scale}
              onChange={(e) => setEdit({ ...edit, scale: Number(e.target.value) })}
            />
          </label>

          <label className="tl-field">
            <span>Curve</span>
            <select
              className="field"
              value={easing}
              onChange={(e) => setEdit({ ...edit, easing: e.target.value as EasingKind })}
            >
              {(Object.keys(EASING_LABELS) as EasingKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {EASING_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>

          <span className="tl-spacer" />

          <button
            className="btn-icon"
            onClick={() => setEdit({ range: null, scale: 1, easing: 'linear' })}
            disabled={!hasPendingEdit}
            aria-label="Reset trim"
            title="Reset trim"
          >
            <RevertIcon />
          </button>
          <button
            className="btn btn-primary"
            disabled={!hasPendingEdit}
            onClick={applyEditNow}
            title={hasPendingEdit ? 'Apply this edit' : 'Nothing to apply'}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
