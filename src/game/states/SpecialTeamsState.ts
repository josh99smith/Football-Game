import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import { Player, type TeamId } from "../entities/Player";
import { Ball } from "../entities/Ball";
import { HUD } from "../../ui/HUD";
import { COLORS, FONT } from "../../ui/Theme";
import { drawPanel } from "../../ui/widgets";
import { PAT_POINTS, FIELD_GOAL_POINTS } from "../Match";
import { PX_PER_YARD, FIELD_WIDTH, FIELD_LENGTH } from "../Field";
import { OFFENSE_PLAYS, DEFENSE_PLAYS } from "../Playbook";
import { KickoffState } from "./KickoffState";
import { PlaySelectState } from "./PlaySelectState";
import { GameOverState } from "./GameOverState";
import { LivePlayState } from "./LivePlayState";

export type KickKind = "fg" | "pat" | "punt";

interface KickOpts {
  kind: KickKind;
  kicking: TeamId;
  /** World X the kick is taken from (FG/punt: the LOS; PAT: the goal line). */
  spotX: number;
}

type Phase = "snap" | "flight" | "result";

// Flight physics (field px / s). Tuned so ~50yd is a strong-leg make.
const GRAV = 820;
const CROSSBAR_PX = 46;     // ball must clear this height at the posts
const UPRIGHT_HALF_PX = 50; // ...and split the uprights within this of center
const CENTER_Y = FIELD_WIDTH / 2;
const RUSH_TIME = 3.0;      // seconds before the rush gets home and blocks the kick

function hexNum(s: string): number { return parseInt(s.replace("#", ""), 16) || 0xffffff; }

/**
 * Special-teams down played as a REAL play (Madden-style): both teams line up on the 3D field, the
 * ball is snapped, and a power+accuracy meter kicks it. The defense rushes — dawdle and it gets
 * blocked. Field goals / extra points must clear the bar and split the uprights; punts boot
 * downfield into a live return.
 */
export class SpecialTeamsState implements GameState {
  private readonly app: GameApp;
  private readonly opts: KickOpts;
  private readonly hud = new HUD();
  private readonly dir: number;
  private readonly postX: number;
  private readonly holdX: number;

  private players: Player[] = [];
  private blockers: Player[] = [];
  private rushers: Player[] = [];
  private kicker!: Player;
  private holder!: Player;
  private readonly ball = new Ball();

  private phase: Phase = "snap";
  private meter = 0;
  private meterDir = 1;
  private power = 0;
  private aim = 0;
  private aimLocked = false;
  private good = false;
  private blocked = false;
  private resolved = false;
  private rushTimer = RUSH_TIME;
  private resultTimer = 0;
  private headline = "";
  private detail = "";
  private distance = 0;
  private prevBallX = 0;
  private readonly speed: number;
  /** The human only kicks for their own team; the CPU kicks its own (auto-times the meter). */
  private readonly humanKicking: boolean;
  private cpuTimer = 0;
  private readonly cpuPowerTarget: number;
  private readonly cpuAimTarget: number;

  constructor(app: GameApp, opts: KickOpts) {
    this.app = app;
    this.opts = opts;
    const m = app.match;
    this.dir = m.attackDir(opts.kicking);
    this.postX = this.dir > 0 ? FIELD_LENGTH - 6.4 : 6.4;
    this.distance = opts.kind === "pat" ? 20 : m.fieldGoalYards(opts.kicking, opts.spotX);
    const back = opts.kind === "punt" ? 10 : 7;
    this.holdX = opts.spotX - this.dir * back * PX_PER_YARD;
    const diff = m.difficulty;
    this.speed = diff === "rookie" ? 1.15 : diff === "allpro" ? 1.85 : 1.5;
    this.humanKicking = opts.kicking === m.humanTeam;
    // CPU kicker: enough leg for the distance, and a small aim error (more on long FGs).
    this.cpuPowerTarget = opts.kind === "pat" ? 0.62 : opts.kind === "punt" ? 0.82
      : Math.max(0.5, Math.min(1, (this.distance - 30) / 38 + 0.28));
    this.cpuAimTarget = (Math.random() * 2 - 1) * Math.min(0.26, this.distance * 0.005);
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.time.reset(); // no residual slow-mo from the play before the kick
    this.app.audio.resume();
    this.app.audio.organCharge();
    this.buildFormation();
    this.app.scene3d.setVisible(true);
    this.app.scene3d.resetAvatars();
    this.app.scene3d.snapCamera(this.holdX, CENTER_Y, this.dir);
    this.prevBallX = this.ball.pos.x;
  }

