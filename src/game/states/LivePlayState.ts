import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import { dist, lerp, clamp, type Vec2 } from "../../engine/math/Vec2";
import { chance } from "../../engine/math/random";
import { Player } from "../entities/Player";
import { Ball } from "../entities/Ball";
import { buildDefense, buildOffense, type OffensePlay, type DefensePlay } from "../Playbook";
import { assignDefense, updateDefense, type PlayContext } from "../ai/DefenseAI";
import { updateOffense } from "../ai/OffenseAI";
import { CPUOffense } from "../ai/CPUOffense";
import { chooseTarget, resolveAir } from "../Passing";
import { HUD } from "../../ui/HUD";
import { TouchControls, type ControlLabels } from "../../ui/TouchControls";
import { LEFT_GOAL_X, RIGHT_GOAL_X, PX_PER_YARD } from "../Field";
import type { PlayOutcome, OutcomeType } from "../Match";
import { PlayResultState } from "./PlayResultState";

type Phase = "presnap" | "live" | "dead";

// Pre-snap is player-controlled now; this is only a safety fallback so a play can't
// hard-stall if the hike is never pressed.
const PRESNAP_TIME = 20;
const MAX_PLAY_TIME = 16;
/** Hold this long (s) to fully charge a bullet pass; a quick tap throws a lob. */
const THROW_CHARGE_MAX = 0.5;
/** Hold the ACTION button this long (s) as a ball carrier to dive instead of juke. */
const DIVE_HOLD = 0.22;
/** A defender within this distance (px) of the carrier tackles on ACTION (else switches). */
const DEF_TACKLE_RANGE = 70;

/** Map throw power (0 lob .. 1 bullet) to launch parameters. Single source of truth. */
function throwParams(power: number): { speed: number; loft: number; spin: number } {
  const p = Math.max(0, Math.min(1, power));
  return { speed: lerp(300, 580, p), loft: lerp(2.0, 0.72, p), spin: lerp(26, 52, p) };
}
const DIFFICULTY = {
  // reactBase/reactRate control how fast the pass rush + pursuit ramp up after the
  // snap — lower = more time in the pocket and bigger running lanes.
  rookie: { pick: 0.1, cpuSpeed: 0.92, reactBase: 0.28, reactRate: 0.9 },
  pro: { pick: 0.18, cpuSpeed: 0.97, reactBase: 0.4, reactRate: 1.2 },
  allpro: { pick: 0.3, cpuSpeed: 1.02, reactBase: 0.52, reactRate: 1.55 },
};

/**
 * The heart of the game: simulates one play from snap to whistle. Handles human
 * control of the ball carrier (offense) or a defender (defense), AI for everyone
 * else, passing, blocking, tackling, big-hit juice, and end-of-play detection.
 */
export class LivePlayState implements GameState {
  private readonly app: GameApp;
  private readonly offensePlay: OffensePlay;
  private readonly defensePlay: DefensePlay;

  private offense: Player[] = [];
  private defense: Player[] = [];
  private all: Player[] = [];
  private ball = new Ball();

  private phase: Phase = "presnap";
  /** Safety fallback so a play never hard-stalls in pre-snap. */
  private snapTimer = PRESNAP_TIME;
  /** True once everyone has broken the huddle and reached their spot. */
  private preSnapReady = false;
  /** Countdown for the CPU offense to hike once set (defense games). */
  private cpuHikeTimer = -1;
  private playTime = 0;

  private dir = 1;
  private offenseTeamId: "HOME" | "AWAY" = "HOME";
  private humanIsOffense = true;
  private controlled: Player | null = null;
  private qb: Player | null = null;

  private cpu: CPUOffense;
  private hud = new HUD();
  private controls = new TouchControls();

  private turbo = 1; // 0..1 meter for the controlled player
  /** Throw charge (seconds ACTION held); maps tap->lob, hold->bullet. */
  private throwCharge = 0;
  private throwCharging = false;
  /** Ball-carrier ACTION hold tracking (tap = juke, hold = dive). */
  private carrierHeld = 0;
  private carrierFired = false;
  private startLosX = 0;
  private passThrown = false;
  private sackPossible = true;
  /** The receiver the current pass is aimed at (attacks the ball in flight). */
  private passTarget: Player | null = null;
  /** Post-whistle beat so the player SEES the catch/tackle before the result banner. */
  private pendingOutcome: PlayOutcome | null = null;
  private deadTimer = 0;
  /** Cooldown so broken tackles can't chain every frame. */
  private lastBreak = -1;
  /** A tackle is wrapping up; endPlay fires when this timer elapses (the contact beat). */
  private pendingTackle: { type: OutcomeType; spot: Vec2 } | null = null;
  private pendingTackleTimer = 0;

  constructor(app: GameApp, offensePlay: OffensePlay, defensePlay: DefensePlay) {
    this.app = app;
    this.offensePlay = offensePlay;
    this.defensePlay = defensePlay;
    this.cpu = new CPUOffense(app.match.difficulty);
  }

  enter(): void {
    const m = this.app.match;
    this.offenseTeamId = m.possession;
    this.humanIsOffense = m.possession === m.humanTeam;
    this.dir = m.attackDir(this.offenseTeamId);
    this.startLosX = m.losX;

    const defTeamId = m.opponent(this.offenseTeamId);
    this.offense = buildOffense(this.offensePlay, this.offenseTeamId, m.losX, this.dir);
    this.defense = buildDefense(defTeamId, m.losX, this.dir);
    this.all = [...this.offense, ...this.defense];
    this.qb = this.offense.find((p) => p.role === "QB") ?? null;

    // Ball starts with the QB.
    if (this.qb) this.ball.attachTo(this.qb);

    const ctx = this.context();
    assignDefense(ctx, this.defensePlay.scheme);

    // Choose who the human controls.
    if (this.humanIsOffense) {
      this.controlled = this.qb;
    } else {
      this.controlled = this.nearestDefenderToBall();
    }
    if (this.controlled) this.controlled.controlled = true;

    this.phase = "presnap";
    this.snapTimer = PRESNAP_TIME;
    this.preSnapReady = false;
    this.cpuHikeTimer = -1;
    this.playTime = 0;
    this.passThrown = false;
    this.sackPossible = true;
    this.turbo = 1;

    // Break the huddle: scatter players off their spots so they walk to the line.
    this.setupPreSnap();

    this.app.scene3d.setVisible(true);
    this.app.scene3d.resetAvatars();
    if (this.qb) this.app.scene3d.snapCamera(this.qb.pos.x, this.qb.pos.y, this.dir);
    this.app.input.setLayout(this.controls.computeLayout(this.app.r));
    this.app.audio.startCrowd();
  }

