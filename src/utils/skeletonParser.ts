import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SkeletonData, BoneData } from '../types';

/**
 * Collect all (parent, child) bone pairs for line drawing.
 */
function collectBonePairs(bones: THREE.Bone[]): [THREE.Bone, THREE.Bone][] {
  const pairs: [THREE.Bone, THREE.Bone][] = [];
  for (const bone of bones) {
    if (bone.parent && (bone.parent as THREE.Bone).isBone) {
      pairs.push([bone.parent as THREE.Bone, bone]);
    }
  }
  return pairs;
}

/**
 * Create fat skeleton lines (LineSegments2) from the bone hierarchy.
 * Returns the line object and an update function to call each frame.
 */
function createSkeletonLines(
  bones: THREE.Bone[]
): { lines: LineSegments2; bonePairs: [THREE.Bone, THREE.Bone][] } {
  const bonePairs = collectBonePairs(bones);

  // Each pair = 2 endpoints × 3 floats
  const positions = new Float32Array(bonePairs.length * 2 * 3);

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);

  const material = new LineMaterial({
    color: 0x00e5ff,
    linewidth: 3,        // 3 pixels wide
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    worldUnits: false,   // linewidth is in screen pixels, not world units
  });

  const lines = new LineSegments2(geometry, material);
  lines.renderOrder = 999;
  lines.frustumCulled = false; // always draw

  return { lines, bonePairs };
}

/**
 * Update the fat-line positions from current bone world matrices.
 * Call this every frame when the skeleton is visible.
 */
export function updateSkeletonLines(
  lines: LineSegments2,
  bonePairs: [THREE.Bone, THREE.Bone][],
  /**
   * Canvas size in CSS pixels. `LineMaterial` needs it to convert its
   * screen-space line width, and it is the *canvas*, not the window — with a
   * dock beside the viewport those differ, and fat lines come out too thick.
   */
  resolution?: { width: number; height: number },
  /**
   * World-to-authored matrix, when the subject carries a display placement.
   *
   * Bone world positions include that placement, and this buffer hangs under
   * the node that applies it, so writing raw world coordinates would apply it
   * twice and the skeleton would drift off the mesh. Omitted, this is the
   * identity and nothing changes.
   */
  toAuthored?: THREE.Matrix4 | null
): void {
  const geo = lines.geometry as LineSegmentsGeometry;
  const startAttr = geo.attributes.instanceStart;
  if (!startAttr) return;

  // instanceStart and instanceEnd share a single InstancedInterleavedBuffer
  // with stride 6: [startX, startY, startZ, endX, endY, endZ, startX, ...]
  // Interleaved: instanceStart and instanceEnd are two views on one buffer.
  const buffer = (startAttr as THREE.InterleavedBufferAttribute).data.array as Float32Array;

  const pos = new THREE.Vector3();

  for (let i = 0; i < bonePairs.length; i++) {
    const [parent, child] = bonePairs[i];
    const offset = i * 6;

    parent.getWorldPosition(pos);
    if (toAuthored) pos.applyMatrix4(toAuthored);
    buffer[offset] = pos.x;
    buffer[offset + 1] = pos.y;
    buffer[offset + 2] = pos.z;

    child.getWorldPosition(pos);
    if (toAuthored) pos.applyMatrix4(toAuthored);
    buffer[offset + 3] = pos.x;
    buffer[offset + 4] = pos.y;
    buffer[offset + 5] = pos.z;
  }

  // Flag both attributes as needing update (they share the same buffer)
  startAttr.needsUpdate = true;
  geo.attributes.instanceEnd.needsUpdate = true;

  // Update the LineMaterial resolution (needed for correct pixel widths)
  const mat = lines.material as LineMaterial;
  if (resolution && resolution.width > 0 && resolution.height > 0) {
    mat.resolution.set(resolution.width, resolution.height);
  }
}

/**
 * A joint-marker radius proportional to the model.
 *
 * Scaled off the *height* of the rig rather than the bounding-box diagonal: a
 * pose with an outstretched limb inflates the diagonal, which would make the
 * markers grow whenever the character happens to be mid-kick.
 *
 * Measured from the bones' world positions, not from `Box3.setFromObject`.
 * That call, run at parse time before the model has ever had its matrices
 * updated in a scene, returned a box one hundred times too small for a skinned
 * mesh: the skinned bounding box already carries the bone transforms, and the
 * mesh's world matrix was then applied on top. The result was a 0.06 mm marker
 * that no screenshot in the project had ever actually shown, hidden behind the
 * screen-space skeleton lines. Bone positions have no such ambiguity.
 */
function jointMarkerRadius(model: THREE.Object3D, bones: THREE.Bone[]): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const bone of bones) box.expandByPoint(bone.getWorldPosition(p));
  const height = box.isEmpty() ? 0 : box.getSize(p).y;
  // 1/300th of stature: ~6mm on a 1.8-unit-tall human.
  const radius = height / 300;
  return Number.isFinite(radius) && radius > 0.0005 ? radius : 0.006;
}

