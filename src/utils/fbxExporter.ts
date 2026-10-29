import * as THREE from 'three';

/**
 * Binary FBX 7.4 writer — meshes, skin weights, skeleton hierarchy and animation.
 *
 * Why this exists at all: FBX is proprietary and three.js ships `FBXLoader` with
 * no writer, so there is nothing to reuse. The cheap alternative, ASCII FBX, is
 * rejected outright by Blender's importer, which would have left the most likely
 * destination unserved. So this writes the binary container.
 *
 * **Three conventions here are the likely source of any DCC problem**, and each is
 * called out at its definition below: the Euler order used to convert quaternions
 * (`EULER_ORDER`), the key interpolation flag (`KEY_FLAG_LINEAR`), and the pair of
 * skin-cluster matrices (`clusterMatrices`). If rotations come in twisted, start
 * with the first; if curves step instead of interpolating, the second; if the mesh
 * arrives inside out or scaled away from its skeleton, the third.
 *
 * Everything is written uncompressed — FBX permits array encoding 0, which keeps
 * a zlib dependency out of the bundle at the cost of file size. A bundled sample runs
 * about 4.5 MB.
 */

/** FBX measures time in these ticks per second. */
const FBX_TICKS_PER_SECOND = 46186158000;

/** Container version. 7500+ would widen node offsets to 64-bit. */
const FBX_VERSION = 7400;

/**
 * Euler order used to convert quaternions, paired with `FBX_ROTATION_ORDER`.
 *
 * **These two do not spell the same thing, and that is the point.** FBX's
 * `eEulerXYZ` is *extrinsic* XYZ; the equivalent intrinsic order — which is what
 * three.js means by `Euler.order` — is its reverse, `ZYX`. three.js's own
 * `FBXLoader` encodes exactly this mapping in `getEulerOrder`, where enum 0 reads
 * back as `'ZYX'`.
 *
 * Writing `'XYZ'` here against `RotationOrder` 0 silently transposes every joint.
 * Bones near identity barely shift, so a rig looks plausible while the hands end
 * up a metre from the wrists — which is how it was caught: a round trip through
 * `FBXLoader` put fingertip vertices 125 cm from where they started.
 */
const EULER_ORDER = 'ZYX';

/** `eEulerXYZ`, the FBX default. `EULER_ORDER` is its intrinsic equivalent. */
const FBX_ROTATION_ORDER = 0;

/**
 * `eInterpolationLinear`. Every frame is keyed, so interpolation barely matters
 * in practice, but an importer that misreads this would step between keys
 * instead of blending.
 */
const KEY_FLAG_LINEAR = 4;

/** Footer constant used by unencrypted FBX files. Importers do not verify it. */
const FOOTER_CODE = new Uint8Array([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66,
  0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]);

const FOOTER_MAGIC = new Uint8Array([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e,
  0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
]);

/**
 * Seeking a looping action to exactly `duration` wraps it to zero, so the last
 * sample would capture the first pose. Same guard as the motion bake.
 */
const END_EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Byte writer
// ---------------------------------------------------------------------------

