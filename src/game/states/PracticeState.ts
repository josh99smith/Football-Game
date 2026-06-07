import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { Player } from "../entities/Player";
import { Ball } from "../entities/Ball";
import { TouchControls } from "../../ui/TouchControls";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { COLORS, FONT } from "../../ui/Theme";
import { TEAMS } from "../Team";
import { LEFT_GOAL_X, PX_PER_YARD, FIELD_WIDTH, FIELD_LENGTH } from "../Field";
import { dist, type Vec2 } from "../../engine/math/Vec2";
import { MenuState } from "./MenuState";

const OFF_DIR = 1; // the offense always attacks +X (the dummy runs this way)

/**
 * Free-roam practice mode: run a ball carrier around the field to drill jukes/cuts, or switch
 * to a defender and practice tackling — against a dummy that stands for a beat, then takes off
 * downfield. No clock, no downs; just reps. (No Match is created.)
 */
export class PracticeState implements GameState {
  private readonly app: GameApp;
  private readonly controls = new TouchControls();
  private all: Player[] = [];
  private carrier!: Player;
  private ball = new Ball();
  private controlIdx = 0;        // which player the human drives (0 = carrier)
  private dir = OFF_DIR;         // camera/control orientation: +1 on offense, -1 on defense
  private homeColor = 0xffd23a;
  private awayColor = 0xe23b3b;
  private homeAccent = 0x1b2f7a;
  private awayAccent = 0xf2c14e;
  private tackledTimer = 0;       // >0 while a tackle cinematic plays out, then we reset
  private dummyRunTimer = 0;      // the uncontrolled carrier stands, then runs downfield
  private exitRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private switchRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(app: GameApp) {
    this.app = app;
    const home = TEAMS[app.config.homeTeamIndex % TEAMS.length];
    const away = TEAMS[app.config.awayTeamIndex % TEAMS.length];
    this.homeColor = hexNum(home.colors.jersey);
    this.awayColor = hexNum(away.colors.jersey);
    this.homeAccent = hexNum(home.colors.accent);
    this.awayAccent = hexNum(away.colors.accent);
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.buildPlayers();
    this.app.scene3d.setVisible(true);
    this.app.scene3d.resetAvatars();
    this.dir = OFF_DIR;
    this.app.scene3d.snapCamera(this.carrier.pos.x, this.carrier.pos.y, this.dir);
    this.app.input.setLayout(this.controls.computeLayout(this.app.r));
    this.app.audio.startCrowd();
  }

  exit(): void {
    this.app.audio.stopCrowd();
  }

  private buildPlayers(): void {
    const cy = FIELD_WIDTH / 2;
    const startX = LEFT_GOAL_X + 22 * PX_PER_YARD;
    this.carrier = new Player("HOME", "HB", 28, startX, cy);
    const d1 = new Player("AWAY", "DB", 21, startX + 24 * PX_PER_YARD, cy - 7 * PX_PER_YARD);
    const d2 = new Player("AWAY", "LB", 55, startX + 26 * PX_PER_YARD, cy + 7 * PX_PER_YARD);
    this.all = [this.carrier, d1, d2];
    for (const p of this.all) { p.home = { x: p.pos.x, y: p.pos.y }; p.heading = 0; }
    this.ball.attachTo(this.carrier);
    this.controlIdx = 0;
    this.tackledTimer = 0;
  }

  /** Put everyone back at the start for another rep. */
  private resetRep(): void {
    this.app.scene3d.resetAvatars();
    const cy = FIELD_WIDTH / 2;
    const startX = LEFT_GOAL_X + 22 * PX_PER_YARD;
    this.place(this.carrier, startX, cy);
    this.place(this.all[1], startX + 24 * PX_PER_YARD, cy - 7 * PX_PER_YARD);
    this.place(this.all[2], startX + 26 * PX_PER_YARD, cy + 7 * PX_PER_YARD);
    this.ball.attachTo(this.carrier);
    this.tackledTimer = 0;
    this.dummyRunTimer = 0;
  }

  private place(p: Player, x: number, y: number): void {
    p.pos = { x, y };
    p.vel = { x: 0, y: 0 };
    p.state = "active";
    p.desired = { x: 0, y: 0 };
    p.hasBall = p === this.carrier;
    p.heading = 0;
    p.lookDir = null;
  }

  private stickToField(): Vec2 {
    const m = this.app.input.move;
    return { x: -m.y * this.dir, y: m.x * this.dir };
  }

