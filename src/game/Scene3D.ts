import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import type { CharacterAsset } from "./CharacterModel";
import { clamp, moveToward } from "../engine/math/Vec2";
import { Field, FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD } from "./Field";

/** Units per field-pixel (1 yard = 1 world unit in 3D). */
const U = 1 / PX_PER_YARD;
const FIELD_LEN_U = FIELD_LENGTH * U;
const FIELD_WID_U = FIELD_WIDTH * U;

const MAX_PLAYERS = 14;

/** A swappable on-field player representation (box fallback or skinned FBX). */
interface Avatar {
  readonly group: THREE.Object3D;
  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number, isDefense: boolean): void;
  /** Apply the fixed-step interpolation: place the body between the last two sim
   * positions by `alpha` (0..1) so motion is smooth on any refresh rate. */
  present(alpha: number): void;
  hide(): void;
  resetPose(): void;
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
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.8 });

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

  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number, _isDefense: boolean): void {
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
    this.helmetMat.color.setHex(trim);
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

  present(alpha: number): void {
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
const FOOT_PLANT_K = 0.0075; // run timeScale per px/s of ground speed (kills foot sliding)
const WALK_PLANT_K = 0.0135; // walk timeScale per px/s of ground speed
const IDLE_OUT = 0.06; // speed01 below this is idle
const MOVE_FULL = 0.18; // speed01 above this is fully in locomotion (idle faded out)
const WALK_TO_RUN_LO = 0.3; // below this, forward motion is the walk cycle
const WALK_TO_RUN_HI = 0.6; // above this, forward motion is the run cycle

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
/** Convert a standard heading (atan2(y,x)) to the model's yaw convention. */
function toModelYaw(h: number): number {
  return Math.atan2(Math.cos(h), Math.sin(h));
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Lerp an action's weight toward a target (~0.12s to fully change) for smooth crossfades. */
function blendW(a: THREE.AnimationAction | null, target: number, dt: number): void {
  if (!a) return;
  a.setEffectiveWeight(moveToward(a.getEffectiveWeight(), target, dt / 0.12));
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
  /** Right-hand bone — the held ball rides it so it follows the hand as it animates. */
  private readonly handBone: THREE.Object3D | null;
  private oneShot: THREE.AnimationAction | null = null;
  private oneShotTime = 0;
  private oneShotDur = 0;
  /** The uniform/helmet materials that get tinted to the team color. */
  private readonly uniformMats: THREE.MeshStandardMaterial[] = [];
  private readonly lean = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly chevron: THREE.Mesh;
  private readonly nub: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  /** Rendered yaw (slewed toward the target heading for smooth turning). */
  private yaw = 0;
  /** Fall progress 0 (upright) .. 1 (flat), lerped for a non-instant tackle. */
  private fallT = 0;
  private readonly interp = new Interp();

  constructor(asset: CharacterAsset) {
    const inner = skeletonClone(asset.template);
    inner.scale.setScalar(asset.scale);
    inner.position.y = asset.groundOffset * asset.scale;
    // Clone the model's materials per-avatar so each can be tinted independently;
    // the uniform/helmet material takes the team color, skin/face stay natural.
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const apply = (mat: THREE.Material): THREE.Material => {
        const clone = mat.clone() as THREE.MeshStandardMaterial;
        if (/uniform|helmet|jersey|body/i.test(mat.name)) this.uniformMats.push(clone);
        return clone;
      };
      m.material = Array.isArray(m.material) ? m.material.map(apply) : apply(m.material);
    });
    // Fallback: if nothing matched by name, tint everything.
    if (this.uniformMats.length === 0) {
      inner.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !Array.isArray(m.material)) this.uniformMats.push(m.material as THREE.MeshStandardMaterial);
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
    // The stance settles into a 3-point and HOLDS — play it once and clamp the final
    // (hand-down) pose so players don't loop back up to standing and re-bend.
    if (this.idleAction) {
      this.idleAction.setLoop(THREE.LoopOnce, 1);
      this.idleAction.clampWhenFinished = true;
      this.idleAction.play();
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
    this.nub.position.set(0.34, 1.1, 0.2);
    this.nub.visible = false;

    // The lean group banks/leans the body; the holder group only yaws + positions,
    // so the ground ring / chevron / ball stay upright.
    this.lean.add(inner);
    this.group.add(this.lean, this.ring, this.chevron, this.nub);

    // Locate the right-hand bone so the held ball can ride it (follows the hand as the
    // run/throw/catch animations move the arm). Falls back to the fixed nub spot if absent.
    let hand: THREE.Object3D | null = null;
    inner.traverse((o) => {
      if (!hand && /RightHand$/i.test(o.name)) hand = o;
    });
    this.handBone = hand;
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
    this.fallT = 0;
    this.oneShot?.setEffectiveWeight(0);
    this.oneShot = null;
    this.lean.rotation.set(0, 0, 0);
    this.group.position.y = 0;
    for (const a of [this.idleAction, this.runAction, this.backAction, this.strafeAction, this.walkAction]) {
      a?.setEffectiveWeight(0);
    }
    // Restart the stance so it bends down once this play, then clamps/holds the pose.
    this.idleAction?.reset();
    this.idleAction?.setEffectiveWeight(0);
    this.interp.reset();
  }

  present(alpha: number): void {
    this.group.position.x = this.interp.x(alpha);
    this.group.position.z = this.interp.z(alpha);
  }

  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number, isDefense: boolean): void {
    void trim;
    void isDefense;
    const g = this.group;
    g.visible = true;
    this.interp.push(p.pos.x * U, p.pos.y * U); // horizontal position interpolated in present()
    g.position.y = 0;

    // Fire one-shot overlays on game events: throw, catch, spin-move juke, the
    // carrier's getting-tackled reaction, the defender's tackle + ball-swat attempts,
    // and a celebration. (Spin supersedes the old change-direction juke clip.)
    if (p.animEvent === "pass") this.triggerOneShot(this.passAction, 1.1);
    else if (p.animEvent === "catch") this.triggerOneShot(this.catchAction, 0.95);
    else if (p.animEvent === "juke") this.triggerOneShot(this.spinAction ?? this.jukeAction, 0.9, 1.15, 0);
    else if (p.animEvent === "tackle") this.triggerOneShot(this.tackleAction, 1.5, 1.05, 0);
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
      const inT = 0.1;
      const outT = 0.28;
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
    const fallTarget = tackleClip ? 0 : lo.down ? 1 : lo.contact ? 0.55 : 0;
    this.fallT = moveToward(this.fallT, fallTarget, (fallTarget > this.fallT ? 1 / 0.25 : 1 / 0.4) * dt);

    // Procedural fall pose (applies whether or not locomotion is muted).
    this.lean.rotation.x = -this.fallT * (Math.PI / 2.1);

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
      const ts = clamp(lo.speed * FOOT_PLANT_K, 0.55, 2.2);
      const walkTs = clamp(lo.speed * WALK_PLANT_K, 0.6, 1.6);
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
      this.walkAction?.setEffectiveTimeScale(walkTs);
      this.runAction?.setEffectiveTimeScale(ts);
      this.backAction?.setEffectiveTimeScale(ts);
      this.strafeAction?.setEffectiveTimeScale(ts);
      // Lean forward when running ahead, back slightly when backpedaling; bank into turns/cuts.
      g.position.y = Math.abs(Math.sin(this.phase * 7)) * 0.03 * Math.min(1, lo.speed / 120) * fwd;
      const bank = clamp(clamp(-lo.turnRate * 0.05, -0.4, 0.4) + p.leanTarget * 0.35, -0.55, 0.55);
      // Forward lean while running ahead, slight backward lean when backpedaling
      // (added on top of the fall pitch, which is ~0 while upright).
      this.lean.rotation.x += (fwd - back) * 0.16 * moving01;
      this.lean.rotation.z = bank;
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

    this.mixer.update(dt);

    // Tint the uniform/helmet to the team color (multiplies the model's texture);
    // glow on fire. Works for the model's Phong or Standard materials.
    for (const m of this.uniformMats) {
      m.color.setHex(jersey);
      m.emissive.setHex(onFire ? 0x5a1e08 : 0x000000);
    }
    this.nub.visible = p.hasBall && !p.isDown;
    // Ride the ball on the right hand so it tracks the animated arm. The bone's world
    // matrix is current after mixer.update; convert into the group's local space (both
    // share the same ancestor chain, so the hand's offset is captured correctly).
    if (this.nub.visible && this.handBone) {
      this.handBone.updateWorldMatrix(true, false);
      this.handBone.getWorldPosition(_handPos);
      this.group.worldToLocal(_handPos);
      this.nub.position.copy(_handPos);
    } else if (!this.handBone) {
      this.nub.position.set(0.34, 1.1, 0.2);
    }
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

  private players: Avatar[] = [];
  private readonly ballGroup = new THREE.Group();
  private readonly ballMesh: THREE.Mesh;
  private readonly losMarker: THREE.Mesh;
  private readonly firstDownMarker: THREE.Mesh;

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

  constructor(canvas: HTMLCanvasElement, field: Field) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x0a1622, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = this.makeSky();
    this.scene.fog = new THREE.Fog(0x223a55, 80, 200);

    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 600);

    // Lighting: hemisphere fill + a sun that follows the action and casts shadows.
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2c5a32, 0.9));
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    const s = 30;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    this.buildField(field);
    this.buildStadium();

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pm = new BoxAvatar();
      pm.hide();
      this.players.push(pm);
      this.scene.add(pm.group);
    }

    // Ball: a stretched ellipsoid that spirals in flight.
    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a4b22, roughness: 0.55 }),
    );
    this.ballMesh.scale.set(1.6, 0.95, 0.95);
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

    this.losMarker = this.buildMarker(0x3a6bff);
    this.firstDownMarker = this.buildMarker(0xffd23a);
    this.scene.add(this.losMarker, this.firstDownMarker);
  }

  private makeSky(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#0a1730");
    grad.addColorStop(0.55, "#1d3a5f");
    grad.addColorStop(1, "#3b6a8c");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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
      new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.2 }),
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

  private buildMarker(color: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(0.2, FIELD_WID_U);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.05;
    m.position.z = FIELD_WID_U / 2;
    return m;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? "block" : "none";
  }

  /** Reset all avatars to a neutral upright pose (call when a new play starts). */
  resetAvatars(): void {
    for (const a of this.players) a.resetPose();
  }

  /** Swap the box-avatar pool for skinned FBX characters once the model has loaded. */
  setCharacter(asset: CharacterAsset): void {
    for (const a of this.players) this.scene.remove(a.group);
    this.players = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const a = new FbxAvatar(asset);
      a.hide();
      this.players.push(a);
      this.scene.add(a.group);
    }
  }

  snapCamera(focusX: number, focusY: number, dir: number): void {
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

  sync(opts: {
    players: Player[];
    ball: Ball;
    colorFor: (p: Player) => { jersey: number; trim: number; onFire: boolean; defense: boolean };
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
        this.players[i].update(p, col.jersey, col.trim, col.onFire, opts.dt, col.defense);
      } else {
        this.players[i].hide();
      }
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

    this.losMarker.position.x = opts.losX * U;
    this.firstDownMarker.position.x = opts.firstDownX * U;

    // Smooth camera follow (per-tick); the final placement is interpolated in render().
    const tp = _tmpPos;
    const tl = _tmpLook;
    this.computeCamTarget(opts.focusX, opts.focusY, opts.dir, tp, tl);
    // Tighter follow so the camera stays connected to decisive player movement.
    const t = Math.min(1, opts.dt * 9);
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

  render(alpha = 1): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    // Interpolate every moving body between its last two sim positions by `alpha`.
    for (const av of this.players) av.present(a);
    if (this.ballGroup.visible && this.ballPrimed) {
      this.ballGroup.position.lerpVectors(this.ballPrev, this.ballCur, a);
    }
    _tmpPos.lerpVectors(this.camPosPrev, this.camPosCur, a);
    _tmpLook.lerpVectors(this.camLookPrev, this.camLookCur, a);
    this.camera.position.set(_tmpPos.x + this.shakeX * U * 0.5, _tmpPos.y + this.shakeY * U * 0.5, _tmpPos.z);
    this.camera.lookAt(_tmpLook);

    this.renderer.render(this.scene, this.camera);
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
// Scratch objects for the spiraling-ball orientation (no per-frame allocation).
const _handPos = new THREE.Vector3();
const _ballVel = new THREE.Vector3();
const _ballQ = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
