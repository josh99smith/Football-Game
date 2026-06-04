import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { dist, type Vec2 } from "../../engine/math/Vec2";
import { chance } from "../../engine/math/random";
import { Player } from "../entities/Player";
import { Ball } from "../entities/Ball";
import { buildDefense, buildOffense, type OffensePlay, type DefensePlay } from "../Playbook";
import { assignDefense, updateDefense, type PlayContext } from "../ai/DefenseAI";
import { updateOffense } from "../ai/OffenseAI";
import { CPUOffense } from "../ai/CPUOffense";
import { chooseTarget, resolveAir } from "../Passing";
import { HUD } from "../../ui/HUD";
import { TouchControls } from "../../ui/TouchControls";
import { LEFT_GOAL_X, RIGHT_GOAL_X, PX_PER_YARD } from "../Field";
import type { PlayOutcome, OutcomeType } from "../Match";
import { PlayResultState } from "./PlayResultState";

type Phase = "presnap" | "live" | "dead";

const PRESNAP_TIME = 0.9;
const MAX_PLAY_TIME = 16;
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
  private snapTimer = PRESNAP_TIME;
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
    this.playTime = 0;
    this.passThrown = false;
    this.sackPossible = true;
    this.turbo = 1;

    this.app.scene3d.setVisible(true);
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
      this.snapTimer -= dt;
      // Offense can hike early with ACTION; otherwise auto-snap.
      if (this.snapTimer <= 0 || (this.humanIsOffense && this.app.input.actionPressed)) {
        this.snap();
      }
      this.syncScene(dt);
      return;
    }
    if (this.phase === "dead") {
      this.updateDeadBeat(dt);
      return;
    }

    this.playTime += dt;
    m.tickClock(dt);

    const ctx = this.context();
    this.handleHumanControl();

    // AI for everyone not under human control.
    updateOffense(ctx, this.controlled);
    if (!this.humanIsOffense) {
      this.cpu.update(ctx, (from, target, receiver) => this.throwPass(from, target, receiver));
    }
    updateDefense(ctx, this.controlled);

    // While the ball is in the air, the target receiver attacks the catch point.
    if (this.ball.state === "inAir" && this.passTarget && !this.passTarget.isDown) {
      const t = this.ball.target;
      const p = this.passTarget;
      const dx = t.x - p.pos.x;
      const dy = t.y - p.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      p.desired = { x: dx / d, y: dy / d };
      p.turbo = true;
    }

    // Apply on-fire flames at carriers' feet.
    this.spawnFireFx();

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
      );
      if (res) this.resolvePassResult(res);
    } else if (this.ball.state === "loose" && landed) {
      // (loose handled in tackle/fumble path)
    }

    this.checkTackles();
    this.checkBoundaries();

    if (this.playTime > MAX_PLAY_TIME && this.phase === "live") {
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

  private colorFor(p: Player): { jersey: number; trim: number; onFire: boolean } {
    const team = this.app.match.team(p.team);
    return {
      jersey: hexNum(team.colors.jersey),
      trim: hexNum(team.colors.trim),
      onFire: team.onFire,
    };
  }

  private snap(): void {
    this.phase = "live";
    this.app.audio.snap();
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

  private handleHumanControl(): void {
    const input = this.app.input;
    const c = this.controlled;

    if (!c || c.isDown) {
      // No live controlled player (e.g. ball in air): allow defense pre-switch.
      if (!this.humanIsOffense && input.actionPressed) this.switchDefender();
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
      this.handleOffenseAction(c, input.actionPressed, input.doubleTapped);
    } else {
      this.handleDefenseAction(c, input.actionPressed, input.doubleTapped);
    }
  }

  private handleOffenseAction(c: Player, pressed: boolean, doubleTap: boolean): void {
    if (!pressed && !doubleTap) return;
    const carrier = this.ball.carrier;

    if (c === this.qb && carrier === this.qb && !this.passThrown && !this.offensePlay.isRun) {
      // QB throws to the receiver indicated by the joystick aim.
      const receivers = this.offense.filter((p) => p.role !== "QB");
      const choice = chooseTarget(this.qb, receivers, this.defense, this.dir, this.app.input.move);
      if (choice) this.throwPass(this.qb, choice.point, choice.receiver);
      return;
    }

    // Ball carrier moves.
    if (carrier === c) {
      if (doubleTap) {
        // Spin/juke: brief tackle-immunity + burst.
        c.jukeTimer = 0.45;
        c.vel.x += Math.cos(c.facing) * 65;
        c.vel.y += Math.sin(c.facing) * 65;
        this.app.audio.juke();
        this.app.particles.burst(c.pos.x, c.pos.y, "#ffffff", 8, 90);
      } else if (pressed) {
        // Dive: lunge forward for extra yards, then you're down.
        this.startDive(c);
      }
    }
  }

  private handleDefenseAction(c: Player, pressed: boolean, doubleTap: boolean): void {
    if (doubleTap) {
      // Dive tackle: lunge with a larger tackle radius for a moment.
      c.diveTimer = 0.32;
      c.vel.x += Math.cos(c.facing) * 95;
      c.vel.y += Math.sin(c.facing) * 95;
    } else if (pressed) {
      this.switchDefender();
    }
  }

  private startDive(c: Player): void {
    c.diveTimer = 0.34;
    c.vel.x += Math.cos(c.facing) * 85;
    c.vel.y += Math.sin(c.facing) * 85;
    this.app.particles.burst(c.pos.x, c.pos.y, "#cfe8d4", 6, 70);
    // The dive ends the play shortly after, securing the spot.
  }

  private switchDefender(): void {
    const target = this.ball.carrier ?? null;
    if (!target) return;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dd = dist(d.pos, target.pos);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    if (best) this.setControlled(best);
  }

  private setControlled(p: Player | null): void {
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = p;
    if (p) p.controlled = true;
  }

  private throwPass(from: Player, target: Vec2, receiver: Player | null): void {
    const distToTarget = dist(from.pos, target);
    // Slower, loftier passes give the receiver time to get under the ball.
    const speed = 300 + Math.min(170, distToTarget * 0.5);
    const loft = distToTarget > 300 ? 1.7 : 1.3;
    this.ball.throwTo(from, target, speed, loft);
    this.passThrown = true;
    this.passTarget = receiver;
    this.app.audio.throwBall();
    // After the throw, no one is controlled until a catch resolves.
    this.setControlled(null);
  }

  private resolvePassResult(res: { caught?: Player; intercepted?: Player; incomplete?: boolean }): void {
    if (res.caught) {
      this.ball.attachTo(res.caught);
      this.passTarget = null;
      this.app.audio.catchBall();
      this.app.floating.add("CAUGHT!", res.caught.pos.x, res.caught.pos.y - 20, { size: 18, color: "#bfffd0" });
      if (res.caught.team === this.app.match.humanTeam && this.humanIsOffense) {
        this.setControlled(res.caught);
      } else if (!this.humanIsOffense) {
        // CPU receiver now runs (driven by CPUOffense.steerCarrier).
      }
    } else if (res.intercepted) {
      this.ball.attachTo(res.intercepted);
      this.app.audio.turnover();
      this.app.floating.add("PICKED!", res.intercepted.pos.x, res.intercepted.pos.y - 20, {
        size: 22,
        color: "#ff8a8a",
      });
      this.app.shake.add(0.4);
      this.endPlay("interception", { x: res.intercepted.pos.x, y: res.intercepted.pos.y });
    } else if (res.incomplete) {
      this.app.audio.whistle();
      this.app.floating.add("INCOMPLETE", this.ball.pos.x, this.ball.pos.y - 10, { size: 18, color: "#ddd" });
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
      const target = p.speedFor(p.turbo || diving, onFire) * mult;
      if (diving) {
        // Keep momentum during a dive (don't steer).
        p.step(dt, Math.hypot(p.vel.x, p.vel.y));
      } else {
        p.step(dt, target);
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
          const nx = dx / d;
          const ny = dy / d;
          // Blockers are "heavier": the other body gets pushed more.
          const aMass = a.job === "block" ? 3 : 1;
          const bMass = b.job === "block" ? 3 : 1;
          const total = aMass + bMass;
          a.pos.x -= nx * overlap * (bMass / total);
          a.pos.y -= ny * overlap * (bMass / total);
          b.pos.x += nx * overlap * (aMass / total);
          b.pos.y += ny * overlap * (aMass / total);
        }
      }
    }
  }

  private checkTackles(): void {
    const carrier = this.ball.carrier;
    if (!carrier || this.phase !== "live") return;

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

  private doTackle(tackler: Player, carrier: Player, big: boolean, closing: number): void {
    const hx = (tackler.pos.x + carrier.pos.x) / 2;
    const hy = (tackler.pos.y + carrier.pos.y) / 2;

    // Fumble chance scales with hit power (Blitz-style strips) — kept rare so a
    // hard hit doesn't constantly cost possession.
    const fumbleChance = big ? 0.08 : 0.02;
    const dirX = carrier.pos.x - tackler.pos.x;
    const dirY = carrier.pos.y - tackler.pos.y;

    if (big) {
      this.app.time.bigHit();
      this.app.shake.add(0.55);
      this.app.particles.spark(hx, hy, dirX, dirY, 18);
      this.app.audio.hit(Math.min(1, closing / 260 + 0.4));
      this.app.floating.add(pickHitWord(), hx, hy - 16, { size: 28, color: "#ffd23a" });
      this.app.audio.crowdCheer();
    } else {
      this.app.shake.add(0.18);
      this.app.particles.burst(hx, hy, "#d9c7a0", 8, 110);
      this.app.audio.hit(0.35);
    }

    carrier.knockDown();
    tackler.facing = Math.atan2(dirY, dirX);

    if (chance(fumbleChance)) {
      // Fumble! Award recovery to whichever side is closer (slight defense bias).
      this.app.floating.add("FUMBLE!", hx, hy - 40, { size: 26, color: "#ff6a6a" });
      this.app.audio.turnover();
      const recoverDefense = chance(0.6);
      const spot = { x: carrier.pos.x, y: carrier.pos.y };
      if (recoverDefense) {
        // Defense recovers => turnover.
        this.bumpFireStreakOnDefense();
        this.endPlay("fumbleLost", spot);
      } else {
        // Offense recovers => down where it happened.
        this.endPlay(this.sackIfBehindLine(spot), spot);
      }
      return;
    }

    if (tackler.team !== this.offenseTeamId && big) this.bumpFireStreakOnDefense();
    this.endPlay(this.sackIfBehindLine({ x: carrier.pos.x, y: carrier.pos.y }), {
      x: carrier.pos.x,
      y: carrier.pos.y,
    });
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
    this.app.audio.score();
    this.app.audio.crowdCheer();
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
    app.floating.render(r, project);

    this.hud.render(r, m, {
      turbo: this.turbo,
      possessionLabel: this.phase === "presnap" ? (this.humanIsOffense ? "TAP ACTION TO HIKE" : "DEFENSE — TAP TO SWITCH") : undefined,
      playClock: this.phase === "presnap" ? this.snapTimer : undefined,
    });
    app.input.setLayout(this.controls.computeLayout(r));
    this.controls.render(r, app.input, this.controlLabels());
  }

  /** Projector bound to the 3D camera, for overlay FX/text. */
  private project = (x: number, y: number, h: number) => this.app.scene3d.project(x, y, h);

  private controlLabels(): { turbo: string; action: string } {
    if (this.humanIsOffense) {
      const isCarrier = this.ball.carrier === this.controlled;
      if (this.controlled === this.qb && !this.passThrown && !this.offensePlay.isRun) {
        return { turbo: "TURBO", action: "PASS" };
      }
      return { turbo: "TURBO", action: isCarrier ? "DIVE" : "—" };
    }
    return { turbo: "TURBO", action: "SWITCH" };
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
