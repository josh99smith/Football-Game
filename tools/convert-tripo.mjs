/**
 * Convert the Tripo-generated football character FBX (skinned mesh + embedded texture + 5 baked
 * takes: relax/walk/run/football-catch/swan-dive) into the game's player.glb:
 *
 *  - weld the loader's triangle soup, meshopt-simplify to a mobile budget (UVs/weights survive
 *    because simplification only drops indices),
 *  - bake the mesh's bindMatrix into the vertices and export the BIND-pose skeleton (the FBX's
 *    node transforms are a mid-take pose),
 *  - RENAME the Tripo bones to the mixamorig names the game is built around (foot IK, ragdoll,
 *    procedural throw, pose capture all look bones up by name),
 *  - wrap everything in a 180°-about-Y root: the character animates facing -Z, the game expects +Z,
 *  - re-encode the embedded texture as RGBA where alpha is the team-recolor mask
 *    (255 keep / ~170 warm trim / ~85 uniform base — same contract as before),
 *  - bake the five takes as named glTF animations (rotation tracks only → in-place locomotion):
 *    idle, walk, run, catch, dive.
 *
 * Usage: node tools/convert-tripo.mjs <character.fbx> <out.glb> [--qc]
 */
import * as fs from "fs";
import * as path from "path";

// --- minimal DOM shims so FBXLoader's embedded-texture path runs under Node ---
globalThis.__blobs = {};
globalThis.window = { URL: { createObjectURL: (blob) => { const id = `blob:${Math.random().toString(36).slice(2)}`; globalThis.__blobs[id] = blob; return id; } } };
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }) };

const THREE = await import("three");
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { MeshoptSimplifier } = await import("meshoptimizer");
const jpeg = (await import("jpeg-js")).default;
const { PNG } = await import("pngjs");

const [, , srcPath, outPath] = process.argv;
const QC = process.argv.includes("--qc");
if (!srcPath || !outPath) {
  console.error("usage: node tools/convert-tripo.mjs <character.fbx> <out.glb> [--qc]");
  process.exit(1);
}

const TARGET_TRIS = 18000;

/** Tripo bone → the mixamorig name the game's systems expect. Unmapped bones keep their names. */
const BONE_RENAME = new Map(Object.entries({
  Hip: "mixamorigHips",
  Waist: "mixamorigSpine",
  Spine01: "mixamorigSpine1",
  Spine02: "mixamorigSpine2",
  NeckTwist01: "mixamorigNeck",
  Head: "mixamorigHead",
  Head_end: "mixamorigHeadTop_End",
  L_Clavicle: "mixamorigLeftShoulder",
  L_Upperarm: "mixamorigLeftArm",
  L_Forearm: "mixamorigLeftForeArm",
  L_Hand: "mixamorigLeftHand",
  L_Thigh: "mixamorigLeftUpLeg",
  L_Calf: "mixamorigLeftLeg",
  L_Foot: "mixamorigLeftFoot",
  L_ToeBase: "mixamorigLeftToeBase",
  R_Clavicle: "mixamorigRightShoulder",
  R_Upperarm: "mixamorigRightArm",
  R_Forearm: "mixamorigRightForeArm",
  R_Hand: "mixamorigRightHand",
  R_Thigh: "mixamorigRightUpLeg",
  R_Calf: "mixamorigRightLeg",
  R_Foot: "mixamorigRightFoot",
  R_ToeBase: "mixamorigRightToeBase",
}));

/** Which take feeds which game clip (matched against the FBX take names). */
const CLIP_MAP = [
  { name: "idle", match: /relax/i },
  { name: "walk", match: /walk_normal/i },
  { name: "run", match: /move_run/i },
  { name: "catch", match: /Football Catch/i },
  { name: "dive", match: /swan-dive/i },
];

console.log("— loading", srcPath);
const buf = fs.readFileSync(srcPath);
const grp = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
let mesh = null;
grp.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
const skeleton = mesh.skeleton;
const allBones = [];
grp.traverse((o) => { if (o.isBone) allBones.push(o); });
console.log(`  mesh: ${mesh.geometry.attributes.position.count} verts (soup), bones: ${allBones.length}, skin joints: ${skeleton.bones.length}`);

