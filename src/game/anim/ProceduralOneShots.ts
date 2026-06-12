import * as THREE from "three";

/**
 * Procedural one-shot moves for animation events that have no clip on the current character
 * (the single-file Tripo player ships only idle/walk/run/catch/dive). Each move poses the body
 * for `dur` seconds, applied in present() AFTER the mixer so it layers on top of locomotion —
 * the same pattern as the procedural QB throw.
 *
 * IDEMPOTENCE: present() runs at display rate (several frames per sim tick), so a move may be
 * applied many times for the same instant. Body posing therefore uses SET semantics on `ctx.body`
 * (the avatar's inner group — nothing else writes its rotation / Y offset) and bone AIMING on the
 * freshly mixer-posed skeleton. Never `+=` anything that survives the frame.
 *
 * The dispatcher always prefers a real clip: drop a take with the right name into the model GLB
 * and the procedural version stops being used automatically.
 *
 * REPLAY CONSTRAINT: triggers may only read fields that exist on ReplaySystem's GhostPlayer
 * (pos / loco / hasBall / leanTarget / role / team) — events re-fire on ghosts during replays.
 */

export interface ProcCtx {
  /** Progress 0..1 through the move. */
  p: number;
  /** World yaw the body faces (loco.heading at trigger time). */
  heading: number;
  /** The avatar's inner body group. SET rotation.x/y/z and posY — cleared when the move ends. */
  body: THREE.Object3D;
  /** Base Y of the body group (ground offset) — posY hops are body.position.y = baseY + dy. */
  baseY: number;
  /** Cached bone lookup (mixamorig short names). */
  bone(short: string): THREE.Bone | null;
  /** Aim a bone so bone→child points along a world direction, weight 0..1 (post-mixer). */
  aimBone(bone: THREE.Bone, child: THREE.Object3D, dirWorld: THREE.Vector3, weight: number): void;
}

