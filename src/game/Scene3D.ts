import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { solveTwoBone } from "./anim/FootIK";
import { ANIM } from "./anim/tuning";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import type { CharacterAsset } from "./CharacterModel";
import { clamp, moveToward } from "../engine/math/Vec2";
import { STEP } from "../engine/Loop";
import { Field, FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD, type FieldBrand } from "./Field";
import type { TeamConfig } from "./Team";
import { drawIcon, type EmblemIcon } from "../ui/Emblems";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { TackleRagdoll } from "../physics/TackleRagdoll";

/** Units per field-pixel (1 yard = 1 world unit in 3D). */
const U = 1 / PX_PER_YARD;
const FIELD_LEN_U = FIELD_LENGTH * U;
const FIELD_WID_U = FIELD_WIDTH * U;

const MAX_PLAYERS = 14;

// --- physics ragdoll tackle tuning (mirrors the hybrid sandbox that proved it out) ---
const RAG_SETTLE_RESIDUAL = 0.8; // total body speed below which it counts as "calm"
const RAG_MIN_FALL = 0.5;        // don't check for calm until the fall is underway (s)
const RAG_CALM_NEEDED = 0.7;     // stay calm this long (incl. a beat lying there) before standing
const RAG_MAX_FALL = 6;          // safety: stand up even if it never fully settles (s)
const RAG_GETUP_DUR = 1.1;       // seconds to rise to standing
const _rgp = new THREE.Vector3();
const _rhip = new THREE.Vector3();
const _handPos = new THREE.Vector3();
// Scratch for the procedural QB throw (aim the arm bones each frame).
const _thA = new THREE.Vector3();
const _thB = new THREE.Vector3();
const _thDir = new THREE.Vector3();
const _thFwd = new THREE.Vector3();
const _thUp = new THREE.Vector3(0, 1, 0);
const _thRight = new THREE.Vector3();
const _thWind = new THREE.Vector3();
const _thRel = new THREE.Vector3();
const _thQ1 = new THREE.Quaternion();
const _thQ2 = new THREE.Quaternion();
const _thQ3 = new THREE.Quaternion();
// Foot-IK scratch (per-leg solve, reused across all avatars).
const _ikHip = new THREE.Vector3();
const _ikKnee = new THREE.Vector3();
const _ikAnkle = new THREE.Vector3();
const _ikToe = new THREE.Vector3();
const _ikTarget = new THREE.Vector3();
const _ikKneeOut = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
function ragEase(x: number): number { return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2; }
// Get-up stagger: legs/hips gather first, spine/head follow, arms swing in last.
function ragGetupDelay(name: string): number {
  if (/UpLeg|Leg|Foot|Toe|Hips/.test(name)) return 0;
  if (/Spine|Neck|Head/.test(name)) return 0.18;
  return 0.3;
}

/** Parameters for a physics tackle, in field (pixel) space; converted to world by Scene3D. */
export interface RagdollHit {
  hitDirX: number; hitDirY: number; // hit direction (carrier - tackler), field space
  closingPx: number;                // closing speed (px/s) -> hit strength
  carryVx: number; carryVy: number; // the player's own momentum (px/s), carried into the fall
  big: boolean;                     // a big hit blows the upper body up; else more low hits
  bit: number;                      // collision membership bit (distinct per body in a pile)
}

/** A swappable on-field player representation (box fallback or skinned FBX). */
interface Avatar {
  readonly group: THREE.Object3D;
  update(p: Player, jersey: number, trim: number, accent: number, helmet: number, decal: EmblemIcon | undefined, onFire: boolean, dt: number, isDefense: boolean): void;
  /** Apply the fixed-step interpolation: place the body between the last two sim
   * positions by `alpha` (0..1) so motion is smooth on any refresh rate. */
  present(alpha: number, dt: number): void;
  hide(): void;
  resetPose(): void;
  /** True while a physics ragdoll owns this body (falling or getting up). */
  ragdollActive(): boolean;
  /** Per physics substep while ragdolling: enforce soft joint limits. */
  applyRagdollLimits(dt: number): void;
  /** Once per sim tick after the world steps: drive bones + advance fall/get-up. */
  advanceRagdoll(dt: number): void;
  /** Hips position in field (pixel) space while ragdolling, for camera/spot tracking. */
  ragdollHipsPx(): { x: number; y: number } | null;
  /** Free per-instance GPU resources when this avatar is replaced (skinned avatars only). */
  dispose?(): void;
}

/**
 * Tracks the last two sim-step horizontal positions so the renderer can place a body
 * between them by the fixed-step alpha (smooth motion on any refresh rate). A fresh
 * push after a snap()/reset starts both samples equal so nothing slides across the field.
 */
class Interp {
  private px = 0;
  private pz = 0;
  private cx = 0;
  private cz = 0;
  private primed = false;

  /** Record this tick's target position (called once per sim step). */
  push(x: number, z: number): void {
    if (this.primed) {
      this.px = this.cx;
      this.pz = this.cz;
    } else {
      this.px = x;
      this.pz = z;
      this.primed = true;
    }
    this.cx = x;
    this.cz = z;
  }

  /** Snap both samples so the next frame doesn't interpolate from a stale spot. */
  reset(): void {
    this.primed = false;
  }

  x(alpha: number): number {
    return this.px + (this.cx - this.px) * alpha;
  }

  z(alpha: number): number {
    return this.pz + (this.cz - this.pz) * alpha;
  }
}

// Shared geometries (created once, reused by every avatar).
const G = {
  leg: new THREE.BoxGeometry(0.22, 0.82, 0.26),
  arm: new THREE.BoxGeometry(0.17, 0.6, 0.19),
  torso: new THREE.BoxGeometry(0.58, 0.72, 0.4),
  pads: new THREE.BoxGeometry(0.92, 0.3, 0.56),
  helmet: new THREE.SphereGeometry(0.27, 14, 12),
  mask: new THREE.BoxGeometry(0.06, 0.16, 0.34),
  ring: new THREE.TorusGeometry(0.98, 0.17, 8, 26),
  chevron: new THREE.ConeGeometry(0.42, 0.78, 4),
  nub: new THREE.SphereGeometry(0.17, 8, 6),
};

const SKIN = 0x8a5a3b;

/** An articulated, lightly-animated box avatar (fallback before the FBX loads). */
class BoxAvatar implements Avatar {
  readonly group = new THREE.Group();
  private readonly torsoMat: THREE.MeshStandardMaterial;
  private readonly padsMat: THREE.MeshStandardMaterial;
  private readonly helmetMat: THREE.MeshStandardMaterial;
  private readonly skinMat: THREE.MeshStandardMaterial;
  private skinTone = -1;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly upper: THREE.Group;
  private readonly ring: THREE.Mesh;
  private readonly chevron: THREE.Mesh;
  private readonly nub: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  private readonly interp = new Interp();

  constructor() {
    this.torsoMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    this.padsMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
    this.helmetMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.35, metalness: 0.1 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.8 });
    const skinMat = this.skinMat;

    // Legs (swing from the hips).
    this.legL = this.limb(G.leg, this.torsoMat, -0.16, 0.82, 0.41);
    this.legR = this.limb(G.leg, this.torsoMat, 0.16, 0.82, 0.41);

    // Upper body group (torso, pads, helmet, arms) so it can lean as one.
    this.upper = new THREE.Group();
    const torso = mesh(G.torso, this.torsoMat, 0, 1.12, 0);
    const pads = mesh(G.pads, this.padsMat, 0, 1.52, 0);
    const helmet = mesh(G.helmet, this.helmetMat, 0, 1.84, 0.02);
    const mask = mesh(G.mask, skinMat, 0, 1.8, 0.24);
    this.armL = this.limb(G.arm, skinMat, -0.5, 1.5, 0.31);
    this.armR = this.limb(G.arm, skinMat, 0.5, 1.5, 0.31);
    this.upper.add(torso, pads, helmet, mask, this.armL, this.armR);

    // Selection ring + bobbing chevron + ball nub.
    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.visible = false;
    this.chevron = new THREE.Mesh(G.chevron, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.chevron.rotation.x = Math.PI;
    this.chevron.position.y = 2.6;
    this.chevron.visible = false;
    this.nub = new THREE.Mesh(G.nub, new THREE.MeshStandardMaterial({ color: 0x7a3b12, roughness: 0.7 }));
    this.nub.position.set(0.55, 1.2, 0.1);
    this.nub.visible = false;

    this.group.add(this.legL, this.legR, this.upper, this.ring, this.chevron, this.nub);
    this.group.scale.setScalar(0.9);
  }

  /** A limb pivoting at a joint (mesh hangs below the joint group). */
  private limb(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, half: number): THREE.Group {
    const joint = new THREE.Group();
    joint.position.set(x, y, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -half;
    m.castShadow = true;
    joint.add(m);
    return joint;
  }

  update(p: Player, jersey: number, _trim: number, _accent: number, helmet: number, _decal: EmblemIcon | undefined, onFire: boolean, dt: number, _isDefense: boolean): void {
    const g = this.group;
    g.visible = true;
    this.interp.push(p.pos.x * U, p.pos.y * U); // horizontal position interpolated in present()

    const speed = Math.hypot(p.vel.x, p.vel.y);
    const moving = Math.min(1, speed / 150);

    if (p.isDown) {
      // Collapse + tip over when tackled.
      g.rotation.set(-Math.PI / 2.2, -p.facing, 0);
      g.position.y = 0.3;
      this.ring.visible = false;
      this.chevron.visible = false;
    } else {
      g.position.y = 0;
      // Face velocity; idle players keep their last facing.
      if (speed > 8) g.rotation.set(0, Math.atan2(p.vel.x, p.vel.y), 0);
      else g.rotation.set(0, Math.atan2(Math.cos(p.facing), Math.sin(p.facing)), 0);

      // Animate stride: exaggerated arm pump + leg swing, scaled by speed.
      this.phase += dt * (4 + moving * 14);
      const sw = Math.sin(this.phase) * (0.25 + moving * 0.85);
      this.legL.rotation.x = sw;
      this.legR.rotation.x = -sw;
      this.armL.rotation.x = -sw * 1.1;
      this.armR.rotation.x = sw * 1.1;
      // Forward lean proportional to speed.
      this.upper.rotation.x = -moving * 0.32;

      this.ring.visible = p.controlled;
      this.chevron.visible = p.controlled;
      if (p.controlled) this.chevron.position.y = 2.6 + Math.sin(this.phase * 0.6) * 0.12;
    }

    this.torsoMat.color.setHex(jersey);
    this.padsMat.color.setHex(jersey);
    this.helmetMat.color.setHex(helmet);
    const tone = skinToneFor(p.number);
    if (tone !== this.skinTone) { this.skinTone = tone; this.skinMat.color.setHex(tone); }
    if (onFire) {
      this.torsoMat.emissive.setHex(0xff5a1e);
      this.torsoMat.emissiveIntensity = 0.3;
      this.padsMat.emissive.setHex(0xff5a1e);
      this.padsMat.emissiveIntensity = 0.3;
    } else {
      this.torsoMat.emissiveIntensity = 0;
      this.padsMat.emissiveIntensity = 0;
    }
    this.nub.visible = p.hasBall && !p.isDown;
  }

  present(alpha: number, _dt: number): void {
    this.group.position.x = this.interp.x(alpha);
    this.group.position.z = this.interp.z(alpha);
  }

  hide(): void {
    this.group.visible = false;
    this.interp.reset();
  }

  resetPose(): void {
    this.group.scale.set(1, 1, 1);
    this.group.rotation.set(0, 0, 0);
    this.group.position.y = 0;
    this.interp.reset();
  }

  // The box fallback has no skeleton, so it never ragdolls.
  ragdollActive(): boolean { return false; }
  applyRagdollLimits(): void {}
  advanceRagdoll(): void {}
  ragdollHipsPx(): null { return null; }
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Facing offset so the model's front points along its movement direction. */
const MODEL_FORWARD = 0;

// Render-side feel constants.
const TURN_RATE_RAD = 14; // rendered yaw slew (rad/s), scaled by speed
// Foot-plant warps: timeScale = speed(px/s) * K, calibrated from each clip's measured
// authored stride speed so the feet grip the ground (no skating) at any pace.
const FOOT_PLANT_K = 0.0109; // run clip strides ~4.6 yd/s (eased ~20% for a calmer stride)
const WALK_PLANT_K = 0.0369; // walk clip strides ~1.7 yd/s
const BACK_PLANT_K = 0.0194; // backpedal clip ~3.2 yd/s
const STRAFE_PLANT_K = 0.0163; // strafe clip ~3.8 yd/s
const IDLE_OUT = 0.06; // speed01 below this is idle
const MOVE_FULL = 0.18; // speed01 above this is fully in locomotion (idle faded out)
// Procedural-locomotion tuning (accel lean, hip motion, foot IK) lives in one mutable object so the
// in-game DEBUG panel can adjust it live — see src/game/anim/tuning.ts. Read as ANIM.* below.
/** Fraction into the stance clip held for a neutral/idle player: a relaxed UPRIGHT stand
 *  (the clip ends in a deep 3-point crouch, which looks wrong for players just milling). */
const IDLE_POSE = 0.13;
const WALK_TO_RUN_LO = 0.3; // below this, forward motion is the walk cycle
const WALK_TO_RUN_HI = 0.6; // above this, forward motion is the run cycle

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
/** Convert a standard heading (atan2(y,x)) to the model's yaw convention. */
const THROW_DUR = 0.5; // seconds of the procedural QB throw motion
function toModelYaw(h: number): number {
  return Math.atan2(Math.cos(h), Math.sin(h));
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** A soft radial-gradient sprite for additive motes/glows. Cached after first build. */
let _moteTex: THREE.Texture | null = null;
function makeMoteTexture(): THREE.Texture {
  if (_moteTex) return _moteTex;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,240,210,0.7)");
  g.addColorStop(1, "rgba(255,230,180,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  _moteTex = new THREE.CanvasTexture(c);
  return _moteTex;
}
/** A soft dark blob for a fake contact shadow under a player (grounds them even outside the
 *  cast-shadow frustum). Cached. */
let _blobTex: THREE.Texture | null = null;
function makeBlobTexture(): THREE.Texture {
  if (_blobTex) return _blobTex;
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(24, 24, 0, 24, 24, 24);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.6, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 48, 48);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}
// ---- Procedural team jersey skins ----
// `body_low` carries the whole uniform on a full 0..1 UV unwrap: front torso lives at U .125-.375,
// the back at U .625-.875 (centerlines at .25 / .75), the four shoulder/sleeve caps sit in the
// edge columns at high V, and the pants fill the lower V band with the shoes at the very bottom.
// We paint a jersey in that layout — base color, white shoulder yoke, accent collar V + sleeve
// stripes, and an outlined player number front & back — then cache it per (jersey,accent,number).
const _jerseyCache = new Map<string, THREE.CanvasTexture>();
function hexCss(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}
function shade(n: number, f: number): string {
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return `#${((m(r) << 16) | (m(g) << 8) | m(b)).toString(16).padStart(6, "0")}`;
}
/** Relative luminance 0..1 of a packed RGB color (for picking readable fills on light vs dark kit). */
function lum(n: number): number {
  return (0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)) / 255;
}
/** Realistic skin-tone palette (light → deep) so a roster isn't 22 clones of one complexion. */
const SKIN_TONES = [0xf2cda0, 0xe3b48a, 0xcd935f, 0xb07a47, 0x946239, 0x70492a, 0x4f3320];
/** Pick a stable skin tone for a player from their number (distinct numbers spread the roster). */
function skinToneFor(num: number): number {
  return SKIN_TONES[((num * 2654435761) >>> 0) % SKIN_TONES.length];
}
/** A stable uniform "cut" per team color so teams differ in pattern, not just hue (the channel sum
 *  spreads the stock palette evenly across all four cuts). */
