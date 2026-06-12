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
  // Leaf ends — unskinned and unanimated, but the tackle ragdoll's body segments end at these
  // joints (foot and hand capsule far-ends), so give them the mixamo names it looks up.
  L_Hand_end: "mixamorigLeftHandMiddle3",
  R_Hand_end: "mixamorigRightHandMiddle3",
  L_ToeBase_end: "mixamorigLeftToe_End",
  R_ToeBase_end: "mixamorigRightToe_End",
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

/** Slice [t0, t1] out of a clip (times rebased to 0). Constant/sparse tracks with no keys inside
 *  the window are resampled at the window start instead of dropped — losing e.g. a single-key
 *  Root rotation track silently breaks the later per-take yaw normalization. */
function sliceClip(src, t0, t1, name) {
  const c = src.clone();
  if (name) c.name = name;
  c.tracks = c.tracks.map((tr) => {
    const keep = [];
    for (let i = 0; i < tr.times.length; i++) if (tr.times[i] >= t0 && tr.times[i] <= t1) keep.push(i);
    const stride = tr.getValueSize();
    const T = tr.constructor;
    if (keep.length === 0) {
      const interp = tr.createInterpolant();
      const v = interp.evaluate(Math.min(Math.max(t0, tr.times[0]), tr.times[tr.times.length - 1]));
      return new T(tr.name, new Float32Array([0]), Float32Array.from(v));
    }
    const times = new Float32Array(keep.length);
    const values = new Float32Array(keep.length * stride);
    keep.forEach((srcI, dst) => {
      times[dst] = tr.times[srcI] - t0;
      values.set(tr.values.subarray(srcI * stride, (srcI + 1) * stride), dst * stride);
    });
    return new T(tr.name, times, values);
  }).filter((tr) => tr != null && tr.times.length > 0);
  c.duration = t1 - t0;
  return c;
}

/** Time-reverse a clip — the baked backpedal (runtime negative timeScale is impossible: the
 *  stride-warp clamps setEffectiveTimeScale to ≥ 0.7 every tick). */
function reverseClip(src, name) {
  const c = src.clone();
  c.name = name;
  c.tracks = c.tracks.map((tr) => {
    const n = tr.times.length;
    const stride = tr.getValueSize();
    const times = new Float32Array(n);
    const values = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) {
      const j = n - 1 - i;
      times[i] = src.duration - tr.times[j];
      values.set(tr.values.subarray(j * stride, (j + 1) * stride), i * stride);
    }
    const T = tr.constructor;
    return new T(tr.name, times, values);
  });
  return c;
}

// Trim the 17.5s "relax" take to a clean standing window — the game freezes neutral players at
// IDLE_POSE (13%) into the clip, which otherwise lands in one of the take's crouch/stretch beats.
const IDLE_WINDOW = [4.0, 12.0];
const rawRelax = takes.find((t) => t.name === "idle")?.clip ?? null;
{
  const take = takes.find((t) => t.name === "idle");
  if (take) {
    take.clip = sliceClip(take.clip, IDLE_WINDOW[0], IDLE_WINDOW[1]);
    console.log(`  idle trimmed to [${IDLE_WINDOW[0]}, ${IDLE_WINDOW[1]}]s`);
  }
}