  private context(): PlayContext {
    return {
      offense: this.offense,
      defense: this.defense,
      ball: this.ball,
      qb: this.qb,
      carrier: this.ball.carrier,
      losX: this.startLosX,
      dir: this.dir,
      isRun: this.offensePlay.isRun,
    };
  }

  private nearestDefenderToBall(): Player | null {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const d of this.defense) {
      const dd = dist(d.pos, this.ball.pos);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  }

  // --- update ---------------------------------------------------------------

  update(dt: number): void {
    const m = this.app.match;

    if (this.phase === "presnap") {
      this.updatePreSnap(dt);
      return;
    }
    if (this.phase === "dead") {
      this.updateDeadBeat(dt);
      return;
    }

    this.playTime += dt;
    m.tickClock(dt);

    const ctx = this.context();
    this.handleHumanControl(dt);

    // AI for everyone not under human control.
    updateOffense(ctx, this.controlled);
    if (!this.humanIsOffense) {
      this.cpu.update(ctx, (from, target, receiver, power) => this.throwPass(from, target, receiver, power));
    }
    updateDefense(ctx, this.controlled);

    // While the ball is in the air, the target receiver attacks the catch point —
    // unless the human has taken control of them (then their input wins).
    if (
      this.ball.state === "inAir" &&
      this.passTarget &&
      !this.passTarget.isDown &&
      this.passTarget !== this.controlled
    ) {
      const t = this.ball.target;
      const p = this.passTarget;
      const dx = t.x - p.pos.x;
      const dy = t.y - p.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      p.desired = { x: dx / d, y: dy / d };
      p.turbo = true;
    }

    // QB faces downfield while dropping back in the pocket (so the drop reads as a
    // backpedal); once he scrambles past the line or throws, he faces his movement.
    if (this.qb) {
      const behind = this.dir > 0 ? this.qb.pos.x < this.startLosX : this.qb.pos.x > this.startLosX;
      const inPocket = this.ball.carrier === this.qb && !this.passThrown && !this.offensePlay.isRun && behind;
      this.qb.lookDir = inPocket ? (this.dir > 0 ? 0 : Math.PI) : null;
    }

    // Apply on-fire flames at carriers' feet + a turbo speed trail.
    this.spawnFireFx();
    this.spawnTurboTrail();

    // Integrate movement.
    this.moveAll(dt);
    this.resolveBodies();

    // Ball + passing.
    const landed = this.ball.update(dt);
    if (this.ball.state === "inAir") {
      const res = resolveAir(
        this.ball,
        this.offense,
        this.defense,
        landed,
        DIFFICULTY[m.difficulty].pick,
        this.passTarget,
      );
      if (res) this.resolvePassResult(res);
    } else if (this.ball.state === "loose" && landed) {
      // (loose handled in tackle/fumble path)
    }

    // A tackle in progress wraps up over the contact beat, then the whistle blows.
    if (this.pendingTackle) {
      this.pendingTackleTimer -= dt;
      if (this.pendingTackleTimer <= 0) {
        const pt = this.pendingTackle;
        this.pendingTackle = null;
        this.endPlay(pt.type, pt.spot);
      }
    } else {
      this.checkTackles();
      this.checkBoundaries();
    }

    if (this.playTime > MAX_PLAY_TIME && this.phase === "live" && !this.pendingTackle) {
      this.endPlay("tackle", this.ballSpot());
    }

    this.syncScene(dt);
  }

  /** Push the current sim state into the 3D scene (positions + camera). */
  private syncScene(dt: number): void {
    const m = this.app.match;
    const focus = this.ball.carrier
      ? this.ball.carrier.pos
      : this.ball.state === "inAir"
        ? this.ball.pos
        : this.qb
          ? this.qb.pos
          : { x: this.startLosX, y: this.app.field.maxY / 2 };
    this.app.scene3d.sync({
      players: this.all,
      ball: this.ball,
      colorFor: (p) => this.colorFor(p),
      focusX: focus.x,
      focusY: focus.y,
      dir: this.dir,
      losX: this.startLosX,
      firstDownX: m.firstDownX,
      shakeX: this.app.shake.offsetX,
      shakeY: this.app.shake.offsetY,
      dt,
    });
  }

  private colorFor(p: Player): { jersey: number; trim: number; onFire: boolean; defense: boolean } {
    const team = this.app.match.team(p.team);
    return {
      jersey: hexNum(team.colors.jersey),
      trim: hexNum(team.colors.trim),
      onFire: team.onFire,
      defense: p.team !== this.offenseTeamId,
    };
  }

  /** Break the huddle: scatter players off their formation spots (which are stored in
   * p.home) so they walk to the line during pre-snap. */
  private setupPreSnap(): void {
    const cy = this.app.field.maxY / 2;
    const huddleX = this.startLosX - this.dir * PX_PER_YARD * 7;
    this.offense.forEach((p, i) => {
      if (p.role === "QB") {
        p.pos = { x: this.startLosX - this.dir * PX_PER_YARD * 4, y: cy };
      } else {
        const ang = (i / this.offense.length) * Math.PI * 2;
        p.pos = { x: huddleX + Math.cos(ang) * PX_PER_YARD * 2.2, y: cy + Math.sin(ang) * PX_PER_YARD * 2.2 };
      }
      p.vel.x = 0;
      p.vel.y = 0;
      this.faceTowardHome(p);
      p.lookDir = null;
    });
    // Defense jogs up to the line from a couple of yards downfield.
    for (const d of this.defense) {
      d.pos = { x: d.home.x + this.dir * PX_PER_YARD * 3, y: d.home.y };
      d.vel.x = 0;
      d.vel.y = 0;
      this.faceTowardHome(d);
      d.lookDir = null;
    }
  }

