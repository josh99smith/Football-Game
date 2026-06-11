/**
 * Offline asset pipeline: turn a raw photogrammetry scan (unrigged, ~800k-tri GLB with a chaotic
 * per-chart texture atlas) + a Mixamo animation FBX (whose skeleton Mixamo already auto-fitted to
 * this scan) into a game-ready rigged player model:
 *
 *   1. dequantize + position-weld the scan (the atlas's thousands of UV charts otherwise lock
 *      every edge against simplification),
 *   2. bake the texture into per-vertex colors (the atlas can't survive decimation; vertex color
 *      at this density reads great at gameplay camera distance and drops the texture entirely),
 *   3. meshopt-simplify to a mobile budget,
 *   4. classify each vertex into a team-recolor mask (primary uniform color / secondary / keep),
 *      stored in COLOR_0.alpha so the game can palette-swap uniforms per team at load,
 *   5. auto-skin the mesh to the Mixamo skeleton extracted from the Idle FBX (bone-segment
 *      distance weights + Laplacian smoothing — the skeleton is already scaled/posed to the scan),
 *   6. bake the Idle clip into the GLB (the game expects the model file to supply its idle), and
 *   7. write a single self-contained player.glb.
 *
 * Usage: node tools/build-player-asset.mjs <scan.glb> <Idle.fbx> <out.glb>
 * Debug dumps (QC plots) land in /tmp/rigqc when --qc is passed.
 */
import * as fs from "fs";
import * as path from "path";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { MeshoptSimplifier } from "meshoptimizer";
import jpeg from "jpeg-js";

const [, , scanPath, idlePath, outPath] = process.argv;
const QC = process.argv.includes("--qc");
if (!scanPath || !idlePath || !outPath) {
  console.error("usage: node tools/build-player-asset.mjs <scan.glb> <Idle.fbx> <out.glb> [--qc]");
  process.exit(1);
}

const TARGET_TRIS = 24000;

// ---------------------------------------------------------------------------------------------
// GLB parsing (manual — three's GLTFLoader needs browser image decoding we don't have in Node)
// ---------------------------------------------------------------------------------------------
function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  let off = 20 + jsonLen;
  let bin = null;
  while (off < buf.length) {
    const clen = dv.getUint32(off, true);
    const ctype = dv.getUint32(off + 4, true);
    if (ctype === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + clen);
    off += 8 + clen;
  }
  return { json, bin };
}

/** Read an accessor into a Float32Array (dequantizing normalized ints per the glTF spec). */
function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
  const nComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const stride = bv.byteStride || compSize * nComp;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(acc.count * nComp);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = {
    5120: (o) => { const v = dv.getInt8(o); return acc.normalized ? Math.max(v / 127, -1) : v; },
    5121: (o) => { const v = dv.getUint8(o); return acc.normalized ? v / 255 : v; },
    5122: (o) => { const v = dv.getInt16(o, true); return acc.normalized ? Math.max(v / 32767, -1) : v; },
    5123: (o) => { const v = dv.getUint16(o, true); return acc.normalized ? v / 65535 : v; },
    5125: (o) => dv.getUint32(o, true),
    5126: (o) => dv.getFloat32(o, true),
  }[acc.componentType];
  for (let i = 0; i < acc.count; i++)
    for (let c = 0; c < nComp; c++) out[i * nComp + c] = read(base + i * stride + c * compSize);
  return out;
}

console.log("— loading scan:", scanPath);
const { json: gj, bin: gbin } = parseGlb(fs.readFileSync(scanPath));
const prim = gj.meshes[0].primitives[0];
const srcPos = readAccessor(gj, gbin, prim.attributes.POSITION);
const srcUv = readAccessor(gj, gbin, prim.attributes.TEXCOORD_0);
const srcIdx = readAccessor(gj, gbin, prim.indices);
const nSrc = srcPos.length / 3;
console.log(`  ${nSrc} verts, ${srcIdx.length / 3} tris`);