  /** Line both teams up: snapper + wall + holder + kicker vs a rush unit. */
  private buildFormation(): void {
    const m = this.app.match;
    const kicking = this.opts.kicking;
    const defense = m.opponent(kicking);
    const dir = this.dir;
    const spotX = this.opts.spotX;
    const yd = (n: number) => n * PX_PER_YARD;

    // Kicking unit (7): a 5-man wall on the line, a holder, and the kicker.
    const wall: [number, number][] = [[0, 0], [0, -2.2], [0, 2.2], [-0.8, -5], [-0.8, 5]];
    this.blockers = wall.map(([fx, lat], i) =>
      this.mk(kicking, "OL", 60 + i, spotX + dir * fx * PX_PER_YARD, CENTER_Y + yd(lat), dir > 0 ? Math.PI : 0));
    this.holder = this.mk(kicking, "QB", 7, this.holdX, CENTER_Y, dir > 0 ? Math.PI : 0);
    this.kicker = this.mk(kicking, "HB", 3, this.holdX - dir * yd(0.6), CENTER_Y + yd(1.3), dir > 0 ? 0 : Math.PI);

    // Rush unit (7): five interior + two edges, crashing the kick.
    const front: [number, number][] = [[1.2, -6], [1.2, -3], [1.2, 0], [1.2, 3], [1.2, 6], [0.5, -9], [0.5, 9]];
    this.rushers = front.map(([fx, lat], i) =>
      this.mk(defense, i < 5 ? "DL" : "LB", 90 + i, spotX + dir * fx * PX_PER_YARD, CENTER_Y + yd(lat), dir > 0 ? 0 : Math.PI));

    this.players = [...this.blockers, this.holder, this.kicker, ...this.rushers];
    this.ball.attachTo(this.holder);
  }

  private mk(team: TeamId, role: Player["role"], num: number, x: number, y: number, facing: number): Player {
    const p = new Player(team, role, num, x, y);
    p.home = { x, y };
    p.facing = facing; p.heading = facing;
    return p;
  }

  update(dt: number): void {
    const tapped = this.app.input.consumeTaps().length > 0 || this.app.input.actionPressed;

    if (this.phase === "snap") {
      if (this.humanKicking) this.runMeter(dt, tapped);
      else this.cpuKick(dt);
      this.runRush(dt);
      this.ball.update(dt); // sits with the holder
      this.syncScene(dt);
      return;
    }

    if (this.phase === "flight") {
      const landed = this.ball.update(dt);
      this.settlePlayers(dt);
      if (!this.resolved) this.checkFlight(landed);
      this.syncScene(dt);
      return;
    }

    this.resultTimer -= dt;
    if (this.resultTimer <= 0 || tapped) this.advance();
  }

  /** Power bar, then aim bar; a tap locks each. The kick fires when aim is set. */
  private runMeter(dt: number, tapped: boolean): void {
    if (!this.aimLocked && this.power === 0) {
      // Power phase.
      this.meter += this.meterDir * this.speed * dt;
      if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
      else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
      if (tapped) { this.power = Math.max(0.001, this.meter); this.app.audio.uiTap(); this.meter = 0.5; this.meterDir = 1; }
      return;
    }
    // Aim phase.
    this.meter += this.meterDir * this.speed * 0.9 * dt;
    if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
    else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
    if (tapped) { this.aim = (this.meter - 0.5) * 2; this.aimLocked = true; this.launch(); }
  }

