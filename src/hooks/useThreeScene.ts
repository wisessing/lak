import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { setupThreeScene, type ThreeHelpers } from '../utils/threeSetup';
import { setupLighting } from '../utils/lightingConfig';
import { publishDevHooks } from '../utils/devHooks';

/**
 * Owns the renderer, the camera, and the one frame loop.
 *
 * **One loop, one owner.** There used to be two: this hook ran a
 * `requestAnimationFrame` that only rendered, while `Scene` ran a second one
 * that advanced the mixer, the overlays and the camera. Nothing ordered them,
 * so a rendered frame could show a pose from before or after that frame's
 * update, and both loops had to be cancelled correctly for playback to stop.
 * Now the update is a callback this loop invokes in a fixed order —
 * playback, overlays, camera, render — exactly once per frame.
 *
 * The loop is `renderer.setAnimationLoop`, not `requestAnimationFrame`, because
 * an immersive session paces frames itself: in XR three.js drives this callback
 * from the headset's own vsync, and a raw rAF loop simply would not run. Making
 * that switch meant AR changed a reference space, not an architecture.
 *
 * Sizing is driven by a `ResizeObserver` on the canvas's *container*, not the
 * window. The docked shell resizes the viewport whenever the dock collapses or
 * the timeline grows a second row — none of which fires a window resize, so a
 * window listener alone would leave the canvas stretched.
 */

/** Cap the device pixel ratio: past 2 the cost buys nothing visible. */
const MAX_PIXEL_RATIO = 2;

/**
 * Longest delta a single frame may report, in seconds.
 *
 * A backgrounded tab, a long parse, or an XR session change can leave an
 * arbitrarily large gap since the last frame. Passing that straight to the
 * mixer would teleport the playhead forward by seconds on the first frame back.
 * Clamping turns the stall into a dropped frame, which is what it actually was.
 */
const MAX_FRAME_DELTA = 0.1;

/**
 * One frame of scene work, run before the render.
 *
 * `frame` is the `XRFrame` for this frame, and it is present only inside an
 * immersive session. It is the only way to ask where the viewer and its input
 * sources are, so the AR placement and picking work needs it; everything else
 * ignores it.
 */
export type FrameCallback = (delta: number, frame?: XRFrame) => void;

export interface UseThreeSceneResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  renderer: THREE.WebGLRenderer | null;
  helpers: ThreeHelpers | null;
  fps: number;
  /** Canvas size in CSS pixels, republished on every resize. */
  viewportSize: { width: number; height: number };
  /**
   * Register the per-frame scene update. Stable, so registering does not
   * restart the loop; passing null unregisters.
   */
  setFrameCallback: (callback: FrameCallback | null) => void;
  /**
   * Treat the next frame as a fresh start rather than a long one.
   *
   * Entering or leaving a session, or coming back from a hidden one, leaves an
   * arbitrary gap since the last frame. Without this the clamp still yields a
   * full jump and the playhead lurches on the first frame back.
   */
  resetFrameTiming: () => void;
  /**
   * Measure the container again and resize to it.
   *
   * Sizing is suppressed while a session presents, so a page that changed shape
   * during one — a rotation, or the shell relaying out — has no pending
   * observation to replay when it ends. Without this the canvas keeps the shape
   * it had when the session began.
   */
  remeasureViewport: () => void;
}

