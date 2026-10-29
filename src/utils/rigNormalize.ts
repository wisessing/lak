import * as THREE from 'three';

/**
 * Collapse the duplicate "shadow" rig that some FBX character files arrive
 * with, and put every skinned mesh on one shared skeleton.
 *
 * The bundled samples have one skinned mesh and load with nothing removed. The
 * handling is for user-loaded files whose skeleton is shared by several meshes.
 *
 * ## Where the duplicate rig comes from
 *
 * Such files are fine — a typical one holds 65 bones, two meshes and two skin
 * deformers over that one skeleton. The duplication is `FBXLoader`'s: when a
 * bone is shared by more than one skin cluster it clones the `Bone` and parents
 * the clone under the original, by its own admission — "In cases where a bone
 * is shared between multiple meshes duplicate the bone here and add it as a
 * child of the first bone" (`FBXLoader.js`, `parseSkeleton`).
 *
 * So each mesh gets its own `Skeleton`, and the second one is a shadow: every bone
 * is a leaf child of the identically named bone in the first, with an identity
 * local transform. A 65-bone rig can arrive as 129 bones.
 *
 * In three.js this mostly hides: a shadow bone inherits its twin's animated world
 * matrix, and `Skeleton.update()` reads world matrices, so the viewport looks
 * right. It stops hiding at the exit doors.
 *
 * - **GLB.** `GLTFExporter` emits one skin per skeleton, so the file describes two
 *   armatures whose bones are parented into each other. Blender builds an armature
 *   per skin and cannot parent bones across them, so the second mesh loses its
 *   pose. When that second mesh is, say, a joint shell bridging the gaps in a
 *   segmented surface mesh, the body imports with visible holes.
 * - **FBX.** The writer receives whatever `parseSkeleton` collected, which is all
 *   129 bones including the shadow copies.
 * - **Analysis.** The motion bake samples those same 129 bones, so half of every
 *   per-bone metric describes a duplicate.
 *
 * Which copy the `AnimationClip` drives is also luck: tracks bind by name, so
 * `PropertyBinding` takes whichever copy it reaches first: on one file the
 * original hierarchy, on another the shadow.
 *
 * ## What this does
 *
 * Two passes, both at load time, both no-ops on a clean model:
 *
 * 1. Remove every shadow bone, rebinding by name to the twin it duplicated.
 * 2. Rebind all skinned meshes to a single shared `Skeleton`, rewriting their
 *    `skinIndex` attributes, so one armature describes the whole model.
 *
 * A shadow bone is only removed when it is *provably* redundant: same name as its
 * parent bone, and an identity local transform. Anything else is left alone, so a
 * rig that legitimately repeats a name is not mangled. Normalization is checked by
 * comparing every skinned vertex position before and after, across frames — it
 * must not move the mesh at all.
 */

/** Local transforms this close to identity are treated as identity. */
const IDENTITY_EPSILON = 1e-4;

export interface RigNormalizeResult {
  /** Shadow bones removed from the graph. */
  removedBones: number;
  /** Skinned meshes rebound off a shadow bone. */
  reboundMeshes: number;
  /** True when every skinned mesh ended up on one shared skeleton. */
  unifiedSkeleton: boolean;
  /** Bone count of the resulting skeleton, or of the graph when there is none. */
  boneCount: number;
}

function isIdentityTransform(bone: THREE.Bone): boolean {
  return (
    bone.position.lengthSq() < IDENTITY_EPSILON * IDENTITY_EPSILON &&
    Math.abs(bone.quaternion.w) > 1 - IDENTITY_EPSILON &&
    Math.abs(bone.scale.x - 1) < IDENTITY_EPSILON &&
    Math.abs(bone.scale.y - 1) < IDENTITY_EPSILON &&
    Math.abs(bone.scale.z - 1) < IDENTITY_EPSILON
  );
}

/**
 * A bone that merely shadows its parent: same name, no transform of its own.
 * Everything such a bone can influence, its parent influences identically.
 */
function isShadowBone(bone: THREE.Bone): boolean {
  const parent = bone.parent as THREE.Bone | null;
  return (
    !!parent && parent.isBone === true && parent.name === bone.name && isIdentityTransform(bone)
  );
}

function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) bones.push(child as THREE.Bone);
  });
  return bones;
}

function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(child as THREE.SkinnedMesh);
  });
  return meshes;
}

/** Walk up past any chain of shadows to the bone that carries the transform. */
function resolveShadow(bone: THREE.Bone): THREE.Bone {
  let current = bone;
  while (isShadowBone(current)) current = current.parent as THREE.Bone;
  return current;
}

/** Depth from the scene root, used to remove the deepest shadows first. */
function depthOf(object: THREE.Object3D): number {
  let depth = 0;
  for (let node: THREE.Object3D | null = object; node; node = node.parent) depth++;
  return depth;
}