function jerseyStyleOf(jersey: number): number {
  return (((jersey >> 16) & 0xff) + ((jersey >> 8) & 0xff) + (jersey & 0xff)) % 4;
}

function jerseyTexture(jersey: number, accent: number, trim: number, num: number): THREE.CanvasTexture {
  const style = jerseyStyleOf(jersey);
  const key = `${jersey.toString(16)}-${accent.toString(16)}-${trim.toString(16)}-${num}-${style}`;
  const cached = _jerseyCache.get(key);
  if (cached) return cached;
  const lightBase = lum(jersey) > 0.6; // a white/road jersey needs dark, team-colored decoration
  const base = hexCss(jersey), acc = hexCss(accent), light = "#f4f4ee";
  const ink = lightBase ? acc : light;             // readable fill for yoke / stripe-mid / numbers
  const numOutline = lightBase ? "#0a0a0a" : acc;  // crisp edge around team-colored numbers on white
  const pants = hexCss(trim), dark = shade(jersey, -0.5);
  const S = 512, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  const Y = (v: number) => (1 - v) * S, U2 = (u: number) => u * S;
  x.fillStyle = base; x.fillRect(0, 0, S, S);

  // Fabric depth: a soft top-lit vertical sheen + a faint woven speckle so the cloth isn't dead flat.
  const grd = x.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, "rgba(255,255,255,0.10)");
  grd.addColorStop(0.45, "rgba(0,0,0,0)");
  grd.addColorStop(1, "rgba(0,0,0,0.22)");
  x.fillStyle = grd; x.fillRect(0, 0, S, S);
  x.globalAlpha = 0.05;
  for (let i = 0; i < 1600; i++) {
    x.fillStyle = i & 1 ? "#000" : "#fff";
    x.fillRect((Math.random() * S) | 0, (Math.random() * S) | 0, 2, 2);
  }
  x.globalAlpha = 1;

  // pants (lower V) + shoes, with an accent hip stripe at the waist
  x.fillStyle = pants; x.fillRect(0, Y(0.46), S, S - Y(0.46));
  x.fillStyle = "#15151a"; x.fillRect(0, Y(0.07), S, S - Y(0.07));
  x.fillStyle = acc; x.fillRect(0, Y(0.44), S, 5);

  // --- torso "cut": each team gets one of four distinct uniform patterns -------------------------
  const torsoCols = [0.125, 0.625]; // left edge of front / back torso columns (each .25 wide)
  const vTop = 0.92, vWaist = 0.46;
  const colW = U2(0.25), colH = Y(vWaist) - Y(vTop);
  for (const u0 of torsoCols) {
    const px = U2(u0), py = Y(vTop);
    if (style === 1) {
      // Bold twin chest stripes flanking the number.
      const sw = colW * 0.1;
      x.fillStyle = acc;
      x.fillRect(px + colW * 0.1, py, sw, colH);
      x.fillRect(px + colW * 0.8, py, sw, colH);
      x.fillStyle = ink;
      x.fillRect(px + colW * 0.1 + sw, py, sw * 0.35, colH);
      x.fillRect(px + colW * 0.8 - sw * 0.35, py, sw * 0.35, colH);
    } else if (style === 2) {
      // Contrast side panels down the torso edges.
      x.fillStyle = acc;
      x.fillRect(px, py, colW * 0.13, colH);
      x.fillRect(px + colW * 0.87, py, colW * 0.13, colH);
      x.fillStyle = dark;
      x.fillRect(px + colW * 0.13, py, colW * 0.03, colH);
      x.fillRect(px + colW * 0.84, py, colW * 0.03, colH);
    } else if (style === 3) {
      // Diagonal sash across the chest (clipped to the torso column).
      x.save();
      x.beginPath(); x.rect(px, py, colW, colH); x.clip();
      x.strokeStyle = acc; x.lineWidth = colW * 0.2;
      x.beginPath(); x.moveTo(px - 12, Y(0.56)); x.lineTo(px + colW + 12, Y(0.86)); x.stroke();
      x.strokeStyle = ink; x.lineWidth = colW * 0.05;
      x.beginPath(); x.moveTo(px - 12, Y(0.54)); x.lineTo(px + colW + 12, Y(0.84)); x.stroke();
      x.restore();
    } else {
      // Classic: shoulder yoke band + accent collar V.
      x.fillStyle = ink; x.fillRect(px, Y(0.84), colW, 9);
    }
  }

  // sleeve stripes (accent / white / accent) + a solid accent cuff at the sleeve end
  for (const [u0, u1] of [[0, 0.125], [0.375, 0.5], [0.5, 0.625], [0.875, 1.0]]) {
    const bands: [number, string][] = [[0.90, acc], [0.865, ink], [0.83, acc]];
    for (const [v, col] of bands) { x.fillStyle = col; x.fillRect(U2(u0), Y(v), U2(u1 - u0), 9); }
    x.fillStyle = acc; x.fillRect(U2(u0), Y(0.99), U2(u1 - u0), Y(0.93) - Y(0.99)); // cuff
  }

  // accent collar V (front & back torso) for every cut
  x.strokeStyle = acc; x.lineWidth = 7;
  for (const cx of [0.25, 0.75]) {
    x.beginPath(); x.moveTo(U2(cx - 0.05), Y(0.86)); x.lineTo(U2(cx), Y(0.80)); x.lineTo(U2(cx + 0.05), Y(0.86)); x.stroke();
  }

  // chest/back number — white with an accent outline and a soft drop shadow for legibility
  const label = String(num);
  for (const cx of [0.25, 0.75]) {
    x.save();
    x.translate(U2(cx), Y(0.63));
    x.textAlign = "center"; x.textBaseline = "middle";
    x.font = "900 78px Arial Narrow, Arial, sans-serif";
    x.shadowColor = "rgba(0,0,0,0.45)"; x.shadowBlur = 6; x.shadowOffsetY = 3;
    x.lineWidth = 7; x.strokeStyle = numOutline; x.strokeText(label, 0, 0);
    x.shadowColor = "transparent";
    x.fillStyle = ink; x.fillText(label, 0, 0);
    x.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _jerseyCache.set(key, tex);
  return tex;
}

