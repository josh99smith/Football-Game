import type { GameApp } from "../engine/Game";
import type { Player } from "./entities/Player";
import { dist, clamp, type Vec2 } from "../engine/math/Vec2";
import { chance } from "../engine/math/random";

/**
 * The tackling engine. It owns the whole contact decision — whiffs, glancing stumbles, broken
 * tackles, the 1-on-1 battle trigger, and (the headline) **dynamic gang tackles** where every
 * defender swarming the ball-carrier piles on at once. The fall is driven by real momentum: a lone
 * arm-tackle from a light defender gets dragged for extra yards, while a strong gang stones the
 * runner (or drives him backward) and is far more likely to rake the ball out.
 *
 * LivePlayState calls `resolve()` once per live frame and acts on the returned outcome (starting a
 * battle, scheduling the whistle, popping a fumble loose). All of the impact physics + FX live here.
 */

export interface TackleQuery {
  carrier: Player;
  defense: Player[];
  dir: number;
  isReturn: boolean;
  controlled: Player | null;
  struggleReady: boolean;
  playTime: number;
  /** Sim-list index of a player (for spawning its ragdoll). */
  indexOf: (p: Player) => number;
}

/** A committed (gang) tackle: everything LivePlayState needs to finish the play. */
export interface GangTackle {
  /** Lead tackler (for fire-streak / possession checks). */
  lead: Player;
  /** Everyone in the pile (lead first). */
  pile: Player[];
  spot: Vec2;
  big: boolean;
  fumble: boolean;
  fumbleVel: { x: number; y: number; up: number };
  /** Contact beat before the whistle blows. */
  beat: number;
  /** Sim indices now ragdolling (carrier + the bodies that tumbled). */
  ragdollIdx: number[];
  /** Camera focus (the carrier). */
  focus: Player;
}

export type TackleOutcome =
  | { kind: "none" }
  | { kind: "whiff" }
  | { kind: "stumble" }
  | { kind: "broken" }
  | { kind: "struggle"; tackler: Player }
  | { kind: "gang"; data: GangTackle };

const SWARM_R = 32;       // defenders within this of the carrier join the pile
const GANG_MAX = 4;       // max bodies in a gang tackle
const RAGDOLL_MAX = 3;    // max simultaneously ragdolling bodies (carrier + 2); rest wrap up
const STRUGGLE_CHANCE = 0.28;
const BODY_BITS = [0x0004, 0x0008, 0x0010, 0x0020]; // distinct collision groups per tackler

const HIT_WORDS = ["WHAM!", "STICK!", "CRUNCH!", "BLOWN UP!", "DROPPED!", "STONED!"];
function hitWord(): string {
  return HIT_WORDS[(Math.random() * HIT_WORDS.length) | 0];
}

export class TackleEngine {
  private readonly app: GameApp;
  private lastBreak = -10;

  constructor(app: GameApp) {
    this.app = app;
  }

  /** New play: clear cooldowns. */
  reset(): void {
    this.lastBreak = -10;
  }

