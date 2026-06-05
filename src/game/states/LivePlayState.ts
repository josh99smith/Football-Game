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
import { FONT, COLORS } from "../../ui/Theme";
import { drawPanel } from "../../ui/widgets";
import { LEFT_GOAL_X, RIGHT_GOAL_X, PX_PER_YARD } from "../Field";
import type { Match, PlayOutcome, OutcomeType } from "../Match";
import { PlayCallOverlay } from "../../ui/PlayCallOverlay";
import { cpuOffensePlay, cpuDefensePlay } from "../ai/PlayCaller";
import { KickoffState } from "./KickoffState";
import { GameOverState } from "./GameOverState";

type Phase = "presnap" | "live" | "dead" | "playcall";

// Pre-snap is player-controlled now; this is only a safety fallback so a play can't
// hard-stall if the hike is never pressed.
const PRESNAP_TIME = 20;
const MAX_PLAY_TIME = 16;
/** Hard cap on the post-play beat so it can't hang if the player never taps. */
const POSTPLAY_MAX = 9;
/** Minimum post-play beat before a tap can skip to the play call (guarantees a post-play). */
const MIN_DEAD_LINGER = 0.7;
/** Hold this long (s) to fully charge a bullet pass; a quick tap throws a lob. */
const THROW_CHARGE_MAX = 0.5;
/** Hold the ACTION button this long (s) as a ball carrier to dive instead of juke. */
const DIVE_HOLD = 0.22;
/** A defender within this distance (px) of the carrier tackles on ACTION (else switches). */
const DEF_TACKLE_RANGE = 70;

/** Map throw power (0 lob .. 1 bullet) to launch parameters. Single source of truth.
 * Lobs get an exaggerated, floaty arc; bullets are flat and fast with a tighter spiral. */