/** Name-based IDs, with a positional suffix only where a name repeats. */
export function assignJointIds(bones: THREE.Bone[]): string[] {
  const seen = new Map<string, number>();
  return bones.map((bone) => {
    const base = bone.name || 'bone';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}

export function parseSkeleton(model: THREE.Group): {
  skeletonData: SkeletonData | null,
  skeletonLines: LineSegments2 | null,
  bonePairs: [THREE.Bone, THREE.Bone][] | null,
  jointMarkers: THREE.Group | null
} {
  let rootBone: THREE.Bone | null = null;
  const bones: THREE.Bone[] = [];

  // Traverse the model to find bones
  model.traverse((object) => {
    if (object.type === 'Bone') {
      const bone = object as THREE.Bone;
      bones.push(bone);
      if (!rootBone) {
        rootBone = bone;
      }
    }
  });

  // Find the true root bone (bone without a parent bone)
  const trueRoot = bones.find(b => b.parent && b.parent.type !== 'Bone') || rootBone;

  // One identity per bone, in traversal order. The name is the identity when
  // it is unique in this rig, which it is for every bundled fixture; a rig
  // that repeats a name gets a positional suffix so two joints never share an
  // ID. Marker index i and jointIds[i] refer to the same bone, which is what
  // lets a raycast hit resolve to an identity instead of a bare index.
  const jointIds = assignJointIds(bones);
  const idOf = new Map<THREE.Bone, string>();
  bones.forEach((bone, i) => idOf.set(bone, jointIds[i]));

  if (!trueRoot || bones.length === 0) {
    return { skeletonData: null, skeletonLines: null, bonePairs: null, jointMarkers: null };
  }

  // 1. Create fat skeleton lines
  const { lines: skeletonLines, bonePairs } = createSkeletonLines(bones);

  // Style the helper for depthTest overlay
  skeletonLines.renderOrder = 999;

  // 2. Create Joint Markers using InstancedMesh (lightweight spherical joints)
  const jointMarkers = new THREE.Group();
  // Marker size is derived from the model, not a constant. 0.006 was tuned for
  // a 0.01-scaled Mixamo FBX; a GLB arrives in metres and an asset from
  // elsewhere could be at any scale, where a fixed radius is either invisible
  // or swallows the rig.
  const sphereGeo = new THREE.SphereGeometry(jointMarkerRadius(model, bones), 6, 6);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0x00e5ff,
    depthTest: false,
    transparent: true,
    opacity: 0.9
  });

  const instancedMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, bones.length);
  instancedMesh.renderOrder = 999;

  // Initialize all instances to zero-scale so they're invisible until the
  // animation loop places them at the correct bone world positions.
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < bones.length; i++) {
    instancedMesh.setMatrixAt(i, zeroMatrix);
  }
  instancedMesh.instanceMatrix.needsUpdate = true;

  jointMarkers.add(instancedMesh);
  jointMarkers.name = 'JointMarkers';

  // Store bone references on the mesh for easy updating in the scene loop,
  // and the parallel identity list for picking.
  instancedMesh.userData = { bones, jointIds };

  // Parse bone hierarchy recursively
  function parseBoneHierarchy(bone: THREE.Object3D): BoneData {
    const children: BoneData[] = [];
    bone.children.forEach(child => {
      if (child.type === 'Bone') {
        children.push(parseBoneHierarchy(child));
      }
    });

    return {
      id: idOf.get(bone as THREE.Bone) ?? bone.name,
      name: bone.name,
      position: bone.position.clone(),
      rotation: bone.quaternion.clone(),
      children: children,
    };
  }

  const parsedBones = parseBoneHierarchy(trueRoot);

  const skeletonData: SkeletonData = {
    bones: [parsedBones],
    boneCount: bones.length,
    rootBone: trueRoot.name,
  };

  return { skeletonData, skeletonLines, bonePairs, jointMarkers };
}

/**
 * Release the skeleton overlay objects this module creates.
 *
 * `parseSkeleton` builds a fat-line geometry and material for the skeleton and
 * an instanced mesh for the joint markers, once per load. They belong to the
 * asset, not to the viewport, so they have to be released when that asset is
 * replaced — otherwise every reload adds two geometries that nothing will ever
 * draw again.
 */
export function disposeSkeletonBundle(
  skeletonLines: THREE.Object3D | null | undefined,
  jointMarkers: THREE.Object3D | null | undefined
): void {
  const release = (object: THREE.Object3D | null | undefined) => {
    if (!object) return;
    object.removeFromParent();
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material?.dispose();
      // The joint markers are an InstancedMesh, which owns an `instanceMatrix`
      // GPU buffer that belongs to neither its geometry nor its material.
      // Disposing those two leaves it allocated, and `renderer.info.memory`
      // counts geometries and textures only, so the leak does not show there.
      const instanced = child as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) instanced.dispose();
    });
  };
  release(skeletonLines);
  release(jointMarkers);
}