  /** Point a player at the spot they're about to walk to (so the break reads as a
   * clean forward jog instead of a sideways/backward shuffle while the heading catches up). */
  private faceTowardHome(p: Player): void {
    const dx = p.home.x - p.pos.x;
    const dy = p.home.y - p.pos.y;
    p.heading = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : this.dir > 0 ? 0 : Math.PI;
  }

  /** Walk everyone from the huddle to their spots; the player decides when to hike. */
  private updatePreSnap(dt: number): void {
    let allSet = true;
    for (const p of this.all) {
      const dx = p.home.x - p.pos.x;
      const dy = p.home.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      const isDef = p.team !== this.offenseTeamId;
      if (d > 6) {
        p.desired = { x: dx / d, y: dy / d };
        p.lookDir = null; // face the way they're walking
        // Per-role pace keyed to base speed so every role reads as the same clean
        // jog (a flat speed under/over-warps the run blend by role).
        p.step(dt, p.baseSpeed * 0.8);
        allSet = false;
      } else {
        // Arrived: hard-stop and set facing so the player stands cleanly in idle,
        // with no muddy decel tail or jitter around the mark.
        p.vel.x = 0;
        p.vel.y = 0;
        p.desired = { x: 0, y: 0 };
        // Settle facing: offense toward downfield, defense toward the offense.
        p.lookDir = isDef ? (this.dir > 0 ? Math.PI : 0) : (this.dir > 0 ? 0 : Math.PI);
        p.step(dt, 0);
      }
    }
    this.preSnapReady = allSet;

    // Defenders can cycle which man they'll control before the snap (pick your matchup).
    if (!this.humanIsOffense && this.app.input.actionPressed) this.cycleDefender();

    if (allSet) {
      if (this.humanIsOffense) {
        if (this.app.input.actionPressed) this.snap();
      } else {
        if (this.cpuHikeTimer < 0) this.cpuHikeTimer = 0.7 + Math.random() * 0.8;
        this.cpuHikeTimer -= dt;
        if (this.cpuHikeTimer <= 0) this.snap();
      }
    }

    // Safety fallback so the play can't hard-stall.
    this.snapTimer -= dt;
    if (this.snapTimer <= 0) this.snap();

    this.syncScene(dt);
  }

  private snap(): void {
    this.phase = "live";
    this.app.audio.snap();
    for (const p of this.all) p.lookDir = null; // hand facing back to AI/movement
    if (this.offensePlay.isRun) {
      // Immediate handoff to the back.
      const hb = this.offense.find((p) => p.role === "HB");
      if (hb && this.qb) {
        this.ball.attachTo(hb);
        if (this.humanIsOffense) {
          this.setControlled(hb);
        }
      }
    }
  }

  private handleHumanControl(dt: number): void {
    const input = this.app.input;
    const c = this.controlled;

    if (!c || c.isDown) {
      // No live controlled player (e.g. ball in air). Defense switches to the nearest
      // defender to the ball; offense grabs the targeted receiver to go up for it.
      if (input.actionPressed) {
        if (!this.humanIsOffense) this.switchDefender();
        else if (this.ball.state === "inAir" && this.passTarget && !this.passTarget.isDown) {
          this.setControlled(this.passTarget);
        }
      }
      return;
    }

    // Movement.
    c.desired = { x: input.move.x, y: input.move.y };

    // Turbo meter management.
    const wantTurbo = input.turbo && (input.move.x !== 0 || input.move.y !== 0);
    if (wantTurbo && this.turbo > 0.02) {
      c.turbo = true;
      this.turbo = Math.max(0, this.turbo - 0.5 * (1 / 60));
    } else {
      c.turbo = false;
      this.turbo = Math.min(1, this.turbo + 0.25 * (1 / 60));
    }

    if (this.humanIsOffense) {
      // The one ACTION button is contextual: the QB (a legal passer behind the line)
      // charges a throw (tap = lob, hold = bullet); any ball carrier jukes/dives.
      if (this.canThrow(c)) {
        this.updateThrowCharge(c, dt);
      } else {
        this.throwCharging = false;
        this.throwCharge = 0;
        if (this.ball.carrier === c) this.updateCarrierAction(c, dt);
      }
    } else {
      this.handleDefenseAction(c);
    }
  }

  /** True when the controlled player is the QB and may legally throw (behind the line,
   * still holding the ball, on a pass play). */
  private canThrow(c: Player): boolean {
    const behind = this.dir > 0 ? c.pos.x <= this.startLosX + 4 : c.pos.x >= this.startLosX - 4;
    return (
      c === this.qb && this.ball.carrier === this.qb && !this.passThrown && !this.offensePlay.isRun && behind
    );
  }

  /** Charge a throw while ACTION is held; release into a lob (tap) -> bullet (hold). */
  private updateThrowCharge(qb: Player, dt: number): void {
    const input = this.app.input;
    // Begin a charge only on a FRESH press, so the held hike press (same button)
    // doesn't carry over into the first live frame and auto-throw a lob.
    if (input.actionPressed) {
      this.throwCharging = true;
      this.throwCharge = 0;
    }
    if (this.throwCharging && input.action) {
      this.throwCharge = Math.min(THROW_CHARGE_MAX, this.throwCharge + dt);
    }
    if (this.throwCharging && input.actionReleased) {
      const power = clamp(this.throwCharge / THROW_CHARGE_MAX, 0, 1);
      this.throwCharging = false;
      this.throwCharge = 0;
      const receivers = this.offense.filter((p) => p.role !== "QB");
      const choice = chooseTarget(qb, receivers, this.defense, this.dir, input.move);
      if (choice) {
        const r = choice.receiver;
        // Lead the receiver by the resulting flight time so they run onto the ball.
        const speed = throwParams(power).speed;
        const flight = dist(qb.pos, r.pos) / speed;
        const lead = { x: r.pos.x + r.vel.x * flight * 0.9, y: r.pos.y + r.vel.y * flight * 0.9 };
        this.throwPass(qb, lead, r, power);
      }
    }
  }

