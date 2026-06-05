import type { Renderer } from "../engine/Renderer";
import { drawPanel, tappedIn, type Rect } from "./widgets";
import { COLORS, FONT } from "./Theme";
import {
  OFFENSE_PLAYS,
  DEFENSE_PLAYS,
  type OffensePlay,
  type DefensePlay,
} from "../game/Playbook";

export interface PlayPick {
  off?: OffensePlay;
  def?: DefensePlay;
}

/**
 * The card-pick play-call UI, shared by the dedicated PlaySelectState (kickoff entry) and the
 * broadcast-style overlay that LivePlayState draws over the live field between downs. It owns
 * card layout, rendering (with route/scheme diagrams) and tap hit-testing — but no game state,
 * so a caller can lay it over anything.
 */
const PER_PAGE = 4; // plays shown at once; the rest live on further pages

export class PlayCallOverlay {
  private cards: { rect: Rect; off?: OffensePlay; def?: DefensePlay }[] = [];
  private humanOffense = true;
  private allPlays: (OffensePlay | DefensePlay)[] = [];
  private page = 0;
  private pages = 1;
  private prevRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private nextRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private dotsY = 0;
  private r!: Renderer;

  /** (Re)compute card rectangles for the current screen size and side. */
  layout(r: Renderer, humanOffense: boolean): void {
    this.r = r;
    this.humanOffense = humanOffense;
    this.allPlays = (humanOffense ? OFFENSE_PLAYS : DEFENSE_PLAYS).slice();
    this.pages = Math.max(1, Math.ceil(this.allPlays.length / PER_PAGE));
    this.page = 0;
    this.computePageCards();
  }

  /** Lay out the (up to 4) cards for the current page, in one row, plus the page-nav regions. */
  private computePageCards(): void {
    const r = this.r;
    const start = this.page * PER_PAGE;
    const items = this.allPlays.slice(start, start + PER_PAGE);
    const cols = Math.max(1, items.length);
    const gap = 12;
    const cardW = Math.min(168, (r.width - 36 - gap * (cols - 1)) / cols);
    const cardH = Math.min(168, r.height * 0.34);
    const totalW = cols * cardW + (cols - 1) * gap;
    const startX = (r.width - totalW) / 2;
    const navH = this.pages > 1 ? 46 : 14;
    const startY = r.height - cardH - navH - 18;

    this.cards = items.map((p, i) => {
      const rect: Rect = { x: startX + i * (cardW + gap), y: startY, w: cardW, h: cardH };
      return this.humanOffense ? { rect, off: p as OffensePlay } : { rect, def: p as DefensePlay };
    });

    const navY = startY + cardH + 8;
    this.dotsY = navY + 18;
    const bw = 92;
    this.prevRect = { x: startX, y: navY, w: bw, h: 34 };
    this.nextRect = { x: startX + totalW - bw, y: navY, w: bw, h: 34 };
  }

  /** If a card was tapped, return the chosen play; page-nav taps flip the page and return null. */
  pick(taps: { x: number; y: number }[]): PlayPick | null {
    if (taps.length === 0) return null;
    if (this.pages > 1) {
      if (tappedIn(this.prevRect, taps)) { this.page = (this.page - 1 + this.pages) % this.pages; this.computePageCards(); return null; }
      if (tappedIn(this.nextRect, taps)) { this.page = (this.page + 1) % this.pages; this.computePageCards(); return null; }
    }
    for (const card of this.cards) {
      if (tappedIn(card.rect, taps)) return { off: card.off, def: card.def };
    }
    return null;
  }