function throwParams(power: number): { speed: number; loft: number; spin: number } {
  const p = Math.max(0, Math.min(1, power));
  return { speed: lerp(290, 590, p), loft: lerp(2.9, 0.65, p), spin: lerp(24, 54, p) };
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
  private offensePlay: OffensePlay; // re-armed each down from the play-call overlay
  private defensePlay: DefensePlay;

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
  /** Applied-outcome result (drives the on-field result banner + routing). */
  private playResult: ReturnType<Match["applyOutcome"]> | null = null;
  /** Secondary line under the result headline (FIRST DOWN! / TURNOVER! / down & dist). */
  private resultDetail = "";
  /** Minimum settle/celebration time before players regroup toward the huddle. */
  private deadTimer = 0;
  /** Total time spent post-whistle (drives the regroup + the hard auto-advance). */
  private deadElapsed = 0;
  /** Where each player ambles back to during the post-play regroup (lazy). */
  private regroupTargets: Map<Player, Vec2> | null = null;
  /** Players currently mid physics-ragdoll (indices into `all`); the whistle waits for them. */
  private ragdollIdx: number[] = [];
  /** Hold the post-play beat until the physics fall + get-up finishes. */
  private holdForRagdoll = false;
  /** Camera subject while a ragdoll tackle plays out (the ball carrier going down). */
  private ragdollFocus: Player | null = null;
  /** Ball spot the play ended at (anchors the regroup huddle). */
  private endSpot: Vec2 = { x: 0, y: 0 };
  /** The offense huddle center — the camera subject between downs. */
  private huddleCenter: Vec2 | null = null;
  /** Where the play finished (ball spot) — the camera subject during the post-play beat. */
  private deadFocus: Vec2 | null = null;
  /** Broadcast play-call overlay shown over the live field between downs, with fade-in. */
  private playCall = new PlayCallOverlay();
  private playCallT = 0;
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
    // Persistent, once-per-state-lifetime setup. This state now lives across the whole drive:
    // it stays mounted through the between-downs play-call overlay and re-arms each play in
    // place (so the 3D field keeps living behind the broadcast-style call), instead of bouncing
    // out to a separate play-select screen.
    this.app.scene3d.setVisible(true);
    this.app.input.setLayout(this.controls.computeLayout(this.app.r));
    this.app.audio.startCrowd();
    this.showHint = !LivePlayState.hintShown;
    if (import.meta.env.DEV) (window as unknown as { __live: LivePlayState }).__live = this;
    this.armPlay(this.offensePlay, this.defensePlay);
  }

  /** Build a fresh down for the given call against the current match state, then go pre-snap.
   *  Called on entry and again for every subsequent play picked from the overlay. */
  private armPlay(offensePlay: OffensePlay, defensePlay: DefensePlay): void {
    const m = this.app.match;
    this.offensePlay = offensePlay;
    this.defensePlay = defensePlay;
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
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = this.humanIsOffense ? this.qb : this.nearestDefenderToBall();
    if (this.controlled) this.controlled.controlled = true;

    // Per-play state (reset every down since the state is reused across the drive).
    this.phase = "presnap";
    this.snapTimer = PRESNAP_TIME;
    this.preSnapReady = false;
    this.cpuHikeTimer = -1;
    this.playTime = 0;
    this.passThrown = false;
    this.passTarget = null;
    this.sackPossible = true;
    this.turbo = 1;
    this.pendingTackle = null;
    this.pendingTackleTimer = 0;
    this.pendingOutcome = null;
    this.playResult = null;
    this.committed = false;
    this.deadTimer = 0;
    this.deadElapsed = 0;
    this.regroupTargets = null;
    this.huddleCenter = null;
    this.deadFocus = null;
    this.ragdollIdx = [];
    this.holdForRagdoll = false;
    this.ragdollFocus = null;

    // Break the huddle: scatter players off their spots so they walk to the line.
    this.setupPreSnap();

    this.app.scene3d.resetAvatars();
    if (this.qb) this.app.scene3d.snapCamera(this.qb.pos.x, this.qb.pos.y, this.dir);
  }

  /** DEV-only: force the ball carrier to be tackled by the nearest defender (headless tests). */
  debugForceTackle(big = true, hitStick = false): boolean {
    if (this.phase !== "live") return false;
    const carrier = this.ball.carrier ?? this.qb;
    if (!carrier) return false;
    let tackler: Player | null = null;
    let best = Infinity;
    for (const d of this.all) {
      if (d.team === carrier.team) continue;
      const dd = dist(d.pos, carrier.pos);
      if (dd < best) { best = dd; tackler = d; }
    }
    if (!tackler) return false;
    // Place the defender right on the carrier so the hit lands this frame.
    tackler.pos = { x: carrier.pos.x - 6, y: carrier.pos.y };
    this.doTackle(tackler, carrier, big || hitStick, 220, hitStick);
    return true;
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
    if (this.phase === "playcall") {
      this.updatePlayCall(dt);
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
      const f = this.app.field;
      const res = resolveAir(
        this.ball,
        this.offense,
        this.defense,
        landed,
        DIFFICULTY[m.difficulty].pick,
        { minX: f.minX, maxX: f.maxX, minY: f.minY, maxY: f.maxY },
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
      this.checkBigHitWhiff();
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
    this.trackRagdolls(); // glue ragdolling players to their physics hips before we frame them
    const busy = this.holdForRagdoll && this.app.scene3d.ragdollsBusy();
    const focus = busy && this.ragdollFocus
      ? this.ragdollFocus.pos // stay on the body being driven into the ground
      : this.phase === "playcall" && this.huddleCenter
        ? this.huddleCenter // ease onto the offense huddle while the call is up
        : this.phase === "dead" && this.deadFocus
          ? this.deadFocus // hold on where the play finished (incompletion / down spot)
          : this.ball.carrier
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
    const huddleX = this.startLosX - this.dir * PX_PER_YARD * 5;
    this.offense.forEach((p, i) => {
      if (p.role === "QB") {
        p.pos = { x: this.startLosX - this.dir * PX_PER_YARD * 4, y: cy };
      } else {
        const ang = (i / this.offense.length) * Math.PI * 2;
        p.pos = { x: huddleX + Math.cos(ang) * PX_PER_YARD * 1.6, y: cy + Math.sin(ang) * PX_PER_YARD * 1.6 };
      }
      p.vel.x = 0;
      p.vel.y = 0;
      this.faceTowardHome(p);
      p.lookDir = null;
    });
    // Defense jogs up to the line from a couple of yards downfield.
    for (const d of this.defense) {
      d.pos = { x: d.home.x + this.dir * PX_PER_YARD * 2.5, y: d.home.y };
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
        // Brisk jog to the line — keep the break-the-huddle read but don't dawdle.
        p.step(dt, p.baseSpeed * 0.62);
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
    const elapsed = PRESNAP_TIME - this.snapTimer;

    if (this.humanIsOffense) {
      // Hurry-up: hike the instant you're set, or after a brief grace if you're impatient.
      if (this.app.input.actionPressed && (allSet || elapsed > 0.8)) this.snap();
    } else {
      // On defense, ACTION cycles which man you'll control; the CPU hikes once set.
      if (this.app.input.actionPressed) this.cycleDefender();
      if (allSet) {
        if (this.cpuHikeTimer < 0) this.cpuHikeTimer = 0.5 + Math.random() * 0.5;
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

  /** Defender ACTION is contextual: unleash a committed BIG HIT when near the carrier,
   * otherwise switch to the defender best placed to make the play. The big hit explodes
   * forward — connect for a devastating, fumble-forcing launch; whiff and you overcommit. */
  private handleDefenseAction(c: Player): void {
    if (!this.app.input.actionPressed) return;
    if (c.diveTimer > 0) return; // already committed to a lunge
    if (this.defenderInTackleRange(c)) {
      c.diveTimer = 0.3;
      c.bigHitArmed = true;
      c.leanTarget = 0.7; // shoulder dips into the hit (the avatar banks)
      const burst = 165;
      c.vel.x += Math.cos(c.facing) * burst;
      c.vel.y += Math.sin(c.facing) * burst;
      this.app.particles.burst(c.pos.x, c.pos.y, "#dce6ff", 6, 80);
      this.app.shake.add(0.12);
    } else {
      this.switchDefender();
    }
  }

  /** A committed big hit that didn't connect leaves the defender overcommitted: when the lunge
   *  window closes without a tackle, they stumble (and the carrier slips by). The risk side. */
  private checkBigHitWhiff(): void {
    for (const d of this.defense) {
      if (d.bigHitArmed && d.diveTimer <= 0) {
        d.bigHitArmed = false;
        d.enterStumble(0.5);
        this.app.particles.burst(d.pos.x, d.pos.y, "#9aa6b8", 5, 70);
        if (d === this.controlled) this.app.floating.add("WHIFF!", d.pos.x, d.pos.y - 18, { size: 18, color: "#cdd6e6", life: 0.8 });
      }
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

  private resolvePassResult(res: { caught?: Player; intercepted?: Player; incomplete?: boolean; swatBy?: Player }): void {
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
      if (res.swatBy) res.swatBy.animEvent = "swat"; // defender bats the pass down
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
      const hitStick = d.bigHitArmed && d.diveTimer > 0; // a committed big hit connected
      const big = hitStick || d.turbo || d.diveTimer > 0 || closing > 150;

      // Glancing side-hit: stumble (stay up, lose a beat) instead of a clean tackle.
      if (!big && this.tryStumble(carrier, d, closing)) return;

      // Break tackle: shrug off hits (much easier on weak hits / with turbo). A clean big hit
      // can't be shrugged off.
      if (!hitStick && this.tryBreakTackle(carrier, d, big)) continue;

      this.doTackle(d, carrier, big, closing, hitStick);
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

  private doTackle(tackler: Player, carrier: Player, big: boolean, closing: number, hitStick = false): void {
    tackler.bigHitArmed = false; // consumed
    const hx = (tackler.pos.x + carrier.pos.x) / 2;
    const hy = (tackler.pos.y + carrier.pos.y) / 2;
    // A committed big hit forces a fumble far more often (it's the whole risk/reward).
    const fumbleChance = hitStick ? 0.28 : big ? 0.08 : 0.02;
    const dirX = carrier.pos.x - tackler.pos.x;
    const dirY = carrier.pos.y - tackler.pos.y;
    const dl = Math.hypot(dirX, dirY) || 1;

    // Impact FX fire at contact start: a quick freeze-punch, then bullet-time slow-mo while the
    // camera pushes in tight on the collision, so the hit reads in dramatic slow motion.
    if (big) {
      this.app.time.freeze(hitStick ? 0.08 : 0.05);
      this.app.time.bulletTime(hitStick ? 0.1 : 0.14, hitStick ? 0.7 : 0.55, 0.85);
      this.app.scene3d.hitZoom(hitStick ? 0.9 : 0.7);
      this.app.shake.add(hitStick ? 0.85 : 0.55);
      this.app.particles.spark(hx, hy, dirX, dirY, hitStick ? 26 : 18);
      this.app.audio.hit(Math.min(1, closing / 260 + (hitStick ? 0.7 : 0.4)));
      this.app.floating.add(hitStick ? "BIG HIT!" : pickHitWord(), hx, hy - 16, { size: hitStick ? 34 : 28, color: hitStick ? "#ff5a3a" : "#ffd23a" });
      this.app.audio.crowdCheer();
    } else {
      this.app.time.bulletTime(0.3, 0.22, 0.45);
      this.app.scene3d.hitZoom(0.32);
      this.app.shake.add(0.2);
      this.app.particles.burst(hx, hy, "#d9c7a0", 8, 110);
      this.app.audio.hit(0.4);
    }

    // Shared fall momentum: carrier + tackler travel together (with forward progress). A big
    // hit launches the carrier back the way they came (negative progress) for the highlight.
    const fwd = hitStick ? 95 : big ? 60 : 28;
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
    carrier.animEvent = "tackle"; // the carrier's getting-tackled reaction (canned fallback)
    tackler.enterContact(bvx * 0.55, bvy * 0.55, beat);
    tackler.animEvent = "tackleMade"; // the defender's tackle hit (canned fallback)
    tackler.facing = Math.atan2(dirY, dirX);
    tackler.heading = tackler.facing;
    this.pendingTackle = { type, spot };
    this.pendingTackleTimer = beat;

    // Physics tackle: hand the carrier (and the tackler driving him down) to the ragdoll,
    // replacing the canned clips. A big hit drives the ragdoll harder for a bigger launch.
    this.startRagdollTackle(carrier, tackler, dirX, dirY, hitStick ? closing + 180 : closing, big);
  }

  /** Spawn physics ragdolls for the two players in a collision and hold the whistle for the
   *  full fall + get-up. The carrier and tackler get distinct collision bits so they tumble
   *  near each other without their bodies exploding into one another. */
  private startRagdollTackle(carrier: Player, tackler: Player, dirX: number, dirY: number, closing: number, big: boolean): void {
    const scene = this.app.scene3d;
    const ci = this.all.indexOf(carrier);
    const ti = this.all.indexOf(tackler);
    const carrierDown = ci >= 0 && scene.startRagdoll(ci, {
      hitDirX: dirX, hitDirY: dirY, closingPx: closing, carryVx: carrier.vel.x, carryVy: carrier.vel.y, big, bit: 0x0002,
    });
    // The tackler is thrown back along the hit (opposite the carrier) at a lighter strength.
    const tacklerDown = ti >= 0 && scene.startRagdoll(ti, {
      hitDirX: -dirX, hitDirY: -dirY, closingPx: closing * 0.6, carryVx: tackler.vel.x, carryVy: tackler.vel.y, big, bit: 0x0004,
    });
    this.ragdollIdx = [];
    if (carrierDown) this.ragdollIdx.push(ci);
    if (tacklerDown) this.ragdollIdx.push(ti);
    this.holdForRagdoll = this.ragdollIdx.length > 0;
    this.ragdollFocus = carrierDown ? carrier : null;
  }

  /** Keep each ragdolling player's sim position glued to its physics hips, so the camera, the
   *  ball spot and the selection follow the tumbling body. */
  private trackRagdolls(): void {
    if (!this.holdForRagdoll) return;
    for (const idx of this.ragdollIdx) {
      const hips = this.app.scene3d.ragdollHipsPx(idx);
      const p = this.all[idx];
      if (hips && p) { p.pos.x = hips.x; p.pos.y = this.app.field.clampY(hips.y); }
    }
  }

  /** Classify a tackle at `spot`: a safety if downed in the offense's own end zone, a
   * sack if the QB is dropped behind the line, otherwise a normal tackle. */
  private sackIfBehindLine(spot: Vec2): OutcomeType {
    const inOwnEndzone = this.offenseTeamId === "HOME" ? spot.x <= LEFT_GOAL_X : spot.x >= RIGHT_GOAL_X;
    if (inOwnEndzone) {
      this.app.floating.add("SAFETY!", spot.x, spot.y - 20, { size: 24, color: "#ff9a9a" });
      return "safety";
    }
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

    // A safety is NOT called just for being in your own end zone (the QB can snap or
    // drop back there) — only when the carrier is tackled/downed there. That's handled
    // at the tackle spot in classifyTackle().

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
    // The whole scoring unit breaks into a celebration during the post-play beat.
    this.celebrate(this.scoringTeamPlayers(carrier));
    this.endPlay("touchdown", { x: carrier.pos.x, y: carrier.pos.y });
  }

  /** Players on the same team as `p` who are upright (eligible to celebrate). */
  private scoringTeamPlayers(p: Player): Player[] {
    return this.all.filter((q) => q.team === p.team && !q.isDown);
  }

  /** Trigger the celebration animation on a group of players (staggered a touch). */
  private celebrate(players: Player[]): void {
    for (const p of players) {
      p.vel.x = 0;
      p.vel.y = 0;
      p.animEvent = "celebrate";
    }
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

    const outcome: PlayOutcome = {
      type,
      ballX: spot.x,
      ballY: spot.y,
      possessionAfter,
      yards: Math.round(gained),
      firstDown: false,
      headline: headlineFor(type, Math.round(gained)),
    };
    this.pendingOutcome = outcome;

    // Apply the result to the rules NOW (so the HUD reflects it during the on-field
    // beat) and build the result lines shown on the field — there's no separate banner
    // screen anymore; a single tap goes straight to the next play.
    this.playResult = m.applyOutcome(outcome);
    this.resultDetail = this.buildResultDetail();

    // Clock: the quarter only advances between plays (not mid-down). Show a beat.
    if (m.clockExpired && !m.isOver) {
      const ev = m.advanceQuarter();
      const label = ev === "half" ? "HALFTIME" : ev === "game" ? "FINAL" : `END OF Q${m.quarter - 1}`;
      this.app.floating.add(label, this.app.field.maxX / 2, this.app.field.maxY / 2, { size: 30, color: COLORS.hazard, life: 2 });
    }

    // Post-play: a short settle/celebration, then players regroup and amble toward the
    // huddle until the player taps to continue (or the hard cap elapses).
    this.deadTimer =
      type === "touchdown" ? 2.6
      : type === "interception" || type === "fumbleLost" ? 1.8
      : type === "incomplete" ? 1.8 // let the throwaway read + receivers pull up, not an instant cut
      : 1.4;
    this.deadElapsed = 0;
    this.endSpot = { x: spot.x, y: spot.y };
    this.regroupTargets = null;
    // Hold the post-play camera on where the play actually finished (the ball — i.e. an
    // incompletion at the catch point, or the spot of the down), not back on the QB.
    const bs = this.ballSpot();
    this.deadFocus = { x: bs.x, y: bs.y };
    // Drain any stale taps so input from the play itself (e.g. a quick tap-throw leaves a tap in
    // the buffer, since the live phase never consumes taps) can't instantly skip the post-play.
    this.app.input.consumeTaps();
  }

  /** The line under the result headline, read from the applied match state. */
  private buildResultDetail(): string {
    const m = this.app.match;
    const res = this.playResult;
    if (res?.scored && res.scoringTeam) return `${m.team(res.scoringTeam).config.name.toUpperCase()} SCORE!`;
    if (this.pendingOutcome?.firstDown) {
      this.app.audio.firstDownChime();
      return "FIRST DOWN!";
    }
    if (res?.changedPossession) return "TURNOVER!";
    return `${ordinal(m.down)} & ${m.distanceYards}`;
  }

  /**
   * Post-whistle beat: bodies settle / the score is celebrated, then players amble back
   * toward the huddle while the result lingers on the field. It waits for a tap to skip
   * to the result + play call, with a hard cap so it can never hang.
   */
  private updateDeadBeat(dt: number): void {
    this.deadTimer -= dt;
    this.deadElapsed += dt;
    // A brief on-field result beat: the whistle blows, the result reads, players settle / the
    // ball-carrier's ragdoll finishes falling and gets up. We DON'T cut away — the camera holds
    // on the play and then the broadcast play-call comes up as an overlay (commitOutcome), with
    // the field still living behind it. The hold respects an in-progress ragdoll tackle.
    const busy = this.holdForRagdoll && this.app.scene3d.ragdollsBusy();
    for (const p of this.all) p.step(dt, 0); // coast to a stop / lie tackled / celebrate in place
    this.ball.update(dt);
    this.spawnFireFx();
    // The beat advances on its own once the result has shown and any tackle has resolved. A
    // deliberate tap can skip ahead, but only after a brief minimum linger — so input from the
    // play itself (a tap-throw, a held action button) can't instantly cut the post-play. We
    // drain taps every frame regardless, and the action button is NOT a skip (it's gameplay).
    const tapped = this.app.input.consumeTaps().length > 0;
    const beatDone = this.deadTimer <= 0 && !busy;
    const skipped = tapped && this.deadElapsed >= MIN_DEAD_LINGER;
    if (beatDone || skipped || this.deadElapsed >= POSTPLAY_MAX) {
      this.commitOutcome();
      return;
    }
    this.syncScene(dt);
  }

  /** Open the between-downs play-call as a broadcast overlay over the still-live field. */
  private enterPlayCall(): void {
    const m = this.app.match;
    this.phase = "playcall";
    this.playCallT = 0;
    this.computeRegroupTargets();
    this.playCall.layout(this.app.r, m.possession === m.humanTeam);
    this.app.input.consumeTaps(); // don't let the skip-tap also pick a card
  }

  /**
   * Between-downs broadcast view: the cards are overlaid while the field keeps living —
   * players amble back to the huddle and settle, the camera eases onto the huddle — until the
   * human picks a play, which arms the next down in place (no cut to a separate screen).
   */
  private updatePlayCall(dt: number): void {
    const m = this.app.match;
    this.playCallT = Math.min(1, this.playCallT + dt * 3);
    for (const p of this.all) {
      if (!p.isDown) this.walkToRegroup(p, dt); // jog back to the huddle, then idle there
      else p.step(dt, 0);
    }
    this.ball.update(dt);
    this.spawnFireFx();

    const pick = this.playCall.pick(this.app.input.consumeTaps());
    if (pick) {
      this.app.audio.uiConfirm();
      // The human picks their side; the CPU calls the opposing play situationally.
      const off = pick.off ?? cpuOffensePlay(m);
      const def = pick.def ?? cpuDefensePlay(m);
      this.armPlay(off, def);
      return;
    }
    this.syncScene(dt);
  }

  /** Amble a player back toward a loose post-play huddle (offense) / their side (defense). */
  private walkToRegroup(p: Player, dt: number): void {
    if (!this.regroupTargets) this.computeRegroupTargets();
    const t = this.regroupTargets!.get(p);
    if (!t) {
      p.step(dt, 0);
      return;
    }
    const dx = t.x - p.pos.x;
    const dy = t.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 8) {
      p.desired = { x: dx / d, y: dy / d };
      p.lookDir = null;
      p.step(dt, p.baseSpeed * 0.45); // a relaxed walk back
      p.pos.y = this.app.field.clampY(p.pos.y);
    } else {
      p.desired = { x: 0, y: 0 };
      p.step(dt, 0);
    }
  }

  /** Place a loose huddle a few yards behind the dead-ball spot (offense side) and let
   * the defense drift to their side, clamped to the field. */
  private computeRegroupTargets(): void {
    const targets = new Map<Player, Vec2>();
    const f = this.app.field;
    const cy = f.maxY / 2;
    const clampX = (x: number) => Math.max(LEFT_GOAL_X + 16, Math.min(RIGHT_GOAL_X - 16, x));
    const huddleX = clampX(this.endSpot.x - this.dir * PX_PER_YARD * 7);
    this.huddleCenter = { x: huddleX, y: cy }; // camera subject between downs
    this.offense.forEach((o, i) => {
      const ang = (i / this.offense.length) * Math.PI * 2;
      targets.set(o, { x: huddleX + Math.cos(ang) * PX_PER_YARD * 2, y: cy + Math.sin(ang) * PX_PER_YARD * 2 });
    });
    const defX = clampX(this.endSpot.x + this.dir * PX_PER_YARD * 6);
    this.defense.forEach((dpl, i) => {
      targets.set(dpl, { x: defX, y: f.clampY(cy + (i - this.defense.length / 2) * PX_PER_YARD * 4) });
    });
    this.regroupTargets = targets;
  }

  /** Show the one-time controls hint on the first live play of the session. */
  private static hintShown = false;
  private showHint = false;

  /** A fading, contextual controls hint shown once at the start of a session. */
  private renderControlHint(r: Renderer): void {
    if (!this.showHint) return;
    // Fade out once the play has been live a few seconds, then retire it for good.
    const fade = this.phase === "live" ? Math.max(0, 1 - (this.playTime - 2) / 2) : 1;
    if (this.phase === "live" && this.playTime > 4) {
      this.showHint = false;
      LivePlayState.hintShown = true;
      return;
    }
    const msg = this.humanIsOffense
      ? "STICK: MOVE   ·   HOLD: PASS / TAP: JUKE   ·   TURBO: SPRINT"
      : "STICK: MOVE   ·   TAP: SWITCH / TACKLE   ·   TURBO: SPRINT";
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "1px";
    r.text(msg, r.width / 2, r.height - 84, {
      size: 13,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      alpha: 0.85 * fade,
      font: FONT.ui,
    });
    ctx.restore();
  }

  private committed = false;
  private commitOutcome(): void {
    if (this.committed || !this.playResult) return;
    this.committed = true;
    const m = this.app.match;
    const res = this.playResult;
    if (m.isOver) {
      this.app.audio.stopCrowd();
      this.app.setState(new GameOverState(this.app));
    } else if (res.kickoff && res.kickReceiver) {
      // A score is its own sequence (kickoff/return); cut to it.
      this.app.audio.stopCrowd();
      this.app.setState(new KickoffState(this.app, res.kickReceiver));
    } else {
      // Normal play-to-play (incl. turnovers on the field): stay mounted and bring up the
      // play-call as a broadcast overlay while players jog back to the huddle behind it.
      this.enterPlayCall();
    }
  }

  private spawnTurboTrail(): void {
    const c = this.controlled;
    if (!c || c.isDown || !c.turbo) return;
    const sp = Math.hypot(c.vel.x, c.vel.y);
    if (sp < 50) return;
    // Stream embers off the trailing foot (just behind the run direction).
    const bx = c.pos.x - (c.vel.x / sp) * 9;
    const by = c.pos.y - (c.vel.y / sp) * 9;
    this.app.particles.trail(bx, by);
    this.app.particles.trail(bx, by);
  }

  private spawnFireFx(): void {
    const m = this.app.match;
    for (const p of this.all) {
      if (p.isDown) continue;
      if (m.team(p.team).onFire && (p.hasBall || p.controlled)) {
        // A subtle flame aura on the hot ball-carrier (not a bonfire).
        this.app.particles.fire(p.pos.x, p.pos.y + p.radius * 0.4, 2, 0.7);
      }
    }
  }

  // --- render ---------------------------------------------------------------

  render(alpha = 1): void {
    const app = this.app;
    const r = app.r;
    const m = app.match;

    // The 3D field + players are drawn to the WebGL canvas; sync happens in update().
    // `alpha` is the fixed-step remainder used to interpolate body/ball/camera motion.
    app.scene3d.render(alpha);

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

    if (this.phase === "dead") {
      this.renderResultBanner(r);
    } else if (this.phase === "playcall") {
      // Broadcast-style call over the live field (players jogging back to the huddle behind it).
      this.renderResultBanner(r, false);
      this.playCall.render(r, { alpha: this.playCallT });
    } else {
      app.input.setLayout(this.controls.computeLayout(r));
      this.controls.render(r, app.input, this.controlLabels());
      if (this.phase === "live" || this.phase === "presnap") this.renderControlHint(r);
    }
  }

  /** On-field result banner during the post-play beat (replaces the old banner screen). */
  private renderResultBanner(r: Renderer, showTapPrompt = true): void {
    if (!this.pendingOutcome) return;
    const w = Math.min(440, r.width - 48);
    const h = 92;
    const x = (r.width - w) / 2;
    const y = 54;
    drawPanel(r, { x, y, w, h });
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "1px";
    r.text(this.pendingOutcome.headline.toUpperCase(), r.width / 2, y + 34, {
      size: 30,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      font: FONT.display,
    });
    ctx.restore();
    r.text(this.resultDetail, r.width / 2, y + 68, { size: 17, align: "center", color: COLORS.blood, baseline: "middle", font: FONT.ui });
    if (!showTapPrompt) return;
    const a = 0.5 + 0.5 * Math.sin(this.deadElapsed * 4);
    r.text("TAP TO CONTINUE", r.width / 2, r.height - 24, {
      size: 15,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      alpha: a,
      font: FONT.display,
    });
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

    // Defense: a committed BIG HIT when on the carrier, otherwise switch.
    if (this.controlled && this.defenderInTackleRange(this.controlled)) {
      return { action: { text: "BIG HIT", icon: "tackle", color: "#d23a2a" } };
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

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
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