// Bake the scene-node transform (the scan parks its real-world scale/offset on the mesh node) so
// vertex positions land directly in the skeleton's space.
{
  const meshNodeIdx = gj.nodes.findIndex((n) => n.mesh === 0);
  const world = new THREE.Matrix4();
  const chain = [];
  let cur = meshNodeIdx;
  while (cur != null && cur >= 0) {
    chain.unshift(cur);
    const parent = gj.nodes.findIndex((n) => (n.children || []).includes(cur));
    cur = parent === -1 ? null : parent;
  }
  for (const ni of chain) {
    const n = gj.nodes[ni];
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(n.translation || [0, 0, 0])),
      new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])),
      new THREE.Vector3(...(n.scale || [1, 1, 1])),
    );
    world.multiply(m);
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < nSrc; i++) {
    v.fromArray(srcPos, i * 3).applyMatrix4(world);
    v.toArray(srcPos, i * 3);
  }
}

// ---------------------------------------------------------------------------------------------
// Texture → per-vertex colors
// ---------------------------------------------------------------------------------------------
console.log("— baking texture to vertex colors");
const imgBv = gj.bufferViews[gj.images[0].bufferView];
const img = jpeg.decode(gbin.subarray(imgBv.byteOffset || 0, (imgBv.byteOffset || 0) + imgBv.byteLength), { useTArray: true });
const srcCol = new Float32Array(nSrc * 3);
for (let i = 0; i < nSrc; i++) {
  // This scan's converter kept FBX-style bottom-left-origin UVs (verified by edge-color
  // coherence: flipped V is 1.5x more coherent), so flip V when sampling the decoded rows.
  const u = srcUv[i * 2] * (img.width - 1);
  const vv = (1 - srcUv[i * 2 + 1]) * (img.height - 1);
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(u)));
  const y0 = Math.max(0, Math.min(img.height - 2, Math.floor(vv)));
  const fx = u - x0, fy = vv - y0;
  for (let c = 0; c < 3; c++) {
    const s = (x, y) => img.data[(y * img.width + x) * 4 + c] / 255;
    srcCol[i * 3 + c] =
      s(x0, y0) * (1 - fx) * (1 - fy) + s(x0 + 1, y0) * fx * (1 - fy) +
      s(x0, y0 + 1) * (1 - fx) * fy + s(x0 + 1, y0 + 1) * fx * fy;
  }
}

// ---------------------------------------------------------------------------------------------
// Position-weld (kill UV-seam duplicates so the simplifier can actually collapse edges)
// ---------------------------------------------------------------------------------------------
console.log("— welding by position");
const canon = new Int32Array(nSrc).fill(-1);
{
  // Snap to a 0.5 mm grid — scan output is noisy and exact-bit welding leaves seam duplicates
  // (and non-manifold junk) that lock the simplifier.
  const GRID = 0.0005;
  const map = new Map();
  for (let i = 0; i < nSrc; i++) {
    const key = `${Math.round(srcPos[i * 3] / GRID)},${Math.round(srcPos[i * 3 + 1] / GRID)},${Math.round(srcPos[i * 3 + 2] / GRID)}`;
    const c = map.get(key);
    if (c === undefined) { map.set(key, i); canon[i] = i; } else canon[i] = c;
  }
  console.log(`  ${map.size} unique positions`);
}
// Canonical-vertex color = average over its seam duplicates (same surface point, charts differ).
const colSum = new Float32Array(nSrc * 4);
for (let i = 0; i < nSrc; i++) {
  const c = canon[i];
  colSum[c * 4] += srcCol[i * 3]; colSum[c * 4 + 1] += srcCol[i * 3 + 1];
  colSum[c * 4 + 2] += srcCol[i * 3 + 2]; colSum[c * 4 + 3] += 1;
}
const weldIdx = new Uint32Array(srcIdx.length);
for (let i = 0; i < srcIdx.length; i++) weldIdx[i] = canon[srcIdx[i]];