// ---------------------------------------------------------------------------------------------
// Geometry: bake bindMatrix, weld the soup, simplify
// ---------------------------------------------------------------------------------------------
const geo = mesh.geometry;
const nSoup = geo.attributes.position.count;
const P = new Float32Array(geo.attributes.position.array);
const N = new Float32Array(geo.attributes.normal.array);
const UV = new Float32Array(geo.attributes.uv.array);
const SI = geo.attributes.skinIndex.array; // uint16
const SW = new Float32Array(geo.attributes.skinWeight.array);
{
  // glTF skinning has no bindMatrix — fold it into the vertex data.
  const bm = mesh.bindMatrix;
  const nm = new THREE.Matrix3().getNormalMatrix(bm);
  const v = new THREE.Vector3();
  for (let i = 0; i < nSoup; i++) {
    v.fromArray(P, i * 3).applyMatrix4(bm).toArray(P, i * 3);
    v.fromArray(N, i * 3).applyMatrix3(nm).normalize().toArray(N, i * 3);
  }
}

console.log("— welding");
const remapSoup = new Int32Array(nSoup);
let nVert = 0;
{
  const map = new Map();
  const order = [];
  for (let i = 0; i < nSoup; i++) {
    const k = `${P[i * 3].toFixed(5)},${P[i * 3 + 1].toFixed(5)},${P[i * 3 + 2].toFixed(5)}|${UV[i * 2].toFixed(5)},${UV[i * 2 + 1].toFixed(5)}|${N[i * 3].toFixed(3)},${N[i * 3 + 1].toFixed(3)},${N[i * 3 + 2].toFixed(3)}`;
    let id = map.get(k);
    if (id === undefined) { id = nVert++; map.set(k, id); order.push(i); }
    remapSoup[i] = id;
  }
  globalThis.__order = order;
}
const order = globalThis.__order;
let pos = new Float32Array(nVert * 3);
let nrm = new Float32Array(nVert * 3);
let uv = new Float32Array(nVert * 2);
let joints = new Uint16Array(nVert * 4);
let weights = new Float32Array(nVert * 4);
order.forEach((src, dst) => {
  pos.set(P.subarray(src * 3, src * 3 + 3), dst * 3);
  nrm.set(N.subarray(src * 3, src * 3 + 3), dst * 3);
  uv.set(UV.subarray(src * 2, src * 2 + 2), dst * 2);
  joints.set(SI.subarray(src * 4, src * 4 + 4), dst * 4);
  weights.set(SW.subarray(src * 4, src * 4 + 4), dst * 4);
});
let idx = new Uint32Array(nSoup);
for (let i = 0; i < nSoup; i++) idx[i] = remapSoup[i];
console.log(`  ${nVert} verts, ${idx.length / 3} tris`);

console.log("— simplifying");
await MeshoptSimplifier.ready;
{
  const [out, err] = MeshoptSimplifier.simplify(idx, pos, 3, TARGET_TRIS * 3, 0.05, []);
  console.log(`  → ${out.length / 3} tris (error ${err.toFixed(4)})`);
  const remap = new Int32Array(nVert).fill(-1);
  let n2 = 0;
  for (const i of out) if (remap[i] === -1) remap[i] = n2++;
  const pk = (a, n, T) => {
    const o = new T(n2 * n);
    for (let i = 0; i < nVert; i++) {
      const r = remap[i];
      if (r !== -1) o.set(a.subarray(i * n, i * n + n), r * n);
    }
    return o;
  };
  pos = pk(pos, 3, Float32Array); nrm = pk(nrm, 3, Float32Array); uv = pk(uv, 2, Float32Array);
  joints = pk(joints, 4, Uint16Array); weights = pk(weights, 4, Float32Array);
  idx = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) idx[i] = remap[out[i]];
  nVert = n2;
  console.log(`  ${nVert} verts out`);
}
// Normalize weights (loader may have dropped >4-influence tails).
for (let i = 0; i < nVert; i++) {
  let s = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
  if (s <= 0) { weights[i * 4] = 1; s = 1; }
  for (let c = 0; c < 4; c++) weights[i * 4 + c] /= s;
}

