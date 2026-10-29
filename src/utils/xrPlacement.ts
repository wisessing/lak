import type { PresentationState } from './presentationSpace';
import { MAX_PRESENTATION_SCALE, MIN_PRESENTATION_SCALE } from './presentationSpace';

/**
 * Turning a surface the device found into a place to stand the subject.
 *
 * Pure, and separate from the session, because this is the part with an answer
 * that can be wrong in ways nobody notices on a device: a subject sunk into the
 * floor, tipped off vertical, or facing away. Those are cheaper to catch here
 * than in a room.
 *
 * The one fact this depends on is the fixtures' own convention: the authored
 * origin is the floor. An exported GLB stands at y≈0, and the bundled rigs measure from -0.01 upward before the
 * import scale. So aligning the subject's origin with the hit point puts its
 * feet on the surface, and no per-frame foot offset is needed or wanted.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * How far from vertical a surface may tilt and still be stood on, in degrees.
 *
 * An implementation tolerance, not a claim about any device's accuracy. It
 * exists to reject walls and ceilings, which a hit test will happily return.
 */
export const MAX_SURFACE_TILT_DEG = 15;

const MIN_UP = Math.cos((MAX_SURFACE_TILT_DEG * Math.PI) / 180);

const finite = (v: Vec3 | null | undefined): v is Vec3 =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * Is this a floor rather than a wall, a ceiling, or nothing?
 *
 * The normal has to point up, not merely be horizontal-ish: a ceiling is just
 * as level as a floor and its normal points the other way.
 */
export function isUprightSurface(normal: Vec3 | null | undefined): boolean {
  if (!finite(normal)) return false;
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (!Number.isFinite(length) || length < 1e-6) return false;
  return normal.y / length >= MIN_UP;
}

export interface PlacementInput {
  /** Where the surface was hit, in the session's reference space. */
  hit: Vec3;
  /** The surface normal at that point. */
  normal: Vec3;
  /** Where the viewer is, so the subject can be turned to face them. */
  viewer: Vec3;
  /**
   * Display scale, 1 by default. Life size is the measurement; anything else is
   * a viewing convenience chosen by the user, and it is clamped to the same
   * bounds the presentation itself enforces.
   */
  scale?: number;
}

/**
 * The placement for a valid hit, or null if the surface will not do.
 *
 * Scale defaults to exactly 1: the subject is a measurement, and showing it at
 * life size in the room is the point of doing this on a device. A smaller scale
 * is applied about the authored origin, the floor between the feet, so the
 * subject still stands on the surface it was given. Yaw only, because
 * pitch or roll would tip a standing figure off the floor it was just placed
 * on. The subject is turned to face the viewer, which is what makes a placement
 * useful immediately rather than after walking around it.
 */
export function placementFromHit({ hit, normal, viewer, scale = 1 }: PlacementInput): PresentationState | null {
  if (!finite(hit) || !finite(viewer)) return null;
  if (!isUprightSurface(normal)) return null;

  // Horizontal only. A viewer above the subject must not tip it over, and a
  // viewer directly overhead gives no direction at all, so that keeps yaw 0.
  const dx = viewer.x - hit.x;
  const dz = viewer.z - hit.z;
  const yaw = Math.hypot(dx, dz) < 1e-6 ? 0 : Math.atan2(dx, dz);

  const clamped = Number.isFinite(scale)
    ? Math.min(MAX_PRESENTATION_SCALE, Math.max(MIN_PRESENTATION_SCALE, scale))
    : 1;
  return { x: hit.x, y: hit.y, z: hit.z, yaw, scale: clamped };
}

/**
 * Where the subject's own forward axis points once a yaw is applied.
 *
 * The rigs face +Z in authored space, so this is that axis rotated. Exported
 * for the checks, which assert that a placed subject faces the viewer rather
 * than trusting that the arithmetic above reads correctly.
 */
export function facingFromYaw(yaw: number): Vec3 {
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
}