export interface ProcMove {
  dur: number; // seconds
  /** While true the move owns the body pitch (suppresses the procedural fall lean). */
  ownsFall?: boolean;
  apply(ctx: ProcCtx): void;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

function facing(ctx: ProcCtx): THREE.Vector3 {
  return _fwd.set(Math.cos(ctx.heading), 0, Math.sin(ctx.heading));
}
function rightOf(ctx: ProcCtx): THREE.Vector3 {
  return _right.copy(facing(ctx)).cross(_UP).normalize();
}
/** 0→1→0 bell over the move (sin envelope). */
const bell = (p: number): number => Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
const smooth = (p: number): number => p * p * (3 - 2 * p);
/** Ramp in fast, hold, release — for poses that should sustain mid-move. */
const hold = (p: number, inT = 0.2, outT = 0.25): number =>
  Math.max(0, Math.min(1, Math.min(p / inT, (1 - p) / outT)));

/** Aim an arm (upper + forearm follow-through) along a world direction. */
function aimArm(ctx: ProcCtx, side: "Left" | "Right", dir: THREE.Vector3, w: number): void {
  const arm = ctx.bone(`${side}Arm`);
  const fore = ctx.bone(`${side}ForeArm`);
  const hand = ctx.bone(`${side}Hand`);
  if (!arm || !fore) return;
  ctx.aimBone(arm, fore, dir, w);
  if (hand) ctx.aimBone(fore, hand, dir, w * 0.85);
}

export const PROC_MOVES: Record<string, ProcMove> = {
  // Ball-carrier 360 spin move: a full body revolution with a slight crouch.
  spin: {
    dur: 0.55,
    apply(ctx) {
      ctx.body.rotation.y = Math.PI * 2 * smooth(ctx.p);
      ctx.body.rotation.x = 0.18 * bell(ctx.p);
    },
  },

  // Hard cut: bank into the plant with a small counter-yaw snap.
  juke: {
    dur: 0.38,
    apply(ctx) {
      const b = bell(ctx.p);
      ctx.body.rotation.z = 0.5 * b;
      ctx.body.rotation.y = 0.35 * Math.sin(Math.PI * 2 * ctx.p);
      ctx.body.rotation.x = 0.12 * b;
    },
  },

  // Stiff-arm: lead arm punched straight out at shoulder height while running.
  stiffArm: {
    dur: 0.55,
    apply(ctx) {
      const w = hold(ctx.p);
      _dir.copy(facing(ctx)).addScaledVector(_UP, -0.1).normalize();
      aimArm(ctx, "Right", _dir, w);
    },
  },

  // Defender's hit: a lunging wrap — pitch in hard, both arms driving forward.
  defTackle: {
    dur: 0.6,
    ownsFall: true,
    apply(ctx) {
      const w = hold(ctx.p, 0.25, 0.35);
      ctx.body.rotation.x = 0.55 * w;
      _dir.copy(facing(ctx)).addScaledVector(_UP, -0.25).normalize();
      aimArm(ctx, "Right", _dir, w * 0.9);
      aimArm(ctx, "Left", _dir, w * 0.9);
    },
  },

  // Carrier's hit reaction when no ragdoll spawned: recoil against the run.
  hitReact: {
    dur: 0.45,
    apply(ctx) {
      ctx.body.rotation.x = -0.4 * bell(ctx.p);
      ctx.body.rotation.z = 0.18 * Math.sin(Math.PI * 2 * ctx.p);
    },
  },

  // Pass breakup: throw an arm high across the ball's path with a small jump read.
  swat: {
    dur: 0.5,
    apply(ctx) {
      const w = hold(ctx.p, 0.18, 0.3);
      _dir.copy(facing(ctx)).addScaledVector(_UP, 1.6).normalize();
      aimArm(ctx, "Right", _dir, w);
      ctx.body.position.y = ctx.baseY + 0.22 * bell(ctx.p);
      ctx.body.rotation.x = -0.12 * w;
    },
  },

  // Placekick: plant lean-back, right leg swings through the ball.
  kick: {
    dur: 0.7,
    apply(ctx) {
      const up = ctx.bone("RightUpLeg");
      const knee = ctx.bone("RightLeg");
      const swing = smooth(Math.min(1, ctx.p / 0.55)); // wind → contact by 55%, then follow
      const w = hold(ctx.p, 0.15, 0.3);
      if (up && knee) {
        // Leg sweeps from cocked-back to driven-forward/up through the strike.
        _dir.copy(facing(ctx)).multiplyScalar(-0.6 + 1.8 * swing).addScaledVector(_UP, -0.9 + 0.8 * swing).normalize();
        ctx.aimBone(up, knee, _dir, w);
      }
      ctx.body.rotation.x = -0.2 * w; // counter-lean back over the plant foot
    },
  },

  // Loose-ball scoop: fold at the waist, throwing the near arm down at the ball.
  pickup: {
    dur: 0.55,
    apply(ctx) {
      const w = bell(ctx.p);
      ctx.body.rotation.x = 0.85 * w;
      _dir.copy(facing(ctx)).addScaledVector(_UP, -1.4).normalize();
      aimArm(ctx, "Right", _dir, w);
    },
  },

  // Touchdown: hops with both arms up in the V.
  celebrate: {
    dur: 1.8,
    apply(ctx) {
      const w = hold(ctx.p, 0.12, 0.15);
      _dir.copy(rightOf(ctx)).multiplyScalar(0.35).addScaledVector(_UP, 1.7).normalize();
      aimArm(ctx, "Right", _dir, w);
      _dir.copy(rightOf(ctx)).multiplyScalar(-0.35).addScaledVector(_UP, 1.7).normalize();
      aimArm(ctx, "Left", _dir, w);
      ctx.body.position.y = ctx.baseY + 0.3 * Math.abs(Math.sin(Math.PI * 2 * ctx.p)) * w;
    },
  },

  // Hard reversal (turnRun): a tight plant-and-whip with a deep bank.
  turnRun: {
    dur: 0.42,
    apply(ctx) {
      const b = bell(ctx.p);
      ctx.body.rotation.z = -0.55 * b;
      ctx.body.rotation.x = 0.2 * b;
    },
  },
};