const orderTop = [];
const visit = (o) => { if (o.isBone) orderTop.push(o); o.children.forEach(visit); };
grp.children.forEach(visit);
const boneIndex = new Map(orderTop.map((b, i) => [b, i]));
const rootBoneIdxs = orderTop.filter((b) => !(b.parent && b.parent.isBone)).map((b) => boneIndex.get(b));
// IBMs in the same (bind) space the vertices live in.
const ibm = new Float32Array(skeleton.bones.length * 16);
skeleton.bones.forEach((b, i) => ibm.set(skeleton.boneInverses[i].elements, i * 16));

// ---------------------------------------------------------------------------------------------
// Texture: embedded JPEG → RGBA PNG with the team-recolor mask in alpha
// ---------------------------------------------------------------------------------------------
console.log("— processing texture");
const blobs = Object.values(globalThis.__blobs);
if (blobs.length === 0) throw new Error("no embedded texture found");
const jpgBytes = new Uint8Array(await blobs[0].arrayBuffer());
const img = jpeg.decode(jpgBytes, { useTArray: true });
console.log(`  ${img.width}x${img.height}`);
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}
const texData = new Uint8Array(img.width * img.height * 4);
const maskStats = [0, 0, 0];
for (let i = 0; i < img.width * img.height; i++) {
  const r = img.data[i * 4] / 255, g = img.data[i * 4 + 1] / 255, b = img.data[i * 4 + 2] / 255;
  const [h, s, l] = rgbToHsl(r, g, b);
  // Classification rules tuned to this character's palette (see --qc histogram): the camo is
  // navy-blue patches (→ team base) + big tan/cream patches (low saturation — they must still
  // recolor to the team accent or every team reads as the same khaki).
  let mask = 0; // keep
  if (s > 0.25 && l > 0.08 && l < 0.75 && h >= 195 && h <= 265) mask = 2; // cool uniform base
  else if (s > 0.15 && l > 0.15 && l < 0.85 && h >= 15 && h <= 70) mask = 1; // warm camo + trim
  maskStats[mask]++;
  texData[i * 4] = img.data[i * 4];
  texData[i * 4 + 1] = img.data[i * 4 + 1];
  texData[i * 4 + 2] = img.data[i * 4 + 2];
  texData[i * 4 + 3] = mask === 1 ? 170 : mask === 2 ? 85 : 255;
}
console.log(`  mask: keep ${maskStats[0]}, warm ${maskStats[1]}, base ${maskStats[2]}`);
const png = new PNG({ width: img.width, height: img.height });
png.data = Buffer.from(texData.buffer, texData.byteOffset, texData.byteLength);
const pngBuf = PNG.sync.write(png);
console.log(`  PNG ${(pngBuf.length / 1e6).toFixed(2)} MB`);

// ---------------------------------------------------------------------------------------------
// Animations: five takes, rotation tracks only (in-place), targets via renamed nodes
// ---------------------------------------------------------------------------------------------
console.log("— baking animations");
const nameToIdx = new Map(orderTop.map((b) => [b.name, boneIndex.get(b)]));
const takes = [];
for (const { name, match } of CLIP_MAP) {
  const clip = grp.animations.find((a) => match.test(a.name));
  if (!clip) { console.warn(`  MISSING take for ${name}`); continue; }
  takes.push({ name, clip });
  console.log(`  ${name} ← "${clip.name}" (${clip.duration.toFixed(2)}s)`);
}

