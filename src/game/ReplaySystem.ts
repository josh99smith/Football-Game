import type { Player, LocoState } from "./entities/Player";
import type { Ball, BallState } from "./entities/Ball";

/** A team color lookup used by Scene3D.sync. */
type ColorFor = (p: Player) => { jersey: number; trim: number; onFire: boolean; defense: boolean };

interface PlayerFrame {
  x: number;
  y: number;
  loco: LocoState;
  hasBall: boolean;
  controlled: boolean;
  isDown: boolean;
  leanTarget: number;
  anim: Player["animEvent"]; // one-shot (throw/catch/spin/tackle/...) fired on this frame, if any
  jersey: number;
  trim: number;
  onFire: boolean;
  defense: boolean;
  role: Player["role"];
  team: Player["team"];
}

interface BallFrame {
  state: BallState;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vvel: number;
  spin: number;
}

interface ReplayFrame {
  p: PlayerFrame[];
  b: BallFrame;
}

/**
 * Records a play (player positions + locomotion + ball) frame by frame so it can be played back
 * as an instant replay. Playback rebuilds lightweight "ghost" Player/Ball objects from a recorded
 * frame and hands them to Scene3D.sync, reusing the whole avatar animation pipeline. (One-shot
 * overlays — throws/catches — aren't re-fired; the replay shows locomotion + down poses.)
 */
export class ReplaySystem {
  private frames: ReplayFrame[] = [];
  private readonly ghosts: GhostPlayer[] = [];
  private readonly ghostBall: GhostBall = makeGhostBall();
  private lastIndex = -1; // last sampled frame, to fire one-shots only on forward playback
  /** ~13s cap so a long play can't grow the buffer without bound. */
  private readonly maxFrames = 800;

  clear(): void {
    this.frames.length = 0;
    this.lastIndex = -1;
  }

  /** Call when (re)starting playback so one-shots fire from the top, not on a scrub jump. */
  rewind(): void {
    this.lastIndex = -1;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get duration(): number {
    return this.frames.length / 60;
  }

  /** Enough of a play to be worth replaying? */
  get available(): boolean {
    return this.frames.length > 20;
  }

  /** Snapshot the current play state. Call once per sim tick while the play is live/settling. */
  record(all: Player[], ball: Ball, colorFor: ColorFor): void {
    if (this.frames.length >= this.maxFrames) return;
    const p: PlayerFrame[] = [];
    for (const o of all) {
      const c = colorFor(o);
      const l = o.loco;
      p.push({
        x: o.pos.x, y: o.pos.y,
        loco: { gait: l.gait, speed: l.speed, speed01: l.speed01, heading: l.heading, moveRel: l.moveRel, turnRate: l.turnRate, down: l.down, contact: l.contact, stumbling: l.stumbling },
        hasBall: o.hasBall, controlled: o.controlled, isDown: o.isDown, leanTarget: o.leanTarget, anim: o.animEvent,
        jersey: c.jersey, trim: c.trim, onFire: c.onFire, defense: c.defense, role: o.role, team: o.team,
      });
    }
    this.frames.push({
      p,
      b: { state: ball.state, x: ball.pos.x, y: ball.pos.y, z: ball.z, vx: ball.vel.x, vy: ball.vel.y, vvel: ball.verticalVel, spin: ball.spin },
    });
  }

  /**
   * Build ghost objects for the recorded frame at time `t` seconds and return everything
   * Scene3D.sync needs, plus the focus point (the ball, or its carrier when held).
   */
  sample(t: number): { players: Player[]; ball: Ball; colorFor: ColorFor; focusX: number; focusY: number } {
    const i = Math.max(0, Math.min(this.frames.length - 1, Math.round(t * 60)));
    const f = this.frames[i];
    // Fire one-shot animations only when playing FORWARD (not when paused or scrubbing); scan the
    // skipped frames so an event isn't missed if a couple of frames were stepped over.
    const forward = i > this.lastIndex && i - this.lastIndex <= 5;
    while (this.ghosts.length < f.p.length) this.ghosts.push(makeGhostPlayer());
    for (let k = 0; k < f.p.length; k++) {
      const g = this.ghosts[k];
      const s = f.p[k];
      g.pos.x = s.x;
      g.pos.y = s.y;
      Object.assign(g.loco, s.loco);
      g.hasBall = s.hasBall;
      g.controlled = s.controlled;
      g.isDown = s.isDown;
      g.leanTarget = s.leanTarget;
      g.role = s.role;
      g.team = s.team;
      g.color = { jersey: s.jersey, trim: s.trim, onFire: s.onFire, defense: s.defense };
      let anim: Player["animEvent"] = null;
      if (forward) {
        for (let j = i; j > this.lastIndex; j--) { const a = this.frames[j].p[k].anim; if (a) { anim = a; break; } }
      }
      g.animEvent = anim;
    }
    this.lastIndex = i;
    const gb = this.ghostBall;
    gb.state = f.b.state;
    gb.pos.x = f.b.x;
    gb.pos.y = f.b.y;
    gb.z = f.b.z;
    gb.vel.x = f.b.vx;
    gb.vel.y = f.b.vy;
    gb.vz = f.b.vvel;
    gb.spin = f.b.spin;

    let fx = f.b.x;
    let fy = f.b.y;
    if (f.b.state === "held") {
      const carrier = f.p.find((s) => s.hasBall);
      if (carrier) { fx = carrier.x; fy = carrier.y; }
    }
    const players = this.ghosts.slice(0, f.p.length) as unknown as Player[];
    return {
      players,
      ball: this.ghostBall as unknown as Ball,
      colorFor: (p) => (p as unknown as GhostPlayer).color,
      focusX: fx,
      focusY: fy,
    };
  }
}

/** Duck-typed stand-ins (Scene3D.sync only reads these fields, never calls methods). */
interface GhostPlayer {
  pos: { x: number; y: number };
  loco: LocoState;
  hasBall: boolean;
  controlled: boolean;
  isDown: boolean;
  leanTarget: number;
  animEvent: Player["animEvent"];
  role: Player["role"];
  team: Player["team"];
  color: { jersey: number; trim: number; onFire: boolean; defense: boolean };
}
interface GhostBall {
  state: BallState;
  pos: { x: number; y: number };
  z: number;
  vel: { x: number; y: number };
  vz: number;
  spin: number;
  carrier: null;
  get verticalVel(): number;
}

function makeGhostPlayer(): GhostPlayer {
  return {
    pos: { x: 0, y: 0 },
    loco: { gait: "idle", speed: 0, speed01: 0, heading: 0, moveRel: 0, turnRate: 0, down: false, contact: false, stumbling: false },
    hasBall: false, controlled: false, isDown: false, leanTarget: 0, animEvent: null,
    role: "WR", team: "HOME", color: { jersey: 0xffffff, trim: 0, onFire: false, defense: false },
  };
}
function makeGhostBall(): GhostBall {
  const b = {
    state: "held" as BallState,
    pos: { x: 0, y: 0 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, spin: 0, carrier: null,
    get verticalVel(): number { return b.vz; },
  };
  return b;
}