  /** The CPU works its own meter: a brief set, fill the power to target, glide the aim, then kick
   *  (always well before the rush gets home, so the CPU rarely gets blocked). */
  private cpuKick(dt: number): void {
    this.cpuTimer += dt;
    if (this.cpuTimer < 0.5) return; // set on the ball a beat
    if (this.power === 0) {
      this.meter = Math.min(this.cpuPowerTarget, this.meter + this.speed * dt);
      if (this.meter >= this.cpuPowerTarget - 0.01) { this.power = Math.max(0.001, this.cpuPowerTarget); this.app.audio.uiTap(); this.meter = 0.5; }
      return;
    }
    const aimPos = this.cpuAimTarget / 2 + 0.5;
    const step = this.speed * dt;
    this.meter += Math.sign(aimPos - this.meter) * Math.min(Math.abs(aimPos - this.meter), step);
    if (Math.abs(this.meter - aimPos) < 0.02) { this.aim = this.cpuAimTarget; this.aimLocked = true; this.launch(); }
  }

  /** Crash the rush toward the kicker; the wall steps up to meet them. Too slow ⇒ blocked. */
  private runRush(dt: number): void {
    this.rushTimer -= dt;
    const target = { x: this.holdX, y: CENTER_Y };
    for (const d of this.rushers) {
      const dx = target.x - d.pos.x, dy = target.y - d.pos.y;
      const dl = Math.hypot(dx, dy) || 1;
      d.desired = { x: dx / dl, y: dy / dl };
      d.step(dt, 56);
    }
    for (let i = 0; i < this.blockers.length; i++) {
      const b = this.blockers[i];
      const r = this.rushers[i] ?? this.rushers[0];
      const dx = r.pos.x - b.pos.x, dy = r.pos.y - b.pos.y;
      const dl = Math.hypot(dx, dy) || 1;
      b.desired = { x: dx / dl, y: dy / dl };
      b.step(dt, 44);
    }
    this.holder.step(dt, 0);
    this.kicker.step(dt, 0);
    if (this.rushTimer <= 0 && !this.aimLocked) { this.blocked = true; this.launch(); }
  }

  /** Fire the kick from the locked power + aim (or pop a weak blocked one). */
  private launch(): void {
    this.phase = "flight";
    this.holder.hasBall = false; // the ball's away — drop the carry indicator
    this.app.audio.kick(this.blocked ? 0.3 : 0.6 + this.power * 0.4);
    const hSpeed = this.blocked ? 200 : 360 + this.power * 900;
    const vz = this.blocked ? 120 : 300 + this.power * 120;
    const vy = this.aimLocked ? this.aim * 130 : (Math.random() * 80 - 40);
    this.prevBallX = this.holdX;
    if (this.opts.kind === "punt" && !this.blocked) {
      // A punt sails downfield; aim barely matters (just a slight hook).
      this.ball.kick(this.holdX, CENTER_Y, this.dir * (520 + this.power * 360), vy * 0.4, 360 + this.power * 90, GRAV);
    } else {
      this.ball.kick(this.holdX, CENTER_Y, this.dir * hSpeed, vy, vz, GRAV);
    }
    this.kicker.facing = this.dir > 0 ? 0 : Math.PI;
  }

  /** Watch the ball: split the uprights, sail wide/short, or (punt) land for the return. */
  private checkFlight(landed: boolean): void {
    if (this.opts.kind === "punt") {
      if (landed) this.resolvePunt();
      return;
    }
    const crossed = this.dir > 0
      ? this.prevBallX < this.postX && this.ball.pos.x >= this.postX
      : this.prevBallX > this.postX && this.ball.pos.x <= this.postX;
    this.prevBallX = this.ball.pos.x;
    if (this.blocked && landed) { this.resolveKick(false); return; }
    if (crossed) {
      const through = this.ball.z > CROSSBAR_PX && this.ball.z < 260 && Math.abs(this.ball.pos.y - CENTER_Y) < UPRIGHT_HALF_PX;
      this.resolveKick(through);
    } else if (landed) {
      this.resolveKick(false); // came up short
    }
  }