// Trim the 17.5s "relax" take to a clean standing window — the game freezes neutral players at
// IDLE_POSE (13%) into the clip, which otherwise lands in one of the take's crouch/stretch beats.
const IDLE_WINDOW = [4.0, 12.0];
{
  const take = takes.find((t) => t.name === "idle");
  if (take) {
    const [t0, t1] = IDLE_WINDOW;
    take.clip = take.clip.clone();
    take.clip.tracks = take.clip.tracks.map((tr) => {
      const keep = [];
      for (let i = 0; i < tr.times.length; i++) if (tr.times[i] >= t0 && tr.times[i] <= t1) keep.push(i);
      const stride = tr.getValueSize();
      const T = tr.constructor;
      if (keep.length === 0) {
        // Constant / sparse track (e.g. a single-key Root rotation): sample its value at the
        // window start instead of dropping it — losing the Root track silently breaks the
        // later per-take yaw normalization.
        const interp = tr.createInterpolant();
        const v = interp.evaluate(Math.min(Math.max(t0, tr.times[0]), tr.times[tr.times.length - 1]));
        return new T(tr.name, new Float32Array([0]), Float32Array.from(v));
      }
      const times = new Float32Array(keep.length);
      const values = new Float32Array(keep.length * stride);
      keep.forEach((src, dst) => {
        times[dst] = tr.times[src] - t0;
        values.set(tr.values.subarray(src * stride, (src + 1) * stride), dst * stride);
      });
      return new T(tr.name, times, values);
    }).filter((tr) => tr != null && tr.times.length > 0);
    take.clip.duration = t1 - t0;
    console.log(`  idle trimmed to [${t0}, ${t1}]s`);
  }
}

// Normalize each take's facing: the takes were merged from DIFFERENT source armatures and don't
// share a base orientation (walk plays ~90° off, catch ~180°). Measure each clip's yaw on the
// loaded FBX and bake a corrective world-yaw into its Root rotation track so every clip faces
// -Z here — which the 180° wrap below turns into the game's +Z forward.
console.log("— normalizing take orientations");
{
  grp.updateMatrixWorld(true);
  const rootB = orderTop[0];
  const A = rootB.parent ? rootB.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  const Ainv = A.clone().invert();
  const findB = (n) => allBones.find((b) => b.name === n);
  const yawNow = () => {
    grp.updateMatrixWorld(true);
    const wp = (b) => b.getWorldPosition(new THREE.Vector3());
    const side = wp(findB("L_Upperarm")).sub(wp(findB("R_Upperarm")));
    const up = wp(findB("Head")).sub(wp(findB("Hip")));
    const f = new THREE.Vector3().crossVectors(side, up);
    return Math.atan2(f.x, f.z);
  };
  const mixerN = new THREE.AnimationMixer(grp);
  for (const take of takes) {
    // The dive pitches the body horizontal mid-clip — orient by its upright run-up only.
    const fractions = take.name === "dive" ? [0.1] : take.name === "idle" ? [0.1, 0.3, 0.5, 0.7, 0.9] : [0.2, 0.45, 0.7];
    let sx = 0, sz = 0;
    for (const f of fractions) {
      mixerN.stopAllAction();
      const act = mixerN.clipAction(take.clip);
      act.reset(); act.play();
      mixerN.update(f * take.clip.duration);
      const y = yawNow();
      sx += Math.sin(y); sz += Math.cos(y);
    }
    mixerN.stopAllAction();
    const mean = Math.atan2(sx, sz);
    const fix = Math.PI - mean; // target: -Z in this (pre-wrap) space
    const Yfix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), fix);
    const corr = Ainv.clone().multiply(Yfix).multiply(A); // world yaw → Root's parent space
    const track = take.clip.tracks.find((t) => t.name === `${rootB.name}.quaternion`);
    if (!track) { console.warn(`  ${take.name}: no Root rotation track, skipped`); continue; }
    const q = new THREE.Quaternion();
    for (let i = 0; i < track.values.length; i += 4) {
      q.fromArray(track.values, i).premultiply(corr);
      q.toArray(track.values, i);
    }
    console.log(`  ${take.name}: yaw off by ${(mean * 180 / Math.PI - 180).toFixed(0)}°, corrected`);
  }
}