/** Growable little-endian byte buffer with after-the-fact patching. */
class ByteWriter {
  private buffer = new Uint8Array(1 << 16);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(this.buffer.buffer);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.length, v); this.length += 1; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.length, v, true); this.length += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.length, v, true); this.length += 4; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.length, v, true); this.length += 4; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.length, v, true); this.length += 8; }

  i64(v: number) {
    this.ensure(8);
    this.view.setBigInt64(this.length, BigInt(Math.round(v)), true);
    this.length += 8;
  }

  bytes(src: Uint8Array) { this.ensure(src.length); this.buffer.set(src, this.length); this.length += src.length; }
  ascii(text: string) { for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i) & 0xff); }
  zeros(count: number) { this.ensure(count); this.length += count; }

  patchU32(offset: number, value: number) { this.view.setUint32(offset, value, true); }

  toArrayBuffer(): ArrayBuffer {
    return this.buffer.buffer.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// Node tree
// ---------------------------------------------------------------------------

type Prop =
  | { t: 'C'; v: boolean }
  | { t: 'Y'; v: number }
  | { t: 'I'; v: number }
  | { t: 'L'; v: number }
  | { t: 'F'; v: number }
  | { t: 'D'; v: number }
  | { t: 'S'; v: string }
  | { t: 'i'; v: ArrayLike<number> }
  | { t: 'l'; v: ArrayLike<number> }
  | { t: 'f'; v: ArrayLike<number> }
  | { t: 'd'; v: ArrayLike<number> };

interface Node {
  name: string;
  props: Prop[];
  children: Node[];
}

const node = (name: string, props: Prop[] = [], children: Node[] = []): Node => ({
  name,
  props,
  children,
});

const S = (v: string): Prop => ({ t: 'S', v });
const I = (v: number): Prop => ({ t: 'I', v });
const L = (v: number): Prop => ({ t: 'L', v });
const D = (v: number): Prop => ({ t: 'D', v });

/**
 * Object names are stored reversed with a `\0\1` separator — `Hips::Model`
 * becomes `Hips\0\1Model`. Missing this makes every object anonymous to an
 * importer.
 */
const objectName = (name: string, klass: string): Prop =>
  S(`${name}\u0000\u0001${klass}`);

/**
 * How a `Properties70` value is encoded, keyed by the property's declared FBX
 * type. Anything not listed here is a float64.
 *
 * **This is not cosmetic.** Blender's importer asserts on the storage type, not
 * just the type name: `elem_props_get_integer` requires INT32 or INT64,
 * `elem_props_get_enum` and `elem_props_get_bool` require INT32
 * (`io_scene_fbx/import_fbx.py`). Writing a float64 into `FrontAxis` aborts the
 * import with a bare `AssertionError` before a single object is read — which is
 * exactly what a whole-file rejection looked like from the outside.
 */
const PROPERTY_VALUE_TYPE: Record<string, 'I' | 'L'> = {
  int: 'I',
  enum: 'I',
  bool: 'I',
  KTime: 'L',
  ULongLong: 'L',
};

/** A `Properties70` entry. */
function P(name: string, type: string, sub: string, flags: string, ...values: number[]): Node {
  const props: Prop[] = [S(name), S(type), S(sub), S(flags)];
  const encoding = PROPERTY_VALUE_TYPE[type];
  for (const v of values) {
    if (encoding === 'I') props.push(I(Math.round(v)));
    else if (encoding === 'L') props.push(L(Math.round(v)));
    else props.push(D(v));
  }
  return node('P', props);
}

function writeProp(w: ByteWriter, p: Prop): void {
  w.u8(p.t.charCodeAt(0));
  switch (p.t) {
    case 'C': w.u8(p.v ? 1 : 0); return;
    case 'Y': w.i16(p.v); return;
    case 'I': w.i32(p.v); return;
    case 'L': w.i64(p.v); return;
    case 'F': w.f32(p.v); return;
    case 'D': w.f64(p.v); return;
    case 'S': {
      // Not null-terminated; the length prefix is authoritative.
      w.u32(p.v.length);
      w.ascii(p.v);
      return;
    }
    default: {
      // Array property. Encoding 0 means raw — FBX permits it, so we skip zlib
      // entirely rather than taking on a compression dependency.
      const n = p.v.length;
      const stride = p.t === 'l' || p.t === 'd' ? 8 : 4;
      w.u32(n);
      w.u32(0);
      w.u32(n * stride);
      for (let i = 0; i < n; i++) {
        const value = p.v[i];
        if (p.t === 'i') w.i32(value);
        else if (p.t === 'l') w.i64(value);
        else if (p.t === 'f') w.f32(value);
        else w.f64(value);
      }
    }
  }
}

function writeNode(w: ByteWriter, n: Node): void {
  const header = w.length;
  // EndOffset, NumProperties and PropertyListLen are all patched once the real
  // sizes are known. Offsets are absolute, which is why this streams rather than
  // composing buffers bottom-up.
  w.u32(0);
  w.u32(0);
  w.u32(0);
  w.u8(n.name.length);
  w.ascii(n.name);

  const propStart = w.length;
  for (const p of n.props) writeProp(w, p);
  const propLen = w.length - propStart;

  for (const child of n.children) writeNode(w, child);
  // A 13-byte null record terminates a child list, and must be absent when
  // there are no children.
  if (n.children.length > 0) w.zeros(13);

  w.patchU32(header, w.length);
  w.patchU32(header + 4, n.props.length);
  w.patchU32(header + 8, propLen);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

interface BoneSamples {
  /** Local translation per frame, xyz interleaved. */
  translation: Float64Array;
  /** Local rotation per frame as unwrapped Euler degrees, xyz interleaved. */
  rotation: Float64Array;
  /** Local scale per frame, xyz interleaved. */
  scale: Float64Array;
}

/**
 * The transform of the plain nodes between `model` and a top-level bone.
 *
 * A top-level bone is written under the scene root, so its local transform has
 * to carry whatever sat above it in the source. On many character files that is
 * nothing: the hips hang straight off the model. A Blender export puts an armature node
 * in between, and that node holds the axis change and the metre-to-centimetre
 * scale; leave it out and the keys come out a hundred times too small and lying
 * on their back. Null when a bone has an exported bone (or the model) as parent.
 */
function ancestorMatrix(
  bone: THREE.Bone,
  model: THREE.Object3D,
  exported: Set<THREE.Bone>
): THREE.Matrix4 | null {
  const chain: THREE.Object3D[] = [];
  for (let node = bone.parent; node && node !== model; node = node.parent) {
    if (exported.has(node as THREE.Bone)) return null;
    chain.push(node);
  }
  if (chain.length === 0) return null;
  const matrix = new THREE.Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    matrix.multiply(chain[i].matrix);
  }
  return matrix;
}

/**
 * The uniform scale each bone inherits from plain nodes above the skeleton.
 *
 * `ancestorMatrix` folds those nodes into the top-level bone, scale included,
 * and a bone carrying a hundredfold scale is something importers handle badly:
 * Blender drops it from the pose and leaves the rig barely moving. So the scale
 * is taken back out of the top-level bone and pushed down into the translations
 * beneath it instead, which states the same pose in centimetres throughout.
 * `introduced` marks the bone where the factor enters. On a rig with nothing
 * above its skeleton every factor is 1 and nothing changes.
 */
interface CarriedScale {
  factor: number;
  introduced: boolean;
}

function carriedScales(model: THREE.Object3D, bones: THREE.Bone[]): CarriedScale[] {
  const exported = new Set(bones);
  const byBone = new Map<THREE.Bone, CarriedScale>();
  return bones.map((bone) => {
    const parent = byBone.get(bone.parent as THREE.Bone);
    let carried: CarriedScale;
    if (parent) {
      carried = { factor: parent.factor, introduced: false };
    } else {
      const above = ancestorMatrix(bone, model, exported);
      carried = { factor: above ? above.getMaxScaleOnAxis() : 1, introduced: true };
    }
    byBone.set(bone, carried);
    return carried;
  });
}

/** Apply a bone's carried scale to one local transform; see `carriedScales`. */
function applyCarried(carried: CarriedScale, position: THREE.Vector3, scale: THREE.Vector3): void {
  if (carried.factor === 1) return;
  if (carried.introduced) scale.divideScalar(carried.factor);
  else position.multiplyScalar(carried.factor);
}

/**
 * Sample each bone's *local* transform per frame.
 *
 * Local, not world: FBX stores `Lcl Translation` / `Lcl Rotation` relative to the
 * parent, so the world-space motion dataset used elsewhere in the app is the
 * wrong input here. A top-level bone also takes in the plain nodes above it; see
 * `ancestorMatrix`.
 *
 * Euler angles are unwrapped as they are produced — a raw conversion jumps by
 * ±360° whenever it crosses the principal range, and an importer reading those
 * keys literally spins the joint all the way round between two frames.
 */
function sampleLocals(
  model: THREE.Object3D,
  bones: THREE.Bone[],
  clip: THREE.AnimationClip,
  frameCount: number,
  fps: number,
  carried: CarriedScale[]
): BoneSamples[] {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();

  const out: BoneSamples[] = bones.map(() => ({
    translation: new Float64Array(frameCount * 3),
    rotation: new Float64Array(frameCount * 3),
    scale: new Float64Array(frameCount * 3),
  }));

  const euler = new THREE.Euler(0, 0, 0, EULER_ORDER);
  const previous = new Float64Array(bones.length * 3);
  const exported = new Set(bones);
  const local = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let frame = 0; frame < frameCount; frame++) {
    const time = Math.min(frame / fps, Math.max(0, clip.duration - END_EPSILON));
    mixer.setTime(time);

    for (let b = 0; b < bones.length; b++) {
      const bone = bones[b];
      const offset = frame * 3;
      const s = out[b];

      // Read per frame: the plain nodes above a bone can be animated too.
      const above = ancestorMatrix(bone, model, exported);
      if (above) {
        bone.updateMatrix();
        local.multiplyMatrices(above, bone.matrix).decompose(position, quaternion, scale);
      } else {
        position.copy(bone.position);
        quaternion.copy(bone.quaternion);
        scale.copy(bone.scale);
      }
      applyCarried(carried[b], position, scale);

      s.translation[offset] = position.x;
      s.translation[offset + 1] = position.y;
      s.translation[offset + 2] = position.z;

      s.scale[offset] = scale.x;
      s.scale[offset + 1] = scale.y;
      s.scale[offset + 2] = scale.z;

      euler.setFromQuaternion(quaternion, EULER_ORDER);
      const raw = [
        THREE.MathUtils.radToDeg(euler.x),
        THREE.MathUtils.radToDeg(euler.y),
        THREE.MathUtils.radToDeg(euler.z),
      ];

      for (let axis = 0; axis < 3; axis++) {
        let value = raw[axis];
        if (frame > 0) {
          const prev = previous[b * 3 + axis];
          // Shift by whole turns until this key is adjacent to the last one.
          value += Math.round((prev - value) / 360) * 360;
        }
        previous[b * 3 + axis] = value;
        s.rotation[offset + axis] = value;
      }
    }
  }

  mixer.stopAllAction();
  mixer.uncacheClip(clip);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry and skinning
// ---------------------------------------------------------------------------

/** One skin cluster: the vertices a single bone pulls on, and how hard. */
interface Cluster {
  /** Index into the exported bone list. */
  bone: number;
  indices: Int32Array;
  weights: Float64Array;
  /** See `clusterMatrices`. */
  transform: number[];
  transformLink: number[];
}

/** A mesh flattened into the arrays FBX wants. */
interface MeshPart {
  name: string;
  source: THREE.Mesh;
  /** Control points, xyz interleaved. */
  vertices: Float64Array;
  /**
   * One entry per polygon vertex, indexing `vertices`. The last entry of each
   * polygon is stored as its bitwise complement — that is how FBX marks a
   * polygon boundary, and an importer reading it literally sees one giant face.
   */
  polygonVertexIndex: Int32Array;
  /** Per polygon vertex, xyz interleaved. Empty when the mesh has no normals. */
  normals: Float64Array;
  /** Per polygon vertex, uv interleaved. Empty when the mesh has no UVs. */
  uvs: Float64Array;
  /** Per polygon, indexing `materials`. Empty when one material covers the mesh. */
  materialPerPolygon: Int32Array;
  materials: THREE.Material[];
  clusters: Cluster[];
}

/**
 * The two matrices every skin cluster carries, and the reason a mesh can arrive
 * detached from its skeleton.
 *
 * FBX poses a skinned vertex as `boneNow · inverse(boneAtBind) · meshAtBind · v`,
 * and splits that across the cluster as:
 *
 * - `TransformLink` — the bone's world matrix at bind time.
 * - `Transform` — the mesh's world matrix at bind time, taken into the bone's
 *   space: `inverse(boneAtBind) · meshAtBind`.
 *
 * three.js stores the first factor pre-inverted as `Skeleton.boneInverses`, and
 * the second as `SkinnedMesh.bindMatrix`, so both fall out directly. This matches
 * what Blender's own FBX exporter writes, which is the compatibility that matters.
 */
function clusterMatrices(
  mesh: THREE.SkinnedMesh,
  boneSlot: number,
  factor: number,
  unplace: THREE.Matrix4
): { transform: number[]; transformLink: number[] } {
  const boneInverse = mesh.skeleton.boneInverses[boneSlot];
  // The bones are written with their carried scale taken out (see
  // `carriedScales`), so the bind matrices take it out too. The vertices are
  // written already placed (see `buildMeshPart`), so `unplace` takes them back
  // to the mesh's own space before the bind matrix applies.
  const unscale = new THREE.Matrix4().makeScale(factor, factor, factor);
  const transform = unscale
    .clone()
    .multiply(boneInverse)
    .multiply(mesh.bindMatrix)
    .multiply(unplace);
  const transformLink = new THREE.Matrix4().copy(boneInverse).invert().multiply(unscale.invert());
  return { transform: transform.toArray(), transformLink: transformLink.toArray() };
}

/**
 * Flatten one mesh. Returns null for anything without triangles to write.
 *
 * `boneIndex` maps bone objects onto their position in the exported bone list, so
 * skin indices are translated rather than assumed to line up — the skeleton's own
 * bone order and the export order are built by separate traversals.
 */
function buildMeshPart(
  model: THREE.Object3D,
  mesh: THREE.Mesh,
  boneIndex: Map<THREE.Bone, number>,
  carried: CarriedScale[]
): MeshPart | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) return null;

  const index = geometry.getIndex();
  const cornerCount = index ? index.count : position.count;
  if (cornerCount < 3) return null;

  // The vertices go out in model space, with the mesh's placement baked in, and
  // the mesh node is written as the identity. three.js's FBXLoader binds a mesh
  // with an identity bind matrix when the file has no bind pose, so a mesh node
  // carrying a transform comes back skinned in the wrong place. On many character
  // files the placement is the identity anyway; a Blender export puts the axis change
  // and unit scale here.
  const placed = new THREE.Matrix4();
  for (let node: THREE.Object3D | null = mesh; node && node !== model; node = node.parent) {
    node.updateMatrix();
    placed.premultiply(node.matrix);
  }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(placed);
  const unplace = placed.clone().invert();

  const vertices = new Float64Array(position.count * 3);
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(placed);
    vertices[i * 3] = vertex.x;
    vertices[i * 3 + 1] = vertex.y;
    vertices[i * 3 + 2] = vertex.z;
  }

  const triangleCount = Math.floor(cornerCount / 3);
  const polygonVertexIndex = new Int32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) {
      const corner = t * 3 + c;
      const vertex = index ? index.getX(corner) : corner;
      polygonVertexIndex[corner] = c === 2 ? ~vertex : vertex;
    }
  }

  /** Expand a per-vertex attribute into FBX's per-polygon-vertex layout. */
  const perCorner = (name: string, size: number): Float64Array => {
    const attribute = geometry.getAttribute(name);
    if (!attribute) return new Float64Array(0);
    const out = new Float64Array(triangleCount * 3 * size);
    for (let corner = 0; corner < triangleCount * 3; corner++) {
      const vertex = index ? index.getX(corner) : corner;
      for (let c = 0; c < size; c++) out[corner * size + c] = attribute.getComponent(vertex, c);
    }
    return out;
  };

  // UVs go out exactly as three.js holds them, so a round trip through
  // FBXLoader is lossless. Blender flips V on import; the sample materials are
  // untextured, so that is cosmetic here.
  const normals = perCorner('normal', 3);
  const normal = new THREE.Vector3();
  for (let i = 0; i < normals.length; i += 3) {
    normal.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(normalMatrix).normalize();
    normals[i] = normal.x;
    normals[i + 1] = normal.y;
    normals[i + 2] = normal.z;
  }
  const uvs = perCorner('uv', 2);

  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let materialPerPolygon = new Int32Array(0);
  if (materials.length > 1 && geometry.groups.length > 0) {
    materialPerPolygon = new Int32Array(triangleCount);
    for (const group of geometry.groups) {
      const first = Math.floor(group.start / 3);
      const last = Math.min(triangleCount, first + Math.floor(group.count / 3));
      const slot = Math.min(group.materialIndex ?? 0, materials.length - 1);
      for (let t = first; t < last; t++) materialPerPolygon[t] = slot;
    }
  }

  const clusters: Cluster[] = [];
  const skinned = mesh as THREE.SkinnedMesh;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');

  if (skinned.isSkinnedMesh && skinned.skeleton && skinIndex && skinWeight) {
    const bones = skinned.skeleton.bones;
    const perBone = new Map<number, { indices: number[]; weights: number[]; slot: number }>();

    for (let v = 0; v < skinIndex.count; v++) {
      for (let c = 0; c < skinIndex.itemSize; c++) {
        const weight = skinWeight.getComponent(v, c);
        if (weight <= 0) continue;
        const bone = bones[skinIndex.getComponent(v, c)];
        const exported = bone ? boneIndex.get(bone) : undefined;
        // A weight onto a bone outside the export list has nowhere to go.
        // normalizeRig makes this unreachable for the bundled assets.
        if (exported === undefined) continue;
        let entry = perBone.get(exported);
        if (!entry) {
          entry = { indices: [], weights: [], slot: bones.indexOf(bone) };
          perBone.set(exported, entry);
        }
        entry.indices.push(v);
        entry.weights.push(weight);
      }
    }

    for (const [bone, entry] of [...perBone.entries()].sort((a, b) => a[0] - b[0])) {
      clusters.push({
        bone,
        indices: new Int32Array(entry.indices),
        weights: new Float64Array(entry.weights),
        ...clusterMatrices(skinned, entry.slot, carried[bone].factor, unplace),
      });
    }
  }

  return {
    name: mesh.name || 'Mesh',
    source: mesh,
    vertices,
    polygonVertexIndex,
    normals,
    uvs,
    materialPerPolygon,
    materials,
    clusters,
  };
}

