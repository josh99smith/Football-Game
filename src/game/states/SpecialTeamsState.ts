import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import type { TeamId } from "../entities/Player";
import { HUD } from "../../ui/HUD";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { drawPanel } from "../../ui/widgets";
import {
  PAT_POINTS,
  TWO_POINT_POINTS,
  FIELD_GOAL_POINTS,
} from "../Match";
import { PX_PER_YARD } from "../Field";
import { KickoffState } from "./KickoffState";
import { PlaySelectState } from "./PlaySelectState";
import { GameOverState } from "./GameOverState";

export type KickKind = "fg" | "pat" | "punt";

interface KickOpts {
  kind: KickKind;
  kicking: TeamId;
  /** World X the kick is taken from (FG/punt: the LOS; PAT: the goal line). */
  spotX: number;
}

type Phase = "power" | "aim" | "flight" | "result";

/**
 * Special-teams kick: a two-tap timing mini-game. Tap once to lock POWER off an oscillating bar,
 * tap again to lock AIM off a sweeping marker. The ball then flies and the result resolves —
 * a field goal / extra point through the uprights, or a punt that pins the opponent deep.
 * Rendered as a clean 2D presentation (the 3D field is hidden between live downs).
 */
export class SpecialTeamsState implements GameState {
  private readonly app: GameApp;
  private readonly opts: KickOpts;
  private readonly hud = new HUD();

  private phase: Phase = "power";
  private meter = 0;        // 0..1 oscillator position
  private meterDir = 1;
  private power = 0;        // locked power 0..1
  private aim = 0;          // locked aim deviation -1..1 (0 = perfect)
  private flightT = 0;      // 0..1 ball animation
  private good = false;
  private resultTimer = 0;
  private headline = "";
  private detail = "";
  private distance = 0;     // FG distance in yards (for display + difficulty)
  /** How fast the meters sweep (per second) — harder difficulties sweep faster. */
  private readonly speed: number;

  constructor(app: GameApp, opts: KickOpts) {
    this.app = app;
    this.opts = opts;
    const m = app.match;
    this.distance = opts.kind === "pat" ? 20 : m.fieldGoalYards(opts.kicking, opts.spotX);
    const diff = m.difficulty;
    this.speed = diff === "rookie" ? 1.15 : diff === "allpro" ? 1.85 : 1.5;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.resume();
    this.app.audio.organCharge();
  }

  update(dt: number): void {
    const tapped = this.app.input.consumeTaps().length > 0 || this.app.input.actionPressed;

    if (this.phase === "power") {
      // Ping-pong the power bar; a tap locks it.
      this.meter += this.meterDir * this.speed * dt;
      if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
      else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
      if (tapped) {
        this.power = this.meter;
        this.app.audio.uiTap();
        this.phase = "aim";
        this.meter = 0.5;
        this.meterDir = 1;
      }
      return;
    }

    if (this.phase === "aim") {
      // Sweep the aim marker across the band; a tap locks the deviation from center.
      this.meter += this.meterDir * this.speed * 0.9 * dt;
      if (this.meter >= 1) { this.meter = 1; this.meterDir = -1; }
      else if (this.meter <= 0) { this.meter = 0; this.meterDir = 1; }
      if (tapped) {
        this.aim = (this.meter - 0.5) * 2; // -1..1
        this.phase = "flight";
        this.flightT = 0;
        this.app.audio.hit(0.5); // the thump of the kick
        this.resolve();
      }
      return;
    }

    if (this.phase === "flight") {
      this.flightT = Math.min(1, this.flightT + dt * 1.6);
      if (this.flightT >= 1) {
        this.phase = "result";
        this.resultTimer = 1.6;
        this.setResultText();
        if (this.good) { this.app.audio.score(); this.app.audio.crowdCheer(); }
        else { this.app.audio.crowdGroan(); }
      }
      return;
    }

    // result
    this.resultTimer -= dt;
    if (this.resultTimer <= 0 || tapped) this.advance();
  }