  private resolveKick(through: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.good = through && !this.blocked;
    if (this.good) {
      this.app.match.addPoints(this.opts.kicking, this.opts.kind === "fg" ? FIELD_GOAL_POINTS : PAT_POINTS);
      if (this.opts.kind === "fg") this.app.match.recordFieldGoal(this.opts.kicking);
    }
    this.toResult();
  }

  private resolvePunt(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.advancePunt();
  }

  private toResult(): void {
    this.phase = "result";
    this.resultTimer = 1.7;
    const k = this.opts.kind;
    if (this.blocked) { this.headline = "BLOCKED!"; this.detail = ""; }
    else if (this.good) { this.headline = "IT'S GOOD!"; this.detail = k === "fg" ? "FIELD GOAL" : "EXTRA POINT"; }
    else { this.headline = "NO GOOD"; this.detail = Math.abs(this.ball.pos.y - CENTER_Y) >= UPRIGHT_HALF_PX ? "WIDE" : "SHORT"; }
    if (this.good) { this.app.audio.score(); this.app.audio.crowdCheer(); } else { this.app.audio.crowdGroan(); }
  }

  private settlePlayers(dt: number): void {
    for (const p of this.players) p.step(dt, 0);
  }

  /** Push the formation + ball into the 3D scene each frame. */
  private syncScene(dt: number): void {
    const focusX = this.phase === "flight" ? this.ball.pos.x : this.holdX;
    const focusY = this.phase === "flight" ? this.ball.pos.y : CENTER_Y;
    this.app.scene3d.sync({
      players: this.players,
      ball: this.ball,
      colorFor: (p) => this.colorFor(p),
      focusX, focusY,
      dir: this.dir,
      losX: this.opts.spotX,
      firstDownX: this.opts.spotX,
      shakeX: this.app.shake.offsetX,
      shakeY: this.app.shake.offsetY,
      dt,
    });
  }

  private colorFor(p: Player): { jersey: number; trim: number; onFire: boolean; defense: boolean } {
    const team = this.app.match.team(p.team);
    return { jersey: hexNum(team.colors.jersey), trim: hexNum(team.colors.trim), onFire: false, defense: p.team !== this.opts.kicking };
  }

  // --- transitions -----------------------------------------------------------------------
  private advancePunt(): void {
    const m = this.app.match;
    const receiver = m.opponent(this.opts.kicking);
    const dir = this.dir;
    const landX = this.ball.pos.x;
    // The receiver's OWN goal (the one they defend) is the goal the kicking team attacks.
    const ownGoal = m.attackGoalX(this.opts.kicking);
    const intoEndzone = dir > 0 ? landX >= ownGoal : landX <= ownGoal;
    if (this.blocked) {
      // A blocked punt is a short, live, ugly ball — hand the receiving team a short field.
      m.startSeries(receiver, clampX(this.opts.spotX - dir * 5 * PX_PER_YARD));
      this.app.setState(new PlaySelectState(this.app));
      return;
    }
    if (intoEndzone) {
      m.startSeries(receiver, m.ownYardX(receiver, 20));
      this.app.setState(new PlaySelectState(this.app));
      return;
    }
    m.possession = receiver;
    this.app.setState(new LivePlayState(this.app, OFFENSE_PLAYS[0], DEFENSE_PLAYS[0], { receiver, ballX: clampX(landX) }));
  }