/** Pass 1 — drop shadow bones and rebind the meshes that were bound to them. */
function collapseShadowBones(root: THREE.Object3D, result: RigNormalizeResult): void {
  const shadows = collectBones(root).filter(isShadowBone);
  if (shadows.length === 0) return;

  const shadowSet = new Set(shadows);

  for (const mesh of collectSkinnedMeshes(root)) {
    const bones = mesh.skeleton?.bones ?? [];
    if (!bones.some((bone) => shadowSet.has(bone))) continue;

    // The shadow and its twin share a bind pose, so the existing inverses stay
    // correct. Recomputing them here would bake the current pose into the rest
    // position instead.
    const rebound = bones.map(resolveShadow);
    const inverses = mesh.skeleton.boneInverses.map((m) => m.clone());
    mesh.bind(new THREE.Skeleton(rebound, inverses), mesh.bindMatrix.clone());
    result.reboundMeshes++;
  }

  // Deepest first, so a shadow whose own children include shadows is handled
  // after them and nothing is reparented onto a bone that is about to go.
  shadows.sort((a, b) => depthOf(b) - depthOf(a));

  for (const shadow of shadows) {
    const parent = shadow.parent;
    if (!parent) continue;
    // Identity local transform, so reparenting onto the twin preserves every
    // child's world transform without touching it.
    for (const child of [...shadow.children]) parent.add(child);
    shadow.removeFromParent();
    result.removedBones++;
  }
}

/**
 * Pass 2 — one `Skeleton` for the whole model.
 *
 * `GLTFExporter` writes a skin per skeleton, so leaving each mesh on its own
 * skeleton still produces a multi-armature glTF even after the shadow bones are
 * gone. Bones are ordered by graph traversal and every mesh's `skinIndex` is
 * rewritten into that order.
 *
 * Bails out rather than guessing if two meshes disagree about a bone's inverse
 * bind matrix, since one shared skeleton could then only be right for one of them.
 */
function unifySkeletons(root: THREE.Object3D, result: RigNormalizeResult): void {
  const meshes = collectSkinnedMeshes(root).filter((m) => (m.skeleton?.bones.length ?? 0) > 0);
  if (meshes.length === 0) return;

  const order = collectBones(root);
  const indexOf = new Map<THREE.Bone, number>();
  order.forEach((bone, i) => indexOf.set(bone, i));

  // Every mesh must bind bones that are still in the graph for a shared skeleton
  // to be expressible at all.
  for (const mesh of meshes) {
    if (mesh.skeleton.bones.some((bone) => !indexOf.has(bone))) return;
  }

  const inverses: (THREE.Matrix4 | null)[] = order.map(() => null);
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.skeleton.bones.length; i++) {
      const slot = indexOf.get(mesh.skeleton.bones[i])!;
      const candidate = mesh.skeleton.boneInverses[i];
      const existing = inverses[slot];
      if (!existing) {
        inverses[slot] = candidate.clone();
        continue;
      }
      for (let e = 0; e < 16; e++) {
        if (Math.abs(existing.elements[e] - candidate.elements[e]) > 1e-3) return;
      }
    }
  }

  // A bone no mesh binds still needs an entry. In bind pose the world matrix is
  // the bind matrix, and this runs at load before any clip is applied.
  root.updateMatrixWorld(true);
  const boneInverses = order.map(
    (bone, i) => inverses[i] ?? new THREE.Matrix4().copy(bone.matrixWorld).invert()
  );

  const shared = new THREE.Skeleton(order, boneInverses);

  for (const mesh of meshes) {
    const remap = mesh.skeleton.bones.map((bone) => indexOf.get(bone)!);
    const skinIndex = mesh.geometry.getAttribute('skinIndex');
    if (skinIndex) {
      // Uint8 indices cannot address a longer bone list; widen before writing.
      const needsWidening = skinIndex.array instanceof Uint8Array && order.length > 255;
      const target = needsWidening
        ? new THREE.BufferAttribute(new Uint16Array(skinIndex.array), skinIndex.itemSize)
        : skinIndex;
      for (let i = 0; i < skinIndex.count; i++) {
        for (let c = 0; c < skinIndex.itemSize; c++) {
          target.setComponent(i, c, remap[skinIndex.getComponent(i, c)] ?? 0);
        }
      }
      target.needsUpdate = true;
      if (needsWidening) mesh.geometry.setAttribute('skinIndex', target);
    }
    mesh.bind(shared, mesh.bindMatrix.clone());
  }

  result.unifiedSkeleton = true;
  result.boneCount = order.length;
}

/**
 * Normalize a loaded rig in place. Safe on a model that is already clean — it
 * reports what it found and changes nothing it does not have to.
 */
export function normalizeRig(root: THREE.Object3D): RigNormalizeResult {
  const result: RigNormalizeResult = {
    removedBones: 0,
    reboundMeshes: 0,
    unifiedSkeleton: false,
    boneCount: 0,
  };

  collapseShadowBones(root, result);
  root.updateMatrixWorld(true);
  unifySkeletons(root, result);
  root.updateMatrixWorld(true);

  if (result.boneCount === 0) result.boneCount = collectBones(root).length;
  return result;
}
