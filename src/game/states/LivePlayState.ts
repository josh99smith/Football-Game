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
  rookie: { pick: 0.22, cpuSpeed: 0.95 },
  pro: { pick: 0.34, cpuSpeed: 1.0 },
  allpro: { pick: 0.48, cpuSpeed: 1.05 },
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

    this.app.cam.zoom = this.computeZoom();
    if (this.qb) this.app.cam.snapTo(this.qb.pos.x, this.qb.pos.y);
    this.app.input.setLayout(this.controls.computeLayout(this.app.r));
    this.app.audio.startCrowd();
  }

  private computeZoom(): number {
    // Fit the full field width to the screen height (leaving room for the HUD).
    const usableH = this.app.r.height - 80;
    return Math.max(0.5, Math.min(1.4, usableH / (53.3 * PX_PER_YARD + 60)));
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
      this.updateCamera(dt);
      return;
    }
    if (this.phase === "dead") return;

    this.playTime += dt;
    m.tickClock(dt);

    const ctx = this.context();
    this.handleHumanControl();

    // AI for everyone not under human control.
    updateOffense(ctx, this.controlled);
    if (!this.humanIsOffense) {
      this.cpu.update(ctx, (from, target) => this.throwPass(from, target));
    }
    updateDefense(ctx, this.controlled);

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

    this.updateCamera(dt);
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
      if (choice) this.throwPass(this.qb, choice.point);
      return;
    }

    // Ball carrier moves.
    if (carrier === c) {
      if (doubleTap) {
        // Spin/juke: brief tackle-immunity + burst.
        c.jukeTimer = 0.45;
        c.vel.x += Math.cos(c.facing) * 90;
        c.vel.y += Math.sin(c.facing) * 90;
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
      c.vel.x += Math.cos(c.facing) * 120;
      c.vel.y += Math.sin(c.facing) * 120;
    } else if (pressed) {
      this.switchDefender();
    }
  }

  private startDive(c: Player): void {
    c.diveTimer = 0.34;
    c.vel.x += Math.cos(c.facing) * 110;
    c.vel.y += Math.sin(c.facing) * 110;
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

  private throwPass(from: Player, target: Vec2): void {
    const distToTarget = dist(from.pos, target);
    const speed = 520 + Math.min(260, distToTarget * 0.7);
    const loft = distToTarget > 360 ? 1.5 : 1.0;
    this.ball.throwTo(from, target, speed, loft);
    this.passThrown = true;
    this.app.audio.throwBall();
    // After the throw, no one is controlled until a catch resolves.
    this.setControlled(null);
  }

  private resolvePassResult(res: { caught?: Player; intercepted?: Player; incomplete?: boolean }): void {
    if (res.caught) {
      this.ball.attachTo(res.caught);
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
    for (const p of this.all) {
      if (p.isDown) {
        p.step(dt, 0);
        continue;
      }
      const onFire = m.team(p.team).onFire;
      const diving = p.diveTimer > 0;
      const target = p.speedFor(p.turbo || diving, onFire) * (p.team === this.offenseTeamId ? 1 : DIFFICULTY[m.difficulty].cpuSpeed);
      if (diving) {
        // Keep momentum during a dive (don't steer).
        p.step(dt, Math.hypot(p.vel.x, p.vel.y));
      } else {
        p.step(dt, target);
      }
      p.pos.y = this.app.field.clampY(p.pos.y);
    }
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
      const reach = d.diveTimer > 0 ? d.radius + carrier.radius + 12 : d.radius + carrier.radius;
      if (dist(d.pos, carrier.pos) > reach) continue;

      // Juke: the carrier shrugs the first tackler and the defender whiffs.
      if (carrier.jukeTimer > 0) {
        carrier.jukeTimer = 0;
        d.knockDown(0.8);
        this.app.particles.burst(d.pos.x, d.pos.y, "#ffffff", 6, 80);
        continue;
      }

      // Tackle. Big hit if the defender is turbo/diving or closing fast.
      const closing = Math.hypot(d.vel.x - carrier.vel.x, d.vel.y - carrier.vel.y);
      const big = d.turbo || d.diveTimer > 0 || closing > 230;
      this.doTackle(d, carrier, big, closing);
      return;
    }
  }

  private doTackle(tackler: Player, carrier: Player, big: boolean, closing: number): void {
    const hx = (tackler.pos.x + carrier.pos.x) / 2;
    const hy = (tackler.pos.y + carrier.pos.y) / 2;

    // Fumble chance scales with hit power (Blitz-style strips).
    const fumbleChance = big ? 0.16 : 0.04;
    const dirX = carrier.pos.x - tackler.pos.x;
    const dirY = carrier.pos.y - tackler.pos.y;

    if (big) {
      this.app.time.bigHit();
      this.app.shake.add(0.55);
      this.app.particles.spark(hx, hy, dirX, dirY, 18);
      this.app.audio.hit(Math.min(1, closing / 380 + 0.4));
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
      this.app.floating.add("ON FIRE!", this.app.cam.cx, this.app.cam.cy - 60, {
        size: 30,
        color: "#ff8a1e",
      });
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
    this.app.audio.stopCrowd();

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
    this.app.setState(new PlayResultState(this.app, outcome));
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

  private updateCamera(dt: number): void {
    const focus = this.ball.carrier ?? (this.ball.state === "inAir" ? this.ballPos() : this.qb);
    if (focus) {
      const target = "pos" in focus ? focus.pos : focus;
      this.app.cam.follow(target as Vec2, 0.12, dt);
    }
    this.app.cam.clampToBounds(
      this.app.field.minX,
      this.app.field.minY,
      this.app.field.maxX,
      this.app.field.maxY,
    );
  }

  private ballPos(): { pos: Vec2 } {
    return { pos: this.ball.pos };
  }

  // --- render ---------------------------------------------------------------

  render(): void {
    const app = this.app;
    const r = app.r;
    const m = app.match;

    app.cam.apply(r.ctx, r.dpr);
    app.field.render(r, app.cam);
    this.renderMarkers();
    // Draw players sorted by Y for a pseudo-depth feel.
    const sorted = [...this.all].sort((a, b) => a.pos.y - b.pos.y);
    for (const p of sorted) {
      p.render(r, m.team(p.team).colors, m.team(p.team).onFire);
    }
    this.ball.render(r);
    app.particles.render(r);
    app.floating.render(r);
    app.cam.reset(r.ctx);

    // Screen-space UI.
    this.hud.render(r, m, {
      turbo: this.turbo,
      possessionLabel: this.phase === "presnap" ? (this.humanIsOffense ? "TAP ACTION TO HIKE" : "DEFENSE — TAP TO SWITCH") : undefined,
    });
    app.input.setLayout(this.controls.computeLayout(r));
    this.controls.render(r, app.input, this.controlLabels());
  }

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

  /** Draw the line of scrimmage and the bright first-down line. */
  private renderMarkers(): void {
    const r = this.app.r;
    const f = this.app.field;
    r.line(this.startLosX, f.minY, this.startLosX, f.maxY, "rgba(40,80,255,0.6)", 2.5);
    r.line(this.app.match.firstDownX, f.minY, this.app.match.firstDownX, f.maxY, "rgba(255,215,40,0.85)", 3);
  }

  exit(): void {
    this.app.audio.stopCrowd();
  }
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