  /** Per-frame contact resolution. */
  resolve(q: TackleQuery): TackleOutcome {
    const { carrier, defense } = q;

    // Lead tackler = the closest defender within reach of the carrier.
    let lead: Player | null = null;
    let leadD = Infinity;
    for (const d of defense) {
      if (d.isDown) continue;
      const reach = (d.radius + carrier.radius) * (d.diveTimer > 0 ? 0.92 : 0.78);
      const dd = dist(d.pos, carrier.pos);
      if (dd <= reach && dd < leadD) { leadD = dd; lead = d; }
    }
    if (!lead) return { kind: "none" };

    // Juke: the carrier shrugs the first man and the defender whiffs past.
    if (carrier.jukeTimer > 0) {
      carrier.jukeTimer = 0;
      lead.knockDown(0.8);
      this.app.particles.burst(lead.pos.x, lead.pos.y, "#ffffff", 6, 80);
      return { kind: "whiff" };
    }

    const pile = this.gather(carrier, defense, lead);
    const gangSize = pile.length;
    const closing = Math.hypot(lead.vel.x - carrier.vel.x, lead.vel.y - carrier.vel.y);
    const hitStick = lead.bigHitArmed && lead.diveTimer > 0;
    const big = hitStick || lead.turbo || lead.diveTimer > 0 || closing > 150;

    // Tecmo-style 1-on-1 battle — only when the human is involved and it's a clean, lone hit.
    if (q.struggleReady && gangSize === 1 && (q.controlled === carrier || q.controlled === lead) && chance(STRUGGLE_CHANCE)) {
      return { kind: "struggle", tackler: lead };
    }

    // Glancing side-hit on a lone defender: stagger but stay up.
    if (gangSize === 1 && !big && this.tryStumble(carrier, lead, closing, q.playTime)) return { kind: "stumble" };

    // Break the tackle — strength + momentum vs the pile (a clean committed hit can't be broken).
    if (!hitStick && this.tryBreak(carrier, pile, big, q.playTime)) {
      lead.knockDown(0.7);
      carrier.vel.x *= 0.8; carrier.vel.y *= 0.8;
      this.app.particles.burst(lead.pos.x, lead.pos.y, "#ffffff", 7, 90);
      this.app.audio.juke();
      this.app.shake.add(0.14);
      this.app.shake.kick(carrier.vel.x, carrier.vel.y, 5); // lurch the way he bursts free
      this.app.floating.add(gangSize >= 2 ? "OUT OF THE PILE!" : "BROKE IT!", carrier.pos.x, carrier.pos.y, { size: 18, color: "#bfffd0", life: 0.8 });
      return { kind: "broken" };
    }

    return { kind: "gang", data: this.execute(q, pile, big, hitStick, closing) };
  }

  /** Force a committed tackle with a known lead (used after a lost 1-on-1 battle / debug). */
  commitTackle(q: TackleQuery, lead: Player): GangTackle {
    const pile = this.gather(q.carrier, q.defense, lead);
    const closing = Math.hypot(lead.vel.x - q.carrier.vel.x, lead.vel.y - q.carrier.vel.y) + 120;
    return this.execute(q, pile, true, false, closing);
  }

  /** Gather the swarm: the lead plus the nearest other defenders crashing the carrier. */
  private gather(carrier: Player, defense: Player[], lead: Player): Player[] {
    const near = defense
      .filter((d) => d !== lead && !d.isDown && dist(d.pos, carrier.pos) <= carrier.radius + d.radius + SWARM_R)
      .sort((a, b) => dist(a.pos, carrier.pos) - dist(b.pos, carrier.pos));
    return [lead, ...near].slice(0, GANG_MAX);
  }