/**
 * The bind pose, as a local transform per bone.
 *
 * This has to be the *bind* pose and not, say, the clip's first frame. Vertices
 * are written in bind space and the skin clusters undo the bind pose to get them
 * there (see `clusterMatrices`), so a rest pose that disagrees with
 * `TransformLink` leaves the mesh hanging off a skeleton it no longer matches —
 * arms out at T-pose width while the bones stand at their ease, or worse.
 *
 * `Skeleton.boneInverses` is the bind pose, pre-inverted. Bones no skin binds have
 * no entry there, so they fall back to their current local transform, composed
 * onto whatever their parent resolved to — `bones` is in traversal order, so a
 * parent is always resolved first.
 */
function bindLocals(
  model: THREE.Object3D,
  bones: THREE.Bone[],
  carried: CarriedScale[]
): { t: number[]; r: number[]; s: number[] }[] {
  const bindWorld = new Map<THREE.Bone, THREE.Matrix4>();

  model.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    mesh.skeleton.bones.forEach((bone, i) => {
      if (bindWorld.has(bone)) return;
      bindWorld.set(bone, new THREE.Matrix4().copy(mesh.skeleton.boneInverses[i]).invert());
    });
  });

  const resolved = new Map<THREE.Bone, THREE.Matrix4>();
  const exported = new Set(bones);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, EULER_ORDER);

  return bones.map((bone, i) => {
    const parent = bone.parent as THREE.Bone | null;
    const parentWorld = parent ? resolved.get(parent) : undefined;

    let world = bindWorld.get(bone);
    if (!world) {
      bone.updateMatrix();
      const above = parentWorld ? null : ancestorMatrix(bone, model, exported);
      world = parentWorld
        ? new THREE.Matrix4().multiplyMatrices(parentWorld, bone.matrix)
        : above
          ? new THREE.Matrix4().multiplyMatrices(above, bone.matrix)
          : new THREE.Matrix4().copy(bone.matrix);
    }
    resolved.set(bone, world);

    const local = parentWorld
      ? new THREE.Matrix4().copy(parentWorld).invert().multiply(world)
      : world.clone();
    local.decompose(position, quaternion, scale);
    applyCarried(carried[i], position, scale);
    euler.setFromQuaternion(quaternion, EULER_ORDER);

    return {
      t: [position.x, position.y, position.z],
      r: [
        THREE.MathUtils.radToDeg(euler.x),
        THREE.MathUtils.radToDeg(euler.y),
        THREE.MathUtils.radToDeg(euler.z),
      ],
      s: [scale.x, scale.y, scale.z],
    };
  });
}