export function useThreeScene(): UseThreeSceneResult {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<THREE.Scene | null>(null);
  const [camera, setCamera] = useState<THREE.PerspectiveCamera | null>(null);
  const [renderer, setRenderer] = useState<THREE.WebGLRenderer | null>(null);
  const [helpers, setHelpers] = useState<ThreeHelpers | null>(null);
  const [fps, setFps] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(0);

  // The scene update, held in a ref so re-registering it never restarts the
  // loop. An identity-guarded effect dependency would rebuild the renderer
  // every time Scene re-rendered.
  const frameCallbackRef = useRef<FrameCallback | null>(null);
  // Set by the loop effect, which owns the clock these reset.
  const resetTimingRef = useRef<(() => void) | null>(null);
  const resetFrameTiming = useCallback(() => resetTimingRef.current?.(), []);
  const remeasureRef = useRef<(() => void) | null>(null);
  const remeasureViewport = useCallback(() => remeasureRef.current?.(), []);
  const setFrameCallback = useCallback((callback: FrameCallback | null) => {
    frameCallbackRef.current = callback;
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;

    const { scene: newScene, camera: newCamera, renderer: newRenderer, helpers: newHelpers } =
      setupThreeScene(canvas);

    setupLighting(newScene);

    setScene(newScene);
    setCamera(newCamera);
    setRenderer(newRenderer);
    setHelpers(newHelpers);

    lastTimeRef.current = performance.now();
    let lastFrameTime = performance.now();

    /**
     * The frame. Update once, render once, in that order.
     *
     * `setAnimationLoop` supplies its own timestamp, but only in XR is it
     * guaranteed to be the frame's display time, so the delta is measured the
     * same way in both modes and clamped.
     */
    const animate = (_time?: number, frame?: XRFrame) => {
      const now = performance.now();
      const delta = Math.min((now - lastFrameTime) / 1000, MAX_FRAME_DELTA);
      lastFrameTime = now;

      frameCountRef.current++;
      const sinceReport = now - lastTimeRef.current;
      if (sinceReport >= 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / sinceReport));
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      frameCallbackRef.current?.(delta, frame);
      newRenderer.render(newScene, newCamera);
    };

    newRenderer.setAnimationLoop(animate);

    /*
     * Development-only seam for the XR frame path.
     *
     * An `XRFrame` reaches the callback above only from a real session, because
     * three.js drives the loop from the device's own vsync and supplies the
     * frame itself. There is no way to hand the placement code a frame from a
     * test without one, and placement is exactly the part that has to be right
     * before anybody stands in a room holding a tablet. This runs the registered
     * callback with a supplied frame, and does nothing else: no second loop. In
     * a production build the hook bag is never created, so this is never
     * published and cannot be called, although the identifier and this closure
     * survive minification. See `devHooks.ts`.
     */
    publishDevHooks({
      driveFrameWithXR: (frame: XRFrame, delta = 1 / 60) => {
        frameCallbackRef.current?.(delta, frame);
      },
    });

    /**
     * Coming back from a hidden tab, the next frame is a fresh start, not a
     * long one. Without this the clamp above still yields a full 100ms jump.
     */
    const onVisibility = () => {
      lastFrameTime = performance.now();
      lastTimeRef.current = performance.now();
      frameCountRef.current = 0;
    };
    resetTimingRef.current = onVisibility;
    document.addEventListener('visibilitychange', onVisibility);

    // --- Sizing ---------------------------------------------------------
    let pending = 0;

    const applySize = () => {
      pending = 0;
      /*
       * Not while presenting. In a session the runtime owns the render target
       * and the projection: it sizes the framebuffer for the device's own
       * views, and writing a page-derived size, pixel ratio or aspect over that
       * fights it for the duration. The page is remeasured on exit instead,
       * which is what the observer fires for anyway once the canvas comes back.
       */
      if (newRenderer.xr?.isPresenting) return;
      const parent = canvas.parentElement;
      // Measure the container: renderer.setSize writes the canvas's own CSS
      // size, so observing the canvas would feed itself.
      const width = parent?.clientWidth ?? canvas.clientWidth;
      const height = parent?.clientHeight ?? canvas.clientHeight;
      if (width === 0 || height === 0) return;

      newCamera.aspect = width / height;
      newCamera.updateProjectionMatrix();
      // Re-applied on every resize so moving between monitors of different
      // density does not leave the canvas at the launch ratio.
      newRenderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      newRenderer.setSize(width, height, false);
      canvas.style.width = '100%';
      canvas.style.height = '100%';

      setViewportSize({ width, height });
    };

    /** Coalesce bursts of observations into one resize per frame. */
    const scheduleSize = () => {
      if (pending) return;
      pending = requestAnimationFrame(applySize);
    };

    remeasureRef.current = scheduleSize;
    applySize();

    const observer = new ResizeObserver(scheduleSize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    window.addEventListener('resize', scheduleSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleSize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (pending) cancelAnimationFrame(pending);
      // Stop this renderer's loop. Passing null is the documented way; it also
      // detaches the XR session loop if one is running.
      newRenderer.setAnimationLoop(null);
      newRenderer.dispose();
    };
  }, []);

  return {
    canvasRef,
    scene,
    camera,
    renderer,
    helpers,
    fps,
    viewportSize,
    setFrameCallback,
    resetFrameTiming,
    remeasureViewport,
  };
}
