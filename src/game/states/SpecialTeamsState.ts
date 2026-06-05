import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import type { TeamId } from "../entities/Player";
import { HUD } from "../../ui/HUD";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { drawPanel } from "../../ui/widgets";
import { PAT_POINTS, TWO_POINT_POINTS, FIELD_GOAL_POINTS } from "../Match";
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

type Phase = "power" | "aim" | "flight" | "result";

// Flight physics (field px / seconds). Tuned so ~50yd is a strong-leg make.
const GRAV = 820;
const CROSSBAR_PX = 46; // ball must clear this height at the posts
const UPRIGHT_HALF_PX = 46; // ...and land within this of center
const CENTER_Y = FIELD_WIDTH / 2;

/**
 * Special-teams place-kick: a two-tap timing mini-game (power, then aim) that kicks the ball
 * through the actual uprights on the 3D field — field goals and extra points. (Punts use the
 * same meter but resolve to a live return, drawn in 2D here.)
 */
export class SpecialTeamsState implements GameState {
  private readonly app: GameApp;
  private readonly opts: KickOpts;
  private readonly hud = new HUD();
  private readonly is3D: boolean; // FG/PAT kick through the uprights in 3D
  private readonly dir: number;
  private readonly postX: number; // field-px X of the uprights

  private phase: Phase = "power";
  private meter = 0;
  private meterDir = 1;
  private power = 0;
  private aim = 0;
  private good = false;
  private resolved = false;
  private resultTimer = 0;
  private headline = "";
  private detail = "";
  private distance = 0;
  private readonly speed: number;

  // 3D ball flight (field px + height).
  private bx = 0;
  private by = CENTER_Y;
  private bz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private settle = 0;

  constructor(app: GameApp, opts: KickOpts) {
    this.app = app;
    this.opts = opts;
    const m = app.match;
    this.is3D = opts.kind !== "punt";
    this.dir = m.attackDir(opts.kicking);
    this.postX = this.dir > 0 ? FIELD_LENGTH - 6.4 : 6.4;
    this.distance = opts.kind === "pat" ? 20 : m.fieldGoalYards(opts.kicking, opts.spotX);
    const diff = m.difficulty;
    this.speed = diff === "rookie" ? 1.15 : diff === "allpro" ? 1.85 : 1.5;
    this.bx = opts.spotX;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.resume();
    this.app.audio.organCharge();
    if (this.is3D) {
      this.app.scene3d.setVisible(true);
      this.app.scene3d.prepareKick(this.bx, CENTER_Y, this.dir);
    } else {
      this.app.scene3d.setVisible(false);
    }
  }

  update(dt: number): void {
    const tapped = this.app.input.consumeTaps().length > 0 || this.app.input.actionPressed;

    if (this.phase === "power") {
      this.meter += this.meterDir * this.speed * dt;
      if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
      else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
      if (tapped) {
        this.power = this.meter;
        this.app.audio.uiTap();
        this.phase = "aim";
        this.meter = 0.5; this.meterDir = 1;
      }
      return;
    }

    if (this.phase === "aim") {
      this.meter += this.meterDir * this.speed * 0.9 * dt;
      if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
      else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
      if (tapped) {
        this.aim = (this.meter - 0.5) * 2;
        this.app.audio.hit(0.5);
        this.startFlight();
      }
      return;
    }

    if (this.phase === "flight") {
      this.stepFlight(dt);
      return;
    }

    this.resultTimer -= dt;
    if (this.resultTimer <= 0 || tapped) this.advance();
  }

  /** Launch the ball from the locked power + aim. */
  private startFlight(): void {
    this.phase = "flight";
    if (!this.is3D) { this.resolvePunt(); return; }
    const hSpeed = 360 + this.power * 900;
    this.vx = this.dir * hSpeed;
    this.vz = 300 + this.power * 120;
    this.vy = this.aim * 130;
    this.bx = this.opts.spotX;
    this.by = CENTER_Y;
    this.bz = 0;
    this.resolved = false;
  }