/**
 * Meshes worth writing, in traversal order.
 *
 * Line and point objects are skipped: three.js models them as `Mesh` subclasses,
 * but FBX polygon geometry cannot express them. The viewport overlays live on the
 * scene rather than under the model, so nothing here has to filter those out.
 * Hidden meshes are still exported — the viewport's mesh toggle is a viewing
 * preference, not a decision about the file.
 */
function collectMeshParts(
  model: THREE.Object3D,
  boneIndex: Map<THREE.Bone, number>,
  carried: CarriedScale[]
): MeshPart[] {
  const parts: MeshPart[] = [];
  model.traverse((child) => {
    const mesh = child as THREE.Mesh & { isLine?: boolean; isPoints?: boolean };
    if (!mesh.isMesh || mesh.isLine || mesh.isPoints) return;
    const part = buildMeshPart(model, mesh, boneIndex, carried);
    if (part) parts.push(part);
  });
  return parts;
}

/**
 * Approximate `MeshPhongMaterial` and friends as an FBX Phong material.
 *
 * Colours go out in **sRGB**, not three.js's linear working space, because that
 * is the convention the source assets use and what `FBXLoader` expects: it reads
 * `DiffuseColor` as sRGB and converts, so writing linear components darkens the
 * model on every round trip — `ab3e36` came back `680c09`.
 *
 * Two things about FBX colour are worth knowing before touching this.
 *
 * Blender's FBX importer does **not** colour-manage `DiffuseColor` — it copies the
 * number straight into a linear `Base Color`. So the same file is read one way by
 * three.js and another by Blender, and no single value satisfies both. Writing
 * sRGB matches the source assets, which is the tie-breaker: the export lands where
 * the source files land.
 *
 * `DiffuseFactor` is written explicitly as 1. The source assets carry
 * `DiffuseColor` × `DiffuseFactor` (0.8) plus a premultiplied legacy `Diffuse`
 * vector, and `FBXLoader` reads the premultiplied one and discards the factor — so
 * by the time a colour reaches this writer the factor is already baked in and
 * cannot be recovered. Stating 1 keeps an importer that *does* apply the factor
 * from darkening the model a second time. The visible consequence is that our
 * export is uniformly 0.8x the original's `DiffuseColor` in Blender; the
 * information to do better was lost on load, not here.
 */