  update(dt: number): void {
    const input = this.app.input;
    const sc = this.app.scene3d;

    // --- top-of-screen UI taps: EXIT / SWITCH ---
    const taps = input.consumeTaps();
    if (taps.length) {
      if (tappedIn(this.exitRect, taps)) { this.app.audio.uiTap(); this.backToMenu(); return; }
      if (tappedIn(this.switchRect, taps)) this.cycleControl();
    }
    if (input.action2Pressed) this.cycleControl();

    // Mark the controlled player so the avatar shows the selection ring.
    for (let i = 0; i < this.all.length; i++) this.all[i].controlled = i === this.controlIdx;
    const controlled = this.all[this.controlIdx];

    if (this.tackledTimer > 0) {
      // A tackle is playing out (ragdoll + bullet-time). Hold the camera on the body, then reset.
      this.tackledTimer -= dt;
      const hips = sc.ragdollHipsPx(0);
      if (hips) { this.carrier.pos.x = hips.x; this.carrier.pos.y = this.app.field.clampY(hips.y); }
      for (const p of this.all) p.vel = { x: 0, y: 0 };
      this.ball.update(dt);
      if (this.tackledTimer <= 0) this.resetRep();
      this.syncScene(dt);
      return;
    }

    // --- drive the human-controlled player ---
    controlled.desired = this.stickToField();
    controlled.turbo = input.turbo && (input.move.x !== 0 || input.move.y !== 0);
    if (input.actionPressed) {
      if (this.controlIdx === 0) this.spin(controlled);
      else this.bigHit(controlled);
    }

    // --- AI for everyone else ---
    for (let i = 0; i < this.all.length; i++) {
      const p = this.all[i];
      if (i === this.controlIdx) continue;
      if (p === this.carrier) {
        // Uncontrolled ball carrier = the tackling dummy: stand a beat, then run downfield.
        this.dummyRunTimer += dt;
        if (this.dummyRunTimer < 1.4) { p.desired = { x: 0, y: 0 }; p.turbo = false; }
        else { p.desired = { x: OFF_DIR, y: 0 }; p.turbo = true; }
      } else {
        // A defender: pursue the ball carrier.
        const t = this.carrier.pos;
        const dx = t.x - p.pos.x, dy = t.y - p.pos.y;
        const d = Math.hypot(dx, dy) || 1;
        p.desired = { x: dx / d, y: dy / d };
        p.turbo = d > 40;
      }
    }

    // --- integrate + keep on the field ---
    for (const p of this.all) {
      p.agility = p === controlled ? 1.8 : 1;
      const speed = p.speedFor(p.turbo, false);
      p.step(dt, speed, p === controlled ? 3.2 : 1);
      p.pos.x = Math.max(8, Math.min(FIELD_LENGTH - 8, p.pos.x));
      p.pos.y = this.app.field.clampY(p.pos.y);
    }
    this.ball.update(dt);

    // --- tackle: a defender reaching the carrier lays the (big) hit ---
    this.checkTackle();

    this.syncScene(dt);
  }

  private spin(c: Player): void {
    c.jukeTimer = 0.5;
    const sp = Math.hypot(c.vel.x, c.vel.y);
    if (sp > 30) { c.vel.x += (c.vel.x / sp) * 75; c.vel.y += (c.vel.y / sp) * 75; }
    else { c.vel.x += Math.cos(c.facing) * 60; c.vel.y += Math.sin(c.facing) * 60; }
    const aim = this.stickToField();
    const am = Math.hypot(aim.x, aim.y);
    if (am > 0.3) {
      c.vel.x += (aim.x / am) * 34; c.vel.y += (aim.y / am) * 34;
      c.leanTarget = Math.sign(c.vel.x * (aim.y / am) - c.vel.y * (aim.x / am)) || 1;
    } else c.leanTarget = 1;
    c.animEvent = "spin";
    this.app.audio.juke();
  }

  private bigHit(c: Player): void {
    if (c.diveTimer > 0) return;
    c.diveTimer = 0.3;
    c.bigHitArmed = true;
    c.leanTarget = 0.7;
    c.vel.x += Math.cos(c.facing) * 165;
    c.vel.y += Math.sin(c.facing) * 165;
    this.app.particles.burst(c.pos.x, c.pos.y, "#dce6ff", 6, 80);
    this.app.shake.add(0.12);
  }

  private checkTackle(): void {
    if (this.tackledTimer > 0 || this.carrier.isDown) return;
    for (let i = 1; i < this.all.length; i++) {
      const d = this.all[i];
      const reach = d.diveTimer > 0 ? d.radius + this.carrier.radius + 10 : (d.radius + this.carrier.radius) * 0.95;
      if (dist(d.pos, this.carrier.pos) > reach) continue;
      this.layTackle(d, i);
      return;
    }
  }