// ---------------------------------------------------------------------------------------------
// Skeleton. Node transforms = the trimmed idle's FIRST FRAME locals: the FBX node rest is a
// garbage mid-take pose (it breaks the game's bbox-derived scale/ground offset and the get-up's
// rest-pose blend target), while the takes' rotation tracks fully repose every joint anyway.
// Translations stay the FBX node locals the takes were authored against (bind-derived locals
// warp the animated skeleton). Skinning is unaffected: boneWorld * IBM, IBMs from the FBX bind.
// ---------------------------------------------------------------------------------------------
console.log("— building skeleton (rest = idle first frame)");
{
  const mixerP = new THREE.AnimationMixer(grp);
  const idleTake = takes.find((t) => t.name === "idle") ?? takes[0];
  const act = mixerP.clipAction(idleTake.clip);
  act.reset(); act.play();
  mixerP.update(0.001);
  grp.updateMatrixWorld(true);
}
const nodes = orderTop.map((b) => {
  const n = { name: BONE_RENAME.get(b.name) ?? b.name, translation: b.position.toArray(), rotation: b.quaternion.toArray() };
  if (Math.abs(b.scale.x - 1) > 1e-4 || Math.abs(b.scale.y - 1) > 1e-4 || Math.abs(b.scale.z - 1) > 1e-4) n.scale = b.scale.toArray();
  const kids = b.children.filter((c) => c.isBone).map((c) => boneIndex.get(c));
  if (kids.length) n.children = kids;
  return n;
});

// ---------------------------------------------------------------------------------------------
// Write GLB
// ---------------------------------------------------------------------------------------------
console.log("— writing", outPath);
const chunks = [];
let byteLen = 0;
const bufferViews = [];
const accessors = [];
function push(data, target, accDef) {
  const pad = (4 - (byteLen % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); byteLen += pad; }
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: byteLen, byteLength: b.length, ...(target ? { target } : {}) });
  chunks.push(b);
  byteLen += b.length;
  accessors.push({ bufferView: bufferViews.length - 1, ...accDef });
  return accessors.length - 1;
}
function minMax(arr, n) {
  const min = Array(n).fill(Infinity), max = Array(n).fill(-Infinity);
  for (let i = 0; i < arr.length; i += n)
    for (let c = 0; c < n; c++) { min[c] = Math.min(min[c], arr[i + c]); max[c] = Math.max(max[c], arr[i + c]); }
  return { min, max };
}

const j8 = new Uint8Array(nVert * 4);
for (let i = 0; i < nVert * 4; i++) j8[i] = joints[i];
const w8 = new Uint8Array(nVert * 4);
for (let i = 0; i < nVert; i++) {
  let acc = 0;
  for (let c = 0; c < 4; c++) {
    const w = c === 3 ? 255 - acc : Math.round(weights[i * 4 + c] * 255);
    w8[i * 4 + c] = Math.max(0, w); acc += w8[i * 4 + c];
  }
}
const idx16 = nVert <= 65535 ? Uint16Array.from(idx) : idx;
const accIdx = push(idx16, 34963, { componentType: nVert <= 65535 ? 5123 : 5125, count: idx.length, type: "SCALAR" });
const accPos = push(pos, 34962, { componentType: 5126, count: nVert, type: "VEC3", ...minMax(pos, 3) });
const accNrm = push(nrm, 34962, { componentType: 5126, count: nVert, type: "VEC3" });
const accUv = push(uv, 34962, { componentType: 5126, count: nVert, type: "VEC2" });
const accJnt = push(j8, 34962, { componentType: 5121, count: nVert, type: "VEC4" });
const accWgt = push(w8, 34962, { componentType: 5121, normalized: true, count: nVert, type: "VEC4" });
const accIbm = push(ibm, null, { componentType: 5126, count: skeleton.bones.length, type: "MAT4" });
{
  const pad = (4 - (byteLen % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); byteLen += pad; }
  bufferViews.push({ buffer: 0, byteOffset: byteLen, byteLength: pngBuf.length });
  chunks.push(pngBuf);
  byteLen += pngBuf.length;
}
const imgBvIdx = bufferViews.length - 1;

const animations = takes.map(({ name, clip }) => {
  const channels = [];
  const samplers = [];
  for (const tr of clip.tracks) {
    const m = tr.name.match(/^(.*)\.quaternion$/);
    if (!m) continue; // rotation-only: in-place locomotion, smaller file
    const node = nameToIdx.get(m[1]);
    if (node === undefined) continue;
    const inAcc = push(Float32Array.from(tr.times), null, { componentType: 5126, count: tr.times.length, type: "SCALAR", min: [tr.times[0]], max: [tr.times[tr.times.length - 1]] });
    const outAcc = push(Float32Array.from(tr.values), null, { componentType: 5126, count: tr.times.length, type: "VEC4" });
    samplers.push({ input: inAcc, output: outAcc, interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node, path: "rotation" } });
  }
  return { name, channels, samplers };
});