  /** Ball-carrier ACTION: a quick tap jukes (sidestep), holding past a beat dives. */
  private updateCarrierAction(c: Player, dt: number): void {
    const input = this.app.input;
    if (input.actionPressed) {
      this.carrierHeld = 0;
      this.carrierFired = false;
    }
    if (input.action) {
      this.carrierHeld += dt;
      if (!this.carrierFired && this.carrierHeld >= DIVE_HOLD) {
        this.startDive(c);
        this.carrierFired = true;
      }
    }
    if (input.actionReleased && !this.carrierFired) {
      this.doJuke(c);
      this.carrierFired = true;
    }
  }

  /** Juke: brief tackle-immunity + a lateral burst in the aim direction that preserves
   * forward momentum (a real sidestep, not a teleport). */
  private doJuke(c: Player): void {
    c.jukeTimer = 0.45;
    const aim = this.app.input.move;
    const am = Math.hypot(aim.x, aim.y);
    if (am > 0.3) {
      c.vel.x += (aim.x / am) * 80;
      c.vel.y += (aim.y / am) * 80;
      const cross = c.vel.x * (aim.y / am) - c.vel.y * (aim.x / am);
      c.leanTarget = Math.sign(cross) || 1;
    } else {
      c.vel.x += Math.cos(c.facing) * 55;
      c.vel.y += Math.sin(c.facing) * 55;
    }
    c.animEvent = "juke";
    this.app.audio.juke();
    this.app.particles.burst(c.pos.x, c.pos.y, "#ffffff", 8, 90);
  }

  /** Defender ACTION is contextual: a dive tackle when on top of the carrier, otherwise
   * switch to the defender best placed to make the play. */
  private handleDefenseAction(c: Player): void {
    if (!this.app.input.actionPressed) return;
    if (this.defenderInTackleRange(c)) {
      c.diveTimer = 0.32;
      c.vel.x += Math.cos(c.facing) * 95;
      c.vel.y += Math.sin(c.facing) * 95;
    } else {
      this.switchDefender();
    }
  }

  /** Is this defender close enough to the carrier that ACTION should be a tackle? */
  private defenderInTackleRange(c: Player): boolean {
    const carrier = this.ball.carrier;
    return !!carrier && !carrier.isDown && dist(c.pos, carrier.pos) < DEF_TACKLE_RANGE;
  }

  private startDive(c: Player): void {
    c.diveTimer = 0.34;
    c.vel.x += Math.cos(c.facing) * 85;
    c.vel.y += Math.sin(c.facing) * 85;
    this.app.particles.burst(c.pos.x, c.pos.y, "#cfe8d4", 6, 70);
    // The dive ends the play shortly after, securing the spot.
  }

  /** Switch to the defender best placed to make a play: nearest to the carrier, or to
   * the pass's landing spot while the ball is in the air, or to the loose ball. */
  private switchDefender(): void {
    const point = this.ball.carrier
      ? this.ball.carrier.pos
      : this.ball.state === "inAir"
        ? this.ball.target
        : this.ball.pos;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const d of this.defense) {
      if (d.isDown || d === this.controlled) continue;
      const dd = dist(d.pos, point);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    if (best) this.setControlled(best);
  }

  /** Cycle control through the defenders (used pre-snap to pick your matchup). */
  private cycleDefender(): void {
    const list = this.defense.filter((d) => !d.isDown);
    if (list.length === 0) return;
    const idx = this.controlled ? list.indexOf(this.controlled) : -1;
    this.setControlled(list[(idx + 1) % list.length]);
  }

  private setControlled(p: Player | null): void {
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = p;
    if (p) p.controlled = true;
  }

  /**
   * Throw the ball. `power` (0..1) blends a touch lob (0: high, floaty, slow) into a
   * bullet (1: flat, fast, tight spiral). A quick tap throws a lob; holding charges a
   * bullet. The receiver is led by the resulting flight time so fast WRs run onto it.
   */
  private throwPass(from: Player, target: Vec2, receiver: Player | null, power = 0.4): void {
    // Lob -> bullet: faster + flatter + a tighter, quicker spiral as power climbs.
    const { speed, loft, spin } = throwParams(power);
    this.ball.throwTo(from, target, speed, loft, spin);
    this.passThrown = true;
    this.passTarget = receiver;
    from.animEvent = "pass";
    this.app.audio.throwBall();
    // The thrower's side has no carrier until the catch, so the offense human drops to
    // no-control (and can grab a receiver in the air). A defending human KEEPS their
    // defender so they can break on the ball.
    if (this.humanIsOffense) this.setControlled(null);
  }

