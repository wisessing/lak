import { useEffect } from 'react';
import type * as THREE from 'three';
import { pickJointAtScreenPoint } from '../utils/jointPicking';
import { useStore } from '../store';

/**
 * Select a joint by tapping or clicking it in the viewport.
 *
 * The same surface is how the camera is orbited, so the question this hook
 * answers is not "was a marker under the pointer" but "was that a tap". A
 * pointer that moves more than a few pixels, stays down too long, or is joined
 * by a second finger is a drag, a hold, or a pinch, and none of those selects.
 * The thresholds are generous enough for a finger and tight enough that an
 * orbit drag that happens to start on a joint leaves the selection alone.
 *
 * Resolution goes through `pickJointAtScreenPoint`, which is the same resolver
 * an XR controller ray would use; only the ray's origin differs.
 */

/** Movement past this, in CSS pixels, turns a tap into a drag. */
const TAP_SLOP_PX = 8;
/** A press held longer than this is not a tap. */
const TAP_MAX_MS = 500;

export function useJointPicking(
  canvas: HTMLCanvasElement | null,
  camera: THREE.Camera | null,
  markers: THREE.Object3D | null | undefined,
  /**
   * False suspends the whole gesture path. During an immersive session the same
   * touch is delivered as an XR input source, and letting both run would resolve
   * one tap into two selections.
   */
  enabled: boolean = true
): void {
  const selectJoint = useStore((s) => s.selectJoint);
  const clearSelection = useStore((s) => s.clearSelection);

  useEffect(() => {
    if (!canvas || !camera || !enabled) return;

    let down: { id: number; x: number; y: number; at: number } | null = null;
    let activePointers = 0;
    let multiTouch = false;

    const onDown = (e: PointerEvent) => {
      activePointers++;
      if (activePointers > 1) {
        // A second finger means a pinch or two-finger pan is starting. The
        // gesture stays disqualified until every pointer has lifted.
        multiTouch = true;
        down = null;
        return;
      }
      if (e.button !== 0) return;
      multiTouch = false;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
    };

    // Disqualification has to happen on the way, not at the end. Comparing the
    // release point with the press point measures net displacement, and an
    // orbit drag that swings out and comes back finishes within a few pixels of
    // where it started: the camera has been turned right round and the release
    // still reads as a tap. Watching the movement as it happens catches it.
    const onMove = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP_PX) down = null;
    };

    const onUp = (e: PointerEvent) => {
      activePointers = Math.max(0, activePointers - 1);
      const press = down;
      down = null;
      if (!press || multiTouch || press.id !== e.pointerId) {
        if (activePointers === 0) multiTouch = false;
        return;
      }

      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      const held = performance.now() - press.at;
      if (moved > TAP_SLOP_PX || held > TAP_MAX_MS) return;

      const rect = canvas.getBoundingClientRect();
      const id = pickJointAtScreenPoint(
        camera,
        markers,
        e.clientX - rect.left,
        e.clientY - rect.top,
        rect.width,
        rect.height
      );
      // A tap on empty space is the clear gesture. It is also reachable by a
      // visible button, so nobody has to discover this.
      if (id) selectJoint(id);
      else clearSelection();
    };

    const onCancel = () => {
      activePointers = 0;
      multiTouch = false;
      down = null;
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
    };
  }, [canvas, camera, markers, enabled, selectJoint, clearSelection]);
}