  /** Compute the outcome from the locked power + aim and bank any points. */
  private resolve(): void {
    const m = this.app.match;
    const k = this.opts.kind;
    if (k === "punt") {
      this.good = Math.abs(this.aim) < 0.55; // a wild aim shanks it
      return;
    }
    // FG / PAT: enough power to reach, and aim inside the (distance-dependent) uprights window.
    const maxRange = 32 + this.power * 38; // ~32yd chip up to a ~70yd boot
    const reaches = this.distance <= maxRange;
    const window = Math.max(0.16, 0.52 - this.distance * 0.004); // tighter from distance
    const onLine = Math.abs(this.aim) <= window;
    this.good = reaches && onLine;
    if (this.good) {
      m.addPoints(this.opts.kicking, k === "fg" ? FIELD_GOAL_POINTS : PAT_POINTS);
    }
    void TWO_POINT_POINTS;
  }

  private setResultText(): void {
    const k = this.opts.kind;
    if (k === "punt") {
      this.headline = this.good ? "BOOM!" : "SHANKED!";
      this.detail = this.good ? "PINNED DEEP" : "";
      return;
    }
    if (this.good) {
      this.headline = "IT'S GOOD!";
      this.detail = k === "fg" ? "FIELD GOAL" : "EXTRA POINT";
      return;
    }
    this.headline = "NO GOOD";
    // Tell the player why they missed.
    const maxRange = 32 + this.power * 38;
    this.detail = this.distance > maxRange ? "SHORT" : "WIDE";
  }

  /** Transition to whatever comes after the kick. */
  private advance(): void {
    const m = this.app.match;
    const k = this.opts.kind;
    const kicking = this.opts.kicking;
    const receiver = m.opponent(kicking);

    if (m.isOver) { this.app.audio.stopCrowd(); this.app.setState(new GameOverState(this.app)); return; }

    if (k === "punt") {
      // Ball travels downfield from the spot; opponent takes over where it's fielded (a live
      // return slots in here later). A shank is short and angled; a clean punt nets more.
      const dir = m.attackDir(kicking);
      const grossYd = 32 + this.power * 30 - (this.good ? 0 : 16);
      let landX = this.opts.spotX + dir * grossYd * PX_PER_YARD;
      const ownGoal = m.attackGoalX(receiver); // receiver's own goal line = kicking team's target
      // Don't bury it through the end zone — that's a touchback to the 20.
      const intoEndzone = dir > 0 ? landX >= ownGoal : landX <= ownGoal;
      if (intoEndzone) landX = m.ownYardX(receiver, 20);
      m.startSeries(receiver, clampX(landX));
      this.app.setState(new PlaySelectState(this.app));
      return;
    }

    // FG or PAT: a make or a miss both lead to the scoring team kicking off, EXCEPT a missed FG,
    // which is a turnover at the spot (the other team takes over there).
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
    const ctx = r.ctx;
    r.begin(COLORS.bg0);
    grungeBackground(ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });

    const cx = r.width / 2;
    const title = this.opts.kind === "fg" ? "FIELD GOAL" : this.opts.kind === "pat" ? "EXTRA POINT" : "PUNT";
    r.text(title, cx, 86, { size: 40, align: "center", color: COLORS.bone, font: FONT.display });
    if (this.opts.kind !== "punt") {
      r.text(`${this.distance} YARDS`, cx, 120, { size: 18, align: "center", color: COLORS.hazard, font: FONT.ui });
    }

    // Target graphic: uprights for a kick, a field arrow for a punt.
    if (this.opts.kind === "punt") this.drawPuntField(r, cx, r.height * 0.34);
    else this.drawUprights(r, cx, r.height * 0.36);

    this.drawMeters(r, cx);