  private resolvePassResult(res: { caught?: Player; intercepted?: Player; incomplete?: boolean }): void {
    if (res.caught) {
      this.ball.attachTo(res.caught);
      this.passTarget = null;
      res.caught.animEvent = "catch";
      this.app.audio.catchBall();
      this.app.floating.add("CAUGHT!", res.caught.pos.x, res.caught.pos.y - 20, { size: 18, color: "#bfffd0" });
      if (res.caught.team === this.app.match.humanTeam) this.app.audio.crowdCheer();
      if (res.caught.team === this.app.match.humanTeam && this.humanIsOffense) {
        this.setControlled(res.caught);
      }
    } else if (res.intercepted) {
      this.ball.attachTo(res.intercepted);
      res.intercepted.animEvent = "catch";
      this.app.audio.turnover();
      if (res.intercepted.team === this.app.match.humanTeam) this.app.audio.crowdCheer();
      else this.app.audio.crowdGroan();
      this.app.floating.add("PICKED!", res.intercepted.pos.x, res.intercepted.pos.y - 20, {
        size: 22,
        color: "#ff8a8a",
      });
      this.app.shake.add(0.4);
      this.endPlay("interception", { x: res.intercepted.pos.x, y: res.intercepted.pos.y });
    } else if (res.incomplete) {
      this.app.audio.whistle();
      if (this.humanIsOffense) this.app.audio.crowdGroan();
      this.app.floating.add("INCOMPLETE", this.ball.pos.x, this.ball.pos.y - 10, { size: 18, color: "#ddd" });
      // Let the ball skip/bounce at the spot during the dead beat.
      this.ball.becomeLoose(this.ball.vel.x * 0.3, this.ball.vel.y * 0.3, 120);
      this.endPlay("incomplete", { x: this.startLosX, y: this.ball.pos.y });
    }
  }

  // --- physics --------------------------------------------------------------

  private moveAll(dt: number): void {
    const m = this.app.match;
    // Defense ramps up after the snap so plays can develop; the rate scales with
    // difficulty (Rookie gives more pocket time and bigger lanes).
    const diff = DIFFICULTY[m.difficulty];
    const react = Math.min(1, diff.reactBase + this.playTime * diff.reactRate);
    for (const p of this.all) {
      if (p.isDown) {
        p.step(dt, 0);
        continue;
      }
      const onFire = m.team(p.team).onFire;
      const diving = p.diveTimer > 0;
      const isDefense = p.team !== this.offenseTeamId;
      let mult = isDefense ? DIFFICULTY[m.difficulty].cpuSpeed * react : 1;
      // A blocker latched onto a defender drags them to a crawl (opens lanes).
      if (isDefense && this.isEngagedByBlocker(p)) mult *= 0.32;
      // A covering DB is flat-footed for a beat when his receiver breaks, so the
      // receiver gains real separation out of the cut.
      if (isDefense && p.job === "cover" && p.assignment && p.assignment.cutTimer > 0) mult *= 0.55;
      // Glancing-hit stumble drains a beat of speed.
      if (p.isStumbling) mult *= 0.5;
      const target = p.speedFor(p.turbo || diving, onFire) * mult;
      // The human-controlled player gets much snappier acceleration/turning.
      const accelMul = p === this.controlled ? 2.3 : 1;
      if (diving) {
        // Keep momentum during a dive (don't steer).
        p.step(dt, Math.hypot(p.vel.x, p.vel.y));
      } else {
        p.step(dt, target, accelMul);
      }
      p.pos.y = this.app.field.clampY(p.pos.y);
    }
  }

  /** True if an offensive blocker is currently latched onto this defender. */
  private isEngagedByBlocker(d: Player): boolean {
    for (const o of this.offense) {
      if (o.job !== "block" || o.isDown) continue;
      const rr = o.radius + d.radius + 12;
      const dx = o.pos.x - d.pos.x;
      const dy = o.pos.y - d.pos.y;
      if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
  }

  /** Push overlapping bodies apart so blockers wall defenders (blocking emerges). */
  private resolveBodies(): void {
    const carrier = this.ball.carrier;
    for (let i = 0; i < this.all.length; i++) {
      const a = this.all[i];
      if (a.isDown) continue;
      for (let j = i + 1; j < this.all.length; j++) {
        const b = this.all[j];
        if (b.isDown) continue;
        // The carrier's collisions are resolved by tackle logic, not separation.
        if (a === carrier || b === carrier) continue;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const min = a.radius + b.radius;
        if (d > 0 && d < min) {
          const overlap = min - d;
          if (overlap < 0.4) continue; // slop: ignore micro-overlaps to avoid buzzing
          const nx = dx / d;
          const ny = dy / d;
          // Blockers are "heavier": the other body gets pushed more.
          const aMass = a.job === "block" ? 3 : 1;
          const bMass = b.job === "block" ? 3 : 1;
          const total = aMass + bMass;
          // Partial (spring-like) correction each frame instead of a hard teleport;
          // the geometric series still fully separates over a few frames.
          const c = 0.5;
          a.pos.x -= nx * overlap * (bMass / total) * c;
          a.pos.y -= ny * overlap * (bMass / total) * c;
          b.pos.x += nx * overlap * (aMass / total) * c;
          b.pos.y += ny * overlap * (aMass / total) * c;

          // Collision impulse: only when the two are actually closing, so contact
          // has weight (a bump) without jitter on resting/leaning bodies.
          const relN = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
          if (relN < 0) {
            const j = -relN * 0.45;
            a.vel.x -= nx * j * (bMass / total);
            a.vel.y -= ny * j * (bMass / total);
            b.vel.x += nx * j * (aMass / total);
            b.vel.y += ny * j * (aMass / total);
          }
        }
      }
    }
  }

  private checkTackles(): void {
    const carrier = this.ball.carrier;
    if (!carrier || carrier.isDown || this.phase !== "live") return;

    for (const d of this.defense) {
      if (d.isDown) continue;
      const reach = d.diveTimer > 0 ? d.radius + carrier.radius + 10 : (d.radius + carrier.radius) * 0.95;
      if (dist(d.pos, carrier.pos) > reach) continue;

      // Juke: the carrier shrugs the first tackler and the defender whiffs.
      if (carrier.jukeTimer > 0) {
        carrier.jukeTimer = 0;
        d.knockDown(0.8);
        this.app.particles.burst(d.pos.x, d.pos.y, "#ffffff", 6, 80);
        continue;
      }

      const closing = Math.hypot(d.vel.x - carrier.vel.x, d.vel.y - carrier.vel.y);
      const big = d.turbo || d.diveTimer > 0 || closing > 150;

      // Glancing side-hit: stumble (stay up, lose a beat) instead of a clean tackle.
      if (!big && this.tryStumble(carrier, d, closing)) return;

      // Break tackle: shrug off hits (much easier on weak hits / with turbo).
      if (this.tryBreakTackle(carrier, d, big)) continue;

      this.doTackle(d, carrier, big, closing);
      return;
    }
  }

  /** Attempt to break a tackle. Returns true if the carrier stays up. */
  private tryBreakTackle(carrier: Player, tackler: Player, big: boolean): boolean {
    if (this.playTime - this.lastBreak < 0.55) return false;
    // Big hits can only be broken by powering through with turbo.
    let p = big ? (carrier.turbo ? 0.25 : 0.06) : carrier.turbo ? 0.6 : 0.38;
    if (this.defendersNear(carrier, 32) >= 2) p *= 0.4; // gang tackles still win
    if (Math.random() >= p) return false;
    this.lastBreak = this.playTime;
    tackler.knockDown(0.7);
    carrier.vel.x *= 0.78;
    carrier.vel.y *= 0.78;
    this.app.particles.burst(tackler.pos.x, tackler.pos.y, "#ffffff", 7, 90);
    this.app.audio.juke();
    this.app.shake.add(0.14);
    this.app.floating.add("BROKE IT!", carrier.pos.x, carrier.pos.y, { size: 18, color: "#bfffd0", life: 0.8 });
    return true;
  }

  private defendersNear(p: Player, radius: number): number {
    let n = 0;
    const r2 = radius * radius;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dx = d.pos.x - p.pos.x;
      const dy = d.pos.y - p.pos.y;
      if (dx * dx + dy * dy < r2) n++;
    }
    return n;
  }