  /** Execute the (possibly multi-man) tackle: pile momentum, ragdolls, fumble check, FX. */
  private execute(q: TackleQuery, pile: Player[], big: boolean, hitStick: boolean, closing: number): GangTackle {
    const { carrier, isReturn, indexOf } = q;
    const lead = pile[0];
    const gangSize = pile.length;
    const hx = (carrier.pos.x + lead.pos.x) / 2;
    const hy = (carrier.pos.y + lead.pos.y) / 2;
    const dirX = carrier.pos.x - lead.pos.x;
    const dirY = carrier.pos.y - lead.pos.y;
    const dl = Math.hypot(dirX, dirY) || 1;

    // Pile momentum = mass-weighted centre-of-mass velocity of the carrier + every tackler, so a
    // lone light defender barely slows a strong back (drag forward) while a gang reverses him.
    let mx = carrier.vel.x * carrier.strength;
    let my = carrier.vel.y * carrier.strength;
    let mass = carrier.strength;
    for (const t of pile) { mx += t.vel.x * t.strength; my += t.vel.y * t.strength; mass += t.strength; }
    // Plus a shove off the lead tackler (hard for a committed big hit — that's where the pop is).
    const shove = hitStick ? 90 : big ? 55 : 22;
    const pvx = mx / mass + (dirX / dl) * shove;
    const pvy = my / mass + (dirY / dl) * shove;

    const beat = clamp(0.2 + gangSize * 0.035 + (big ? 0.08 : 0), 0.2, 0.42);

    // Fumble: a committed strip, a big hit, or extra arrivals raking at the ball. Never on returns.
    const fumbleChance = isReturn ? 0 : clamp((hitStick ? 0.26 : big ? 0.07 : 0.02) + (gangSize - 1) * 0.045, 0, 0.42);
    const fumble = chance(fumbleChance);
    const fumbleVel = { x: (dirX / dl) * 120 + (Math.random() * 80 - 40), y: (dirY / dl) * 120 + (Math.random() * 80 - 40), up: 220 };

    // The whole pile wraps up and rides the shared momentum down.
    carrier.enterContact(pvx, pvy, beat);
    carrier.animEvent = "tackle";
    for (let i = 0; i < pile.length; i++) {
      const t = pile[i];
      t.enterContact(pvx * 0.5, pvy * 0.5, beat);
      t.animEvent = "tackleMade";
      t.facing = Math.atan2(carrier.pos.y - t.pos.y, carrier.pos.x - t.pos.x);
      t.heading = t.facing;
      t.bigHitArmed = false;
      t.diveTimer = 0;
      t.leanTarget = i % 2 === 0 ? 0.4 : -0.4; // lean into the pile
    }

    // Ragdoll the carrier + the closest couple of tacklers (cap for physics); the rest just wrap.
    const ragdollIdx: number[] = [];
    const ci = indexOf(carrier);
    if (ci >= 0 && this.app.scene3d.startRagdoll(ci, {
      hitDirX: dirX, hitDirY: dirY, closingPx: closing, carryVx: carrier.vel.x, carryVy: carrier.vel.y, big, bit: 0x0002,
    })) ragdollIdx.push(ci);
    const ragTacklers = Math.min(pile.length, RAGDOLL_MAX - 1);
    for (let i = 0; i < ragTacklers; i++) {
      const t = pile[i];
      const ti = indexOf(t);
      if (ti >= 0 && this.app.scene3d.startRagdoll(ti, {
        hitDirX: -dirX, hitDirY: -dirY, closingPx: closing * 0.55, carryVx: t.vel.x, carryVy: t.vel.y, big, bit: BODY_BITS[i] ?? 0x0004,
      })) ragdollIdx.push(ti);
    }

    this.impactFx(hx, hy, dirX, dirY, big, hitStick, gangSize, closing, fumble, lead.team);

    // Spot where the pile settles (slides along the shared momentum for part of the beat).
    const spot = { x: carrier.pos.x + pvx * beat * 0.6, y: carrier.pos.y + pvy * beat * 0.6 };

    return { lead, pile, spot, big, fumble, fumbleVel, beat, ragdollIdx, focus: carrier };
  }