// ---------------------------------------------------------------------------------------------
// Simplify
// ---------------------------------------------------------------------------------------------
console.log("— simplifying");
await MeshoptSimplifier.ready;
let simpIdx = weldIdx, simpErr = 0;
// Escalating error budget: each pass can unlock edges the previous pass couldn't collapse (scan
// topology junk), and Prune drops disconnected floaters smaller than the pass's error.
for (const err of [0.005, 0.01, 0.02, 0.04, 0.08, 0.15]) {
  if (simpIdx.length <= TARGET_TRIS * 3) break;
  let out, e;
  try {
    [out, e] = MeshoptSimplifier.simplify(simpIdx, srcPos, 3, TARGET_TRIS * 3, err, ["Prune"]);
  } catch {
    [out, e] = MeshoptSimplifier.simplify(simpIdx, srcPos, 3, TARGET_TRIS * 3, err, []);
  }
  if (out.length < simpIdx.length) { simpIdx = out; simpErr = Math.max(simpErr, e); }
  console.log(`  pass (err ${err}): → ${simpIdx.length / 3} tris (achieved ${simpErr.toFixed(4)})`);
  if (out.length >= simpIdx.length && err > 0.02) break; // stuck on topology — stop burning passes
}
// Photogrammetry junk (non-manifold edges, self-intersections) hard-blocks edge-collapse well
// above our budget — finish the job with the topology-ignoring cluster simplifier. Its output
// still indexes the ORIGINAL vertex buffer, so colors carry over untouched.
if (simpIdx.length > TARGET_TRIS * 3) {
  const [out, e] = MeshoptSimplifier.simplifySloppy(simpIdx, srcPos, 3, null, TARGET_TRIS * 3, 0.3);
  simpIdx = out; simpErr = Math.max(simpErr, e);
  console.log(`  sloppy: → ${simpIdx.length / 3} tris (achieved ${simpErr.toFixed(4)})`);
}

// Compact to the surviving vertices.
const remap = new Int32Array(nSrc).fill(-1);
let nOut = 0;
for (const i of simpIdx) if (remap[i] === -1) remap[i] = nOut++;
const pos = new Float32Array(nOut * 3);
const col = new Float32Array(nOut * 3);
for (let i = 0; i < nSrc; i++) {
  const r = remap[i];
  if (r === -1) continue;
  pos[r * 3] = srcPos[i * 3]; pos[r * 3 + 1] = srcPos[i * 3 + 1]; pos[r * 3 + 2] = srcPos[i * 3 + 2];
  const n = colSum[i * 4 + 3] || 1;
  col[r * 3] = colSum[i * 4] / n; col[r * 3 + 1] = colSum[i * 4 + 1] / n; col[r * 3 + 2] = colSum[i * 4 + 2] / n;
}
const idx = new Uint32Array(simpIdx.length);
for (let i = 0; i < simpIdx.length; i++) idx[i] = remap[simpIdx[i]];
console.log(`  ${nOut} verts out`);

// Smooth vertex normals.
const nrm = new Float32Array(nOut * 3);
{
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
    b.sub(a); c.sub(a); n.crossVectors(b, c);
    for (const vi of [idx[t], idx[t + 1], idx[t + 2]]) {
      nrm[vi * 3] += n.x; nrm[vi * 3 + 1] += n.y; nrm[vi * 3 + 2] += n.z;
    }
  }
  for (let i = 0; i < nOut; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }
}

