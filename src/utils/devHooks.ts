import type * as THREE from 'three';

/**
 * Development-only measurement seam.
 *
 * Some checks are about what is actually on screen — how much of
 * the viewport the subject fills, whether an overlay still lines up with the
 * mesh after the subject is placed somewhere else — and the interface exposes
 * no way to ask. Rendered pixels could be compared, but a pixel diff tells you
 * that something changed, not what, and it fails for unrelated reasons.
 *
 * So the objects a test would otherwise have to guess at are published here,
 * behind `import.meta.env.DEV`, and are absent from a production bundle.
 *
 * This is for invariants the interface genuinely cannot reach. Anything a user
 * can do should still be tested by doing it.
 */

export interface DevSceneRefs {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  presentationRoot: THREE.Object3D;
}

type HookBag = Record<string, unknown>;

function bag(): HookBag | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const w = window as unknown as { __lakDevHooks?: HookBag };
  if (!w.__lakDevHooks) w.__lakDevHooks = {};
  return w.__lakDevHooks;
}

/** Publish one or more hooks. Merged, so registrations do not clobber. */
export function publishDevHooks(entries: HookBag): void {
  const target = bag();
  if (!target) return;
  Object.assign(target, entries);
}

/** Publish the live scene objects. Pass null on unmount. */
export function publishDevScene(refs: DevSceneRefs | null): void {
  publishDevHooks({ sceneRefs: refs });
}
