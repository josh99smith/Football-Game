import type { Renderer } from "../engine/Renderer";
import type { Match } from "../game/Match";

/** Top scoreboard: score, quarter, clock, down & distance, possession, fire, turbo. */
export class HUD {
  render(r: Renderer, match: Match, opts: { turbo: number; possessionLabel?: string }): void {
    const ctx = r.ctx;
    const w = r.width;
    const barH = 46;

    // Scoreboard background.
    ctx.fillStyle = "rgba(8, 20, 12, 0.86)";
    ctx.fillRect(0, 0, w, barH);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, barH - 2, w, 2);

    const home = match.home;
    const away = match.away;

    // Home (left).
    this.teamChip(r, 12, 8, home.config.abbr, home.config.colors.jersey, home.score, home.onFire, "left");
    // Away (right).
    this.teamChip(r, w - 12, 8, away.config.abbr, away.config.colors.jersey, away.score, away.onFire, "right");

    // Center: quarter + clock.
    const mins = Math.floor(match.clock / 60);
    const secs = Math.floor(match.clock % 60);
    const clockStr = `${mins}:${secs.toString().padStart(2, "0")}`;
    r.text(`Q${match.quarter}`, w / 2, 12, { size: 13, align: "center", color: "#ffd23a", baseline: "top" });
    r.text(clockStr, w / 2, 26, { size: 20, align: "center", color: "#fff", baseline: "top" });

    // Down & distance + ball spot, just under center.
    const dd = match.isGoalToGo()
      ? `${ordinal(match.down)} & GOAL`
      : `${ordinal(match.down)} & ${match.distanceYards}`;
    const possName = match.team(match.possession).config.abbr;
    r.text(`${possName}  ${dd}  ·  ${match.fieldSideLabel()}`, w / 2, barH + 6, {
      size: 13,
      align: "center",
      color: "#dfeee2",
      baseline: "top",
    });

    if (opts.possessionLabel) {
      r.text(opts.possessionLabel, w / 2, barH + 24, {
        size: 12,
        align: "center",
        color: "#ffd23a",
        baseline: "top",
      });
    }

    // Turbo meter (bottom-left).
    this.turboMeter(r, opts.turbo);
  }

  private teamChip(
    r: Renderer,
    x: number,
    y: number,
    abbr: string,
    color: string,
    score: number,
    onFire: boolean,
    align: "left" | "right",
  ): void {
    const ctx = r.ctx;
    ctx.save();
    // Color swatch.
    ctx.fillStyle = color;
    const swX = align === "left" ? x : x - 26;
    ctx.fillRect(swX, y, 26, 30);
    if (onFire) {
      ctx.strokeStyle = "#ff7b1e";
      ctx.lineWidth = 3;
      ctx.strokeRect(swX - 1.5, y - 1.5, 29, 33);
    }
    r.text(abbr, align === "left" ? x + 34 : x - 34, y + 4, {
      size: 14,
      color: "#cfe",
      align: align === "left" ? "left" : "right",
      baseline: "top",
    });
    r.text(String(score), align === "left" ? x + 34 : x - 34, y + 18, {
      size: 22,
      color: "#fff",
      align: align === "left" ? "left" : "right",
      baseline: "top",
    });
    ctx.restore();
  }

  private turboMeter(r: Renderer, turbo: number): void {
    const ctx = r.ctx;
    const w = 120;
    const h = 12;
    const x = 16;
    const y = r.height - 26;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#0a3a1a";
    ctx.fillRect(x, y, w, h);
    const fill = Math.max(0, Math.min(1, turbo));
    ctx.fillStyle = fill > 0.25 ? "#28c0ff" : "#ff5a5a";
    ctx.fillRect(x, y, w * fill, h);
    r.text("TURBO", x, y - 14, { size: 11, color: "#bfe", baseline: "top" });
  }
}

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}