// ---------------------------------------------------------------------------------------------
// Team-recolor mask: classify each vertex's color → keep / primary uniform / secondary uniform.
// Stored in COLOR_0.alpha so the game can palette-swap per team at load.
// ---------------------------------------------------------------------------------------------
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
console.log("— classifying colors for team recolor");
const MASK_KEEP = 0, MASK_PRIMARY = 1, MASK_SECONDARY = 2;
const mask = new Uint8Array(nOut);
const hist = new Map();
for (let i = 0; i < nOut; i++) {
  const [h, s, l] = rgbToHsl(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
  // SECONDARY = the scan's dominant navy uniform color (jersey/helmet/boots) → team primary at
  // runtime. PRIMARY = the saturated orange trim → team accent. Bare-skin tans (s ≈ 0.3-0.45,
  // bright) must stay KEEP, so the warm class needs high saturation or darker luminance.
  if (h >= 8 && h <= 52 && l > 0.1 && l < 0.8 && (s > 0.5 || (s > 0.38 && l < 0.5))) mask[i] = MASK_PRIMARY;
  else if (s > 0.12 && l < 0.68 && h >= 180 && h <= 270) mask[i] = MASK_SECONDARY;
  else mask[i] = MASK_KEEP;
  const bucket = `${Math.round(h / 15) * 15}/${(s > 0.3 ? "S" : "s")}${(l > 0.5 ? "L" : "l")}`;
  hist.set(bucket, (hist.get(bucket) || 0) + 1);
}
if (QC) console.log("  hue histogram:", [...hist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 14));
console.log(`  primary ${[...mask].filter((m) => m === 1).length}, secondary ${[...mask].filter((m) => m === 2).length}, keep ${[...mask].filter((m) => m === 0).length}`);

// ---------------------------------------------------------------------------------------------
// Skeleton (from the Mixamo-retargeted Idle FBX — already auto-fitted to this scan) + idle clip
// ---------------------------------------------------------------------------------------------
console.log("— extracting skeleton + idle clip:", idlePath);
const fbuf = fs.readFileSync(idlePath);
const fgrp = new FBXLoader().parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength), "");
fgrp.updateMatrixWorld(true);
const bones = [];
fgrp.traverse((o) => { if (o.isBone) bones.push(o); });
const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
const idleClip = fgrp.animations[0] ?? null;
console.log(`  ${bones.length} bones, idle clip: ${idleClip ? idleClip.duration.toFixed(2) + "s" : "none"}`);

// Skinnable subset: skip fingers/end nubs — a chibi in gloves binds better to whole-hand bones,
// and fewer influences smooth out scan noise. All bones still ship (animation targets them).
const SKINNABLE = bones.filter((b) => /Hips$|Spine\d?$|Neck$|Head$|Shoulder$|Arm$|ForeArm$|Hand$|UpLeg$|Leg$|Foot$|ToeBase$/.test(b.name));
console.log(`  skinnable: ${SKINNABLE.length}`);

// Bone segments (world space): joint → each child joint; hands extend to the middle-finger tip so
// the glove binds rigidly to the hand; childless bones get a stub along the parent direction.
const segs = SKINNABLE.map((b) => {
  const p0 = b.getWorldPosition(new THREE.Vector3());
  let ends = b.children.filter((c) => c.isBone).map((c) => c.getWorldPosition(new THREE.Vector3()));
  if (/Hand$/.test(b.name)) {
    const tip = bones.find((x) => x.name === b.name + "Middle4");
    if (tip) ends = [tip.getWorldPosition(new THREE.Vector3())];
  }
  if (ends.length === 0) {
    const par = b.parent.getWorldPosition(new THREE.Vector3());
    ends = [p0.clone().add(p0.clone().sub(par).normalize().multiplyScalar(0.04))];
  }
  const side = /Left/.test(b.name) ? 1 : /Right/.test(b.name) ? -1 : 0;
  return { bone: b, p0, ends, side };
});

