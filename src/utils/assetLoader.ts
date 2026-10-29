import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { normalizeRig } from './rigNormalize';
import { sampleUrl, type SampleAsset } from '../constants/sampleAssets';

/**
 * Load a motion asset — FBX or GLB — into one shape the rest of the app can
 * consume.
 *
 * The two formats need genuinely different handling, and conflating them is how
 * a model ends up 100× too big:
 *
 * - **FBX** arrives in the exporter's units, which for Mixamo means
 *   centimetres, so it is scaled by 0.01. Its clips hang off
 *   `object.animations`.
 * - **GLB** is metres by specification, so it is *not* scaled. Its clips come
 *   back beside the scene rather than on it, and have to be attached.
 *
 * `normalizeRig` runs for both. It only removes bones that are provably
 * redundant — same name as their parent bone, identity local transform — so it
 * is a no-op on a clean rig and a fix on the duplicated ones `FBXLoader`
 * produces. Running it unconditionally means a GLB exported *from this app*
 * round-trips through the same path.
 */

export type AssetFormat = 'fbx' | 'glb';

export interface LoadedAsset {
  object: THREE.Group;
  animations: THREE.AnimationClip[];
  format: AssetFormat;
}

/** Single-file `.glb` only: `.gltf` needs sidecar buffers we cannot resolve. */
const EXTENSIONS: Record<string, AssetFormat> = {
  '.fbx': 'fbx',
  '.glb': 'glb',
};

/** The format a filename implies, or null if we do not handle it. */
export function formatOf(fileName: string): AssetFormat | null {
  const lower = fileName.toLowerCase();
  for (const [ext, format] of Object.entries(EXTENSIONS)) {
    if (lower.endsWith(ext)) return format;
  }
  return null;
}

export const ACCEPT_ATTRIBUTE = Object.keys(EXTENSIONS).join(',');

/** Shadows are a scene-wide convention, applied the same way for both formats. */
function enableShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

export async function loadAsset(
  file: File,
  onProgress?: (progress: number) => void
): Promise<LoadedAsset> {
  const format = formatOf(file.name);
  if (!format) {
    throw new Error(`${file.name} is not an FBX or GLB file.`);
  }

  const url = URL.createObjectURL(file);
  const report = (xhr: ProgressEvent) => {
    // `total` is 0 when the length is unknown; reporting NaN would freeze the
    // progress bar rather than leaving it be.
    if (onProgress && xhr.total > 0) onProgress((xhr.loaded / xhr.total) * 100);
  };

  try {
    if (format === 'fbx') {
      const object = await new FBXLoader().loadAsync(url, report);
      normalizeRig(object);
      object.scale.setScalar(0.01);
      enableShadows(object);
      return { object, animations: object.animations ?? [], format };
    }

    const gltf = await new GLTFLoader().loadAsync(url, report);
    const object = gltf.scene;
    normalizeRig(object);
    enableShadows(object);
    // GLTFLoader hands animations back separately; everything downstream reads
    // them from the object, so attach them.
    object.animations = gltf.animations ?? [];
    return { object, animations: object.animations, format };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fetch a bundled sample and hand it back as a `File`.
 *
 * Deliberately a `File` rather than a second loader entry point: the sample
 * then travels through `loadAsset`, `normalizeRig`, the 0.01 FBX conversion,
 * and the store's guarded replacement exactly as a user-picked file does. One
 * parse path means a sample cannot drift from an import.
 *
 * `signal` lets a superseded request stop downloading rather than finish into a
 * result nobody will use.
 */
export async function fetchSampleFile(
  sample: SampleAsset,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {}
): Promise<File> {
  const url = sampleUrl(sample);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Could not download ${sample.fileName} (HTTP ${response.status}).`);
  }

  // Report download progress when the server declares a length. Without one,
  // leave the bar alone rather than animating a number we cannot compute.
  const total = Number(response.headers.get('content-length') ?? 0);
  if (!onProgress || !total || !response.body) {
    const blob = await response.blob();
    return new File([blob], sample.fileName, { type: 'application/octet-stream' });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(100, (received / total) * 100));
  }
  return new File(chunks as BlobPart[], sample.fileName, { type: 'application/octet-stream' });
}

/**
 * Release the GPU resources of an asset the app will never show.
 *
 * A superseded or abandoned load has already built geometries, materials, and
 * textures. Dropping the reference alone leaks them, and the reliability item
 * this is part of is specifically about rapid sample switching.
 */
let supersededCount = 0;
let retiredCount = 0;

/**
 * How many assets have been released this session, by reason.
 *
 * Two reasons, and they are worth telling apart. A **superseded** asset was
 * parsed for a request that a newer one overtook, so it was never on screen. A
 * **retired** asset was the active model until something replaced it. Both must
 * be released; only the first says anything about the load race.
 *
 * Counting is the only way to observe either from outside, since the object is
 * unreachable by design once it is dropped.
 */
export function disposedAssetCounts(): { superseded: number; retired: number } {
  return { superseded: supersededCount, retired: retiredCount };
}

/** Release an asset that lost a load race before it could be shown. */
export function disposeSupersededAsset(root: THREE.Object3D): void {
  supersededCount++;
  disposeAsset(root);
}

/**
 * Release the asset that was on screen until now.
 *
 * Detached first: the replacement is written to the store before React commits,
 * so for one frame the old model is still parented, and rendering a disposed
 * geometry would simply re-upload it and undo the work.
 */
export function retireAsset(root: THREE.Object3D): void {
  retiredCount++;
  root.removeFromParent();
  disposeAsset(root);
}

export function disposeAsset(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) if (material) materials.add(material);
    // A skinned mesh uploads its bone matrices as a data texture, which belongs
    // to the Skeleton rather than to any material. Releasing geometries and
    // materials alone left exactly one texture behind per load, and several
    // meshes can share one skeleton, hence the set.
    const skinned = child as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) skeletons.add(skinned.skeleton);
  });

  for (const material of materials) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