  /** Glancing side-hit: the carrier staggers but stays up. Returns true if applied. */
  private tryStumble(carrier: Player, tackler: Player, closing: number): boolean {
    if (this.playTime - this.lastBreak < 0.5) return false;
    const cv = Math.hypot(carrier.vel.x, carrier.vel.y);
    if (cv < 45 || closing > 110 || this.defendersNear(carrier, 28) >= 2) return false;
    const hvx = tackler.pos.x - carrier.pos.x;
    const hvy = tackler.pos.y - carrier.pos.y;
    const hl = Math.hypot(hvx, hvy) || 1;
    const dot = (carrier.vel.x / cv) * (hvx / hl) + (carrier.vel.y / cv) * (hvy / hl);
    if (dot > 0.5) return false; // tackler is square in front -> real tackle, not a brush

    carrier.enterStumble(0.28);
    // Nudge away from the hit + lean to that side.
    carrier.vel.x -= (hvx / hl) * 30;
    carrier.vel.y -= (hvy / hl) * 30;
    const cross = carrier.vel.x * hvy - carrier.vel.y * hvx;
    carrier.leanTarget = Math.sign(cross) || 1;
    this.app.time.slow(0.85, 0.12);
    this.app.shake.add(0.1);
    this.app.particles.burst((carrier.pos.x + tackler.pos.x) / 2, (carrier.pos.y + tackler.pos.y) / 2, "#ffffff", 5, 70);
    this.app.audio.hit(0.3);
    return true;
  }

  private doTackle(tackler: Player, carrier: Player, big: boolean, closing: number): void {
    const hx = (tackler.pos.x + carrier.pos.x) / 2;
    const hy = (tackler.pos.y + carrier.pos.y) / 2;
    const fumbleChance = big ? 0.08 : 0.02;
    const dirX = carrier.pos.x - tackler.pos.x;
    const dirY = carrier.pos.y - tackler.pos.y;
    const dl = Math.hypot(dirX, dirY) || 1;

    // Impact FX fire at contact start, so the hit-stop/slow-mo plays over the wrap-up.
    if (big) {
      this.app.time.bigHit();
      this.app.shake.add(0.55);
      this.app.particles.spark(hx, hy, dirX, dirY, 18);
      this.app.audio.hit(Math.min(1, closing / 260 + 0.4));
      this.app.floating.add(pickHitWord(), hx, hy - 16, { size: 28, color: "#ffd23a" });
      this.app.audio.crowdCheer();
    } else {
      this.app.time.slow(0.6, 0.12);
      this.app.shake.add(0.2);
      this.app.particles.burst(hx, hy, "#d9c7a0", 8, 110);
      this.app.audio.hit(0.4);
    }

    // Shared fall momentum: carrier + tackler travel together (with forward progress).
    const fwd = big ? 60 : 28;
    const bvx = (carrier.vel.x + tackler.vel.x) * 0.5 + (dirX / dl) * fwd;
    const bvy = (carrier.vel.y + tackler.vel.y) * 0.5 + (dirY / dl) * fwd;
    const beat = big ? 0.32 : 0.22;
    const spot = { x: carrier.pos.x + (dirX / dl) * (big ? 8 : 3), y: carrier.pos.y };

    let type: OutcomeType;
    if (chance(fumbleChance)) {
      this.app.floating.add("FUMBLE!", hx, hy - 40, { size: 26, color: "#ff6a6a" });
      this.app.audio.turnover();
      this.ball.becomeLoose((dirX / dl) * 120 + (Math.random() * 80 - 40), (dirY / dl) * 120 + (Math.random() * 80 - 40), 220);
      const recoverDefense = chance(0.6);
      if (recoverDefense) {
        const defenseIsHuman = this.app.match.opponent(this.offenseTeamId) === this.app.match.humanTeam;
        if (defenseIsHuman) this.app.audio.crowdCheer();
        else this.app.audio.crowdGroan();
        this.bumpFireStreakOnDefense();
        type = "fumbleLost";
      } else {
        type = this.sackIfBehindLine(spot);
      }
    } else {
      if (tackler.team !== this.offenseTeamId && big) this.bumpFireStreakOnDefense();
      type = this.sackIfBehindLine(spot);
    }

    // Both players wrap up and go down together; the whistle blows after the beat.
    carrier.enterContact(bvx, bvy, beat);
    tackler.enterContact(bvx * 0.55, bvy * 0.55, beat);
    tackler.facing = Math.atan2(dirY, dirX);
    tackler.heading = tackler.facing;
    this.pendingTackle = { type, spot };
    this.pendingTackleTimer = beat;
  }