function distToSeg(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

console.log("— computing skin weights");
const nB = SKINNABLE.length;
let W = new Float32Array(nOut * nB);
for (let i = 0; i < nOut; i++) {
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
  for (let s = 0; s < nB; s++) {
    const seg = segs[s];
    // A side-limb bone only claims vertices on its own side (with a small midline margin).
    if (seg.side === 1 && px < -0.015) continue;
    if (seg.side === -1 && px > 0.015) continue;
    let d = Infinity;
    for (const e of seg.ends) d = Math.min(d, distToSeg(px, py, pz, seg.p0, e));
    W[i * nB + s] = 1 / (d * d + 1e-5);
  }
  // Keep top 4 raw influences (pre-smoothing) to sparsify.
  const row = W.subarray(i * nB, i * nB + nB);
  const top = [...row.keys()].sort((a, b) => row[b] - row[a]).slice(0, 4);
  const keep = new Set(top);
  let sum = 0;
  for (let s = 0; s < nB; s++) { if (!keep.has(s)) row[s] = 0; else sum += row[s]; }
  for (let s = 0; s < nB; s++) row[s] /= sum || 1;
}

// Laplacian-smooth the weight field over the mesh so seams between bone regions deform softly.
console.log("— smoothing weights");
{
  const nbr = Array.from({ length: nOut }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const adj = nbr.map((s) => Uint32Array.from(s));
  for (let pass = 0; pass < 12; pass++) {
    const W2 = new Float32Array(nOut * nB);
    for (let i = 0; i < nOut; i++) {
      const an = adj[i];
      const self = 1.5; // keep some stiffness so smoothing doesn't bleed across the whole body
      for (let s = 0; s < nB; s++) W2[i * nB + s] = W[i * nB + s] * self;
      for (const j of an) for (let s = 0; s < nB; s++) W2[i * nB + s] += W[j * nB + s];
      let sum = 0;
      for (let s = 0; s < nB; s++) sum += W2[i * nB + s];
      for (let s = 0; s < nB; s++) W2[i * nB + s] /= sum || 1;
    }
    W = W2;
  }
}

// Final per-vertex top-4 joints/weights.
const joints = new Uint8Array(nOut * 4);
const weights = new Uint8Array(nOut * 4);
for (let i = 0; i < nOut; i++) {
  const row = W.subarray(i * nB, i * nB + nB);
  const top = [...row.keys()].sort((a, b) => row[b] - row[a]).slice(0, 4);
  let sum = 0;
  for (const s of top) sum += row[s];
  let acc = 0;
  for (let k = 0; k < 4; k++) {
    const s = top[k];
    joints[i * 4 + k] = boneIndex.get(SKINNABLE[s].name);
    const w = k === 3 ? 255 - acc : Math.round((row[s] / sum) * 255);
    weights[i * 4 + k] = Math.max(0, w);
    acc += w;
  }
}

// ---------------------------------------------------------------------------------------------
// Write the GLB: bone nodes + skinned vertex-colored mesh + baked idle animation
// ---------------------------------------------------------------------------------------------
console.log("— writing", outPath);
const bonesParentIdx = bones.map((b) => (b.parent && b.parent.isBone ? boneIndex.get(b.parent.name) : -1));
const nodes = bones.map((b, i) => {
  const n = { name: b.name, translation: b.position.toArray(), rotation: b.quaternion.toArray() };
  if (b.scale.x !== 1 || b.scale.y !== 1 || b.scale.z !== 1) n.scale = b.scale.toArray();
  const children = bones.map((c, ci) => (bonesParentIdx[ci] === i ? ci : -1)).filter((x) => x >= 0);
  if (children.length) n.children = children;
  return n;
});
const meshNode = nodes.length;
nodes.push({ name: "playerscan", mesh: 0, skin: 0 });
const rootBones = bones.map((_, i) => i).filter((i) => bonesParentIdx[i] === -1);

// Inverse bind matrices from the FBX rest pose.
const ibm = new Float32Array(bones.length * 16);
const inv = new THREE.Matrix4();
bones.forEach((b, i) => {
  inv.copy(b.matrixWorld).invert();
  ibm.set(inv.elements, i * 16);
});

// Buffer assembly helper.
const chunks = [];
let byteLen = 0;
const bufferViews = [];
const accessors = [];
function push(data, target, accDef) {
  const pad = (4 - (byteLen % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); byteLen += pad; }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: byteLen, byteLength: buf.length, ...(target ? { target } : {}) });
  chunks.push(buf);
  byteLen += buf.length;
  accessors.push({ bufferView: bufferViews.length - 1, ...accDef });
  return accessors.length - 1;
}
function minMax(arr, n) {
  const min = Array(n).fill(Infinity), max = Array(n).fill(-Infinity);
  for (let i = 0; i < arr.length; i += n)
    for (let c = 0; c < n; c++) { min[c] = Math.min(min[c], arr[i + c]); max[c] = Math.max(max[c], arr[i + c]); }
  return { min, max };
}