const meshNode = nodes.length;
nodes.push({ name: "playerscan", mesh: 0, skin: 0 });
// Wrap node = 180° about Y (the takes animate the character facing -Z; the game expects +Z)
// composed with the NON-BONE ancestor transform above the root bone (the FBX "Armature" group
// carries the Blender Z-up → Y-up -90° X rotation; dropping it lays the skeleton on its back).
const wrapNode = nodes.length;
{
  grp.updateMatrixWorld(true);
  const rootBone = orderTop[0];
  const ancestor = rootBone.parent ? rootBone.parent.matrixWorld.clone() : new THREE.Matrix4();
  const wrap = new THREE.Matrix4().makeRotationY(Math.PI).multiply(ancestor);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  wrap.decompose(p, q, s);
  const n = { name: "playerroot", rotation: q.toArray(), children: [...rootBoneIdxs, meshNode] };
  if (p.lengthSq() > 1e-10) n.translation = p.toArray();
  if (Math.abs(s.x - 1) > 1e-4 || Math.abs(s.y - 1) > 1e-4 || Math.abs(s.z - 1) > 1e-4) n.scale = s.toArray();
  nodes.push(n);
}

const outJson = {
  asset: { version: "2.0", generator: "Football-Game tools/convert-tripo.mjs" },
  scene: 0,
  scenes: [{ name: "player", nodes: [wrapNode] }],
  nodes,
  skins: [{ inverseBindMatrices: accIbm, joints: skeleton.bones.map((b) => boneIndex.get(b)), skeleton: rootBoneIdxs[0] }],
  meshes: [{ name: "playerscan", primitives: [{ attributes: { POSITION: accPos, NORMAL: accNrm, TEXCOORD_0: accUv, JOINTS_0: accJnt, WEIGHTS_0: accWgt }, indices: accIdx, material: 0 }] }],
  images: [{ name: "playerscan", mimeType: "image/png", bufferView: imgBvIdx }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  textures: [{ source: 0, sampler: 0 }],
  // alphaMode stays OPAQUE: the texture's alpha channel is the recolor mask, not transparency.
  materials: [{ name: "playerscan", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: false }],
  animations,
  bufferViews,
  accessors,
  buffers: [{ byteLength: byteLen }],
};

function glbWrite(json, binChunks, binLen) {
  let jbuf = Buffer.from(JSON.stringify(json));
  const jpad = (4 - (jbuf.length % 4)) % 4;
  if (jpad) jbuf = Buffer.concat([jbuf, Buffer.alloc(jpad, 0x20)]);
  const bpad = (4 - (binLen % 4)) % 4;
  const bin = Buffer.concat([...binChunks, Buffer.alloc(bpad)]);
  const total = 12 + 8 + jbuf.length + 8 + bin.length;
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jbuf.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const bhead = Buffer.alloc(8);
  bhead.writeUInt32LE(bin.length, 0); bhead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jbuf, bhead, bin]);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, glbWrite(outJson, chunks, byteLen));
console.log(`  wrote ${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB`);

if (QC) {
  fs.mkdirSync("/tmp/rigqc", { recursive: true });
  fs.writeFileSync("/tmp/rigqc/tripo_qc.json", JSON.stringify({ pos: [...pos], nrm: [...nrm], uv: [...uv], idx: [...idx] }));
  fs.writeFileSync("/tmp/rigqc/tripo_atlas.png", pngBuf);
  // hue histogram of the texture for tuning the mask rules
  const hist = new Map();
  for (let i = 0; i < img.width * img.height; i += 7) {
    const [h, s, l] = rgbToHsl(img.data[i * 4] / 255, img.data[i * 4 + 1] / 255, img.data[i * 4 + 2] / 255);
    const k = `h${Math.round(h / 20) * 20}/${s > 0.45 ? "S" : s > 0.2 ? "m" : "s"}${l > 0.6 ? "L" : l > 0.3 ? "m" : "l"}`;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  console.log("  texture histogram:", [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14));
  console.log("  QC dump → /tmp/rigqc/tripo_qc.json + tripo_atlas.png");
}