  private stepFlight(dt: number): void {
    const prevX = this.bx;
    this.bx += this.vx * dt;
    this.by += this.vy * dt;
    this.bz += this.vz * dt;
    this.vz -= GRAV * dt;

    if (!this.resolved) {
      const crossed = this.dir > 0 ? prevX < this.postX && this.bx >= this.postX : prevX > this.postX && this.bx <= this.postX;
      if (crossed) {
        const through = this.bz > CROSSBAR_PX && this.bz < 220 && Math.abs(this.by - CENTER_Y) < UPRIGHT_HALF_PX;
        this.resolveKick(through);
      } else if (this.bz <= 0) {
        this.resolveKick(false); // landed short
      }
    }
    if (this.resolved) {
      this.settle -= dt;
      if (this.settle <= 0) this.toResult();
    }
    if (this.bz < 0) { this.bz = 0; this.vz = 0; this.vx *= 0.6; }
  }

  private resolveKick(through: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.good = through;
    this.settle = 0.5;
    const m = this.app.match;
    if (through) m.addPoints(this.opts.kicking, this.opts.kind === "fg" ? FIELD_GOAL_POINTS : PAT_POINTS);
    void TWO_POINT_POINTS;
  }

  private resolvePunt(): void {
    this.good = Math.abs(this.aim) < 0.55;
    this.resolved = true;
    this.toResult();
  }

  private toResult(): void {
    if (this.phase === "result") return;
    this.phase = "result";
    this.resultTimer = 1.5;
    this.setResultText();
    if (this.good) { this.app.audio.score(); this.app.audio.crowdCheer(); }
    else { this.app.audio.crowdGroan(); }
  }

  private setResultText(): void {
    const k = this.opts.kind;
    if (k === "punt") { this.headline = this.good ? "BOOM!" : "SHANKED!"; this.detail = this.good ? "PINNED DEEP" : ""; return; }
    if (this.good) { this.headline = "IT'S GOOD!"; this.detail = k === "fg" ? "FIELD GOAL" : "EXTRA POINT"; return; }
    this.headline = "NO GOOD";
    this.detail = Math.abs(this.by - CENTER_Y) >= UPRIGHT_HALF_PX ? "WIDE" : "SHORT";
  }

  /** Transition to whatever comes after the kick. */
  private advance(): void {
    const m = this.app.match;
    const k = this.opts.kind;
    const kicking = this.opts.kicking;
    const receiver = m.opponent(kicking);

    if (m.isOver) { this.app.audio.stopCrowd(); this.app.setState(new GameOverState(this.app)); return; }

    if (k === "punt") {
      const dir = m.attackDir(kicking);
      const grossYd = 32 + this.power * 30 - (this.good ? 0 : 16);
      let landX = this.opts.spotX + dir * grossYd * PX_PER_YARD;
      const ownGoal = m.attackGoalX(receiver);
      const intoEndzone = dir > 0 ? landX >= ownGoal : landX <= ownGoal;
      if (intoEndzone) {
        m.startSeries(receiver, m.ownYardX(receiver, 20));
        this.app.setState(new PlaySelectState(this.app));
        return;
      }
      landX = clampX(landX);
      m.possession = receiver;
      this.app.setState(new LivePlayState(this.app, OFFENSE_PLAYS[0], DEFENSE_PLAYS[0], { receiver, ballX: landX }));
      return;
    }

    // Missed field goal: the other team takes over at the spot. Otherwise the scoring team kicks off.
    if (k === "fg" && !this.good) {
      m.startSeries(receiver, clampX(this.opts.spotX));
      this.app.setState(new PlaySelectState(this.app));
      return;
    }
    this.app.audio.stopCrowd();
    this.app.setState(new KickoffState(this.app, receiver));
  }

  render(): void {
    const r = this.app.r;
    if (this.is3D) {
      // The 3D field renders the kick + uprights; the meters draw on the transparent 2D overlay.
      const zForRender = this.phase === "flight" || this.phase === "result" ? this.bz : 0;
      const xForRender = this.phase === "flight" || this.phase === "result" ? this.bx : this.opts.spotX;
      this.app.scene3d.renderKickFrame(xForRender, this.by, zForRender, this.dir);
      this.drawOverlay(r, false);
      return;
    }
    // Punt: 2D presentation.
    r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.drawOverlay(r, true);
  }