    if (this.phase === "result") {
      const col = this.good ? "#3ad17a" : COLORS.bloodBright;
      r.text(this.headline, cx, r.height * 0.5, { size: 52, align: "center", color: col, font: FONT.display });
      if (this.detail) r.text(this.detail, cx, r.height * 0.5 + 40, { size: 20, align: "center", color: COLORS.bone, font: FONT.ui });
    }
  }

  /** Goalposts in faux 3D with the ball arcing toward them. */
  private drawUprights(r: Renderer, cx: number, topY: number): void {
    const ctx = r.ctx;
    const w = Math.min(180, r.width * 0.42);
    const postH = 90;
    const crossY = topY + 46;
    ctx.save();
    ctx.strokeStyle = "#f5d23a";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    // Crossbar + two uprights.
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, crossY);
    ctx.lineTo(cx + w / 2, crossY);
    ctx.moveTo(cx - w / 2, crossY);
    ctx.lineTo(cx - w / 2, crossY - postH);
    ctx.moveTo(cx + w / 2, crossY);
    ctx.lineTo(cx + w / 2, crossY - postH);
    ctx.stroke();
    // Base post.
    ctx.beginPath();
    ctx.moveTo(cx, crossY);
    ctx.lineTo(cx, crossY + 30);
    ctx.stroke();
    ctx.restore();

    // Ball flight: rises from the bottom and drifts toward the locked aim.
    if (this.phase === "flight" || this.phase === "result") {
      const t = this.phase === "result" ? 1 : this.flightT;
      const startY = r.height * 0.62;
      const aimX = cx + this.aim * (w / 2) * 1.25; // misses sail outside the posts
      const bx = cx + (aimX - cx) * t;
      const by = startY + (crossY - 14 - startY) * t;
      r.circle(bx, by, 7, this.good ? "#ffe6a0" : COLORS.bloodBright);
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
      const t = this.phase === "result" ? 1 : this.flightT;
      const bx = cx - w / 2 + w * (0.1 + 0.8 * t);
      const by = topY + h / 2 - Math.sin(t * Math.PI) * 46;
      r.circle(bx, by, 6, "#ffe6a0");
    }
  }

  /** Power + aim meters with prompts. */
  private drawMeters(r: Renderer, cx: number): void {
    const ctx = r.ctx;
    const y = r.height * 0.7;
    const bw = Math.min(360, r.width - 60);
    const bh = 26;
    const bx = cx - bw / 2;

    // Power bar.
    drawPanel(r, { x: bx - 6, y: y - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(bx, y, bw, bh);
    const pw = (this.phase === "power" ? this.meter : this.power) * bw;
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, "#3ad17a");
    grad.addColorStop(0.6, COLORS.hazard);
    grad.addColorStop(1, COLORS.bloodBright);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, y, pw, bh);
    r.text("POWER", bx, y - 16, { size: 14, align: "left", color: COLORS.ash, font: FONT.ui });

    // Aim bar (only meaningful from the aim phase on).
    const ay = y + 64;
    drawPanel(r, { x: bx - 6, y: ay - 6, w: bw + 12, h: bh + 12 }, COLORS.bg1);
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(bx, ay, bw, bh);
    // Center target band.
    ctx.fillStyle = "rgba(58,209,122,0.35)";
    ctx.fillRect(cx - bw * 0.06, ay, bw * 0.12, bh);
    ctx.fillStyle = "#3ad17a";
    ctx.fillRect(cx - 1.5, ay - 4, 3, bh + 8);
    const marker = this.phase === "aim" ? this.meter : (this.aim / 2 + 0.5);
    if (this.phase === "aim" || this.phase === "flight" || this.phase === "result") {
      const mxp = bx + marker * bw;
      ctx.fillStyle = COLORS.bone;
      ctx.fillRect(mxp - 3, ay - 4, 6, bh + 8);
    }
    r.text("AIM", bx, ay - 16, { size: 14, align: "left", color: COLORS.ash, font: FONT.ui });

    // Prompt.
    const prompt = this.phase === "power" ? "TAP TO SET POWER"
      : this.phase === "aim" ? "TAP TO AIM"
      : "";
    if (prompt) {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 140);
      r.text(prompt, cx, ay + bh + 36, { size: 22, align: "center", color: COLORS.hazard, font: FONT.display, alpha: pulse });
    }
  }
}

function clampX(x: number): number {
  // Keep spots on the field of play (mirror Match's clamp without exporting it).
  const LEFT = 10 * PX_PER_YARD;
  const RIGHT = 110 * PX_PER_YARD;
  return Math.max(LEFT, Math.min(RIGHT, x));
}
