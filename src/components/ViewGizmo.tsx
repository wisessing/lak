import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GIZMO_AXES, GIZMO_AXIS_ORDER } from '../constants/cameraPresets';
import type { CameraViewControls, GizmoAxis } from '../types';
import './ViewGizmo.css';

/** Widget geometry, in SVG user units (the viewBox is SIZE x SIZE). */
const SIZE = 96;
const CENTER = SIZE / 2;
/** Distance from the centre to a ball centre. */
const ORBIT_RADIUS = 31;
const BALL_RADIUS = 11;

/** Radians of orbit per pixel dragged — crossing the widget is about a half turn. */
const DRAG_SPEED = Math.PI / 90;
/** Pointer travel, in px, below which a press counts as a click rather than a drag. */
const CLICK_SLOP = 4;
/** Sub-pixel moves are not worth a re-render. */
const REDRAW_EPSILON = 0.05;

interface Ball {
  axis: GizmoAxis;
  x: number;
  y: number;
  /** Positive when the axis points toward the viewer. */
  depth: number;
}

/**
 * Projects the six axis directions into widget space using the camera's own
 * basis, then orders them back-to-front so the near balls paint last.
 */
function projectAxes(right: THREE.Vector3, up: THREE.Vector3, back: THREE.Vector3): Ball[] {
  return GIZMO_AXIS_ORDER.map((axis) => {
    const dir = GIZMO_AXES[axis].direction;
    return {
      axis,
      x: CENTER + dir.dot(right) * ORBIT_RADIUS,
      // SVG y grows downward, so the screen-up component is negated.
      y: CENTER - dir.dot(up) * ORBIT_RADIUS,
      depth: dir.dot(back),
    };
  }).sort((a, b) => a.depth - b.depth);
}