  private drawOverlay(r: Renderer, puntField: boolean): void {
    this.hud.render(r, this.app.match, { turbo: 1 });
    const cx = r.width / 2;
    const title = this.opts.kind === "fg" ? "FIELD GOAL" : this.opts.kind === "pat" ? "EXTRA POINT" : "PUNT";
    r.text(title, cx, 84, { size: 38, align: "center", color: COLORS.bone, font: FONT.display });
    if (this.opts.kind !== "punt") {
      r.text(`${this.distance} YARDS`, cx, 116, { size: 18, align: "center", color: COLORS.hazard, font: FONT.ui });
    }
    if (puntField) this.drawPuntField(r, cx, r.height * 0.32);

    // Meters only matter until the kick is away.
    if (this.phase === "power" || this.phase === "aim") this.drawMeters(r, cx);

    if (this.phase === "result") {
      const col = this.good ? "#3ad17a" : COLORS.bloodBright;
      r.text(this.headline, cx, r.height * 0.46, { size: 54, align: "center", color: col, font: FONT.display });
      if (this.detail) r.text(this.detail, cx, r.height * 0.46 + 42, { size: 20, align: "center", color: COLORS.bone, font: FONT.ui });
    }
  }

  private drawPuntField(r: Renderer, cx: number, topY: number): void {
    const ctx = r.ctx;
    const w = Math.min(260, r.width * 0.7);
    const h = 70;
    ctx.save();
    ctx.fillStyle = "#16823a";
    ctx.fillRect(cx - w / 2, topY, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    for (let i = 1; i < 6; i++) ctx.strokeRect(cx - w / 2 + (w / 6) * i, topY, 0.1, h);
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(cx - w / 2, topY, w, h);
    ctx.restore();
    if (this.phase === "flight" || this.phase === "result") {
      const t = Math.min(1, 1 - this.resultTimer / 1.5);
      const bx = cx - w / 2 + w * (0.1 + 0.8 * t);
      const by = topY + h / 2 - Math.sin(t * Math.PI) * 46;
      r.circle(bx, by, 6, "#ffe6a0");
    }
  }

  private drawMeters(r: Renderer, cx: number): void {
    const ctx = r.ctx;
    const y = r.height * 0.72;
    const bw = Math.min(360, r.width - 60);
    const bh = 26;
    const bx = cx - bw / 2;

    drawPanel(r, { x: bx - 6, y: y - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(bx, y, bw, bh);
    const pw = (this.phase === "power" ? this.meter : this.power) * bw;
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, "#3ad17a"); grad.addColorStop(0.6, COLORS.hazard); grad.addColorStop(1, COLORS.bloodBright);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, y, pw, bh);
    r.text("POWER", bx, y - 16, { size: 14, align: "left", color: COLORS.ash, font: FONT.ui });

    const ay = y + 64;
    drawPanel(r, { x: bx - 6, y: ay - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(bx, ay, bw, bh);
    ctx.fillStyle = "rgba(58,209,122,0.35)";
    ctx.fillRect(cx - bw * 0.055, ay, bw * 0.11, bh);
    ctx.fillStyle = "#3ad17a";
    ctx.fillRect(cx - 1.5, ay - 4, 3, bh + 8);
    if (this.phase === "aim") {
      const mxp = bx + this.meter * bw;
      ctx.fillStyle = COLORS.bone;
      ctx.fillRect(mxp - 3, ay - 4, 6, bh + 8);
    }
    r.text("AIM", bx, ay - 16, { size: 14, align: "left", color: COLORS.ash, font: FONT.ui });

    const prompt = this.phase === "power" ? "TAP TO SET POWER" : "TAP TO AIM";
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 140);
    r.text(prompt, cx, ay + bh + 36, { size: 22, align: "center", color: COLORS.hazard, font: FONT.display, alpha: pulse });
  }
}

function clampX(x: number): number {
  const LEFT = 10 * PX_PER_YARD;
  const RIGHT = 110 * PX_PER_YARD;
  return Math.max(LEFT, Math.min(RIGHT, x));
}