// ---- Procedural helmet skins ----
// The helmet mesh ("Helmet_low") unwraps into the canvas region u[0..0.67] v[0..0.45]; with the
// default flipY texture that island lives in the lower-left (canvas y 0.55..1, x 0..0.67). We paint
// the shell color there, a front-to-back center stripe (accent between white pinstripes), and a
// team decal on each side, then cache per (helmet,accent,decal).
const _helmetCache = new Map<string, THREE.CanvasTexture>();
function helmetTexture(helmet: number, accent: number, decal?: EmblemIcon): THREE.CanvasTexture {
  const key = `${helmet.toString(16)}-${accent.toString(16)}-${decal ?? "none"}`;
  const cached = _helmetCache.get(key);
  if (cached) return cached;
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  const shell = hexCss(helmet), acc = hexCss(accent);
  x.fillStyle = shell; x.fillRect(0, 0, S, S);
  // UV island bounds in canvas space (v flipped).
  const u = (uu: number) => uu * S, vY = (vv: number) => (1 - vv) * S;
  const yTop = vY(0.45), yBot = vY(0); // island spans these canvas rows
  // Subtle top sheen on the shell for a glossy finish.
  const g = x.createLinearGradient(0, yTop, 0, yBot);
  g.addColorStop(0, "rgba(255,255,255,0.16)"); g.addColorStop(0.5, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.22)");
  x.fillStyle = g; x.fillRect(0, yTop, u(0.67), yBot - yTop);
  // Crown stripe: the dome unwraps so a constant-v band wraps the shell front-to-back over the top
  // (verified against a UV probe). White pinstripes flank a bold accent center.
  const by = vY(0.40), bh = S * 0.045; // high-v = crown of the helmet
  x.fillStyle = "#f4f4ee"; x.fillRect(0, by - bh * 1.2, u(0.67), bh * 2.4);
  x.fillStyle = acc; x.fillRect(0, by - bh * 0.55, u(0.67), bh * 1.1);
  // Team decal on the side panel. The helmet's two sides share one mirrored UV island centered at
  // ~(0.21, 0.11) (measured from the mesh geometry), so a single stamp shows on BOTH sides. On a
  // light shell use a dark decal (the accent may itself be light, e.g. silver-on-silver); on a dark
  // shell the bright accent pops.
  if (decal) {
    const decalColor = lum(helmet) > 0.55 ? "#15171c" : acc;
    drawIcon(x, u(0.21), vY(0.11), S * 0.07, decal, decalColor);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _helmetCache.set(key, tex);
  return tex;
}

/** Lerp an action's weight toward a target (~0.12s to fully change) for smooth crossfades. */
function blendW(a: THREE.AnimationAction | null, target: number, dt: number): void {
  if (!a) return;
  a.setEffectiveWeight(moveToward(a.getEffectiveWeight(), target, dt / 0.16));
}

/** A skinned, animated player using the rigged model's own textured uniform. */
class FbxAvatar implements Avatar {
  readonly group = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly idleAction: THREE.AnimationAction | null;
  private readonly runAction: THREE.AnimationAction | null;
  private readonly backAction: THREE.AnimationAction | null;
  private readonly strafeAction: THREE.AnimationAction | null;
  private readonly walkAction: THREE.AnimationAction | null;
  private readonly passAction: THREE.AnimationAction | null;
  private readonly catchAction: THREE.AnimationAction | null;
  private readonly jukeAction: THREE.AnimationAction | null;
  private readonly tackleAction: THREE.AnimationAction | null;
  private readonly spinAction: THREE.AnimationAction | null;
  private readonly defTackleAction: THREE.AnimationAction | null;
  private readonly defSwatAction: THREE.AnimationAction | null;
  private readonly celebrateAction: THREE.AnimationAction | null;
  private oneShot: THREE.AnimationAction | null = null;
  private oneShotTime = 0;
  private oneShotDur = 0;
  /** Jersey/pants mesh material(s) — get the procedural team-jersey skin texture. */
  private readonly jerseyMats: THREE.MeshStandardMaterial[] = [];
  /** Helmet material(s) — get the dark trim color. */
  private readonly helmetMats: THREE.MeshStandardMaterial[] = [];
  /** Face/arms material(s) — held at a neutral skin tone. */
  private readonly skinMats: THREE.MeshStandardMaterial[] = [];
  /** Cache key of the jersey texture currently applied, so we only swap it when it changes. */
  private jerseyKey = "";
  /** Skin tone currently applied to the face/arms, so we only re-tint when the player changes. */
  private skinTone = -1;
  /** Cache key of the helmet skin currently applied (shell + stripe + decal). */
  private helmetKey = "";
  private readonly lean = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly chevron: THREE.Mesh;
  private readonly nub: THREE.Mesh;
  private readonly blob: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  /** Per-player phase so idle breathing isn't synchronized across the team. */
  private readonly breatheOffset = Math.random() * Math.PI * 2;
  /** Rendered yaw (slewed toward the target heading for smooth turning). */
  private yaw = 0;
  /** Fall progress 0 (upright) .. 1 (flat), lerped for a non-instant tackle. */
  private fallT = 0;
  /** Smoothed body bank (roll) into turns/cuts, so direction changes read as a lean. */
  private bankSmooth = 0;
  private readonly interp = new Interp();

  // --- physics ragdoll tackle (replaces the canned tackle clip when a hit lands) ---
  private readonly inner: THREE.Object3D;
  /** Procedural QB throw: time remaining + the heading locked at release. */
  private throwT = 0;
  private throwHeading = 0;
  /** Bind-pose local transforms, the target the get-up blends back to. */
  private readonly restPose = new Map<THREE.Bone, { p: THREE.Vector3; q: THREE.Quaternion }>();
  private ragdoll: TackleRagdoll | null = null;
  private rPhase: "anim" | "fall" | "getup" = "anim";
  private fallTime = 0;
  private settleTimer = 0;
  private getupT = 0;
  private readonly getupFrom = new Map<THREE.Bone, { p: THREE.Vector3; q: THREE.Quaternion }>();
  /** After get-up, stay standing (ignore the down/contact fall pose) until the next play. */
  private suppressFall = false;
  /** Cached leg chains + measured bone lengths for foot IK (null if the rig lacks the bones). */
  private legIK: { hip: THREE.Bone; knee: THREE.Bone; ankle: THREE.Bone; toe: THREE.Bone | null; l1: number; l2: number }[] | null = null;

  constructor(asset: CharacterAsset) {
    const inner = skeletonClone(asset.template);
    inner.scale.setScalar(asset.scale);
    inner.position.y = asset.groundOffset * asset.scale;
    // Clone the model's materials per-avatar so each can be tinted independently. The mesh names
    // tell us what's what: `body_low` is the jersey+pants (a full 0..1 UV unwrap → we paint a
    // procedural team jersey skin onto it), the helmet mesh takes the dark trim color, and the
    // face/arms keep a natural skin tone.
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const isJersey = /body/i.test(m.name);
      const isHelmet = /helmet/i.test(m.name);
      const apply = (mat: THREE.Material): THREE.Material => {
        const clone = mat.clone() as THREE.MeshStandardMaterial;
        if (isJersey) this.jerseyMats.push(clone);
        else if (isHelmet) this.helmetMats.push(clone);
        else { clone.color.setHex(SKIN); this.skinMats.push(clone); }
        return clone;
      };
      m.material = Array.isArray(m.material) ? m.material.map(apply) : apply(m.material);
    });
    // Fallback: if mesh names didn't separate cleanly, treat everything as jersey so the team
    // color still applies (better a flat-tinted player than an untinted gray one).
    if (this.jerseyMats.length === 0) {
      inner.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !Array.isArray(m.material)) this.jerseyMats.push(m.material as THREE.MeshStandardMaterial);
      });
    }

    this.mixer = new THREE.AnimationMixer(inner);
    const clips = asset.clips;
    this.idleAction = clips.idle ? this.mixer.clipAction(clips.idle) : null;
    this.runAction = clips.run ? this.mixer.clipAction(clips.run) : null;
    this.backAction = clips.runBack ? this.mixer.clipAction(clips.runBack) : null;
    this.strafeAction = clips.strafe ? this.mixer.clipAction(clips.strafe) : null;
    this.walkAction = clips.walk ? this.mixer.clipAction(clips.walk) : null;
    this.passAction = clips.pass ? this.mixer.clipAction(clips.pass) : null;
    this.catchAction = clips.catch ? this.mixer.clipAction(clips.catch) : null;
    this.jukeAction = clips.juke ? this.mixer.clipAction(clips.juke) : null;
    this.tackleAction = clips.tackle ? this.mixer.clipAction(clips.tackle) : null;
    this.spinAction = clips.spin ? this.mixer.clipAction(clips.spin) : null;
    this.defTackleAction = clips.defTackle ? this.mixer.clipAction(clips.defTackle) : null;
    this.defSwatAction = clips.defSwat ? this.mixer.clipAction(clips.defSwat) : null;
    this.celebrateAction = clips.celebrate ? this.mixer.clipAction(clips.celebrate) : null;
    for (const a of [this.runAction, this.backAction, this.strafeAction, this.walkAction]) {
      a?.setLoop(THREE.LoopRepeat, Infinity);
      a?.play();
      a?.setEffectiveWeight(0);
    }
    for (const a of [this.passAction, this.catchAction, this.jukeAction, this.tackleAction, this.spinAction, this.defTackleAction, this.defSwatAction, this.celebrateAction]) {
      a?.setLoop(THREE.LoopOnce, 1);
      if (a) a.clampWhenFinished = true;
    }
    // Neutral/idle players hold a relaxed UPRIGHT stand, not the deep 3-point crouch the clip
    // ends on — freeze the clip early (IDLE_POSE) where the body is standing.
    if (this.idleAction) {
      this.idleAction.play();
      this.idleAction.paused = true;
      this.idleAction.time = IDLE_POSE * (this.idleAction.getClip().duration || 1);
      this.idleAction.setEffectiveWeight(0);
    }
    (this.idleAction ?? this.runAction)?.setEffectiveWeight(1);

    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.visible = false;
    this.chevron = new THREE.Mesh(G.chevron, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.chevron.rotation.x = Math.PI;
    this.chevron.position.y = 2.8;
    this.chevron.visible = false;
    this.nub = new THREE.Mesh(G.nub, new THREE.MeshStandardMaterial({ color: 0x7a3b12, roughness: 0.7 }));
    this.nub.scale.set(1.5, 1, 1);
    this.nub.position.set(0.26, 1.22, 0.12); // tucked against the torso on the carry side
    this.nub.visible = false;

    // Soft fake contact shadow so players read as planted even outside the cast-shadow frustum.
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 1.7),
      new THREE.MeshBasicMaterial({ map: makeBlobTexture(), transparent: true, depthWrite: false, opacity: 0.75 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.02;
    this.blob.renderOrder = -1;

    // The lean group banks/leans the body; the holder group only yaws + positions,
    // so the ground ring / chevron / ball stay upright.
    this.lean.add(inner);
    this.group.add(this.lean, this.ring, this.chevron, this.nub, this.blob);

    // Snapshot the bind pose now (before the mixer ever runs) — the get-up blends back to it.
    this.inner = inner;
    inner.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.restPose.set(o as THREE.Bone, { p: o.position.clone(), q: o.quaternion.clone() });
    });
    this.setupFootIK();
  }

  /** Cache each leg's hip/knee/ankle/toe bones and measure the (rigid) thigh + shin lengths from
   *  the bind pose, so foot IK can run allocation-free each frame. */
  private setupFootIK(): void {
    this.inner.updateWorldMatrix(true, true);
    const legs: NonNullable<typeof this.legIK> = [];
    for (const side of ["Left", "Right"] as const) {
      const hip = this.bone(side + "UpLeg");
      const knee = this.bone(side + "Leg");
      const ankle = this.bone(side + "Foot");
      if (!hip || !knee || !ankle) continue;
      hip.getWorldPosition(_ikHip);
      knee.getWorldPosition(_ikKnee);
      ankle.getWorldPosition(_ikAnkle);
      legs.push({ hip, knee, ankle, toe: this.bone(side + "ToeBase"), l1: _ikHip.distanceTo(_ikKnee), l2: _ikKnee.distanceTo(_ikAnkle) });
    }
    this.legIK = legs.length ? legs : null;
  }

  /**
   * Ground-adhesion foot IK — run after the mixer poses the skeleton (in present()). For each leg,
   * when the foot is low (planted) pull the ankle straight down so its lowest contact point meets
   * the ground plane (y=0), killing the floaty hover; two-bone IK keeps the leg rigid and the knee
   * bending the way the clip already poses it. Swing (lifted) feet fade out untouched. Vertical only
   * — no horizontal plant-locking yet — to stay conservative.
   */
  private applyFootIK(): void {
    const legs = this.legIK;
    if (!legs) return;
    for (const leg of legs) {
      leg.hip.getWorldPosition(_ikHip);
      leg.knee.getWorldPosition(_ikKnee);
      leg.ankle.getWorldPosition(_ikAnkle);
      let soleY = _ikAnkle.y;
      if (leg.toe) { leg.toe.getWorldPosition(_ikToe); soleY = Math.min(soleY, _ikToe.y); }
      const plant = 1 - smoothstep(ANIM.FOOT_PLANT_LO, ANIM.FOOT_PLANT_HI, soleY);
      if (plant <= 0.001) continue;
      _ikTarget.copy(_ikAnkle);
      _ikTarget.y = _ikAnkle.y - soleY * plant * ANIM.FOOT_IK_WEIGHT; // drop so the sole reaches y=0
      solveTwoBone(_ikHip, _ikKnee, _ikTarget, leg.l1, leg.l2, _ikKneeOut);
      _ikDir.subVectors(_ikKneeOut, _ikHip).normalize();
      this.aimBone(leg.hip, leg.knee, _ikDir, 1);
      leg.knee.getWorldPosition(_ikKnee); // refreshed by aimBone's updateWorldMatrix
      _ikDir.subVectors(_ikTarget, _ikKnee).normalize();
      this.aimBone(leg.knee, leg.ankle, _ikDir, 1);
    }
  }

  /**
   * Free this avatar's per-instance GPU resources. Called when the character is rebuilt (the rig →
   * locomotion → full-clip upgrade swaps the whole avatar pool a couple of times). Skinned geometry
   * and the cached jersey textures are SHARED (skeleton clone / texture cache), so we only release
   * the per-avatar cloned materials + mixer bindings — otherwise repeated rebuilds leak GPU memory,
   * which is exactly what tips a phone over into failed loads.
   */
  dispose(): void {
    if (this.ragdoll?.active) this.ragdoll.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inner);
    for (const m of this.jerseyMats) m.dispose();
    for (const m of this.helmetMats) m.dispose();
    for (const m of this.skinMats) m.dispose();
    (this.ring.material as THREE.Material).dispose();
    (this.chevron.material as THREE.Material).dispose();
    (this.nub.material as THREE.Material).dispose();
    (this.blob.material as THREE.Material).dispose();
    this.blob.geometry.dispose();
  }

  // --- physics ragdoll lifecycle ----------------------------------------------------------
  ragdollActive(): boolean { return this.rPhase !== "anim"; }

  /** Snapshot the current animated pose and hand the body to physics for a real tackle fall. */
  startRagdoll(physics: PhysicsWorld, carry: THREE.Vector3, hitDir: THREE.Vector3, hitSpeed: number, hitLow: boolean, bit: number): void {
    if (!this.ragdoll) { this.ragdoll = new TackleRagdoll(physics); this.ragdoll.bind(this.inner); }
    this.group.updateWorldMatrix(true, true); // freeze the live pose in world space
    this.group.position.y = 0;                 // so the get-up later stands with feet on the ground
    this.ragdoll.spawn(carry, hitDir, hitSpeed, hitLow, bit);
    this.rPhase = "fall"; this.fallTime = 0; this.settleTimer = 0; this.suppressFall = false;
    this.ring.visible = false; this.chevron.visible = false; this.nub.visible = false;
  }

  applyRagdollLimits(dt: number): void { this.ragdoll?.applyLimits(dt); }

  advanceRagdoll(dt: number): void {
    if (!this.ragdoll) return;
    if (this.rPhase === "fall") {
      this.ragdoll.drive(); // bodies drive the skinned-mesh bones in world space
      this.fallTime += dt;
      if (this.fallTime > RAG_MIN_FALL && this.ragdoll.residualMotion() < RAG_SETTLE_RESIDUAL) this.settleTimer += dt;
      else this.settleTimer = 0;
      if (this.settleTimer > RAG_CALM_NEEDED || this.fallTime > RAG_MAX_FALL) this.startGetup();
    } else if (this.rPhase === "getup") {
      this.getupT += dt / RAG_GETUP_DUR;
      this.blendGetup(Math.min(1, this.getupT));
      if (this.getupT >= 1) this.finishGetup();
    }
  }

  ragdollHipsPx(): { x: number; y: number } | null {
    if (this.rPhase === "anim") return null;
    const h = this.bone("Hips");
    if (!h) return null;
    h.getWorldPosition(_rhip);
    return { x: _rhip.x / U, y: _rhip.z / U };
  }

  /** Find a bone instance by short (mixamorig-stripped) name within this avatar. */
  private bone(short: string): THREE.Bone | null {
    let found: THREE.Bone | null = null;
    this.inner.traverse((o) => { if (!found && (o as THREE.Bone).isBone && o.name === "mixamorig" + short) found = o as THREE.Bone; });
    return found;
  }

  /**
   * Procedural throwing motion, applied on top of the mixer pose. Aims the right upper-arm and
   * forearm bones through an over-the-top arc: wind up (arm cocked up/back), whip forward, follow
   * through — blending in/out so it crossfades with locomotion. `p` is 0..1 through the throw.
   */
  private applyThrow(p: number): void {
    const arm = this.bone("RightArm");
    const fore = this.bone("RightForeArm");
    const hand = this.bone("RightHand");
    if (!arm || !fore) return;
    const h = this.throwHeading;
    _thFwd.set(Math.cos(h), 0, Math.sin(h));          // character's world forward
    _thRight.copy(_thFwd).cross(_thUp).normalize();    // their right side
    // Wind-up: arm up and slightly back/out. Release: arm forward and down (whip).
    _thWind.copy(_thUp).multiplyScalar(0.95).addScaledVector(_thFwd, -0.15).addScaledVector(_thRight, 0.25).normalize();
    _thRel.copy(_thFwd).multiplyScalar(0.95).addScaledVector(_thUp, -0.2).addScaledVector(_thRight, 0.05).normalize();
    const t = smoothstep(0.22, 0.62, p); // wind -> release
    _thDir.copy(_thWind).lerp(_thRel, t).normalize();
    const weight = Math.max(0, Math.min(1, Math.min(p / 0.12, (1 - p) / 0.18)));
    this.aimBone(arm, fore, _thDir, weight);
    // The forearm leads slightly forward of the upper arm on release (the whip).
    _thDir.lerp(_thRel, 0.35 * t).normalize();
    this.aimBone(fore, hand ?? fore, _thDir, weight * 0.9);
  }

  /** Rotate `bone` so its down-the-bone direction (toward `child`) points at `targetDir` (world),
   *  blended by `weight`. Leaves the result as the bone's local quaternion. */
  private aimBone(bone: THREE.Bone, child: THREE.Object3D, targetDir: THREE.Vector3, weight: number): void {
    bone.getWorldPosition(_thA);
    child.getWorldPosition(_thB);
    _thB.sub(_thA);
    if (_thB.lengthSq() < 1e-8) return;
    _thB.normalize();
    _thQ1.setFromUnitVectors(_thB, targetDir);   // align current bone dir -> target
    bone.getWorldQuaternion(_thQ2);
    _thQ3.copy(_thQ1).multiply(_thQ2);           // desired world quat
    _thQ2.slerp(_thQ3, weight);                   // blend
    (bone.parent as THREE.Object3D).getWorldQuaternion(_thQ1);
    bone.quaternion.copy(_thQ1.invert().multiply(_thQ2));
    bone.updateWorldMatrix(false, true);          // refresh so the next aim reads fresh child pos
  }

  private startGetup(): void {
    this.getupFrom.clear();
    for (const [bone] of this.restPose) this.getupFrom.set(bone, { p: bone.position.clone(), q: bone.quaternion.clone() });
    this.ragdoll!.dispose(); // hand off from physics to the procedural stand-up blend
    this.rPhase = "getup"; this.getupT = 0;
  }

  private blendGetup(t: number): void {
    for (const [bone, from] of this.getupFrom) {
      const to = this.restPose.get(bone)!;
      const d = ragGetupDelay(bone.name);
      const e = ragEase(clamp((t - d) / (1 - d), 0, 1));
      bone.quaternion.copy(from.q).slerp(to.q, e);
      if (bone.name.endsWith("Hips")) {
        // Stand up where the body settled: keep the fallen X/Z, raise Y to standing height.
        _rgp.set(from.p.x, THREE.MathUtils.lerp(from.p.y, to.p.y, ragEase(t)), from.p.z);
        bone.position.copy(_rgp);
      } else {
        bone.position.lerpVectors(from.p, to.p, e);
      }
    }
    this.inner.updateWorldMatrix(true, true);
  }

  /** Reconcile back to the game's convention (body placed by the group, bones at rest) so the
   *  idle animation can resume seamlessly: move the group to where the body stood up. */
  private finishGetup(): void {
    const h = this.bone("Hips");
    if (h) h.getWorldPosition(_rhip); else _rhip.set(this.group.position.x, 0, this.group.position.z);
    for (const [bone, r] of this.restPose) { bone.position.copy(r.p); bone.quaternion.copy(r.q); }
    this.group.position.set(_rhip.x, 0, _rhip.z);
    this.interp.reset();
    this.interp.push(_rhip.x, _rhip.z); // prime so present() doesn't slide from a stale spot
    this.rPhase = "anim";
    this.suppressFall = true; // remain standing until the next play resets us
  }


  /**
   * Play a one-shot overlay, capping how long it ducks locomotion (clips can be long).
   * `rate` speeds up playback and `startAt` skips into the clip (e.g. to land on the
   * plant of a long change-of-direction clip rather than its run-in).
   */
  private triggerOneShot(
    action: THREE.AnimationAction | null,
    maxDur: number,
    rate = 1,
    startAt = 0,
  ): void {
    if (!action) return;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(rate);
    action.time = startAt;
    action.play();
    this.oneShot = action;
    this.oneShotTime = 0;
    // oneShotTime advances in real seconds; the clip runs `rate`x faster.
    this.oneShotDur = Math.min((action.getClip().duration - startAt) / rate, maxDur);
  }

  /** Reset to an upright, neutral pose for a fresh play (pooled avatars are reused). */
  resetPose(): void {
    // Tear down any ragdoll and restore the bind pose so the new play starts clean.
    if (this.ragdoll?.active) this.ragdoll.dispose();
    this.rPhase = "anim";
    this.suppressFall = false;
    for (const [bone, r] of this.restPose) { bone.position.copy(r.p); bone.quaternion.copy(r.q); }
    this.fallT = 0;
    this.bankSmooth = 0;
    this.oneShot?.setEffectiveWeight(0);
    this.oneShot = null;
    this.lean.rotation.set(0, 0, 0);
    this.group.position.y = 0;
    for (const a of [this.idleAction, this.runAction, this.backAction, this.strafeAction, this.walkAction]) {
      a?.setEffectiveWeight(0);
    }
    // Hold the upright neutral stand again for the new play.
    if (this.idleAction) {
      this.idleAction.paused = true;
      this.idleAction.time = IDLE_POSE * (this.idleAction.getClip().duration || 1);
      this.idleAction.setEffectiveWeight(0);
    }
    this.interp.reset();
  }

  present(alpha: number, dt: number): void {
    if (this.rPhase !== "anim") return; // physics fixed the group while ragdolling; don't slide it
    this.group.position.x = this.interp.x(alpha);
    this.group.position.z = this.interp.z(alpha);

    // Advance the skinned animation at the DISPLAY refresh rate (real dt), decoupled from the fixed
    // 60Hz sim. The sim sets the action weights/targets each tick; rendering the clips here keeps the
    // motion smooth on 90/120Hz screens (where a sim step happens only every ~2nd frame) instead of
    // popping/stuttering. The procedural throw + carried-ball follow the mixer, so they run here too.
    this.mixer.update(dt);
    if (this.throwT > 0) {
      this.throwT -= dt;
      this.applyThrow(clamp(1 - this.throwT / THROW_DUR, 0, 1));
    }
    // Foot IK runs on the fully-posed skeleton (after the mixer + throw). Suppressed during one-shot
    // overlays (tackle/juke/spin) where the legs do non-locomotion things. Default-off (see FOOT_IK).
    if (ANIM.FOOT_IK && !this.oneShot) this.applyFootIK();
    if (this.nub.visible) {
      const hand = this.bone("RightHand") ?? this.bone("RightForeArm");
      if (hand) {
        hand.getWorldPosition(_handPos);
        this.group.worldToLocal(_handPos);
        this.nub.position.set(_handPos.x, _handPos.y, _handPos.z);
      }
    }
  }

  update(p: Player, jersey: number, trim: number, accent: number, helmet: number, decal: EmblemIcon | undefined, onFire: boolean, dt: number, isDefense: boolean): void {
    void isDefense;
    const g = this.group;
    g.visible = true;
    // While a physics ragdoll owns the body, it's stepped/driven in advanceRagdoll(); the
    // normal animation + position pipeline stands down so it doesn't fight the bones. Drop any
    // queued one-shot (e.g. the canned "tackle") so it can't fire when we hand back to anim.
    if (this.rPhase !== "anim") { p.animEvent = null; return; }
    this.interp.push(p.pos.x * U, p.pos.y * U); // horizontal position interpolated in present()
    g.position.y = 0;

    // Fire one-shot overlays on game events: throw, catch, the change-of-direction juke,
    // the spin move, the carrier's getting-tackled reaction, the defender's tackle + ball-swat
    // attempts, and a celebration. Each ramps in/out (below) so it crossfades with locomotion.
    if (p.animEvent === "pass") { this.throwT = THROW_DUR; this.throwHeading = p.loco.heading; }
    else if (p.animEvent === "catch") this.triggerOneShot(this.catchAction, 0.95);
    else if (p.animEvent === "juke") this.triggerOneShot(this.jukeAction, 0.55, 1.25, 0);
    else if (p.animEvent === "spin") this.triggerOneShot(this.spinAction ?? this.jukeAction, 0.95, 1.1, 0);
    else if (p.animEvent === "stiffArm") this.triggerOneShot(this.jukeAction ?? this.spinAction, 0.5, 1.3, 0);
    else if (p.animEvent === "tackle") this.triggerOneShot(this.tackleAction, 1.4, 1.1, 1.0);
    else if (p.animEvent === "tackleMade") this.triggerOneShot(this.defTackleAction, 1.4, 1.1, 0);
    else if (p.animEvent === "swat") this.triggerOneShot(this.defSwatAction, 0.95, 1.2, 0.3);
    else if (p.animEvent === "celebrate") this.triggerOneShot(this.celebrateAction, 2.6, 1.0, 0);
    p.animEvent = null;

    const lo = p.loco;

    // Smooth, rate-limited yaw toward the heading the sim already smoothed (carve, no snap).
    const targetYaw = toModelYaw(lo.heading) + MODEL_FORWARD;
    const turnCap = TURN_RATE_RAD * (0.55 + 0.9 * (1 - lo.speed01)) * dt;
    this.yaw += clamp(wrapAngle(targetYaw - this.yaw), -turnCap, turnCap);
    g.rotation.y = this.yaw;

    // One-shot envelope (ramp in/out); ducks locomotion, which ramps back in on the out phase.
    let osW = 0;
    if (this.oneShot) {
      this.oneShotTime += dt;
      const inT = 0.14;
      const outT = 0.32;
      if (this.oneShotTime < inT) osW = this.oneShotTime / inT;
      else if (this.oneShotTime > this.oneShotDur - outT) osW = Math.max(0, (this.oneShotDur - this.oneShotTime) / outT);
      else osW = 1;
      if (this.oneShotTime >= this.oneShotDur) {
        this.oneShot.setEffectiveWeight(0);
        this.oneShot = null;
        osW = 0;
      } else {
        this.oneShot.setEffectiveWeight(osW);
      }
    }
    const loco = 1 - osW;

    // Procedural fall: lerp toward flat (contact staggers partway, down goes flat, else up).
    // When the tackle clip is the active one-shot, IT drives the fall, so skip the
    // procedural pitch (otherwise the body would double-tip).
    const tackleClip = this.oneShot != null && this.oneShot === this.tackleAction;
    const fallTarget = this.suppressFall ? 0 : tackleClip ? 0 : lo.down ? 1 : lo.contact ? 0.55 : 0;
    this.fallT = moveToward(this.fallT, fallTarget, (fallTarget > this.fallT ? 1 / 0.25 : 1 / 0.4) * dt);

    // Procedural fall pose (applies whether or not locomotion is muted).
    this.lean.rotation.x = -this.fallT * (Math.PI / 2.1);

    // Contact shadow spreads + softens as the body goes down (a falling player's shadow pools out).
    const blobScale = 1 + this.fallT * 0.5;
    this.blob.scale.set(blobScale, blobScale, 1);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.75 - this.fallT * 0.3;

    // Compute TARGET weights, then lerp toward them so every transition crossfades.
    let tIdle = 0;
    let tWalk = 0;
    let tRun = 0;
    let tBack = 0;
    let tStrafe = 0;

    if (this.fallT > 0.02) {
      // Falling / on the ground: procedural pose, locomotion fades out.
      g.position.y = this.fallT * 0.25;
      this.ring.visible = false;
      this.chevron.visible = false;
    } else {
      // Directional blend: split locomotion among forward/backpedal/strafe by the
      // movement direction relative to facing (so backpedals & shuffles read right).
      const moving01 = smoothstep(IDLE_OUT, MOVE_FULL, lo.speed01);
      // Forward motion crossfades walk -> run with speed (true walk cycle at a stroll,
      // run when hustling), each foot-planted to ground speed by its own warp.
      const runMix = smoothstep(WALK_TO_RUN_LO, WALK_TO_RUN_HI, lo.speed01);
      // Split locomotion by movement-vs-facing angle, but sharpened so a mild turn
      // (small moveRel from the heading slew) stays a forward run instead of bleeding
      // into a shuffle/backpedal. Shuffle only dominates past ~50deg, backpedal past ~130.
      const c = Math.cos(lo.moveRel);
      let fwd = Math.pow(Math.max(0, c), 1.4);
      let back = Math.pow(Math.max(0, -c), 1.4);
      let strafe = Math.pow(Math.abs(Math.sin(lo.moveRel)), 2.0);
      const sum = fwd + back + strafe || 1;
      fwd /= sum; back /= sum; strafe /= sum;
      const fwdMoving = fwd * moving01;
      tWalk = fwdMoving * (1 - runMix);
      tRun = fwdMoving * runMix;
      tBack = back * moving01;
      tStrafe = strafe * moving01;
      tIdle = 1 - moving01; // everyone settles into the football ready stance
      // Each cycle is warped to its own measured stride so feet grip the ground.
      this.walkAction?.setEffectiveTimeScale(clamp(lo.speed * WALK_PLANT_K, 0.7, 3.6));
      this.runAction?.setEffectiveTimeScale(clamp(lo.speed * FOOT_PLANT_K, 0.7, 2.6));
      this.backAction?.setEffectiveTimeScale(clamp(lo.speed * BACK_PLANT_K, 0.7, 3.0));
      this.strafeAction?.setEffectiveTimeScale(clamp(lo.speed * STRAFE_PLANT_K, 0.7, 3.0));
      // Bank hard into turns/cuts so a change of direction reads as a dynamic lean (plus the
      // juke lean). Smoothed so it carves in rather than snapping, but quick enough to feel sharp.
      // A gentle breathing bob when idle keeps a standing player from reading as a frozen statue.
      const breathe = Math.sin(this.phase * 2.1 + this.breatheOffset) * 0.012 * (1 - moving01);
      g.position.y = (ANIM.PROC_HIP
        ? Math.abs(Math.sin(this.phase * 7)) * ANIM.HIP_BOB_AMP * lo.speed01 * fwd
        : Math.abs(Math.sin(this.phase * 7)) * 0.03 * Math.min(1, lo.speed / 120) * fwd) + breathe;
      // Acceleration → weight lean: project the low-passed accel onto facing (fore/aft) and the
      // perpendicular (lateral). Decel ⇒ lean back; accel ⇒ lean in; lateral accel ⇒ extra bank.
      const ch = Math.cos(lo.heading), sh = Math.sin(lo.heading);
      const aFwd = ANIM.ACCEL_LEAN ? lo.accelX * ch + lo.accelY * sh : 0;
      const aLat = ANIM.ACCEL_LEAN ? -lo.accelX * sh + lo.accelY * ch : 0;
      const accelPitch = clamp(aFwd * ANIM.LEAN_ACCEL_GAIN, -ANIM.LEAN_PITCH_MAX, ANIM.LEAN_PITCH_MAX);
      const bankTarget = clamp(clamp(-lo.turnRate * 0.085, -0.55, 0.55) + p.leanTarget * 0.42 + aLat * ANIM.BANK_ACCEL_GAIN, -0.62, 0.62);
      this.bankSmooth += (bankTarget - this.bankSmooth) * Math.min(1, dt * 9);
      // Forward lean while running ahead (more at speed), slight backward lean when backpedaling
      // (added on top of the fall pitch, which is ~0 while upright), plus the accel weight pitch.
      this.lean.rotation.x += ((fwd - back) * 0.16 + fwd * lo.speed01 * 0.12) * moving01 + accelPitch;
      // Half-frequency weight-shift roll (once per stride) on top of the turn/accel bank.
      const hipRoll = ANIM.PROC_HIP ? Math.sin(this.phase * 3.5) * ANIM.HIP_ROLL_AMP * moving01 * fwd : 0;
      this.lean.rotation.z = this.bankSmooth + hipRoll;
      this.lean.rotation.y = 0;
      this.phase += dt;
      this.ring.visible = p.controlled;
      this.chevron.visible = p.controlled;
      if (p.controlled) this.chevron.position.y = 2.8 + Math.sin(this.phase * 4) * 0.12;
    }

    // Smoothly crossfade all locomotion/idle weights toward their targets.
    blendW(this.idleAction, tIdle * loco, dt);
    blendW(this.walkAction, tWalk * loco, dt);
    blendW(this.runAction, tRun * loco, dt);
    blendW(this.backAction, tBack * loco, dt);
    blendW(this.strafeAction, tStrafe * loco, dt);

    // NOTE: the mixer is advanced in present() at the display's refresh rate (not here at the fixed
    // 60Hz sim rate) so the skinned animation is smooth on high-refresh screens — see present().

    // Paint the team jersey skin onto the body mesh (cached per team-colors + number), keep the
    // helmet on the dark trim color. The jersey color lives in the texture, so the material color
    // stays white (a non-white color would multiply/darken the printed numbers and stripes).
    const key = `${jersey.toString(16)}-${accent.toString(16)}-${trim.toString(16)}-${p.number}`;
    if (key !== this.jerseyKey) {
      this.jerseyKey = key;
      const tex = jerseyTexture(jersey, accent, trim, p.number);
      for (const m of this.jerseyMats) { m.map = tex; m.needsUpdate = true; }
    }
    for (const m of this.jerseyMats) {
      m.color.setHex(0xffffff);
      m.emissive.setHex(onFire ? 0x5a1e08 : 0x000000);
    }
    // Vary the complexion per player so a team isn't 11 identical faces.
    const tone = skinToneFor(p.number);
    if (tone !== this.skinTone) {
      this.skinTone = tone;
      for (const m of this.skinMats) m.color.setHex(tone);
    }
    // Paint the helmet skin (shell + crown stripe + team decal); color stays white so the texture reads.
    const hkey = `${helmet.toString(16)}-${accent.toString(16)}-${decal ?? "none"}`;
    if (hkey !== this.helmetKey) {
      this.helmetKey = hkey;
      const htex = helmetTexture(helmet, accent, decal);
      for (const m of this.helmetMats) { m.map = htex; m.needsUpdate = true; }
    }
    for (const m of this.helmetMats) {
      m.color.setHex(0xffffff);
      m.emissive.setHex(onFire ? 0x5a1e08 : 0x000000);
    }
    // Carried ball visibility (its position is placed in present(), after the mixer poses the hand).
    this.nub.visible = p.hasBall && !p.isDown;
  }

  hide(): void {
    this.group.visible = false;
    this.interp.reset();
  }
}