const idx16 = nOut <= 65535 ? Uint16Array.from(idx) : idx;
const accIdx = push(idx16, 34963, { componentType: nOut <= 65535 ? 5123 : 5125, count: idx.length, type: "SCALAR" });
const accPos = push(pos, 34962, { componentType: 5126, count: nOut, type: "VEC3", ...minMax(pos, 3) });
const accNrm = push(nrm, 34962, { componentType: 5126, count: nOut, type: "VEC3" });
// COLOR_0 = rgba16: rgb = baked color, a = team-recolor mask (1.0 keep / ~0.67 primary /
// ~0.33 secondary). glTF vertex colors are LINEAR — the sampled JPEG is sRGB, so decode here or
// the model renders washed-out (three re-encodes to sRGB on output). 16-bit because linear-space
// darks (the navy uniform) band visibly at 8 bits.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const colU16 = new Uint16Array(nOut * 4);
for (let i = 0; i < nOut; i++) {
  colU16[i * 4] = Math.round(srgbToLinear(col[i * 3]) * 65535);
  colU16[i * 4 + 1] = Math.round(srgbToLinear(col[i * 3 + 1]) * 65535);
  colU16[i * 4 + 2] = Math.round(srgbToLinear(col[i * 3 + 2]) * 65535);
  colU16[i * 4 + 3] = mask[i] === MASK_PRIMARY ? 43690 : mask[i] === MASK_SECONDARY ? 21845 : 65535;
}
const accCol = push(colU16, 34962, { componentType: 5123, normalized: true, count: nOut, type: "VEC4" });
const accJnt = push(joints, 34962, { componentType: 5121, count: nOut, type: "VEC4" });
const accWgt = push(weights, 34962, { componentType: 5121, normalized: true, count: nOut, type: "VEC4" });
const accIbm = push(ibm, null, { componentType: 5126, count: bones.length, type: "MAT4" });

// Idle animation: copy the FBX clip's tracks (rotation for every bone + hips translation).
const animChannels = [];
const animSamplers = [];
if (idleClip) {
  for (const tr of idleClip.tracks) {
    const m = tr.name.match(/^(.*)\.(quaternion|position)$/);
    if (!m || !boneIndex.has(m[1])) continue;
    const node = boneIndex.get(m[1]);
    const path = m[2] === "quaternion" ? "rotation" : "translation";
    const inAcc = push(Float32Array.from(tr.times), null, { componentType: 5126, count: tr.times.length, type: "SCALAR", min: [tr.times[0]], max: [tr.times[tr.times.length - 1]] });
    const outAcc = push(Float32Array.from(tr.values), null, { componentType: 5126, count: tr.times.length, type: path === "rotation" ? "VEC4" : "VEC3" });
    animSamplers.push({ input: inAcc, output: outAcc, interpolation: "LINEAR" });
    animChannels.push({ sampler: animSamplers.length - 1, target: { node, path } });
  }
}

const outJson = {
  asset: { version: "2.0", generator: "Football-Game tools/build-player-asset.mjs" },
  scene: 0,
  scenes: [{ name: "player", nodes: [...rootBones, meshNode] }],
  nodes,
  skins: [{ inverseBindMatrices: accIbm, joints: bones.map((_, i) => i), skeleton: rootBones[0] }],
  meshes: [{ name: "playerscan", primitives: [{ attributes: { POSITION: accPos, NORMAL: accNrm, COLOR_0: accCol, JOINTS_0: accJnt, WEIGHTS_0: accWgt }, indices: accIdx, material: 0 }] }],
  materials: [{ name: "playerscan", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
  animations: idleClip ? [{ name: "idle", channels: animChannels, samplers: animSamplers }] : [],
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
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jbuf.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const bhead = Buffer.alloc(8);
  bhead.writeUInt32LE(bin.length, 0); bhead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jbuf, bhead, bin]);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, glbWrite(outJson, chunks, byteLen));
console.log(`  wrote ${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB`);

// ---------------------------------------------------------------------------------------------
// QC dumps for offline plotting
// ---------------------------------------------------------------------------------------------
if (QC) {
  fs.mkdirSync("/tmp/rigqc", { recursive: true });
  const dom = new Uint8Array(nOut);
  for (let i = 0; i < nOut; i++) dom[i] = joints[i * 4];
  fs.writeFileSync("/tmp/rigqc/qc.json", JSON.stringify({
    pos: [...pos], col: [...colU8], dom: [...dom],
    boneNames: bones.map((b) => b.name),
    bonePos: bones.map((b) => b.getWorldPosition(new THREE.Vector3()).toArray()),
  }));
  console.log("  QC dump → /tmp/rigqc/qc.json");
}