function materialNode(material: THREE.Material, id: number): Node {
  const colored = material as THREE.MeshStandardMaterial;
  const srgb = (source: THREE.Color | undefined, fallback: number): THREE.Color =>
    (source ?? new THREE.Color(fallback)).clone().convertLinearToSRGB();
  const color = srgb(colored.color, 0xcccccc);
  const emissive = srgb(colored.emissive, 0x000000);

  return node(
    'Material',
    [L(id), objectName(material.name || 'Material', 'Material'), S('')],
    [
      node('Version', [I(102)]),
      node('ShadingModel', [S('phong')]),
      node('MultiLayer', [I(0)]),
      node('Properties70', [], [
        P('DiffuseColor', 'Color', '', 'A', color.r, color.g, color.b),
        // Already folded into DiffuseColor upstream — see the note above.
        P('DiffuseFactor', 'Number', '', 'A', 1),
        P('EmissiveColor', 'Color', '', 'A', emissive.r, emissive.g, emissive.b),
        P('SpecularColor', 'Color', '', 'A', 0.2, 0.2, 0.2),
        P('Shininess', 'double', 'Number', '', 20),
        P('Opacity', 'double', 'Number', '', material.opacity ?? 1),
      ]),
    ]
  );
}

/** The `Geometry` record: control points, polygons, normals, UVs, materials. */
function geometryNode(part: MeshPart, id: number): Node {
  const children: Node[] = [
    node('Vertices', [{ t: 'd', v: part.vertices }]),
    node('PolygonVertexIndex', [{ t: 'i', v: part.polygonVertexIndex }]),
    node('GeometryVersion', [I(124)]),
  ];

  if (part.normals.length > 0) {
    children.push(
      node('LayerElementNormal', [I(0)], [
        node('Version', [I(102)]),
        node('Name', [S('')]),
        node('MappingInformationType', [S('ByPolygonVertex')]),
        node('ReferenceInformationType', [S('Direct')]),
        node('Normals', [{ t: 'd', v: part.normals }]),
      ])
    );
  }

  if (part.uvs.length > 0) {
    children.push(
      node('LayerElementUV', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('UVMap')]),
        node('MappingInformationType', [S('ByPolygonVertex')]),
        node('ReferenceInformationType', [S('Direct')]),
        node('UV', [{ t: 'd', v: part.uvs }]),
      ])
    );
  }

  const oneMaterial = part.materialPerPolygon.length === 0;
  children.push(
    node('LayerElementMaterial', [I(0)], [
      node('Version', [I(101)]),
      node('Name', [S('')]),
      node('MappingInformationType', [S(oneMaterial ? 'AllSame' : 'ByPolygon')]),
      node('ReferenceInformationType', [S('IndexToDirect')]),
      node('Materials', [{ t: 'i', v: oneMaterial ? [0] : part.materialPerPolygon }]),
    ])
  );

  const layerEntries: Node[] = [
    node('LayerElement', [], [node('Type', [S('LayerElementMaterial')]), node('TypedIndex', [I(0)])]),
  ];
  if (part.normals.length > 0) {
    layerEntries.unshift(
      node('LayerElement', [], [node('Type', [S('LayerElementNormal')]), node('TypedIndex', [I(0)])])
    );
  }
  if (part.uvs.length > 0) {
    layerEntries.push(
      node('LayerElement', [], [node('Type', [S('LayerElementUV')]), node('TypedIndex', [I(0)])])
    );
  }
  children.push(node('Layer', [I(0)], [node('Version', [I(100)]), ...layerEntries]));

  return node('Geometry', [L(id), objectName(part.name, 'Geometry'), S('Mesh')], children);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface FbxExportOptions {
  /** Curve sampling rate. Defaults to 30. */
  fps?: number;
  /** Take name recorded in the file. */
  takeName?: string;
  /** Creator string. */
  creator?: string;
}