  private advance(): void {
    const m = this.app.match;
    const kicking = this.opts.kicking;
    const receiver = m.opponent(kicking);
    if (m.isOver) { this.app.audio.stopCrowd(); this.app.setState(new GameOverState(this.app)); return; }
    // A missed/blocked field goal is a turnover at the spot; a make (and any PAT) leads to a kickoff.
    if (this.opts.kind === "fg" && !this.good) {
      m.startSeries(receiver, clampX(this.opts.spotX));
      this.app.setState(new PlaySelectState(this.app));
      return;
    }
    this.app.audio.stopCrowd();
    this.app.setState(new KickoffState(this.app, receiver));
  }

  // --- render ----------------------------------------------------------------------------
  render(alpha = 1): void {
    const r = this.app.r;
    this.app.scene3d.render(alpha);
    this.hud.render(r, this.app.match, { turbo: 1 });
    const cx = r.width / 2;
    const title = this.opts.kind === "fg" ? "FIELD GOAL" : this.opts.kind === "pat" ? "EXTRA POINT" : "PUNT";
    r.text(title, cx, 80, { size: 34, align: "center", color: COLORS.bone, font: FONT.display });
    if (this.opts.kind !== "punt") {
      r.text(`${this.distance} YARDS`, cx, 110, { size: 16, align: "center", color: COLORS.hazard, font: FONT.ui });
    }
    if (this.phase === "snap") this.drawMeters(r, cx);
    if (this.phase === "result") {
      const col = this.good ? "#3ad17a" : COLORS.bloodBright;
      r.text(this.headline, cx, r.height * 0.44, { size: 52, align: "center", color: col, font: FONT.display });
      if (this.detail) r.text(this.detail, cx, r.height * 0.44 + 40, { size: 20, align: "center", color: COLORS.bone, font: FONT.ui });
    }
  }

  private drawMeters(r: Renderer, cx: number): void {
    const ctx = r.ctx;
    const y = r.height - 150;
    const bw = Math.min(360, r.width - 60);
    const bh = 24;
    const bx = cx - bw / 2;
    const powerPhase = !this.aimLocked && this.power === 0;

    drawPanel(r, { x: bx - 6, y: y - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30"; ctx.fillRect(bx, y, bw, bh);
    const pw = (powerPhase ? this.meter : this.power) * bw;
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, "#3ad17a"); grad.addColorStop(0.6, COLORS.hazard); grad.addColorStop(1, COLORS.bloodBright);
    ctx.fillStyle = grad; ctx.fillRect(bx, y, pw, bh);
    r.text("POWER", bx, y - 14, { size: 13, align: "left", color: COLORS.ash, font: FONT.ui });

    const ay = y + 56;
    drawPanel(r, { x: bx - 6, y: ay - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30"; ctx.fillRect(bx, ay, bw, bh);
    ctx.fillStyle = "rgba(58,209,122,0.35)"; ctx.fillRect(cx - bw * 0.05, ay, bw * 0.1, bh);
    ctx.fillStyle = "#3ad17a"; ctx.fillRect(cx - 1.5, ay - 4, 3, bh + 8);
    if (!powerPhase) { const mxp = bx + this.meter * bw; ctx.fillStyle = COLORS.bone; ctx.fillRect(mxp - 3, ay - 4, 6, bh + 8); }
    r.text("AIM", bx, ay - 14, { size: 13, align: "left", color: COLORS.ash, font: FONT.ui });

    const name = this.app.match.team(this.opts.kicking).config.name.toUpperCase();
    const prompt = !this.humanKicking ? `${name} KICKING…` : powerPhase ? "TAP TO SET POWER" : "TAP TO KICK";
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 140);
    r.text(prompt, cx, ay + bh + 30, { size: 20, align: "center", color: COLORS.hazard, font: FONT.display, alpha: pulse });
  }
}

function clampX(x: number): number {
  const LEFT = 10 * PX_PER_YARD;
  const RIGHT = 110 * PX_PER_YARD;
  return Math.max(LEFT, Math.min(RIGHT, x));
}