function sameLayout(a: Ball[], b: Ball[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every(
    (ball, i) =>
      ball.axis === b[i].axis &&
      Math.abs(ball.x - b[i].x) < REDRAW_EPSILON &&
      Math.abs(ball.y - b[i].y) < REDRAW_EPSILON
  );
}

interface ViewGizmoProps {
  controls: CameraViewControls | null;
}

/**
 * Blender/Godot-style navigation gizmo: drag the widget to tumble the view,
 * click an axis ball to snap to that orthogonal view.
 */
export function ViewGizmo({ controls }: ViewGizmoProps) {
  const [balls, setBalls] = useState<Ball[]>([]);
  const [dragging, setDragging] = useState(false);
  /**
   * Which ball the pointer is over. Hover cannot be pure CSS here: the element
   * under the pointer is in the hit layer, and the ball it has to restyle is in
   * the paint layer below, which CSS cannot reach across.
   */
  const [hoverAxis, setHoverAxis] = useState<GizmoAxis | null>(null);

  // Reused every frame so polling the camera basis allocates nothing.
  const scratch = useMemo(
    () => ({ right: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3() }),
    []
  );
  const lastLayoutRef = useRef<Ball[] | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    travel: number;
    axis: GizmoAxis | null;
  } | null>(null);

  // Follow the camera by polling, the same way PlaybackControls follows the
  // playhead — the render loop lives in Scene and does not drive React state.
  useEffect(() => {
    if (!controls) return;

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!controls.readBasis(scratch.right, scratch.up, scratch.back)) return;

      const next = projectAxes(scratch.right, scratch.up, scratch.back);
      // The camera is stationary most of the time; skip the re-render then.
      if (sameLayout(next, lastLayoutRef.current)) return;
      lastLayoutRef.current = next;
      setBalls(next);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [controls, scratch]);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    // Capture is on the <svg>, so the ball under the press is resolved here
    // rather than by a per-ball handler that would also bubble to this one.
    const hit = (event.target as Element).closest('[data-axis]');
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      travel: 0,
      axis: (hit?.getAttribute('data-axis') as GizmoAxis | undefined) ?? null,
    };
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !controls) return;

      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.travel += Math.abs(dx) + Math.abs(dy);

      // Hold still until the press has clearly become a drag, so a click that
      // wobbles a pixel still snaps instead of nudging the view.
      if (drag.travel > CLICK_SLOP) {
        controls.orbitBy(dx * DRAG_SPEED, dy * DRAG_SPEED);
      }
    },
    [controls]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(false);

      if (controls && drag.axis && drag.travel <= CLICK_SLOP) {
        controls.snapToAxis(drag.axis);
      }
    },
    [controls]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, axis: GizmoAxis) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      controls?.snapToAxis(axis);
    },
    [controls]
  );

  if (!controls) return null;

  return (
    <div className="view-gizmo">
      <svg
        className={`view-gizmo__dial ${dragging ? 'is-dragging' : ''}`}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <circle className="view-gizmo__backdrop" cx={CENTER} cy={CENTER} r={CENTER - 2} />

        {/* Spokes are drawn under every ball, so they never cross a near one. */}
        {balls
          .filter((ball) => GIZMO_AXES[ball.axis].positive)
          .map((ball) => (
            <line
              key={`spoke-${ball.axis}`}
              className={`view-gizmo__spoke view-gizmo__spoke--${GIZMO_AXES[ball.axis].letter.toLowerCase()}`}
              x1={CENTER}
              y1={CENTER}
              x2={ball.x}
              y2={ball.y}
            />
          ))}

        {/*
          Paint and focus are deliberately two separate layers.

          SVG has no z-index — a near ball can only cover a far one by coming
          later in document order, so the visual layer is depth-sorted and
          re-sorts as the camera moves. React reorders keyed nodes by moving
          them in the DOM, and Chrome fires focusout when a focused node is
          moved; a keypress landing in that gap goes to `body` and is lost. So
          the balls that are actually focusable are rendered in a *fixed* axis
          order, on top, transparent. Their DOM order never changes, and with it
          neither focus nor tab order.
        */}
        <g aria-hidden="true" className="view-gizmo__paint">
          {balls.map((ball) => {
            const info = GIZMO_AXES[ball.axis];
            const letter = info.letter.toLowerCase();
            const rear = ball.depth < 0;
            return (
              <g
                key={ball.axis}
                className={
                  `view-gizmo__axis view-gizmo__axis--${letter}` +
                  `${rear ? ' is-rear' : ''}${ball.axis === hoverAxis ? ' is-hover' : ''}`
                }
              >
                <circle className="view-gizmo__ball" cx={ball.x} cy={ball.y} r={BALL_RADIUS} />
                {info.positive && (
                  <text className="view-gizmo__letter" x={ball.x} y={ball.y}>
                    {info.letter}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {GIZMO_AXIS_ORDER.map((axis) => {
          const ball = balls.find((b) => b.axis === axis);
          if (!ball) return null;
          const info = GIZMO_AXES[axis];
          const letter = info.letter.toLowerCase();
          const rear = ball.depth < 0;
          return (
            <g
              key={axis}
              className={`view-gizmo__axis view-gizmo__hit view-gizmo__axis--${letter} ${rear ? 'is-rear' : ''}`}
              data-axis={axis}
              role="button"
              tabIndex={0}
              aria-label={`${info.label} view`}
              onKeyDown={(event) => handleKeyDown(event, axis)}
              onPointerEnter={() => setHoverAxis(axis)}
              onPointerLeave={() => setHoverAxis((current) => (current === axis ? null : current))}
            >
              <title>{`${info.label} view`}</title>
              <circle
                className="view-gizmo__focus"
                cx={ball.x}
                cy={ball.y}
                r={BALL_RADIUS + 2.5}
              />
              <circle className="view-gizmo__hit-area" cx={ball.x} cy={ball.y} r={BALL_RADIUS} />
            </g>
          );
        })}
      </svg>

      <div className="view-gizmo__buttons">
        <button
          type="button"
          title="Home view"
          aria-label="Home view"
          onClick={() => controls.setPreset('perspective')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          <span className="view-gizmo__btn-label">Home</span>
        </button>
        <button type="button" title="Reset camera" aria-label="Reset camera" onClick={() => controls.reset()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <span className="view-gizmo__btn-label">Reset</span>
        </button>
        <button type="button" title="Focus model" aria-label="Focus model" onClick={() => controls.focusModel()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 7V5a2 2 0 0 1 2-2h2" />
            <path d="M17 3h2a2 2 0 0 1 2 2v2" />
            <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
            <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
          </svg>
          <span className="view-gizmo__btn-label">Focus</span>
        </button>
      </div>
    </div>
  );
}