/**
 * Three.js renderer for the in-play 3D view: a stadium with stands + goal posts, a
 * textured turf plane that receives soft shadows, 14 articulated animated players, a
 * spiraling ball, and a high camera that follows the action from behind the offense.
 */
export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  /** Post-processing: bloom over the 3D scene (lights, fire, markers glow). */
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;

  private players: Avatar[] = [];
  /** Shared physics world for ragdoll tackles (loaded async; null until ready). */
  private physics: PhysicsWorld | null = null;
  private readonly ballGroup = new THREE.Group();
  private readonly ballMesh: THREE.Mesh;
  /** Glowing comet trail behind a thrown ball (sprite pool placed along recent positions). */
  private readonly ballTrail: THREE.Sprite[] = [];
  private readonly ballTrailHist: THREE.Vector3[] = [];
  private readonly losMarker: THREE.Object3D;
  private readonly firstDownMarker: THREE.Object3D;
  /** Pulsing glow-wall meshes for the LOS / first-down lines (animated each frame). */
  private readonly markerGlows: THREE.Mesh[] = [];
  private markerT = 0;

  private width = 1;
  private height = 1;
  private ballRoll = 0;

  private camPos = new THREE.Vector3(60, 14, 27);
  private camLook = new THREE.Vector3(70, 1.5, 27);

  // Fixed-step interpolation state for the ball + camera (smooth on any refresh rate).
  private readonly ballPrev = new THREE.Vector3();
  private readonly ballCur = new THREE.Vector3();
  private ballPrimed = false;
  private readonly camPosPrev = new THREE.Vector3(60, 14, 27);
  private readonly camPosCur = new THREE.Vector3(60, 14, 27);
  private readonly camLookPrev = new THREE.Vector3(70, 1.5, 27);
  private readonly camLookCur = new THREE.Vector3(70, 1.5, 27);
  private shakeX = 0;
  private shakeY = 0;
  // Cinematic hit push-in: `cine` (0..1) blends the chase cam toward a tight close-up; held
  // for `cineHold` seconds (real time) on a contact hit, then eased back out.
  private cine = 0;
  private cineHold = 0;

  // Drifting night atmosphere (dust/embers caught in the floodlights).
  private atmo!: THREE.Points;
  private atmoVel!: Float32Array;
  private atmoLast = 0;

  constructor(canvas: HTMLCanvasElement, field: Field) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x05080f, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene.background = this.makeSky();
    this.scene.fog = new THREE.Fog(0x070d1c, 60, 175);

    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 600);

    // Floodlit-night lighting: a dim cool ambient, a strong warm key floodlight that casts
    // shadows, and a cool fill from the far side so players are modelled from two directions
    // (no flat single-shadow look).
    this.scene.add(new THREE.HemisphereLight(0x6f86b6, 0x16241a, 0.5));
    this.sun = new THREE.DirectionalLight(0xfff0d2, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    const s = 30;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0x8fb6ff, 0.5);
    fill.position.set(20, 26, -16);
    this.scene.add(fill);

    this.buildField(field);
    this.buildStadium();
    this.buildFloodlights();
    this.buildAtmosphere();

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pm = new BoxAvatar();
      pm.hide();
      this.players.push(pm);
      this.scene.add(pm.group);
    }

    // Ball: a stretched ellipsoid that spirals in flight.
    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a4b22, roughness: 0.55 }),
    );
    this.ballMesh.scale.set(1.55, 0.92, 0.92);
    this.ballMesh.castShadow = true;
    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.02;
    ballShadow.name = "shadow";
    this.ballGroup.add(this.ballMesh, ballShadow);
    this.ballGroup.visible = false;
    this.scene.add(this.ballGroup);

    // Comet trail: a short pool of additive sprites laid along the ball's recent flight path.
    const trailTex = makeMoteTexture();
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: trailTex, color: 0xffdca0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }),
      );
      s.visible = false;
      this.ballTrail.push(s);
      this.scene.add(s);
    }

    this.losMarker = this.buildMarker(0x4aa0ff); // bright blue line of scrimmage
    this.firstDownMarker = this.buildMarker(0xffe24a); // bright yellow first-down line
    this.scene.add(this.losMarker, this.firstDownMarker);

    // Post-processing: render the scene, add a bloom pass (so floodlights, the on-fire glow,
    // the yard-line markers and big-hit FX bleed light), then tone-map + sRGB to the screen.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Restrained bloom: only genuine highlights (floodlights, on-fire glow, markers) bleed —
    // a high threshold + modest strength keeps the scene crisp, not washed out.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.6, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Spin up the physics world for ragdoll tackles (async WASM). It's ready well before the
    // first snap; until then, tackles fall back to the canned animation.
    void PhysicsWorld.create().then((w) => { this.physics = w; });
  }

  /** Begin a physics ragdoll tackle on the player at `index` (its slot in the sync list). */
  startRagdoll(index: number, hit: RagdollHit): boolean {
    const av = this.players[index];
    if (!this.physics || !(av instanceof FbxAvatar)) return false;
    const dir = _ragDir.set(hit.hitDirX, 0, hit.hitDirY);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    // px/s -> world units/s; a hit's strength scales with closing speed, a fall carries the
    // runner's own momentum (clamped so a sprint doesn't fling the body across the field).
    const hitSpeed = clamp(2.6 + hit.closingPx * U * 0.5, 2.6, 6.5);
    const carry = _ragCarry.set(hit.carryVx * U, 0, hit.carryVy * U).multiplyScalar(0.7);
    if (carry.length() > 5) carry.setLength(5);
    const hitLow = hit.big ? Math.random() < 0.2 : Math.random() < 0.5; // big hits mostly blow up high
    av.startRagdoll(this.physics, carry, dir, hitSpeed, hitLow, hit.bit);
    return true;
  }

  /** Punch the camera in tight on the action for `hold` seconds (a contact-hit close-up). */
  hitZoom(hold = 0.5): void {
    this.cineHold = Math.max(this.cineHold, hold);
  }

  /** True while any avatar is mid-tackle (falling or getting up). */
  ragdollsBusy(): boolean {
    for (const a of this.players) if (a.ragdollActive()) return true;
    return false;
  }

  /** Hips position (field px) of the player at `index` while ragdolling, else null. */
  ragdollHipsPx(index: number): { x: number; y: number } | null {
    return this.players[index]?.ragdollHipsPx() ?? null;
  }

  private makeSky(): THREE.Texture {
    // A moody floodlit-night sky: near-black overhead, deep navy, with a faint sodium-orange
    // city/stadium glow bleeding up from the horizon — gritty, on-theme.
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#04060d");
    grad.addColorStop(0.5, "#0a1124");
    grad.addColorStop(0.82, "#16223e");
    grad.addColorStop(0.93, "#3a3320");
    grad.addColorStop(1, "#5a3a18");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private fieldRef!: Field;
  private fieldCtx!: CanvasRenderingContext2D;
  private fieldTex!: THREE.CanvasTexture;

  /** Re-bake the turf with the two clubs' end-zone colors + names and the home crest at midfield.
   *  Called when a match starts (the field mesh is built once, then re-painted per matchup). */
  setFieldTeams(home: TeamConfig, away: TeamConfig): void {
    if (!this.fieldCtx || !this.fieldTex) return;
    const brand = (cfg: TeamConfig): FieldBrand => ({
      color: cfg.colors.jersey, accent: cfg.colors.accent, label: cfg.nickname,
      abbr: cfg.abbr, trim: cfg.colors.trim, icon: cfg.icon,
    });
    this.fieldRef.drawTexture(this.fieldCtx, brand(home), brand(away));
    this.fieldTex.needsUpdate = true;
  }

  private buildField(field: Field): void {
    const c = document.createElement("canvas");
    c.width = Math.round(FIELD_LENGTH);
    c.height = Math.round(FIELD_WIDTH);
    const ctx = c.getContext("2d")!;
    field.drawTexture(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.fieldRef = field;
    this.fieldCtx = ctx;
    this.fieldTex = tex;

    const geo = new THREE.PlaneGeometry(FIELD_LEN_U, FIELD_WID_U);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(FIELD_LEN_U / 2, 0, FIELD_WID_U / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // A dark apron (sideline area) around the field so edges aren't floating.
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_LEN_U + 30, FIELD_WID_U + 22),
      new THREE.MeshStandardMaterial({ color: 0x123018, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(FIELD_LEN_U / 2, -0.05, FIELD_WID_U / 2);
    apron.receiveShadow = true;
    this.scene.add(apron);
  }

  private buildStadium(): void {
    // Goal posts on the end lines (back of each end zone), per real fields.
    this.scene.add(this.goalPost(0.4));
    this.scene.add(this.goalPost(FIELD_LEN_U - 0.4));

    const crowd = this.makeCrowdTexture();
    const ad = this.makeAdTexture();
    const m = 4;
    const ext = 28;
    const sides: { x: number; z: number; ry: number; len: number }[] = [
      { x: FIELD_LEN_U / 2, z: -m, ry: Math.PI, len: FIELD_LEN_U + ext },
      { x: FIELD_LEN_U / 2, z: FIELD_WID_U + m, ry: 0, len: FIELD_LEN_U + ext },
      { x: -m, z: FIELD_WID_U / 2, ry: -Math.PI / 2, len: FIELD_WID_U + ext },
      { x: FIELD_LEN_U + m, z: FIELD_WID_U / 2, ry: Math.PI / 2, len: FIELD_WID_U + ext },
    ];
    for (const s of sides) this.scene.add(this.buildStand(s.x, s.z, s.ry, s.len, crowd, ad));

    // Light towers at the four corners.
    const corners: [number, number][] = [
      [-m - 3, -m - 3],
      [FIELD_LEN_U + m + 3, -m - 3],
      [-m - 3, FIELD_WID_U + m + 3],
      [FIELD_LEN_U + m + 3, FIELD_WID_U + m + 3],
    ];
    for (const [cx, cz] of corners) this.scene.add(this.lightTower(cx, cz));

    // Jumbotron above the right end zone, facing the field.
    this.scene.add(this.jumbotron(FIELD_LEN_U + m + 5, FIELD_WID_U / 2));
  }

  /**
   * Real floodlight beams from the four corner towers. The towers themselves (emissive banks) are
   * built in buildStadium; this adds the actual pooled illumination so the turf reads as lit from
   * four directions at night. Cheap: no shadow maps (the warm key sun owns the cast shadow) — these
   * just paint warm overlapping pools and give specular pop on jerseys/helmets.
   */
  private buildFloodlights(): void {
    const m = 4;
    const corners: [number, number][] = [
      [-m - 3, -m - 3],
      [FIELD_LEN_U + m + 3, -m - 3],
      [-m - 3, FIELD_WID_U + m + 3],
      [FIELD_LEN_U + m + 3, FIELD_WID_U + m + 3],
    ];
    const cx = FIELD_LEN_U / 2;
    const cz = FIELD_WID_U / 2;
    for (const [x, z] of corners) {
      const spot = new THREE.SpotLight(0xfff1cf, 240, 0, Math.PI / 3.4, 0.55, 1.4);
      spot.position.set(x, 22, z);
      spot.target.position.set(cx, 0, cz);
      this.scene.add(spot, spot.target);
    }
  }

  /**
   * A volume of slow-drifting motes (dust / embers) over the field, lit warm so they bleed into the
   * bloom — night-game grit without a heavyweight particle sim. Positions wrap so the field is
   * always populated; velocities give a lazy, convective drift.
   */
  private buildAtmosphere(): void {
    const N = 340;
    const pos = new Float32Array(N * 3);
    this.atmoVel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * (FIELD_LEN_U + 40) - 20;
      pos[i * 3 + 1] = 0.6 + Math.random() * 20;
      pos[i * 3 + 2] = Math.random() * (FIELD_WID_U + 30) - 15;
      this.atmoVel[i * 3] = (Math.random() - 0.5) * 0.9;
      this.atmoVel[i * 3 + 1] = 0.15 + Math.random() * 0.5; // gentle rise
      this.atmoVel[i * 3 + 2] = (Math.random() - 0.5) * 0.9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffe6b8,
      map: makeMoteTexture(),
      size: 0.5,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.atmo = new THREE.Points(geo, mat);
    this.atmo.frustumCulled = false;
    this.scene.add(this.atmo);
  }

  /** Drift the atmosphere motes; wrap them back into the volume so density stays constant. */
  private tickAtmosphere(dt: number): void {
    const p = this.atmo.geometry.getAttribute("position") as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const v = this.atmoVel;
    const loX = -20, hiX = FIELD_LEN_U + 20;
    const loZ = -15, hiZ = FIELD_WID_U + 15;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += v[i] * dt;
      a[i + 1] += v[i + 1] * dt;
      a[i + 2] += v[i + 2] * dt;
      if (a[i + 1] > 22) { a[i + 1] = 0.6; } // recycle from the ground when it floats out the top
      if (a[i] < loX) a[i] = hiX; else if (a[i] > hiX) a[i] = loX;
      if (a[i + 2] < loZ) a[i + 2] = hiZ; else if (a[i + 2] > hiZ) a[i + 2] = loZ;
    }
    p.needsUpdate = true;
  }

  /** Lay the comet-trail sprites along the ball's recent flight path; clear it when not airborne. */
  private tickBallTrail(airborne: boolean): void {
    if (!airborne) {
      if (this.ballTrailHist.length) {
        this.ballTrailHist.length = 0;
        for (const s of this.ballTrail) { s.visible = false; (s.material as THREE.SpriteMaterial).opacity = 0; }
      }
      return;
    }
    // Push the freshest ball position to the front, cap the history at the pool size.
    this.ballTrailHist.unshift(this.ballCur.clone());
    if (this.ballTrailHist.length > this.ballTrail.length) this.ballTrailHist.pop();
    for (let i = 0; i < this.ballTrail.length; i++) {
      const s = this.ballTrail[i];
      const h = this.ballTrailHist[i];
      if (!h) { s.visible = false; continue; }
      s.visible = true;
      s.position.copy(h);
      const f = 1 - i / this.ballTrail.length; // brightest/biggest near the ball
      (s.material as THREE.SpriteMaterial).opacity = f * 0.55;
      const sc = 0.35 + f * 0.5;
      s.scale.set(sc, sc, sc);
    }
  }

  /** One stand: ad board at field level + two raked seating tiers + a roof line. */
  private buildStand(x: number, z: number, ry: number, len: number, crowd: THREE.Texture, ad: THREE.Texture): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x3a4452, roughness: 1 });

    const adMat = new THREE.MeshStandardMaterial({ map: ad, roughness: 0.8, emissive: 0x111111 });
    const adBoard = new THREE.Mesh(new THREE.BoxGeometry(len, 2.4, 0.5), adMat);
    adBoard.position.set(0, 1.2, 0.4);
    g.add(adBoard);

    const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 1 });
    const lower = new THREE.Mesh(new THREE.BoxGeometry(len, 6.5, 5.5), crowdMat);
    lower.position.set(0, 3.6, 3.4);
    lower.rotation.x = -0.32;
    g.add(lower);

    const upper = new THREE.Mesh(new THREE.BoxGeometry(len, 6, 5.5), crowdMat);
    upper.position.set(0, 9.2, 8.2);
    upper.rotation.x = -0.32;
    g.add(upper);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 8), concrete);
    roof.position.set(0, 13, 8);
    g.add(roof);

    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 0.6), concrete);
    wall.position.set(0, 0.2, 0.1);
    g.add(wall);
    return g;
  }

  private lightTower(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 22, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 }),
    );
    pole.position.y = 11;
    g.add(pole);
    const bank = new THREE.Mesh(
      new THREE.BoxGeometry(5, 2.4, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.6 }),
    );
    bank.position.set(0, 21, 0);
    // Aim the bank toward the field center.
    bank.lookAt(FIELD_LEN_U / 2, 0, FIELD_WID_U / 2);
    g.add(bank);
    return g;
  }

  private jumbotron(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 13, z);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, 7, 13),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 0.8 }),
    );
    g.add(frame);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 5.5),
      new THREE.MeshStandardMaterial({ color: 0x0a2a4a, emissive: 0x1d5a8a, emissiveIntensity: 0.8 }),
    );
    screen.position.x = -0.55;
    screen.rotation.y = -Math.PI / 2;
    g.add(screen);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 13, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a3038 }),
    );
    stem.position.y = -9.5;
    g.add(stem);
    return g;
  }

  private makeAdTexture(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    const panels = ["#1c6fd0", "#d03a3a", "#155a30", "#e6a91e", "#5a3aa0", "#0f8a8a"];
    const pw = 86;
    for (let i = 0, x = 0; x < 512; i++, x += pw) {
      ctx.fillStyle = panels[i % panels.length];
      ctx.fillRect(x, 0, pw - 4, 64);
      // Fake wordmark blocks.
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(x + 14, 26, pw - 32, 6);
      ctx.fillRect(x + 24, 38, pw - 52, 5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private goalPost(x: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf5d23a, roughness: 0.4, metalness: 0.3 });
    const cz = FIELD_WID_U / 2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 8), mat);
    base.position.set(x, 1.5, cz);
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6.2, 8), mat);
    cross.rotation.x = Math.PI / 2;
    cross.position.set(x, 3, cz);
    const u1 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 8), mat);
    u1.position.set(x, 5, cz - 3);
    const u2 = u1.clone();
    u2.position.z = cz + 3;
    g.add(base, cross, u1, u2);
    return g;
  }

  private makeCrowdTexture(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    // Concrete bowl, darker up top (under the roof).
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#090d15");
    g.addColorStop(1, "#212a38");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);

    const skin = ["#f0c9a0", "#e0aa78", "#c98e5e", "#9c6b43", "#7a4f30"];
    // Clothing leans toward the two team colors, with neutrals mixed in.
    const cloth = [
      "#ffd23a", "#ffd23a", "#e23b3b", "#e23b3b", "#ffffff", "#ffffff",
      "#27a3ff", "#1fd17a", "#9b5cff", "#ff7b1e", "#dddddd", "#2a2a2a", "#ff5aa0",
    ];
    const rows = 26;
    for (let r = 0; r < rows; r++) {
      const y = 6 + (r * (256 - 12)) / rows;
      // subtle per-row shading for depth
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(0, y + 6, 512, 2);
      for (let x = 3; x < 512; x += 7) {
        if (Math.random() < 0.07) continue; // empty seat
        const jx = x + (Math.random() * 1.5 - 0.75);
        // torso (clothing)
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = cloth[(Math.random() * cloth.length) | 0];
        ctx.fillRect(jx, y + 2.5, 5, 5);
        // head (skin)
        ctx.fillStyle = skin[(Math.random() * skin.length) | 0];
        ctx.fillRect(jx + 1, y, 3, 3);
      }
    }
    ctx.globalAlpha = 1;
    // Vertical aisles.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    for (let a = 64; a < 512; a += 96) ctx.fillRect(a, 0, 5, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * A broadcast-style yard line: a bright stripe painted on the turf, a translucent glow "wall"
   * rising from it (so it reads from a low camera and through traffic), and a lit pylon at each
   * sideline. Positioned by setting the returned group's `.position.x`.
   */
  private buildMarker(color: number): THREE.Object3D {
    const g = new THREE.Group();
    const cz = FIELD_WID_U / 2;

    // Painted ground stripe.
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, FIELD_WID_U),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.06, cz);
    g.add(stripe);

    // Vertical glow wall (additive) — the part that really makes the line pop.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_WID_U, 0.85),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.26, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    glow.rotation.y = Math.PI / 2;
    glow.position.set(0, 0.42, cz);
    glow.userData.baseOpacity = 0.26;
    this.markerGlows.push(glow);
    g.add(glow);

    // Lit pylons at the sidelines.
    for (const z of [0.25, FIELD_WID_U - 0.25]) {
      const pylon = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.95, 0.3),
        new THREE.MeshBasicMaterial({ color }),
      );
      pylon.position.set(0, 0.48, z);
      g.add(pylon);
    }
    return g;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    const pr = Math.min(dpr, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? "block" : "none";
  }

  /** Reset all avatars to a neutral upright pose (call when a new play starts). */
  resetAvatars(): void {
    for (const a of this.players) a.resetPose();
  }

  /** Swap the box-avatar pool for skinned FBX characters once the model has loaded. */
  /** Snapshot of the loaded character, surfaced by the #diag overlay for remote debugging. */
  charInfo: { skinned: boolean; clips: number } = { skinned: false, clips: 0 };

  setCharacter(asset: CharacterAsset): void {
    const c = asset.clips;
    this.charInfo = {
      skinned: true,
      clips: [c.run, c.walk, c.runBack, c.strafe, c.spin, c.juke, c.catch, c.pass, c.tackle, c.defTackle, c.defSwat, c.celebrate]
        .filter((x) => x != null).length,
    };
    for (const a of this.players) { this.scene.remove(a.group); a.dispose?.(); }
    this.players = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const a = new FbxAvatar(asset);
      a.hide();
      this.players.push(a);
      this.scene.add(a.group);
    }
  }

  /**
   * Replay camera: a cinematic chase that tracks the ball, with user zoom (0 = wide overview,
   * 1 = tight). Set directly (no follow lerp) so scrubbing the timeline doesn't smear.
   */
  replayCam(focusX: number, focusY: number, dir: number, zoom: number): void {
    const z = Math.max(0, Math.min(1, zoom));
    const wx = focusX * U;
    const wz = focusY * U;
    const back = 15 - 8.5 * z; // closer as you zoom in
    const high = 9.5 - 4.5 * z; // lower angle when zoomed in, higher overview when out
    this.camPos.set(wx - dir * back, high, wz);
    this.camLook.set(wx + dir * 1.5, 1.0, wz);
    this.camPosPrev.copy(this.camPos);
    this.camPosCur.copy(this.camPos);
    this.camLookPrev.copy(this.camLook);
    this.camLookCur.copy(this.camLook);
  }

  snapCamera(focusX: number, focusY: number, dir: number): void {
    this.cine = 0; // a fresh play never starts mid hit-zoom
    this.cineHold = 0;
    this.computeCamTarget(focusX, focusY, dir, this.camPos, this.camLook);
    this.camPosPrev.copy(this.camPos);
    this.camPosCur.copy(this.camPos);
    this.camLookPrev.copy(this.camLook);
    this.camLookCur.copy(this.camLook);
    this.ballPrimed = false;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  private computeCamTarget(
    focusX: number,
    focusY: number,
    dir: number,
    outPos: THREE.Vector3,
    outLook: THREE.Vector3,
  ): void {
    const fx = focusX * U;
    const fz = focusY * U;
    // Tight, low "over the shoulder" angle: big readable players + the action up close.
    outPos.set(fx - dir * 7.5, 6.0, fz);
    outLook.set(fx + dir * 10, 0.9, fz);
  }

  /** Place the camera at an explicit world pose for a scripted cinematic (e.g. the pre-snap
   * sweep). Sets the current sample and carries the previous one so render() still interpolates
   * between ticks — call it every tick of the move for a smooth path. World units. */
  dollyCam(px: number, py: number, pz: number, lx: number, ly: number, lz: number): void {
    this.camPosPrev.copy(this.camPosCur);
    this.camLookPrev.copy(this.camLookCur);
    this.camPos.set(px, py, pz);
    this.camLook.set(lx, ly, lz);
    this.camPosCur.copy(this.camPos);
    this.camLookCur.copy(this.camLook);
  }

  sync(opts: {
    players: Player[];
    ball: Ball;
    colorFor: (p: Player) => { jersey: number; trim: number; accent: number; helmet: number; decal?: EmblemIcon; onFire: boolean; defense: boolean };
    focusX: number;
    focusY: number;
    dir: number;
    losX: number;
    firstDownX: number;
    shakeX: number;
    shakeY: number;
    dt: number;
  }): void {
    const { players, ball } = opts;
    for (let i = 0; i < this.players.length; i++) {
      const p = players[i];
      if (p) {
        const col = opts.colorFor(p);
        this.players[i].update(p, col.jersey, col.trim, col.accent, col.helmet, col.decal, col.onFire, opts.dt, col.defense);
      } else {
        this.players[i].hide();
      }
    }

    // Step the shared physics world ONCE per tick (not per avatar) for any active ragdolls,
    // enforcing each one's joint limits per substep, then drive their bones + advance get-up.
    if (this.physics && this.ragdollsBusy()) {
      const active = this.players.filter((a) => a.ragdollActive());
      this.physics.step((sdt) => { for (const a of active) a.applyRagdollLimits(sdt); });
      for (const a of active) a.advanceRagdoll(opts.dt);
    }

    if (ball.state === "held") {
      this.ballGroup.visible = false;
      this.ballPrimed = false; // snap when it next appears (no slide from a stale spot)
    } else {
      this.ballGroup.visible = true;
      if (this.ballPrimed) this.ballPrev.copy(this.ballCur);
      this.ballCur.set(ball.pos.x * U, ball.z * U + 0.1, ball.pos.y * U);
      if (!this.ballPrimed) {
        this.ballPrev.copy(this.ballCur);
        this.ballPrimed = true;
      }
      const shadow = this.ballGroup.getObjectByName("shadow");
      if (shadow) shadow.position.y = -ball.z * U + 0.02 - 0.1;
      // Point the ball along its travel and spiral it; tumble end-over-end if loose.
      if (ball.state === "inAir") {
        // Nose the long axis along the 3D velocity (arc tangent) and spin about it.
        const v = _ballVel.set(ball.vel.x, ball.verticalVel, ball.vel.y);
        if (v.lengthSq() > 1e-4) {
          v.normalize();
          _ballQ.setFromUnitVectors(_xAxis, v);
          _spinQ.setFromAxisAngle(_xAxis, ball.spin);
          this.ballMesh.quaternion.copy(_ballQ).multiply(_spinQ);
        }
      } else if (ball.state === "loose") {
        this.ballRoll += opts.dt * 16;
        this.ballMesh.rotation.set(this.ballRoll, Math.atan2(ball.vel.x, ball.vel.y), this.ballRoll * 0.6);
      }
    }
    this.tickBallTrail(ball.state === "inAir");

    this.losMarker.position.x = opts.losX * U;
    this.firstDownMarker.position.x = opts.firstDownX * U;
    // Gentle pulse on the glow walls so the lines read as "live" broadcast markers.
    this.markerT += opts.dt;
    const pulse = 0.7 + 0.3 * Math.sin(this.markerT * 3.5);
    for (const g of this.markerGlows) {
      (g.material as THREE.MeshBasicMaterial).opacity = (g.userData.baseOpacity as number) * pulse;
    }

    // Smooth camera follow (per-tick); the final placement is interpolated in render().
    const tp = _tmpPos;
    const tl = _tmpLook;
    this.computeCamTarget(opts.focusX, opts.focusY, opts.dir, tp, tl);

    // Cinematic hit push-in. Advance `cine` on REAL time (fixed 1/60 step) so it snaps in even
    // while bullet-time slows the sim dt to a crawl: fast ease-in, slower ease-out.
    const wantCine = this.cineHold > 0 ? 1 : 0;
    if (this.cineHold > 0) this.cineHold -= STEP;
    this.cine = moveToward(this.cine, wantCine, STEP / (wantCine > this.cine ? 0.09 : 0.5));
    if (this.cine > 0.001) {
      const e = this.cine * this.cine * (3 - 2 * this.cine); // smoothstep ease
      const fx = opts.focusX * U;
      const fz = opts.focusY * U;
      // Tight 3/4 angle pushed in on the collision, aimed down at the bodies so the pile sits
      // centered in frame (the chase cam looks downfield & high, which drops a hit to the floor).
      _cinePos.set(fx - opts.dir * 2.6, 3.3, fz + 3.0);
      _cineLook.set(fx, 0.5, fz);
      tp.lerp(_cinePos, e);
      tl.lerp(_cineLook, e);
    }

    // Tighter follow so the camera stays connected to decisive player movement; while pushing
    // in, add a real-time term so the close-up snaps in despite the slowed dt.
    const t = Math.min(1, opts.dt * 9 + this.cine * 0.5);
    this.camPosPrev.copy(this.camPos);
    this.camLookPrev.copy(this.camLook);
    this.camPos.lerp(tp, t);
    this.camLook.lerp(tl, Math.min(1, t * 1.3));
    this.camPosCur.copy(this.camPos);
    this.camLookCur.copy(this.camLook);
    this.shakeX = opts.shakeX;
    this.shakeY = opts.shakeY;

    // Keep the shadow frustum centered on the action.
    const fx = opts.focusX * U;
    const fz = opts.focusY * U;
    this.sun.position.set(fx - 14, 34, fz - 10);
    this.sun.target.position.set(fx, 0, fz);
  }

  /** DEBUG free camera: when true, skip the follow-cam each frame so an external controller
   *  (OrbitControls) owns the camera position/orientation. */
  freeCam = false;
  /** The 3D field camera, exposed for the DEBUG free-camera controller. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
  /** Field-pixel (sim) coordinates → world-space point on the field, for framing the debug camera. */
  fieldToWorld(px: number, py: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(px * U, 1, py * U);
  }

  render(alpha = 1): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    // Real-time delta for frame-rate-independent ambient motion (clamped to skip stalls/tab-outs).
    const now = performance.now();
    const rdt = this.atmoLast ? Math.min(0.05, (now - this.atmoLast) / 1000) : 0.016;
    this.atmoLast = now;
    this.tickAtmosphere(rdt);
    // Interpolate every moving body between its last two sim positions by `alpha`, and advance each
    // avatar's skinned animation by the real render delta `rdt` (smooth on high-refresh displays).
    for (const av of this.players) av.present(a, rdt);
    if (this.ballGroup.visible && this.ballPrimed) {
      this.ballGroup.position.lerpVectors(this.ballPrev, this.ballCur, a);
    }
    if (!this.freeCam) {
      _tmpPos.lerpVectors(this.camPosPrev, this.camPosCur, a);
      _tmpLook.lerpVectors(this.camLookPrev, this.camLookCur, a);
      this.camera.position.set(_tmpPos.x + this.shakeX * U * 0.5, _tmpPos.y + this.shakeY * U * 0.5, _tmpPos.z);
      this.camera.lookAt(_tmpLook);
    }

    this.composer.render();
  }

  // --- special-teams place-kick view ----------------------------------------------------
  /** World X of the uprights the given attack direction is kicking toward. */
  goalPostWorldX(dir: number): number {
    return dir > 0 ? FIELD_LEN_U - 0.4 : 0.4;
  }

  /** Set up a place-kick: hide players, sit the ball on the spot, frame it against the posts. */
  prepareKick(ballX: number, ballY: number, dir: number): void {
    for (const a of this.players) a.hide();
    this.ballGroup.visible = true;
    this.ballPrimed = false;
    this.renderKickFrame(ballX, ballY, 0, dir);
  }

  /** Position the ball mid-flight (field-px x/y, height z in px) and chase it with the camera. */
  renderKickFrame(ballX: number, ballY: number, zPx: number, dir: number): void {
    const bx = ballX * U;
    const by = Math.max(0.05, zPx * U);
    const bz = ballY * U;
    this.ballGroup.position.set(bx, by + 0.1, bz);
    const shadow = this.ballGroup.getObjectByName("shadow");
    if (shadow) shadow.position.y = -by + 0.02 - 0.1;
    this.ballRoll += 0.45;
    this.ballMesh.rotation.set(0, dir > 0 ? Math.PI / 2 : -Math.PI / 2, this.ballRoll);

    const cz = FIELD_WID_U / 2;
    const postX = this.goalPostWorldX(dir);
    // Low and behind the spot, easing up as the ball climbs so it stays framed against the posts.
    this.camera.position.set(bx - dir * 9, 6.2 + by * 0.22, bz + (cz - bz) * 0.12);
    this.camera.lookAt((postX + bx) / 2, Math.max(2.4, by * 0.55), cz);

    const now = performance.now();
    const rdt = this.atmoLast ? Math.min(0.05, (now - this.atmoLast) / 1000) : 0.016;
    this.atmoLast = now;
    this.tickAtmosphere(rdt);
    this.composer.render();
  }

  project(worldX: number, worldY: number, heightPx: number): { x: number; y: number; visible: boolean } {
    _tmpVec.set(worldX * U, heightPx * U, worldY * U);
    _tmpVec.project(this.camera);
    return {
      x: (_tmpVec.x * 0.5 + 0.5) * this.width,
      y: (-_tmpVec.y * 0.5 + 0.5) * this.height,
      visible: _tmpVec.z < 1,
    };
  }
}

const _tmpPos = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _ragDir = new THREE.Vector3();
const _ragCarry = new THREE.Vector3();
const _cinePos = new THREE.Vector3();
const _cineLook = new THREE.Vector3();
// Scratch objects for the spiraling-ball orientation (no per-frame allocation).
const _ballVel = new THREE.Vector3();
const _ballQ = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
