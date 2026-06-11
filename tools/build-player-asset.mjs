/**
 * Offline asset pipeline: turn a raw photogrammetry scan (unrigged, ~800k-tri GLB with a chaotic
 * per-chart texture atlas) + a Mixamo animation FBX (whose skeleton Mixamo already auto-fitted to
 * this scan) into a game-ready rigged player model:
 *
 *   1. dequantize + position-weld the scan and sample its texture per source vertex (inset from
 *      the chart borders, which run exactly through the vertices),
 *   2. VOXEL-REMESH: the scan is a noisy double-layered shell that locks up edge-collapse
 *      simplifiers — solidify it (occupancy grid → close → outside flood → cuberille → Taubin)
 *      into one clean manifold surface,
 *   3. meshopt-simplify to a mobile budget (clean input reaches the target directly),
 *   4. unwrap with xatlas and RE-BAKE a clean texture atlas by sampling the dense source point
 *      cloud with per-channel medians (rejects the source atlas's chart-bleed outliers),
 *   5. classify each texel into a team-recolor mask (warm trim / uniform base / keep), stored in
 *      the atlas's ALPHA channel so the game can palette-swap uniforms per team at load,
 *   6. auto-skin the mesh to the Mixamo skeleton extracted from the Idle FBX (bone-segment
 *      distance weights + Laplacian smoothing — the skeleton is already scaled/posed to the scan),
 *   7. bake the Idle clip into the GLB (the game expects the model file to supply its idle), and
 *   8. write a single self-contained player.glb.
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
import * as watlas from "watlas";
import { PNG } from "pngjs";

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
// This scan's converter kept FBX-style bottom-left-origin UVs (verified by edge-color
// coherence: flipped V is 1.5x more coherent than every other axis transform), so flip V when
// sampling the decoded rows. And because the atlas is thousands of tiny charts whose BORDERS run
// exactly through the vertices, don't sample at the vertex UV (it bleeds the neighboring chart):
// sample each triangle corner inset toward the triangle's UV centroid, and average a vertex's
// color over its incident triangles.
const srcCol = new Float32Array(nSrc * 3);
{
  const sample = (u, v, out) => {
    const su = u * (img.width - 1);
    const sv = (1 - v) * (img.height - 1);
    const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(su)));
    const y0 = Math.max(0, Math.min(img.height - 2, Math.floor(sv)));
    const fx = su - x0, fy = sv - y0;
    for (let c = 0; c < 3; c++) {
      const s = (x, y) => img.data[(y * img.width + x) * 4 + c];
      out[c] = s(x0, y0) * (1 - fx) * (1 - fy) + s(x0 + 1, y0) * fx * (1 - fy) +
        s(x0, y0 + 1) * (1 - fx) * fy + s(x0 + 1, y0 + 1) * fx * fy;
    }
  };
  const accum = new Float32Array(nSrc * 4);
  const rgb = [0, 0, 0];
  const INSET = 0.4; // 0 = at the corner (chart border), 1 = at the centroid
  for (let t = 0; t < srcIdx.length; t += 3) {
    const ia = srcIdx[t], ib = srcIdx[t + 1], ic = srcIdx[t + 2];
    const cu = (srcUv[ia * 2] + srcUv[ib * 2] + srcUv[ic * 2]) / 3;
    const cv = (srcUv[ia * 2 + 1] + srcUv[ib * 2 + 1] + srcUv[ic * 2 + 1]) / 3;
    for (const vi of [ia, ib, ic]) {
      sample(srcUv[vi * 2] * (1 - INSET) + cu * INSET, srcUv[vi * 2 + 1] * (1 - INSET) + cv * INSET, rgb);
      accum[vi * 4] += rgb[0]; accum[vi * 4 + 1] += rgb[1]; accum[vi * 4 + 2] += rgb[2]; accum[vi * 4 + 3]++;
    }
  }
  for (let i = 0; i < nSrc; i++) {
    const n = accum[i * 4 + 3] || 1;
    srcCol[i * 3] = accum[i * 4] / n / 255;
    srcCol[i * 3 + 1] = accum[i * 4 + 1] / n / 255;
    srcCol[i * 3 + 2] = accum[i * 4 + 2] / n / 255;
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
// Voxel remesh. The scan is a noisy DOUBLE-LAYERED shell (inner+outer surface ~1-2 mm apart)
// full of non-manifold junk — edge-collapse simplifiers lock up on it and cluster simplifiers
// merge the layers into fin soup. Solidify it instead: occupancy grid from the dense point
// cloud → morphological close → flood-fill the outside → boundary surface (cuberille) → Taubin
// smooth → clean manifold mesh that simplifies and unwraps perfectly.
// ---------------------------------------------------------------------------------------------
console.log("— voxel remeshing");
const VOX = 0.004;
let pos, idx, nOut;
{
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < nSrc; i++) {
    minX = Math.min(minX, srcPos[i * 3]); maxX = Math.max(maxX, srcPos[i * 3]);
    minY = Math.min(minY, srcPos[i * 3 + 1]); maxY = Math.max(maxY, srcPos[i * 3 + 1]);
    minZ = Math.min(minZ, srcPos[i * 3 + 2]); maxZ = Math.max(maxZ, srcPos[i * 3 + 2]);
  }
  const M = 3; // margin cells
  const nx = Math.ceil((maxX - minX) / VOX) + 2 * M;
  const ny = Math.ceil((maxY - minY) / VOX) + 2 * M;
  const nz = Math.ceil((maxZ - minZ) / VOX) + 2 * M;
  const N = nx * ny * nz;
  const at = (x, y, z) => (z * ny + y) * nx + x;
  const occ = new Uint8Array(N);
  for (let i = 0; i < nSrc; i++) {
    const x = Math.floor((srcPos[i * 3] - minX) / VOX) + M;
    const y = Math.floor((srcPos[i * 3 + 1] - minY) / VOX) + M;
    const z = Math.floor((srcPos[i * 3 + 2] - minZ) / VOX) + M;
    occ[at(x, y, z)] = 1;
  }
  // Dilate once (26-neighborhood) to seal pinholes before the outside flood.
  const dil = new Uint8Array(occ);
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    if (!occ[at(x, y, z)]) continue;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) dil[at(x + dx, y + dy, z + dz)] = 1;
  }
  // BFS flood from a corner: everything reachable through empty cells is OUTSIDE.
  const outside = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  queue[qt++] = at(0, 0, 0);
  outside[at(0, 0, 0)] = 1;
  while (qh < qt) {
    const c = queue[qh++];
    const cz = (c / (nx * ny)) | 0, cy = ((c / nx) | 0) % ny, cx = c % nx;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const x = cx + dx, y = cy + dy, z = cz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      const q = at(x, y, z);
      if (outside[q] || dil[q]) continue;
      outside[q] = 1;
      queue[qt++] = q;
    }
  }
  // Solid = not outside; erode once (6-conn) to undo the dilation's thickening.
  const solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = outside[i] ? 0 : 1;
  const eroded = new Uint8Array(solid);
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const c = at(x, y, z);
    if (!solid[c]) continue;
    if (!solid[at(x + 1, y, z)] || !solid[at(x - 1, y, z)] || !solid[at(x, y + 1, z)] || !solid[at(x, y - 1, z)] || !solid[at(x, y, z + 1)] || !solid[at(x, y, z - 1)]) eroded[c] = 0;
  }
  // Cuberille extraction: a quad (two tris) per face between solid and empty, lattice verts shared.
  const vmap = new Map();
  const verts = [];
  const vid = (x, y, z) => {
    const k = (z * (ny + 1) + y) * (nx + 1) + x;
    let v = vmap.get(k);
    if (v === undefined) {
      v = verts.length / 3;
      vmap.set(k, v);
      verts.push(minX + (x - M) * VOX, minY + (y - M) * VOX, minZ + (z - M) * VOX);
    }
    return v;
  };
  const tris = [];
  const FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    if (!eroded[at(x, y, z)]) continue;
    for (const [[dx, dy, dz], corners] of FACES) {
      if (eroded[at(x + dx, y + dy, z + dz)]) continue;
      const q = corners.map(([cx, cy, cz]) => vid(x + cx, y + cy, z + cz));
      tris.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
  }
  pos = Float32Array.from(verts);
  idx = Uint32Array.from(tris);
  nOut = pos.length / 3;
  console.log(`  grid ${nx}x${ny}x${nz}, surface: ${nOut} verts, ${idx.length / 3} tris`);

  // Heavy Taubin smoothing melts the voxel staircase into the scan's true surface.
  const nbr = Array.from({ length: nOut }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const vadj = nbr.map((s) => Uint32Array.from(s));
  const taubin = (lambda) => {
    const next = new Float32Array(pos);
    for (let i = 0; i < nOut; i++) {
      const an = vadj[i];
      if (an.length === 0) continue;
      let x = 0, y = 0, z = 0;
      for (const j of an) { x += pos[j * 3]; y += pos[j * 3 + 1]; z += pos[j * 3 + 2]; }
      next[i * 3] = pos[i * 3] + lambda * (x / an.length - pos[i * 3]);
      next[i * 3 + 1] = pos[i * 3 + 1] + lambda * (y / an.length - pos[i * 3 + 1]);
      next[i * 3 + 2] = pos[i * 3 + 2] + lambda * (z / an.length - pos[i * 3 + 2]);
    }
    pos.set(next);
  };
  for (let pass = 0; pass < 10; pass++) { taubin(0.5); taubin(-0.52); }
}

// ---------------------------------------------------------------------------------------------
// Simplify (the remeshed surface is clean manifold — meshopt reaches any budget directly).
// ---------------------------------------------------------------------------------------------
console.log("— simplifying");
await MeshoptSimplifier.ready;
{
  const [out, err] = MeshoptSimplifier.simplify(idx, pos, 3, TARGET_TRIS * 3, 0.05, []);
  console.log(`  → ${out.length / 3} tris (error ${err.toFixed(4)})`);
  // Compact to surviving vertices.
  const remap = new Int32Array(nOut).fill(-1);
  let n2 = 0;
  for (const i of out) if (remap[i] === -1) remap[i] = n2++;
  const pos2 = new Float32Array(n2 * 3);
  for (let i = 0; i < nOut; i++) {
    const r = remap[i];
    if (r === -1) continue;
    pos2[r * 3] = pos[i * 3]; pos2[r * 3 + 1] = pos[i * 3 + 1]; pos2[r * 3 + 2] = pos[i * 3 + 2];
  }
  idx = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) idx[i] = remap[out[i]];
  pos = pos2;
  nOut = n2;
  console.log(`  ${nOut} verts out`);
}
const col = new Float32Array(nOut * 3); // filled below by supersampling from the source cloud

// Final-mesh vertex adjacency (used to smooth colors, normals, and skin weights below).
const adj = (() => {
  const nbr = Array.from({ length: nOut }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  return nbr.map((s) => Uint32Array.from(s));
})();

// Taubin-smooth the positions (shrink-compensated): the surviving scan vertices carry 1-3 mm of
// surface noise, so at this edge length adjacent face normals disagree wildly — bad shading AND
// the reason xatlas fragments. λ/μ alternation smooths without losing volume.
{
  const taubin = (lambda) => {
    const next = new Float32Array(pos);
    for (let i = 0; i < nOut; i++) {
      const an = adj[i];
      if (an.length === 0) continue;
      let x = 0, y = 0, z = 0;
      for (const j of an) { x += pos[j * 3]; y += pos[j * 3 + 1]; z += pos[j * 3 + 2]; }
      next[i * 3] = pos[i * 3] + lambda * (x / an.length - pos[i * 3]);
      next[i * 3 + 1] = pos[i * 3 + 1] + lambda * (y / an.length - pos[i * 3 + 1]);
      next[i * 3 + 2] = pos[i * 3 + 2] + lambda * (z / an.length - pos[i * 3 + 2]);
    }
    pos.set(next);
  };
  for (let pass = 0; pass < 4; pass++) { taubin(0.5); taubin(-0.53); }
}

// Supersample colors: a surviving vertex's own sample is ONE noisy texel of a photogrammetry
// atlas — adjacent vertices disagree and the model shades like TV static. Instead, every
// original (welded) vertex votes its color into its nearest FINAL vertex (~70 source samples
// per final vertex), then one gentle Laplacian pass evens out the remainder.
console.log("— supersampling vertex colors");
{
  const cell = 0.012;
  const grid = new Map();
  for (let i = 0; i < nOut; i++) {
    const k = `${Math.round(pos[i * 3] / cell)},${Math.round(pos[i * 3 + 1] / cell)},${Math.round(pos[i * 3 + 2] / cell)}`;
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  }
  // Collect every source sample per final vertex, then take the per-channel MEDIAN: even on the
  // full-res mesh ~a quarter of vertex samples are atlas chart-bleed outliers (white speckle on
  // the navy, etc.) — a mean drags them in and mottles the result; the median rejects them.
  const samples = Array.from({ length: nOut }, () => []);
  for (let v = 0; v < nSrc; v++) {
    if (canon[v] !== v) continue; // one vote per welded position (already the seam-averaged color)
    const x = srcPos[v * 3], y = srcPos[v * 3 + 1], z = srcPos[v * 3 + 2];
    const cx = Math.round(x / cell), cy = Math.round(y / cell), cz = Math.round(z / cell);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!arr) continue;
      for (const f of arr) {
        const d = (pos[f * 3] - x) ** 2 + (pos[f * 3 + 1] - y) ** 2 + (pos[f * 3 + 2] - z) ** 2;
        if (d < bd) { bd = d; best = f; }
      }
    }
    if (best < 0 || bd > (cell * 2.5) ** 2) continue;
    const n = colSum[v * 4 + 3] || 1;
    samples[best].push([colSum[v * 4] / n, colSum[v * 4 + 1] / n, colSum[v * 4 + 2] / n]);
  }
  const filled = new Uint8Array(nOut);
  let covered = 0;
  for (let i = 0; i < nOut; i++) {
    const s = samples[i];
    if (s.length === 0) continue;
    for (let c = 0; c < 3; c++) {
      const vals = s.map((x) => x[c]).sort((a, b) => a - b);
      col[i * 3 + c] = vals[vals.length >> 1];
    }
    filled[i] = 1;
    covered++;
  }
  console.log(`  ${covered}/${nOut} verts median-filtered`);
  // Remeshed vertices with no nearby source samples inherit from covered neighbors.
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    for (let i = 0; i < nOut; i++) {
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const j of adj[i]) {
        if (!filled[j]) continue;
        r += col[j * 3]; g += col[j * 3 + 1]; b += col[j * 3 + 2]; n++;
      }
      if (!n) continue;
      col[i * 3] = r / n; col[i * 3 + 1] = g / n; col[i * 3 + 2] = b / n;
      filled[i] = 2;
      changed++;
    }
    for (let i = 0; i < nOut; i++) if (filled[i] === 2) filled[i] = 1;
    if (!changed) break;
  }
  const sm = new Float32Array(col);
  for (let i = 0; i < nOut; i++) {
    let r = col[i * 3] * 2, g = col[i * 3 + 1] * 2, b = col[i * 3 + 2] * 2, w = 2;
    for (const j of adj[i]) { r += col[j * 3]; g += col[j * 3 + 1]; b += col[j * 3 + 2]; w++; }
    sm[i * 3] = r / w; sm[i * 3 + 1] = g / w; sm[i * 3 + 2] = b / w;
  }
  col.set(sm);
}

// Smooth vertex normals (area-weighted face accumulation, then two Laplacian passes — the raw
// scan surface is bumpy and its lighting speckle reads as noise too).
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
  const renorm = () => {
    for (let i = 0; i < nOut; i++) {
      const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
      nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
    }
  };
  renorm();
  for (let pass = 0; pass < 2; pass++) {
    const sm = new Float32Array(nrm);
    for (let i = 0; i < nOut; i++) {
      let x = nrm[i * 3] * 2, y = nrm[i * 3 + 1] * 2, z = nrm[i * 3 + 2] * 2;
      for (const j of adj[i]) { x += nrm[j * 3]; y += nrm[j * 3 + 1]; z += nrm[j * 3 + 2]; }
      sm[i * 3] = x; sm[i * 3 + 1] = y; sm[i * 3 + 2] = z;
    }
    nrm.set(sm);
    renorm();
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
  if (h >= 8 && h <= 52 && l > 0.1 && l < 0.8 && (s > 0.62 || (s > 0.42 && l < 0.45))) mask[i] = MASK_PRIMARY;
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
// Unwrap (xatlas) + texture re-bake. Vertex colors at this density physically can't hold the
// figure's fine paint regions (3-5 mm stripes/trim) — so generate a CLEAN atlas for the
// simplified mesh and bake colors into it by sampling the dense source point cloud (~1 mm
// spacing) with a per-channel median (rejects the source atlas's chart-bleed outliers).
// ---------------------------------------------------------------------------------------------
console.log("— unwrapping (xatlas)");
await watlas.Initialize();
const atlas = new watlas.Atlas();
atlas.addMesh({
  vertexPositionData: pos, vertexCount: nOut, vertexPositionStride: 12,
  vertexNormalData: nrm, vertexNormalStride: 12,
  indexData: idx, indexCount: idx.length,
});
// Default chart options shatter this (still bumpy) scan into thousands of tiny charts and the
// padding alone blows the atlas up 6x — relax the cost terms so charts can wrap curvature.
atlas.generate(
  { maxCost: 24, normalDeviationWeight: 0.4, roundnessWeight: 0.005, straightnessWeight: 0.1, normalSeamWeight: 0.6, textureSeamWeight: 0 },
  { resolution: 1024, padding: 4, bilinear: true },
);
const AW = atlas.width, AH = atlas.height;
const amesh = atlas.getMesh(0);
const nF = amesh.vertexCount;
console.log(`  atlas ${AW}x${AH}, ${amesh.chartCount} charts, ${nF} verts (from ${nOut})`);
// Unwrapping splits vertices at chart seams: rebuild every attribute through xref.
const fPos = new Float32Array(nF * 3);
const fNrm = new Float32Array(nF * 3);
const fUv = new Float32Array(nF * 2);
const fUvTexel = new Float32Array(nF * 2);
const fJoints = new Uint8Array(nF * 4);
const fWeights = new Uint8Array(nF * 4);
for (let i = 0; i < nF; i++) {
  const v = amesh.getVertex(i);
  const o = v.xref;
  fPos.set(pos.subarray(o * 3, o * 3 + 3), i * 3);
  fNrm.set(nrm.subarray(o * 3, o * 3 + 3), i * 3);
  fJoints.set(joints.subarray(o * 4, o * 4 + 4), i * 4);
  fWeights.set(weights.subarray(o * 4, o * 4 + 4), i * 4);
  fUvTexel[i * 2] = v.uv[0]; fUvTexel[i * 2 + 1] = v.uv[1];
  fUv[i * 2] = v.uv[0] / AW; fUv[i * 2 + 1] = v.uv[1] / AH;
}
const fIdx = new Uint32Array(amesh.indexCount);
amesh.getIndexArray(fIdx);

console.log("— baking texture");
// Spatial grid over the dense canonical source vertices (the color ground truth).
const bake = (() => {
  const cell = 0.0035;
  const grid = new Map();
  for (let v = 0; v < nSrc; v++) {
    if (canon[v] !== v) continue;
    const k = `${Math.round(srcPos[v * 3] / cell)},${Math.round(srcPos[v * 3 + 1] / cell)},${Math.round(srcPos[v * 3 + 2] / cell)}`;
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(v);
  }
  const out = [0, 0, 0];
  const cand = [];
  return (x, y, z) => {
    const cx = Math.round(x / cell), cy = Math.round(y / cell), cz = Math.round(z / cell);
    cand.length = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!arr) continue;
      for (const v of arr) {
        const d = (srcPos[v * 3] - x) ** 2 + (srcPos[v * 3 + 1] - y) ** 2 + (srcPos[v * 3 + 2] - z) ** 2;
        cand.push([d, v]);
      }
    }
    if (cand.length === 0) return null;
    cand.sort((a, b) => a[0] - b[0]);
    const k = Math.min(9, cand.length);
    for (let c = 0; c < 3; c++) {
      const vals = [];
      for (let i = 0; i < k; i++) {
        const v = cand[i][1];
        const n = colSum[v * 4 + 3] || 1;
        vals.push(colSum[v * 4 + c] / n);
      }
      vals.sort((a, b) => a - b);
      out[c] = vals[vals.length >> 1];
    }
    return out;
  };
})();

const texData = new Uint8Array(AW * AH * 4);
const texCovered = new Uint8Array(AW * AH);
const classify = (r, g, b, x, y, z) => {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (h >= 8 && h <= 52 && l > 0.1 && l < 0.8 && (s > 0.62 || (s > 0.42 && l < 0.45))) return MASK_PRIMARY;
  if (s > 0.12 && l < 0.68 && h >= 180 && h <= 270) return MASK_SECONDARY;
  // The BACK of the helmet has a white trim band + light panel that reads as a FACEMASK at
  // gameplay distance — players look like they're running backwards. Fold the helmet-back
  // whites into the uniform-base class so they take the team color; the real (gray, front)
  // facemask stays "keep", which makes the true front unambiguous.
  if (y > 0.13 && z < 0.0 && l > 0.5 && s < 0.4) return MASK_SECONDARY;
  return MASK_KEEP;
};
for (let t = 0; t < fIdx.length; t += 3) {
  const a = fIdx[t], b = fIdx[t + 1], c = fIdx[t + 2];
  const ax = fUvTexel[a * 2], ay = fUvTexel[a * 2 + 1];
  const bx = fUvTexel[b * 2], by = fUvTexel[b * 2 + 1];
  const cx = fUvTexel[c * 2], cy = fUvTexel[c * 2 + 1];
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
  const maxX = Math.min(AW - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
  const maxY = Math.min(AH - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(den) < 1e-9) continue;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const sx = px + 0.5, sy = py + 0.5;
      let w0 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) / den;
      let w1 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) / den;
      let w2 = 1 - w0 - w1;
      const TOL = -0.12; // conservative: claim edge texels so bilinear never reads a hole
      if (w0 < TOL || w1 < TOL || w2 < TOL) continue;
      w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, Math.min(1, w2));
      const x = fPos[a * 3] * w0 + fPos[b * 3] * w1 + fPos[c * 3] * w2;
      const y = fPos[a * 3 + 1] * w0 + fPos[b * 3 + 1] * w1 + fPos[c * 3 + 1] * w2;
      const z = fPos[a * 3 + 2] * w0 + fPos[b * 3 + 2] * w1 + fPos[c * 3 + 2] * w2;
      const rgb = bake(x, y, z);
      if (!rgb) continue;
      const o = (py * AW + px) * 4;
      texData[o] = Math.round(rgb[0] * 255);
      texData[o + 1] = Math.round(rgb[1] * 255);
      texData[o + 2] = Math.round(rgb[2] * 255);
      const m = classify(rgb[0], rgb[1], rgb[2], x, y, z);
      texData[o + 3] = m === MASK_PRIMARY ? 170 : m === MASK_SECONDARY ? 85 : 255;
      texCovered[py * AW + px] = 1;
    }
  }
}
// Despeckle: residual outlier texels (bright flecks inside the navy, stray mask classes) read
// fine up close but turn into marble streaks once a team colorway luminance-scales them. A 3x3
// median over the covered texels (rgb per-channel + mask majority) kills them.
for (let pass = 0; pass < 2; pass++) {
  const out = Uint8Array.from(texData);
  const rs = [], gs = [], bs = [], as = [];
  for (let py = 1; py < AH - 1; py++) {
    for (let px = 1; px < AW - 1; px++) {
      if (!texCovered[py * AW + px]) continue;
      rs.length = gs.length = bs.length = as.length = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = (py + dy) * AW + (px + dx);
        if (!texCovered[q]) continue;
        rs.push(texData[q * 4]); gs.push(texData[q * 4 + 1]); bs.push(texData[q * 4 + 2]); as.push(texData[q * 4 + 3]);
      }
      const mid = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
      const o = (py * AW + px) * 4;
      out[o] = mid(rs); out[o + 1] = mid(gs); out[o + 2] = mid(bs); out[o + 3] = mid(as);
    }
  }
  texData.set(out);
}
// Gutter dilation: bleed covered colors into empty texels so bilinear/mip sampling near chart
// borders never reads black.
for (let pass = 0; pass < 8; pass++) {
  const next = Uint8Array.from(texCovered);
  for (let py = 0; py < AH; py++) {
    for (let px = 0; px < AW; px++) {
      const i = py * AW + px;
      if (texCovered[i]) continue;
      let r = 0, g = 0, b = 0, aMode = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = px + dx, qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= AW || qy >= AH) continue;
        const q = qy * AW + qx;
        if (!texCovered[q]) continue;
        const o = q * 4;
        r += texData[o]; g += texData[o + 1]; b += texData[o + 2]; aMode = texData[o + 3]; n++;
      }
      if (!n) continue;
      const o = i * 4;
      texData[o] = r / n; texData[o + 1] = g / n; texData[o + 2] = b / n; texData[o + 3] = aMode;
      next[i] = 1;
    }
  }
  texCovered.set(next);
}
const png = new PNG({ width: AW, height: AH });
png.data = Buffer.from(texData.buffer, texData.byteOffset, texData.byteLength);
const pngBuf = PNG.sync.write(png);
console.log(`  baked atlas PNG: ${(pngBuf.length / 1e6).toFixed(2)} MB`);

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

const idx16 = nF <= 65535 ? Uint16Array.from(fIdx) : fIdx;
const accIdx = push(idx16, 34963, { componentType: nF <= 65535 ? 5123 : 5125, count: fIdx.length, type: "SCALAR" });
const accPos = push(fPos, 34962, { componentType: 5126, count: nF, type: "VEC3", ...minMax(fPos, 3) });
const accNrm = push(fNrm, 34962, { componentType: 5126, count: nF, type: "VEC3" });
const accUv = push(fUv, 34962, { componentType: 5126, count: nF, type: "VEC2" });
const accJnt = push(fJoints, 34962, { componentType: 5121, count: nF, type: "VEC4" });
const accWgt = push(fWeights, 34962, { componentType: 5121, normalized: true, count: nF, type: "VEC4" });
const accIbm = push(ibm, null, { componentType: 5126, count: bones.length, type: "MAT4" });
// Embedded baked atlas (RGBA png: rgb = albedo, a = team-recolor mask).
const pad = (4 - (byteLen % 4)) % 4;
if (pad) { chunks.push(Buffer.alloc(pad)); byteLen += pad; }
bufferViews.push({ buffer: 0, byteOffset: byteLen, byteLength: pngBuf.length });
chunks.push(pngBuf);
byteLen += pngBuf.length;
const imgBvIdx = bufferViews.length - 1;

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
  meshes: [{ name: "playerscan", primitives: [{ attributes: { POSITION: accPos, NORMAL: accNrm, TEXCOORD_0: accUv, JOINTS_0: accJnt, WEIGHTS_0: accWgt }, indices: accIdx, material: 0 }] }],
  images: [{ name: "playerscan", mimeType: "image/png", bufferView: imgBvIdx }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  textures: [{ source: 0, sampler: 0 }],
  // alphaMode stays OPAQUE: the texture's alpha channel is the recolor mask, not transparency.
  materials: [{ name: "playerscan", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
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
    pos: [...fPos], nrm: [...fNrm], uv: [...fUv], idx: [...fIdx], dom: [...dom],
    boneNames: bones.map((b) => b.name),
    bonePos: bones.map((b) => b.getWorldPosition(new THREE.Vector3()).toArray()),
  }));
  fs.writeFileSync("/tmp/rigqc/atlas.png", pngBuf);
  console.log("  QC dump → /tmp/rigqc/qc.json + atlas.png");
}