  render(r: Renderer, opts: { alpha?: number; title?: string } = {}): void {
    const a = opts.alpha ?? 1;
    if (a <= 0.01) return;
    const ctx = r.ctx;
    const title = opts.title ?? (this.humanOffense ? "CALL IT — OFFENSE" : "CALL IT — DEFENSE");

    ctx.save();
    ctx.globalAlpha = a;
    // A soft scrim behind the call so the cards read over the bright turf, without hiding the
    // field action (players ambling back to the huddle stay visible through it).
    const top = this.cards.length ? this.cards[0].rect.y - 64 : r.height * 0.5;
    const grad = ctx.createLinearGradient(0, top, 0, r.height);
    grad.addColorStop(0, "rgba(8,10,14,0)");
    grad.addColorStop(0.35, "rgba(8,10,14,0.62)");
    grad.addColorStop(1, "rgba(8,10,14,0.82)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top, r.width, r.height - top);

    ctx.letterSpacing = "2px";
    r.text(title, r.width / 2, top + 30, {
      size: 24,
      align: "center",
      color: COLORS.bone,
      font: FONT.display,
    });
    ctx.letterSpacing = "0px";

    for (const card of this.cards) {
      const name = card.off?.name ?? card.def?.name ?? "";
      drawPanel(r, card.rect, COLORS.panel);
      r.text(name.toUpperCase(), card.rect.x + card.rect.w / 2, card.rect.y + 28, {
        size: 22,
        align: "center",
        color: COLORS.bone,
        font: FONT.display,
      });
      const diag = { x: card.rect.x + 10, y: card.rect.y + 44, w: card.rect.w - 20, h: card.rect.h - 74 };
      if (card.off) this.drawOffenseDiagram(r, diag, card.off);
      else if (card.def) this.drawDefenseDiagram(r, diag, card.def);

      const badge = card.off ? (card.off.isRun ? "RUN" : "PASS") : (card.def?.scheme.toUpperCase() ?? "");
      r.text(badge, card.rect.x + card.rect.w / 2, card.rect.y + card.rect.h - 15, {
        size: 12,
        align: "center",
        color: COLORS.blood,
        weight: "normal",
      });
    }

    // Page navigation (only when the playbook spills past one page).
    if (this.pages > 1) {
      drawPanel(r, this.prevRect, COLORS.concrete);
      drawPanel(r, this.nextRect, COLORS.concrete);
      r.text("‹ PREV", this.prevRect.x + this.prevRect.w / 2, this.prevRect.y + this.prevRect.h / 2, {
        size: 14, align: "center", baseline: "middle", color: COLORS.bone, font: FONT.ui,
      });
      r.text("NEXT ›", this.nextRect.x + this.nextRect.w / 2, this.nextRect.y + this.nextRect.h / 2, {
        size: 14, align: "center", baseline: "middle", color: COLORS.bone, font: FONT.ui,
      });
      // Page dots between the buttons.
      const dotGap = 16;
      const dx0 = r.width / 2 - ((this.pages - 1) * dotGap) / 2;
      for (let i = 0; i < this.pages; i++) {
        r.circle(dx0 + i * dotGap, this.dotsY, i === this.page ? 4 : 2.5, i === this.page ? COLORS.hazard : COLORS.steel);
      }
    }
    ctx.restore();
  }

  /** Mini route diagram: dots at the snap, lines tracing each receiver's route. */
  private drawOffenseDiagram(r: Renderer, d: Rect, play: OffensePlay): void {
    const ctx = r.ctx;
    const cx = d.x + d.w / 2;
    const losY = d.y + d.h * 0.74;
    let maxFwd = 12;
    for (const s of play.slots) for (const wp of s.route ?? []) maxFwd = Math.max(maxFwd, wp.fwd);
    const sy = (d.h * 0.66) / maxFwd;
    const sx = d.w / 46;
    const px = (lat: number) => cx + lat * sx;
    const py = (fwd: number) => losY - fwd * sy;

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.x, losY);
    ctx.lineTo(d.x + d.w, losY);
    ctx.stroke();

    for (const slot of play.slots) {
      const startX = px(slot.start.lat);
      const startY = py(slot.start.fwd);
      if (slot.route && slot.route.length) {
        ctx.strokeStyle = "#e0b21a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        for (const wp of slot.route) ctx.lineTo(px(wp.lat), py(wp.fwd));
        ctx.stroke();
      }
      ctx.fillStyle = slot.job === "qb" ? "#e11d2b" : slot.job === "run" ? "#7b8694" : "#fff";
      ctx.beginPath();
      ctx.arc(startX, startY, slot.job === "block" ? 2 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (slot.job === "run") {
        ctx.strokeStyle = "#7b8694";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(startX, py(8));
        ctx.stroke();
      }
    }
  }

  /** Simple defensive scheme icon. */
  private drawDefenseDiagram(r: Renderer, d: Rect, play: DefensePlay): void {
    const ctx = r.ctx;
    const cx = d.x + d.w / 2;
    const losY = d.y + d.h * 0.4;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.x, losY);
    ctx.lineTo(d.x + d.w, losY);
    ctx.stroke();

    const reds = [-1.6, -0.6, 0.6, 1.6];
    if (play.scheme === "blitz") {
      ctx.strokeStyle = "#e11d2b";
      ctx.lineWidth = 2;
      for (const k of reds) {
        const x = cx + k * 26;
        ctx.beginPath();
        ctx.moveTo(x, losY + 34);
        ctx.lineTo(x, losY + 6);
        ctx.moveTo(x - 4, losY + 12);
        ctx.lineTo(x, losY + 6);
        ctx.lineTo(x + 4, losY + 12);
        ctx.stroke();
      }
    } else if (play.scheme === "spy") {
      ctx.fillStyle = "#e11d2b";
      ctx.beginPath();
      ctx.arc(cx, losY + 22, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#e11d2b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, losY + 16);
      ctx.lineTo(cx, losY + 2);
      ctx.stroke();
    } else if (play.scheme === "zone") {
      // Deep-third shells up high + underneath drops — a soft umbrella.
      ctx.strokeStyle = "#39b0e0";
      ctx.lineWidth = 2;
      for (const k of [-1.5, 0, 1.5]) {
        const x = cx + k * 30;
        ctx.beginPath();
        ctx.arc(x, losY - 6, 11, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = "#7b8694";
      for (const k of [-0.8, 0.8]) {
        const x = cx + k * 30;
        ctx.beginPath();
        ctx.arc(x, losY + 20, 7, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "#7b8694";
      ctx.lineWidth = 2;
      for (const k of [-1.4, 0, 1.4]) {
        const x = cx + k * 30;
        ctx.beginPath();
        ctx.arc(x, losY + 20, 8, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