// STANCE: a pre-snap ready pose sliced from the relax take's deepest crouch beat (those beats
// live OUTSIDE the idle window). Found by scanning head height across the raw take.
if (rawRelax) {
  const mixerS = new THREE.AnimationMixer(grp);
  const findB = (n) => allBones.find((b) => b.name === n);
  let bestT = 2.0, bestY = Infinity;
  for (let t = 0.5; t < rawRelax.duration - 1.0; t += 0.25) {
    mixerS.stopAllAction();
    const act = mixerS.clipAction(rawRelax);
    act.reset(); act.play();
    mixerS.update(t);
    grp.updateMatrixWorld(true);
    const y = findB("Head").getWorldPosition(new THREE.Vector3()).y;
    if (y < bestY) { bestY = y; bestT = t; }
  }
  mixerS.stopAllAction();
  const s0 = Math.max(0, bestT - 0.4), s1 = Math.min(rawRelax.duration, bestT + 0.8);
  takes.push({ name: "stance", clip: sliceClip(rawRelax, s0, s1, "stance") });
  console.log(`  stance sliced from crouch beat @${bestT.toFixed(2)}s (headY ${bestY.toFixed(2)}) → [${s0.toFixed(1)}, ${s1.toFixed(1)}]`);
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

// Derived backpedal: time-reversed walk, baked AFTER yaw normalization (reversal preserves the
// corrected orientation). Ships as its own clip so backpedal blends at an independent phase.
{
  const walk = takes.find((t) => t.name === "walk");
  if (walk) {
    takes.push({ name: "runback", clip: reverseClip(walk.clip, "runback") });
    console.log("  runback ← reversed walk");
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
// playerMeta: measured tuning the game reads from the asset (units are GLB-local — the runtime
// multiplies by its own display scale). Hardcoded game constants remain as fallbacks/clamps.
// ---------------------------------------------------------------------------------------------
console.log("— measuring playerMeta");
const playerMeta = { segs: {}, strideRun: 0, strideWalk: 0, ankleY: 0, hipY: 0, height: 0 };
{
  // Bind world position per skin joint (vertices live in this same baked-bind space).
  const bindPos = skeleton.bones.map((b, i) => {
    const m = new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert();
    return new THREE.Vector3().setFromMatrixPosition(m);
  });
  const renamed = skeleton.bones.map((b) => BONE_RENAME.get(b.name) ?? b.name);
  const jointIdxByName = new Map(renamed.map((n, i) => [n, i]));
  // Ragdoll segments (mirrors TackleRagdoll's SEGS): per segment, the drive bone + its twist
  // children own the vertices; the axis runs top→bot.
  const SEG_SPEC = [
    { name: "pelvis", top: "mixamorigHips", bot: "mixamorigSpine1", own: ["mixamorigHips", "Pelvis", "mixamorigSpine"] },
    { name: "torso", top: "mixamorigSpine1", bot: "mixamorigNeck", own: ["mixamorigSpine1", "mixamorigSpine2", "mixamorigLeftShoulder", "mixamorigRightShoulder"] },
    { name: "head", top: "mixamorigNeck", bot: "mixamorigHead", own: ["mixamorigNeck", "NeckTwist02", "mixamorigHead"] },
    ...["Left", "Right"].flatMap((S) => {
      const P = S === "Left" ? "L" : "R";
      return [
        { name: `thigh${P}`, top: `mixamorig${S}UpLeg`, bot: `mixamorig${S}Leg`, own: [`mixamorig${S}UpLeg`, `${P}_ThighTwist01`, `${P}_ThighTwist02`] },
        { name: `shin${P}`, top: `mixamorig${S}Leg`, bot: `mixamorig${S}Foot`, own: [`mixamorig${S}Leg`, `${P}_CalfTwist01`, `${P}_CalfTwist02`] },
        { name: `foot${P}`, top: `mixamorig${S}Foot`, bot: `mixamorig${S}ToeBase`, own: [`mixamorig${S}Foot`, `mixamorig${S}ToeBase`] },
        { name: `uarm${P}`, top: `mixamorig${S}Arm`, bot: `mixamorig${S}ForeArm`, own: [`mixamorig${S}Arm`, `${P}_UpperarmTwist01`, `${P}_UpperarmTwist02`] },
        { name: `farm${P}`, top: `mixamorig${S}ForeArm`, bot: `mixamorig${S}Hand`, own: [`mixamorig${S}ForeArm`, `${P}_ForearmTwist01`, `${P}_ForearmTwist02`] },
        { name: `hand${P}`, top: `mixamorig${S}Hand`, bot: `mixamorig${S}Hand`, own: [`mixamorig${S}Hand`] },
      ];
    }),
  ];
  const ownerOf = new Map(); // joint index → segment
  for (const spec of SEG_SPEC) for (const n of spec.own) {
    const ji = jointIdxByName.get(n);
    if (ji !== undefined) ownerOf.set(ji, spec);
  }
  // Per-vertex dominant joint → segment; accumulate perpendicular distances to the segment axis.
  const dists = new Map(SEG_SPEC.map((s) => [s.name, []]));
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Pv = new THREE.Vector3(), AB = new THREE.Vector3(), AP = new THREE.Vector3();
  for (let i = 0; i < nVert; i++) {
    let bestW = 0, bestJ = -1;
    for (let c = 0; c < 4; c++) if (weights[i * 4 + c] > bestW) { bestW = weights[i * 4 + c]; bestJ = joints[i * 4 + c]; }
    const spec = ownerOf.get(bestJ);
    if (!spec) continue;
    const ti = jointIdxByName.get(spec.top), bi = jointIdxByName.get(spec.bot);
    if (ti === undefined || bi === undefined) continue;
    A.copy(bindPos[ti]); B.copy(bindPos[bi]);
    Pv.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    AB.subVectors(B, A);
    const len2 = AB.lengthSq();
    AP.subVectors(Pv, A);
    const t = len2 > 1e-10 ? Math.max(0, Math.min(1, AP.dot(AB) / len2)) : 0;
    dists.get(spec.name).push(AP.addScaledVector(AB, -t).length());
  }
  let volSum = 0;
  const seg = {};
  for (const spec of SEG_SPEC) {
    const d = dists.get(spec.name);
    if (!d || d.length < 12) continue;
    d.sort((a, b) => a - b);
    const r = d[(d.length * 0.6) | 0]; // 60th percentile — capsule hugs the body, ignores outliers
    const ti = jointIdxByName.get(spec.top), bi = jointIdxByName.get(spec.bot);
    const len = Math.max(0.04, bindPos[ti].distanceTo(bindPos[bi]));
    seg[spec.name] = { r, len };
    volSum += r * r * len;
  }
  for (const [name, s] of Object.entries(seg)) {
    s.m = +(100 * (s.r * s.r * s.len) / volSum).toFixed(2); // ~100 kg split by capsule volume
    s.r = +s.r.toFixed(4);
    delete s.len;
  }
  playerMeta.segs = seg;

  // Rest heights FIRST — grp still holds the idle-frame pose from the skeleton section (the
  // stride sampling below disturbs it).
  const findB = (n) => allBones.find((b) => b.name === n);
  grp.updateMatrixWorld(true);
  playerMeta.ankleY = +findB("L_Foot").getWorldPosition(new THREE.Vector3()).y.toFixed(3);
  playerMeta.hipY = +findB("Hip").getWorldPosition(new THREE.Vector3()).y.toFixed(3);
  playerMeta.height = +(findB("Head").getWorldPosition(new THREE.Vector3()).y + 0.1).toFixed(3);

  // Stride speed: average horizontal speed of the STANCE (lower) foot in the in-place cycle.
  // Also tracks the minimum ANKLE height across the cycle — the true plant height for foot IK
  // (the rest pose can have a lifted/crossed foot, so a single-frame read lies).
  let minAnkleY = Infinity;
  const measureStride = (clip) => {
    const mixerM = new THREE.AnimationMixer(grp);
    const lt = findB("L_ToeBase"), rt = findB("R_ToeBase");
    const la = findB("L_Foot"), ra = findB("R_Foot");
    const samples = 40;
    const speeds = [];
    let prevL = null, prevR = null;
    const dt = clip.duration / samples;
    for (let i = 0; i <= samples; i++) {
      mixerM.stopAllAction(); const a2 = mixerM.clipAction(clip); a2.reset(); a2.play();
      mixerM.update(i * dt);
      grp.updateMatrixWorld(true);
      const L = lt.getWorldPosition(new THREE.Vector3());
      const R = rt.getWorldPosition(new THREE.Vector3());
      minAnkleY = Math.min(minAnkleY, la.getWorldPosition(new THREE.Vector3()).y, ra.getWorldPosition(new THREE.Vector3()).y);
      if (prevL) {
        const stance = L.y < R.y ? [L, prevL] : [R, prevR];
        const dx = stance[0].x - stance[1].x, dz = stance[0].z - stance[1].z;
        speeds.push(Math.hypot(dx, dz) / dt);
      }
      prevL = L; prevR = R;
    }
    mixerM.stopAllAction();
    if (speeds.length === 0) return 0;
    // 75th percentile, not the mean: samples at the foot-reversal instants are near zero and a
    // mean drags the estimate ~2x low → clips played ~2x too fast in-game (strobing legs).
    speeds.sort((a, b) => a - b);
    return speeds[(speeds.length * 0.75) | 0];
  };
  const runTake = takes.find((t) => t.name === "run");
  const walkTake = takes.find((t) => t.name === "walk");
  playerMeta.strideRun = +(runTake ? measureStride(runTake.clip) : 0).toFixed(3);
  playerMeta.strideWalk = +(walkTake ? measureStride(walkTake.clip) : 0).toFixed(3);
  if (Number.isFinite(minAnkleY)) playerMeta.ankleY = +Math.max(0.01, minAnkleY).toFixed(3);
  console.log(`  segs: ${Object.keys(seg).length}, strideRun ${playerMeta.strideRun} m/s, strideWalk ${playerMeta.strideWalk} m/s, ankleY ${playerMeta.ankleY}`);
}

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

// One-shot takes (dive/catch/stance) carry their VERTICAL body motion as a Root translation
// channel — rotation-only export pivots the body around a pelvis frozen at standing height (the
// dive read as a crawl with the legs in the air). Vertical-only so the channel can never fight
// the sim's horizontal movement, and on Root (not Hips) so the runtime's Hips.position strip
// leaves it alone. Values are Root-parent-local: Vloc = the wrap node's inverse-rotated world up.
const VERT_TAKES = new Set(["dive", "catch", "stance"]);
const rootBoneTop = orderTop[0];
const rootRestLocal = new THREE.Vector3().fromArray(nodes[boneIndex.get(rootBoneTop)].translation);
const Vloc = (() => {
  grp.updateMatrixWorld(true);
  const ancestor = rootBoneTop.parent ? rootBoneTop.parent.matrixWorld.clone() : new THREE.Matrix4();
  const W = new THREE.Matrix4().makeRotationY(Math.PI).multiply(ancestor);
  const q = new THREE.Quaternion().setFromRotationMatrix(W).invert();
  return new THREE.Vector3(0, 1, 0).applyQuaternion(q);
})();
// The source takes have NO vertical root motion (Tripo strips it — the dive "flattens" by
// rotating around a pelvis pinned at standing height, legs in the air). Synthesize the drop:
// per frame, measure the body's LOWEST extremity and push the whole body down by however much
// it rose above its frame-0 level — the lowest point stays glued to the turf through the move.
const sampleDropY = (clip, n) => {
  const mixerV = new THREE.AnimationMixer(grp);
  // Hands excluded: they swing below ground level in the source takes and would invert the
  // correction into a LIFT. A hand brushing into the turf is fine; a floating body is not.
  const joints = ["Head", "L_Foot", "R_Foot", "L_ToeBase", "R_ToeBase"]
    .map((nm) => allBones.find((b) => b.name === nm)).filter(Boolean);
  const v = new THREE.Vector3();
  const mins = [];
  for (let i = 0; i <= n; i++) {
    mixerV.stopAllAction();
    const a = mixerV.clipAction(clip);
    a.reset(); a.play();
    mixerV.update((i / n) * clip.duration);
    grp.updateMatrixWorld(true);
    let m = Infinity;
    for (const b of joints) m = Math.min(m, b.getWorldPosition(v).y);
    mins.push(m);
  }
  mixerV.stopAllAction();
  // Absolute ground reference (the measured ankle plant height) rather than frame 0 — the take
  // may START with a foot lifted mid-stride. Push down only, never lift; the one-shot's weight
  // fade-in absorbs any offset at the clip start.
  const groundRef = Math.max(0.01, playerMeta.ankleY || 0.03) * 1.3;
  const drops = mins.map((m) => Math.min(0, groundRef - m));
  // Light smoothing so the grounding can't pop frame to frame.
  return drops.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(drops.length - 1, i + 1); k++) { sum += drops[k]; cnt++; }
    return sum / cnt;
  });
};

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
  if (VERT_TAKES.has(name)) {
    const N = Math.max(12, Math.round(clip.duration * 12));
    const ys = sampleDropY(clip, N);
    const times = new Float32Array(N + 1);
    const values = new Float32Array((N + 1) * 3);
    for (let i = 0; i <= N; i++) {
      times[i] = (i / N) * clip.duration;
      const dy = ys[i];
      values[i * 3] = rootRestLocal.x + Vloc.x * dy;
      values[i * 3 + 1] = rootRestLocal.y + Vloc.y * dy;
      values[i * 3 + 2] = rootRestLocal.z + Vloc.z * dy;
    }
    const inAcc = push(times, null, { componentType: 5126, count: times.length, type: "SCALAR", min: [0], max: [clip.duration] });
    const outAcc = push(values, null, { componentType: 5126, count: times.length, type: "VEC3" });
    samplers.push({ input: inAcc, output: outAcc, interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node: boneIndex.get(rootBoneTop), path: "translation" } });
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
  // playerMeta lands on gltf.scene.userData at load — the game's measured-tuning channel.
  scenes: [{ name: "player", nodes: [wrapNode], extras: { playerMeta } }],
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