  private sackIfBehindLine(spot: Vec2): OutcomeType {
    const carrierWasQB = this.ball.carrier?.role === "QB";
    const behind = this.dir > 0 ? spot.x < this.startLosX : spot.x > this.startLosX;
    if (carrierWasQB && behind && this.sackPossible) return "sack";
    return "tackle";
  }

  private bumpFireStreakOnDefense(): void {
    const defTeam = this.app.match.team(this.app.match.opponent(this.offenseTeamId));
    defTeam.streak++;
    if (defTeam.igniteIfReady()) {
      this.app.audio.fire();
      const s = this.ballSpot();
      this.app.floating.add("ON FIRE!", s.x, s.y, { size: 30, color: "#ff8a1e", life: 1.4 });
    }
  }

  private checkBoundaries(): void {
    const carrier = this.ball.carrier;
    if (!carrier || this.phase !== "live") return;

    // Touchdown: carrier reaches the attacking end zone.
    const inAttackEndzone =
      this.offenseTeamId === "HOME" ? carrier.pos.x >= RIGHT_GOAL_X : carrier.pos.x <= LEFT_GOAL_X;
    if (inAttackEndzone) {
      this.scoreTouchdown(carrier);
      return;
    }

    // Safety: ball carrier down in their own end zone is handled by tackle spot;
    // detect crossing into own end zone here as an immediate safety.
    const inOwnEndzone =
      this.offenseTeamId === "HOME" ? carrier.pos.x <= LEFT_GOAL_X : carrier.pos.x >= RIGHT_GOAL_X;
    if (inOwnEndzone) {
      this.app.floating.add("SAFETY!", carrier.pos.x, carrier.pos.y - 20, { size: 24, color: "#ff9a9a" });
      this.endPlay("safety", { x: carrier.pos.x, y: carrier.pos.y });
      return;
    }

    // Out of bounds (sidelines).
    if (carrier.pos.y <= this.app.field.minY + 3 || carrier.pos.y >= this.app.field.maxY - 3) {
      this.app.audio.whistle();
      this.endPlay("outOfBounds", { x: carrier.pos.x, y: carrier.pos.y });
    }
  }

  private scoreTouchdown(carrier: Player): void {
    this.app.audio.airHorn();
    if (carrier.team === this.app.match.humanTeam) {
      this.app.audio.crowdCheer();
      this.app.audio.organCharge();
    } else {
      this.app.audio.crowdGroan();
    }
    this.app.shake.add(0.6);
    this.app.particles.confetti(carrier.pos.x, carrier.pos.y, 50);
    this.app.floating.add("TOUCHDOWN!", carrier.pos.x, carrier.pos.y - 30, { size: 34, color: "#ffd23a", life: 1.6 });
    this.app.time.slow(0.4, 0.5);
    // Offense scoring extends an on-fire streak chance.
    this.endPlay("touchdown", { x: carrier.pos.x, y: carrier.pos.y });
  }

  private ballSpot(): Vec2 {
    const c = this.ball.carrier;
    return c ? { x: c.pos.x, y: c.pos.y } : { x: this.ball.pos.x, y: this.ball.pos.y };
  }

  private endPlay(type: OutcomeType, spot: Vec2): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    if (this.controlled) this.controlled.controlled = false;
    this.passTarget = null;

    const m = this.app.match;
    const gained = (spot.x - this.startLosX) * this.dir / PX_PER_YARD;
    const possessionAfter =
      type === "interception" || type === "fumbleLost" || type === "safety"
        ? m.opponent(this.offenseTeamId)
        : this.offenseTeamId;