/** Channel triples every animated bone gets. */
const CHANNELS = [
  { key: 'T', property: 'Lcl Translation', field: 'translation' as const },
  { key: 'R', property: 'Lcl Rotation', field: 'rotation' as const },
  { key: 'S', property: 'Lcl Scaling', field: 'scale' as const },
];

const AXES = ['d|X', 'd|Y', 'd|Z'];

/**
 * Serialize a model — meshes, skin weights, skeleton and animation — as a binary
 * FBX.
 *
 * Sampling drives a temporary mixer over `model`, which momentarily moves the
 * live bones. The app's render loop re-applies its own mixer on the next frame,
 * so the viewport recovers on its own.
 *
 * `bones` fixes the exported bone order, and skin indices are translated into it
 * rather than assumed to match. A weight pointing at a bone outside that list is
 * dropped, so pass the whole skeleton.
 */
export function exportFbx(
  model: THREE.Object3D,
  bones: THREE.Bone[],
  clip: THREE.AnimationClip | null,
  options: FbxExportOptions = {}
): ArrayBuffer {
  if (bones.length === 0) {
    throw new Error('FBX export needs a skeleton: no bones were found.');
  }

  const fps = options.fps ?? 30;
  const takeName = options.takeName || 'Take 001';
  const creator = options.creator || 'LAK';

  const duration = clip ? clip.duration : 0;
  const frameCount = clip ? Math.max(2, Math.round(duration * fps) + 1) : 0;

  // Read the rest pose before sampling: sampling runs a mixer over the live
  // bones, and any bone outside a skin has only its current local transform to
  // fall back on.
  const carried = carriedScales(model, bones);
  const restPose = bindLocals(model, bones, carried);
  const samples = clip ? sampleLocals(model, bones, clip, frameCount, fps, carried) : null;

  // --- Identities. Any distinct set works; sequential keeps them readable. ---
  let nextId = 1000000;
  const newId = () => ++nextId;

  const boneIds = bones.map(() => newId());
  const attrIds = bones.map(() => newId());
  const stackId = newId();
  const layerId = newId();

  const boneIndex = new Map<THREE.Bone, number>();
  bones.forEach((bone, i) => boneIndex.set(bone, i));

  const objects: Node[] = [];
  const connections: Node[] = [];

  // --- Bones ---
  bones.forEach((bone, i) => {
    const rest = restPose[i];

    objects.push(
      node(
        'Model',
        [L(boneIds[i]), objectName(bone.name || `Bone${i}`, 'Model'), S('LimbNode')],
        [
          node('Version', [I(232)]),
          node('Properties70', [], [
            // Declared explicitly so the file states which Euler order its
            // rotation curves are expressed in. See EULER_ORDER — the names of
            // the two orders differ on purpose.
            P('RotationOrder', 'enum', '', '', FBX_ROTATION_ORDER),
            P('InheritType', 'enum', '', '', 1),
            P('Lcl Translation', 'Lcl Translation', '', 'A', rest.t[0], rest.t[1], rest.t[2]),
            P('Lcl Rotation', 'Lcl Rotation', '', 'A', rest.r[0], rest.r[1], rest.r[2]),
            P('Lcl Scaling', 'Lcl Scaling', '', 'A', rest.s[0], rest.s[1], rest.s[2]),
          ]),
          node('Shading', [{ t: 'C', v: true }]),
          node('Culling', [S('CullingOff')]),
        ]
      )
    );

    objects.push(
      node(
        'NodeAttribute',
        [L(attrIds[i]), objectName('', 'NodeAttribute'), S('LimbNode')],
        [
          node('TypeFlags', [S('Skeleton')]),
        ]
      )
    );

    connections.push(node('C', [S('OO'), L(attrIds[i]), L(boneIds[i])]));

    // Parent within the exported set, or the scene root (id 0).
    const parent = bone.parent as THREE.Bone | null;
    const parentIdx = parent ? boneIndex.get(parent) : undefined;
    connections.push(
      node('C', [S('OO'), L(boneIds[i]), L(parentIdx !== undefined ? boneIds[parentIdx] : 0)])
    );
  });

  // --- Meshes, materials and skin deformers ---
  const parts = collectMeshParts(model, boneIndex, carried);
  let materialCount = 0;
  let deformerCount = 0;

  for (const part of parts) {
    const geometryId = newId();
    const meshId = newId();

    objects.push(geometryNode(part, geometryId));

    // The mesh node is the identity: its placement within the model is baked
    // into the vertices (see `buildMeshPart`). Its parent is the scene root: the
    // bones move the vertices, so re-parenting the mesh under a bone would apply
    // that motion twice.
    objects.push(
      node(
        'Model',
        [L(meshId), objectName(part.name, 'Model'), S('Mesh')],
        [
          node('Version', [I(232)]),
          node('Properties70', [], [
            P('RotationOrder', 'enum', '', '', FBX_ROTATION_ORDER),
            P('InheritType', 'enum', '', '', 1),
          ]),
          node('Shading', [{ t: 'C', v: true }]),
          node('Culling', [S('CullingOff')]),
        ]
      )
    );

    connections.push(node('C', [S('OO'), L(meshId), L(0)]));
    connections.push(node('C', [S('OO'), L(geometryId), L(meshId)]));

    for (const material of part.materials) {
      if (!material) continue;
      const materialId = newId();
      objects.push(materialNode(material, materialId));
      connections.push(node('C', [S('OO'), L(materialId), L(meshId)]));
      materialCount++;
    }

    if (part.clusters.length === 0) continue;

    // Skin and cluster are both `Deformer` records; the object-name class and the
    // subtype are what tell them apart.
    const skinId = newId();
    objects.push(
      node('Deformer', [L(skinId), objectName(part.name, 'Deformer'), S('Skin')], [
        node('Version', [I(101)]),
        node('Link_DeformAcuracy', [D(50)]),
      ])
    );
    connections.push(node('C', [S('OO'), L(skinId), L(geometryId)]));
    deformerCount++;

    for (const cluster of part.clusters) {
      const clusterId = newId();
      objects.push(
        node('Deformer', [L(clusterId), objectName(bones[cluster.bone].name, 'SubDeformer'), S('Cluster')], [
          node('Version', [I(100)]),
          node('UserData', [S(''), S('')]),
          node('Indexes', [{ t: 'i', v: cluster.indices }]),
          node('Weights', [{ t: 'd', v: cluster.weights }]),
          node('Transform', [{ t: 'd', v: cluster.transform }]),
          node('TransformLink', [{ t: 'd', v: cluster.transformLink }]),
        ])
      );
      connections.push(node('C', [S('OO'), L(clusterId), L(skinId)]));
      connections.push(node('C', [S('OO'), L(boneIds[cluster.bone]), L(clusterId)]));
      deformerCount++;
    }
  }

  // --- Animation ---
  let curveNodeCount = 0;
  let curveCount = 0;

  if (clip && samples) {
    const stopTicks = Math.round(duration * FBX_TICKS_PER_SECOND);

    objects.push(
      node(
        'AnimationStack',
        [L(stackId), objectName(takeName, 'AnimStack'), S('')],
        [
          node('Properties70', [], [
            P('LocalStop', 'KTime', 'Time', '', stopTicks),
            P('ReferenceStop', 'KTime', 'Time', '', stopTicks),
          ]),
        ]
      )
    );

    objects.push(
      node('AnimationLayer', [L(layerId), objectName('BaseLayer', 'AnimLayer'), S('')])
    );
    connections.push(node('C', [S('OO'), L(layerId), L(stackId)]));

    // Key times are shared by every curve, so they are built once.
    const times = new Float64Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      times[f] = Math.round((f / fps) * FBX_TICKS_PER_SECOND);
    }
    const attrFlags = [KEY_FLAG_LINEAR];
    const attrData = [0, 0, 0, 0];
    const attrRefCount = [frameCount];

    bones.forEach((_, i) => {
      for (const channel of CHANNELS) {
        const series = samples[i][channel.field];
        const curveNodeId = newId();
        curveNodeCount++;

        objects.push(
          node(
            'AnimationCurveNode',
            [L(curveNodeId), objectName(channel.key, 'AnimCurveNode'), S('')],
            [
              node('Properties70', [], [
                P('d|X', 'Number', '', 'A', series[0]),
                P('d|Y', 'Number', '', 'A', series[1]),
                P('d|Z', 'Number', '', 'A', series[2]),
              ]),
            ]
          )
        );

        connections.push(node('C', [S('OO'), L(curveNodeId), L(layerId)]));
        connections.push(
          node('C', [S('OP'), L(curveNodeId), L(boneIds[i]), S(channel.property)])
        );

        for (let axis = 0; axis < 3; axis++) {
          const values = new Float32Array(frameCount);
          for (let f = 0; f < frameCount; f++) values[f] = series[f * 3 + axis];

          const curveId = newId();
          curveCount++;

          objects.push(
            node(
              'AnimationCurve',
              [L(curveId), objectName('', 'AnimCurve'), S('')],
              [
                node('Default', [D(values[0])]),
                node('KeyVer', [I(4008)]),
                node('KeyTime', [{ t: 'l', v: times }]),
                node('KeyValueFloat', [{ t: 'f', v: values }]),
                node('KeyAttrFlags', [{ t: 'i', v: attrFlags }]),
                node('KeyAttrDataFloat', [{ t: 'i', v: attrData }]),
                node('KeyAttrRefCount', [{ t: 'i', v: attrRefCount }]),
              ]
            )
          );

          connections.push(
            node('C', [S('OP'), L(curveId), L(curveNodeId), S(AXES[axis])])
          );
        }
      }
    });
  }

  // --- Document skeleton ---
  const definitions: Node[] = [
    node('Version', [I(100)]),
    node('Count', [I(objects.length + 1)]),
    node('ObjectType', [S('GlobalSettings')], [node('Count', [I(1)])]),
    node('ObjectType', [S('Model')], [node('Count', [I(bones.length + parts.length)])]),
    node('ObjectType', [S('NodeAttribute')], [node('Count', [I(bones.length)])]),
  ];
  if (parts.length > 0) {
    definitions.push(
      node('ObjectType', [S('Geometry')], [node('Count', [I(parts.length)])]),
      node('ObjectType', [S('Material')], [node('Count', [I(materialCount)])])
    );
  }
  if (deformerCount > 0) {
    definitions.push(
      node('ObjectType', [S('Deformer')], [node('Count', [I(deformerCount)])])
    );
  }
  if (clip) {
    definitions.push(
      node('ObjectType', [S('AnimationStack')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationLayer')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationCurveNode')], [node('Count', [I(curveNodeCount)])]),
      node('ObjectType', [S('AnimationCurve')], [node('Count', [I(curveCount)])])
    );
  }

  const documentId = newId();

  const roots: Node[] = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(FBX_VERSION)]),
      node('Creator', [S(creator)]),
    ]),
    node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        // Y-up, Z-front, X-right — matching three.js.
        P('UpAxis', 'int', 'Integer', '', 1),
        P('UpAxisSign', 'int', 'Integer', '', 1),
        P('FrontAxis', 'int', 'Integer', '', 2),
        P('FrontAxisSign', 'int', 'Integer', '', 1),
        P('CoordAxis', 'int', 'Integer', '', 0),
        P('CoordAxisSign', 'int', 'Integer', '', 1),
        P('UnitScaleFactor', 'double', 'Number', '', 1),
        P('CustomFrameRate', 'double', 'Number', '', fps),
      ]),
    ]),
    node('Documents', [], [
      node('Count', [I(1)]),
      node('Document', [L(documentId), S('Scene'), S('Scene')], [
        node('RootNode', [L(0)]),
      ]),
    ]),
    node('References'),
    node('Definitions', [], definitions),
    node('Objects', [], objects),
    node('Connections', [], connections),
  ];

  if (clip) {
    const stopTicks = Math.round(duration * FBX_TICKS_PER_SECOND);
    roots.push(
      node('Takes', [], [
        node('Current', [S(takeName)]),
        node('Take', [S(takeName)], [
          node('FileName', [S('')]),
          node('LocalTime', [L(0), L(stopTicks)]),
          node('ReferenceTime', [L(0), L(stopTicks)]),
        ]),
      ])
    );
  }

  // --- Serialize ---
  const w = new ByteWriter();
  w.ascii('Kaydara FBX Binary  ');
  w.u8(0x00);
  w.u8(0x1a);
  w.u8(0x00);
  w.u32(FBX_VERSION);

  for (const root of roots) writeNode(w, root);
  // Terminates the top-level node list.
  w.zeros(13);

  w.bytes(FOOTER_CODE);
  // Pad so the version field lands on a 16-byte boundary.
  const pad = (16 - (w.length % 16)) % 16;
  w.zeros(pad === 0 ? 16 : pad);
  w.u32(FBX_VERSION);
  w.zeros(120);
  w.bytes(FOOTER_MAGIC);

  return w.toArrayBuffer();
}