  private impactFx(hx: number, hy: number, dirX: number, dirY: number, big: boolean, hitStick: boolean, gangSize: number, closing: number, fumble: boolean, _team: string): void {
    const a = this.app;
    const gang = gangSize >= 3;
    // Directional camera lurch (px): the camera gets *shoved* the way the runner is driven. Scales
    // with the violence of the contact so a hit-stick rocks the frame and a wrap-up barely nudges it.
    const kick = hitStick ? 15 : gang ? 12 : big ? 9 : 4;
    a.shake.kick(dirX, dirY, kick);
    if (big || gang) {
      a.time.freeze(hitStick ? 0.09 : 0.05);
      // Tiered slow-mo: the biggest hits get a deeper, longer hold so they read as a *moment*;
      // a routine "big" (just fast closing) stays snappy so the pace doesn't drag.
      if (hitStick) a.time.bulletTime(0.08, 0.72, 0.95);
      else if (gang) a.time.bulletTime(0.12, 0.5, 0.8);
      else a.time.bulletTime(0.18, 0.34, 0.6);
      a.scene3d.hitZoom(hitStick ? 0.95 : gang ? 0.82 : 0.66);
      a.shake.add(hitStick ? 0.9 : gang ? 0.72 : 0.5);
      a.particles.spark(hx, hy, dirX, dirY, hitStick ? 28 : gang ? 22 : 18);
      if (hitStick || gang) a.audio.bigHit(); else a.audio.hit(Math.min(1, closing / 260 + 0.4));
      const word = gang ? "GANG TACKLE!" : hitStick ? "BIG HIT!" : hitWord();
      a.floating.add(word, hx, hy - 16, { size: hitStick ? 34 : gang ? 30 : 28, color: hitStick ? "#ff5a3a" : gang ? "#ff9a3a" : "#ffd23a" });
      a.audio.crowdCheer();
    } else {
      a.time.bulletTime(0.3, 0.2, 0.42);
      a.scene3d.hitZoom(0.3);
      a.shake.add(0.18);
      a.particles.burst(hx, hy, "#d9c7a0", 8, 110);
      a.audio.hit(0.4);
    }
    if (fumble) {
      // Turnover drama: the ball pops loose during the contact, so escalate the moment hard —
      // a deeper, longer freeze + bullet-time to sell the scramble, an extra camera punch, a tight
      // zoom, and a crowd gasp. A loose ball is the most exciting thing that can happen on a down.
      a.time.freeze(0.11);
      a.time.bulletTime(0.07, 0.85, 1.05);
      a.scene3d.hitZoom(1.0);
      a.shake.add(0.4);
      a.shake.kick(dirX, dirY, 10);
      a.particles.spark(hx, hy, dirX, dirY, 30);
      a.floating.add("FUMBLE!", hx, hy - 40, { size: 30, color: "#ff5a3a" });
      a.audio.turnover();
      a.audio.crowdGroan();
    }
  }

  /** Glancing hit on a moving carrier from the side: stagger, stay up. */
  private tryStumble(carrier: Player, tackler: Player, closing: number, playTime: number): boolean {
    if (playTime - this.lastBreak < 0.5) return false;
    const cv = Math.hypot(carrier.vel.x, carrier.vel.y);
    if (cv < 45 || closing > 110) return false;
    const hvx = tackler.pos.x - carrier.pos.x;
    const hvy = tackler.pos.y - carrier.pos.y;
    const hl = Math.hypot(hvx, hvy) || 1;
    const dot = (carrier.vel.x / cv) * (hvx / hl) + (carrier.vel.y / cv) * (hvy / hl);
    if (dot > 0.5) return false; // square in front -> a real tackle, not a brush
    carrier.enterStumble(0.28);
    carrier.vel.x -= (hvx / hl) * 30;
    carrier.vel.y -= (hvy / hl) * 30;
    const cross = carrier.vel.x * hvy - carrier.vel.y * hvx;
    carrier.leanTarget = Math.sign(cross) || 1;
    this.app.time.slow(0.85, 0.12);
    this.app.shake.add(0.1);
    this.app.shake.kick(hvx, hvy, 4); // a glancing shove off the would-be tackler
    this.app.particles.burst((carrier.pos.x + tackler.pos.x) / 2, (carrier.pos.y + tackler.pos.y) / 2, "#ffffff", 5, 70);
    this.app.audio.hit(0.3);
    return true;
  }

  /** Strength + momentum break check against the whole pile. */
  private tryBreak(carrier: Player, pile: Player[], big: boolean, playTime: number): boolean {
    if (playTime - this.lastBreak < 0.55) return false;
    const speed = Math.hypot(carrier.vel.x, carrier.vel.y);
    let p = big ? (carrier.turbo ? 0.22 : 0.05) : carrier.turbo ? 0.55 : 0.34;
    const carrierPower = carrier.strength * (1 + speed / 320) * (carrier.turbo ? 1.2 : 1);
    let gangStr = 0;
    for (const t of pile) gangStr += t.strength;
    p *= clamp(carrierPower / (gangStr * 0.9), 0.3, 1.8);
    if (pile.length >= 2) p *= 0.45; // a gang is hard to slip
    if (pile.length >= 3) p *= 0.5;
    if (Math.random() >= p) return false;
    this.lastBreak = playTime;
    return true;
  }
}