    this.pendingOutcome = {
      type,
      ballX: spot.x,
      ballY: spot.y,
      possessionAfter,
      yards: Math.round(gained),
      firstDown: false,
      headline: headlineFor(type, Math.round(gained)),
    };
    // Linger on the field so the player sees how the play ended, then show the banner.
    this.deadTimer =
      type === "touchdown" ? 1.6 : type === "interception" || type === "fumbleLost" ? 1.3 : 0.85;
  }

  /** Post-whistle beat: bodies settle and FX play out before the result screen. */
  private updateDeadBeat(dt: number): void {
    this.deadTimer -= dt;
    for (const p of this.all) p.step(dt, 0); // coast to a stop
    this.ball.update(dt);
    this.spawnFireFx();
    // Tap/ACTION skips straight to the result.
    if (this.deadTimer <= 0 || this.app.input.actionPressed) {
      this.commitOutcome();
      return;
    }
    this.syncScene(dt);
  }

  private committed = false;
  private commitOutcome(): void {
    if (this.committed || !this.pendingOutcome) return;
    this.committed = true;
    this.app.audio.stopCrowd();
    this.app.setState(new PlayResultState(this.app, this.pendingOutcome));
  }

  private spawnTurboTrail(): void {
    const c = this.controlled;
    if (!c || c.isDown || !c.turbo) return;
    if (Math.hypot(c.vel.x, c.vel.y) < 50) return;
    this.app.particles.trail(c.pos.x, c.pos.y);
  }

  private spawnFireFx(): void {
    const m = this.app.match;
    for (const p of this.all) {
      if (p.isDown) continue;
      if (m.team(p.team).onFire && (p.hasBall || p.controlled)) {
        this.app.particles.fire(p.pos.x, p.pos.y + p.radius * 0.4, 2);
      }
    }
  }

  // --- render ---------------------------------------------------------------

  render(): void {
    const app = this.app;
    const r = app.r;
    const m = app.match;

    // The 3D field + players are drawn to the WebGL canvas; sync happens in update().
    app.scene3d.render();

    // FX and UI are drawn on the transparent 2D overlay above the 3D scene.
    const project = this.project;
    app.particles.render(r, project);
    this.renderPassHints(r);
    this.renderThrowMeter(r);
    app.floating.render(r, project);

    this.hud.render(r, m, {
      turbo: this.turbo,
      possessionLabel: this.phase === "presnap" ? this.preSnapLabel() : undefined,
      playClock: this.phase === "presnap" ? this.snapTimer : undefined,
    });
    app.input.setLayout(this.controls.computeLayout(r));
    this.controls.render(r, app.input, this.controlLabels());
  }

  /** Pre-snap HUD prompt: break-the-huddle while walking, hike prompt once set. */
  private preSnapLabel(): string {
    if (!this.humanIsOffense) {
      return this.preSnapReady ? "DEFENSE — TAP TO SWITCH" : "DEFENSE — BREAK THE HUDDLE";
    }
    return this.preSnapReady ? "TAP ACTION TO HIKE" : "BREAKING THE HUDDLE…";
  }

  /** Projector bound to the 3D camera, for overlay FX/text. */
  private project = (x: number, y: number, h: number) => this.app.scene3d.project(x, y, h);

  /** Reticles over eligible receivers (green=open) + a highlight on the target. */
  private renderPassHints(r: Renderer): void {
    if (!this.humanIsOffense || this.passThrown || this.offensePlay.isRun) return;
    if (!this.qb || this.ball.carrier !== this.qb) return;
    const ctx = r.ctx;
    const eligible = this.offense.filter((p) => p.role !== "QB" && p.job !== "block" && !p.isDown);
    const choice = chooseTarget(this.qb, this.offense.filter((p) => p.role !== "QB"), this.defense, this.dir, this.app.input.move);
    const target = choice?.receiver ?? null;

    for (const rcv of eligible) {
      const s = this.app.scene3d.project(rcv.pos.x, rcv.pos.y, 80);
      if (!s.visible) continue;
      const open = this.nearestDefDist(rcv);
      const color = open > 78 ? "#5dff7a" : open > 44 ? "#ffd23a" : "#ff5a5a";
      const isTarget = rcv === target;
      const size = isTarget ? 13 : 8;
      const y = s.y - (isTarget ? 4 : 0);
      ctx.save();
      ctx.globalAlpha = isTarget ? 1 : 0.75;
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, y + size);
      ctx.lineTo(s.x - size * 0.8, y);
      ctx.lineTo(s.x + size * 0.8, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (isTarget) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(s.x, y - 1, size + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** A charging-throw power bar above the QB: green lob -> red bullet as you hold. */
  private renderThrowMeter(r: Renderer): void {
    if (!this.throwCharging || !this.qb) return;
    const t = clamp(this.throwCharge / THROW_CHARGE_MAX, 0, 1);
    const s = this.app.scene3d.project(this.qb.pos.x, this.qb.pos.y, 130);
    if (!s.visible) return;
    const ctx = r.ctx;
    const w = 56;
    const h = 8;
    const x = s.x - w / 2;
    const y = s.y - 34;
    const cr = Math.round(lerp(80, 255, t));
    const cg = Math.round(lerp(230, 80, t));
    const cb = Math.round(lerp(160, 40, t));
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(x, y, w * t, h);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#fff";
    ctx.font = 'bold 11px "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(t > 0.66 ? "BULLET" : t < 0.33 ? "LOB" : "PASS", s.x, y - 4);
    ctx.restore();
  }

  private nearestDefDist(p: Player): number {
    let m = Infinity;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dd = dist(d.pos, p.pos);
      if (dd < m) m = dd;
    }
    return m;
  }

  /** The single ACTION button morphs by situation (the rest is procedural in the
   * control handlers). Keep this label in sync with what ACTION actually does. */
  private controlLabels(): ControlLabels {
    const blue = "#1c6fd0";
    const green = "#1f9d4d";
    const grey = "#5a6b7a";

    if (this.phase === "presnap") {
      return this.humanIsOffense
        ? { action: { text: "HIKE", icon: "pass", color: green } }
        : { action: { text: "SWITCH", icon: "switch", color: blue } };
    }

    if (this.humanIsOffense) {
      const c = this.controlled;
      if (c && this.canThrow(c)) return { action: { text: "PASS", icon: "pass", color: blue } };
      if (c && this.ball.carrier === c) return { action: { text: "JUKE", icon: "juke", color: green } };
      if (this.ball.state === "inAir") return { action: { text: "CATCH", icon: "pass", color: green } };
      return { action: { text: "—", icon: "switch", color: grey } };
    }

    // Defense: tackle when on the carrier, otherwise switch.
    if (this.controlled && this.defenderInTackleRange(this.controlled)) {
      return { action: { text: "TACKLE", icon: "tackle", color: green } };
    }
    return { action: { text: "SWITCH", icon: "switch", color: blue } };
  }

  exit(): void {
    this.app.audio.stopCrowd();
  }
}

/** Convert a "#rrggbb" CSS color to a numeric hex for Three.js materials. */
function hexNum(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}

function pickHitWord(): string {
  const words = ["BOOM!", "POW!", "CRUNCH!", "WHAM!", "LEVELED!"];
  return words[Math.floor(Math.random() * words.length)];
}

function headlineFor(type: OutcomeType, yards: number): string {
  switch (type) {
    case "touchdown":
      return "TOUCHDOWN!";
    case "interception":
      return "INTERCEPTED!";
    case "fumbleLost":
      return "FUMBLE — TURNOVER!";
    case "safety":
      return "SAFETY!";
    case "sack":
      return `SACKED! ${yards} yd`;
    case "incomplete":
      return "INCOMPLETE";
    case "outOfBounds":
      return `OUT OF BOUNDS · ${yards >= 0 ? "+" : ""}${yards} yd`;
    default:
      return `${yards >= 0 ? "+" : ""}${yards} yd`;
  }
}