  private layTackle(tackler: Player, tacklerIdx: number): void {
    const sc = this.app.scene3d;
    const hitStick = tackler.bigHitArmed;
    tackler.bigHitArmed = false;
    const dx = this.carrier.pos.x - tackler.pos.x;
    const dy = this.carrier.pos.y - tackler.pos.y;
    const closing = Math.hypot(this.carrier.vel.x - tackler.vel.x, this.carrier.vel.y - tackler.vel.y);
    const hx = (tackler.pos.x + this.carrier.pos.x) / 2;
    const hy = (tackler.pos.y + this.carrier.pos.y) / 2;
    // Ragdoll both bodies + the bullet-time hit cinematic.
    sc.startRagdoll(0, { hitDirX: dx, hitDirY: dy, closingPx: hitStick ? closing + 160 : closing, carryVx: this.carrier.vel.x, carryVy: this.carrier.vel.y, big: true, bit: 0x0002 });
    sc.startRagdoll(tacklerIdx, { hitDirX: -dx, hitDirY: -dy, closingPx: closing * 0.6, carryVx: tackler.vel.x, carryVy: tackler.vel.y, big: true, bit: 0x0004 });
    this.app.time.freeze(hitStick ? 0.07 : 0.04);
    this.app.time.bulletTime(hitStick ? 0.12 : 0.18, hitStick ? 0.6 : 0.4, 0.8);
    sc.hitZoom(hitStick ? 0.85 : 0.6);
    this.app.shake.add(hitStick ? 0.7 : 0.4);
    this.app.particles.spark(hx, hy, dx, dy, hitStick ? 22 : 14);
    this.app.audio.hit(Math.min(1, closing / 260 + (hitStick ? 0.6 : 0.4)));
    this.app.audio.crowdCheer();
    this.app.floating.add(hitStick ? "BIG HIT!" : pickHitWord(), hx, hy - 16, { size: hitStick ? 32 : 26, color: hitStick ? "#ff5a3a" : "#ffd23a" });
    this.carrier.vel = { x: 0, y: 0 };
    this.tackledTimer = 3.0;
  }

  private cycleControl(): void {
    this.controlIdx = (this.controlIdx + 1) % this.all.length;
    this.dummyRunTimer = 0; // a fresh dummy beat when we hand the ball to the AI
    // Flip the camera to the controlled side's perspective (defense looks back at the carrier),
    // snapping so it doesn't swing 180° across the field.
    this.dir = this.controlIdx === 0 ? OFF_DIR : -OFF_DIR;
    const c = this.all[this.controlIdx];
    this.app.scene3d.snapCamera(c.pos.x, c.pos.y, this.dir);
    this.app.audio.uiTap();
  }

  private backToMenu(): void {
    this.app.setState(new MenuState(this.app));
  }

  private syncScene(dt: number): void {
    const c = this.all[this.controlIdx];
    this.app.scene3d.sync({
      players: this.all,
      ball: this.ball,
      colorFor: (p) => ({
        jersey: p.team === "HOME" ? this.homeColor : this.awayColor,
        trim: 0x111118,
        accent: p.team === "HOME" ? this.homeAccent : this.awayAccent,
        onFire: false,
        defense: p.team === "AWAY",
      }),
      focusX: c.pos.x,
      focusY: c.pos.y,
      dir: this.dir,
      losX: LEFT_GOAL_X + 22 * PX_PER_YARD,
      firstDownX: LEFT_GOAL_X + 32 * PX_PER_YARD,
      shakeX: this.app.shake.offsetX,
      shakeY: this.app.shake.offsetY,
      dt,
    });
  }

  render(alpha = 1): void {
    const app = this.app;
    const r = app.r;
    app.scene3d.render(alpha);
    app.particles.render(r, (x, y, h) => app.scene3d.project(x, y, h));
    app.floating.render(r, (x, y, h) => app.scene3d.project(x, y, h));

    // Touch controls (joystick + turbo + contextual action).
    app.input.setLayout(this.controls.computeLayout(r));
    const onOffense = this.controlIdx === 0;
    this.controls.render(r, app.input, {
      action: onOffense
        ? { text: "SPIN", icon: "spin", color: "#1f9d4d" }
        : { text: "BIG HIT", icon: "tackle", color: "#d23a2a" },
    });

    // Top bar: EXIT + SWITCH + a one-line hint.
    const bw = Math.min(120, r.width * 0.26);
    this.exitRect = { x: 12, y: 12, w: bw, h: 34 };
    this.switchRect = { x: r.width - bw - 12, y: 12, w: bw, h: 34 };
    drawButton(r, this.exitRect, "‹ EXIT", { fill: COLORS.concrete, size: 14 });
    drawButton(r, this.switchRect, "SWITCH", { fill: COLORS.steel, size: 14 });
    r.text("PRACTICE", r.width / 2, 18, { size: 14, align: "center", color: COLORS.blood, baseline: "top", font: FONT.display });
    r.text(onOffense ? "RUN & SPIN — SWITCH TO PLAY DEFENSE" : "TACKLE THE DUMMY — SWITCH TO CARRY", r.width / 2, 36, {
      size: 11, align: "center", color: COLORS.ash, baseline: "top", font: FONT.ui,
    });
  }
}

function hexNum(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}
function pickHitWord(): string {
  const w = ["BOOM!", "POW!", "CRUNCH!", "WHAM!", "LEVELED!"];
  return w[Math.floor(Math.random() * w.length)];
}
