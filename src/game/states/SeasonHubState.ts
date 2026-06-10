import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { TEAMS } from "../Team";
import { drawButton, drawPanel, tappedIn, type Rect } from "../../ui/widgets";
import { drawCrest } from "../../ui/Emblems";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import {
  standings, userGameThisWeek, opponentOf, userPlayoffGame, userInPlayoff,
  simGame, advanceWeek, simWholePlayoff, makeSeason, saveSeason,
  type SeasonData, type PlayoffGame,
} from "../season";
import { MatchupIntroState } from "./MatchupIntroState";
import { MenuState } from "./MenuState";

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

/** Season home screen: standings + your next game during the regular season, the 4-team bracket in
 *  the playoff, and the champion when it's done. Plays your games for real; sims the rest. */
export class SeasonHubState implements GameState {
  private readonly app: GameApp;
  private rects: Record<string, Rect> = {};
  private t = 0;

  constructor(app: GameApp) { this.app = app; }

  private get season(): SeasonData { return this.app.season!; }

  enter(): void { this.app.input.consumeTaps(); }

  update(dt: number): void {
    this.t += dt;
    const taps = this.app.input.consumeTaps();
    if (taps.length === 0) return;
    const s = this.season;

    if (tappedIn(this.rects.menu, taps)) { this.app.audio.uiTap(); this.app.setState(new MenuState(this.app)); return; }

    if (s.phase === "regular") {
      if (tappedIn(this.rects.play, taps)) { this.playUserGame(opponentOf(userGameThisWeek(s)!, s.teamIndex)); return; }
      if (tappedIn(this.rects.sim, taps)) { this.simUserWeek(); return; }
    } else if (s.phase === "playoff") {
      const g = userPlayoffGame(s);
      if (g && tappedIn(this.rects.play, taps)) { this.playUserGame(opponentOf(g, s.teamIndex)); return; }
      if (this.rects.simPlayoff && tappedIn(this.rects.simPlayoff, taps)) {
        this.app.audio.uiConfirm(); simWholePlayoff(s); saveSeason(s); return;
      }
    } else if (s.phase === "done") {
      if (tappedIn(this.rects.newSeason, taps)) {
        this.app.audio.uiConfirm();
        const fresh = makeSeason(s.teamIndex, s.difficulty, s.quarterLength);
        saveSeason(fresh); this.app.season = fresh; return;
      }
    }
    this.app.audio.uiTap();
  }

  /** Launch the user's game (always as HOME) against `opponent`. */
  private playUserGame(opponent: number): void {
    this.app.audio.uiConfirm();
    const s = this.season;
    this.app.config.homeTeamIndex = s.teamIndex;
    this.app.config.awayTeamIndex = opponent;
    this.app.config.difficulty = s.difficulty;
    this.app.config.quarterLength = s.quarterLength;
    this.app.newMatch();
    this.app.setState(new MatchupIntroState(this.app));
  }

  /** Sim the user's own game this week too (skip-play), then advance. */
  private simUserWeek(): void {
    this.app.audio.uiConfirm();
    const s = this.season;
    const g = userGameThisWeek(s);
    if (!g) return;
    const r = simGame(g.home, g.away, s.ratings);
    const userScore = g.home === s.teamIndex ? r.homeScore : r.awayScore;
    const oppScore = g.home === s.teamIndex ? r.awayScore : r.homeScore;
    advanceWeek(s, userScore, oppScore);
    saveSeason(s);
  }

  render(): void {
    const r = this.app.r;
    const s = this.season;
    r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, this.t);
    const ctx = r.ctx;

    const w = Math.min(480, r.width - 24);
    const x = (r.width - w) / 2;
    const h = Math.min(r.height - 24, 560);
    const y = Math.max(12, (r.height - h) / 2);
    drawPanel(r, { x, y, w, h });

    const myTeam = TEAMS[s.teamIndex];
    ctx.save();
    ctx.letterSpacing = "2px";
    const heading = s.phase === "regular" ? `SEASON · WEEK ${s.week + 1}` : s.phase === "playoff" ? "PLAYOFFS" : "SEASON COMPLETE";
    r.text(heading, r.width / 2, y + 30, { size: 22, align: "center", color: COLORS.hazard, font: FONT.display });
    ctx.restore();
    r.text(`${myTeam.name.toUpperCase()} — YOUR FRANCHISE`, r.width / 2, y + 54, { size: 12, align: "center", color: COLORS.ash, weight: "normal", baseline: "middle" });

    const bodyY = y + 78;
    if (s.phase === "done") this.renderChampion(r, x, bodyY, w);
    else if (s.phase === "playoff") this.renderBracket(r, x, bodyY, w);
    else this.renderStandings(r, x, bodyY, w, h, y);

    // Buttons across the bottom.
    const by = y + h - 60;
    const bw = (w - 36) / 2;
    this.rects.menu = { x: x + 12, y: by, w: bw, h: 46 };
    drawButton(r, this.rects.menu, "MENU", { fill: COLORS.steel, size: 16 });
    const rightRect = { x: x + 24 + bw, y: by, w: bw, h: 46 };
    if (s.phase === "regular") {
      this.rects.play = rightRect;
      drawButton(r, this.rects.play, `PLAY WEEK ${s.week + 1}`, { fill: COLORS.blood, accent: COLORS.hazard, size: 16 });
      // A small SIM-week button above the row.
      this.rects.sim = { x: x + 12, y: by - 40, w: w - 24, h: 30 };
      drawButton(r, this.rects.sim, "SIM THIS WEEK", { fill: COLORS.concrete, size: 13 });
    } else if (s.phase === "playoff") {
      const g = userPlayoffGame(s);
      if (g) {
        this.rects.play = rightRect;
        drawButton(r, this.rects.play, g.round === "final" ? "PLAY FINAL" : "PLAY SEMIFINAL", { fill: COLORS.blood, accent: COLORS.hazard, size: 15 });
        this.rects.simPlayoff = { x: 0, y: 0, w: 0, h: 0 }; // inert (the user has a game to play)
      } else {
        // User is out (or not in the bracket) — offer to sim the rest to a champion.
        this.rects.simPlayoff = rightRect;
        drawButton(r, this.rects.simPlayoff, userInPlayoff(s) ? "SIM REST" : "SIM PLAYOFFS", { fill: COLORS.concrete, accent: COLORS.hazard, size: 15 });
      }
    } else {
      this.rects.newSeason = rightRect;
      drawButton(r, this.rects.newSeason, "NEW SEASON", { fill: COLORS.blood, accent: COLORS.hazard, size: 16 });
    }
  }

  private renderStandings(r: GameApp["r"], x: number, y: number, w: number, h: number, panelY: number): void {
    const s = this.season;
    const ctx = r.ctx;
    const rows = standings(s);
    const rowH = clamp((panelY + h - 120 - y) / rows.length, 22, 34);
    r.text("STANDINGS", x + 16, y, { size: 12, align: "left", color: COLORS.blood, baseline: "middle", weight: "normal" });
    r.text("W", x + w - 130, y, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
    r.text("L", x + w - 92, y, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
    r.text("DIFF", x + w - 44, y, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
    rows.forEach((row, i) => {
      const ry = y + 22 + i * rowH;
      const mine = row.team === s.teamIndex;
      const inPlayoff = i < 4;
      ctx.fillStyle = mine ? "rgba(212,32,42,0.18)" : i % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0)";
      ctx.fillRect(x + 10, ry - rowH / 2, w - 20, rowH);
      // seed bar for the top 4
      if (inPlayoff) { ctx.fillStyle = COLORS.hazard; ctx.fillRect(x + 10, ry - rowH / 2, 3, rowH); }
      const t = TEAMS[row.team];
      r.text(`${i + 1}`, x + 24, ry, { size: 13, align: "center", color: inPlayoff ? COLORS.hazard : COLORS.ash, baseline: "middle", font: FONT.display });
      drawCrest(ctx, x + 46, ry, 11, t);
      r.text(t.name.toUpperCase(), x + 64, ry, { size: clamp(rowH * 0.42, 12, 15), align: "left", color: mine ? COLORS.bone : COLORS.bone, baseline: "middle", font: FONT.display });
      r.text(`${row.w}`, x + w - 130, ry, { size: 14, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
      r.text(`${row.l}`, x + w - 92, ry, { size: 14, align: "center", color: COLORS.ash, baseline: "middle", font: FONT.display });
      r.text(`${row.diff > 0 ? "+" : ""}${row.diff}`, x + w - 44, ry, { size: 13, align: "center", color: row.diff >= 0 ? COLORS.bone : COLORS.blood, baseline: "middle", font: FONT.display });
    });

    // Your next matchup.
    const g = userGameThisWeek(s);
    if (g) {
      const opp = TEAMS[opponentOf(g, s.teamIndex)];
      const ny = panelY + h - 96;
      r.text("THIS WEEK", r.width / 2, ny, { size: 11, align: "center", color: COLORS.blood, baseline: "middle", weight: "normal" });
      r.text(`${TEAMS[s.teamIndex].abbr}  vs  ${opp.abbr}`, r.width / 2, ny + 18, { size: 18, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
    }
  }

  private renderBracket(r: GameApp["r"], x: number, y: number, w: number): void {
    const s = this.season;
    const b = s.bracket!;
    const ctx = r.ctx;
    const line = (g: PlayoffGame, gy: number, label: string): void => {
      const home = TEAMS[g.home], away = TEAMS[g.away];
      const mine = g.home === s.teamIndex || g.away === s.teamIndex;
      ctx.fillStyle = mine ? "rgba(212,32,42,0.18)" : "rgba(255,255,255,0.03)";
      ctx.fillRect(x + 14, gy - 18, w - 28, 36);
      r.text(label, x + 24, gy - 24, { size: 10, align: "left", color: COLORS.blood, baseline: "middle", weight: "normal" });
      const score = g.played ? `  ${g.homeScore}–${g.awayScore}` : "";
      r.text(`(${g.seedHome}) ${home.abbr}  vs  (${g.seedAway}) ${away.abbr}${score}`, x + 24, gy, {
        size: 16, align: "left", color: COLORS.bone, baseline: "middle", font: FONT.display,
      });
      if (g.played) {
        const winAbbr = TEAMS[g.homeScore >= g.awayScore ? g.home : g.away].abbr;
        r.text(`${winAbbr} ►`, x + w - 24, gy, { size: 13, align: "right", color: COLORS.hazard, baseline: "middle", font: FONT.display });
      }
    };
    line(b.semis[0], y + 30, "SEMIFINAL 1");
    line(b.semis[1], y + 92, "SEMIFINAL 2");
    if (b.final) line(b.final, y + 168, "CHAMPIONSHIP");
    else r.text("CHAMPIONSHIP — TBD", r.width / 2, y + 168, { size: 14, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
  }

  private renderChampion(r: GameApp["r"], x: number, y: number, w: number): void {
    const s = this.season;
    const champ = s.bracket?.champion ?? s.teamIndex;
    const won = champ === s.teamIndex;
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "2px";
    r.text(won ? "CHAMPIONS!" : "CHAMPION", r.width / 2, y + 30, { size: 30, align: "center", color: won ? COLORS.hazard : COLORS.bone, font: FONT.display });
    ctx.restore();
    drawCrest(ctx, r.width / 2, y + 100, 44, TEAMS[champ]);
    r.text(TEAMS[champ].name.toUpperCase(), r.width / 2, y + 160, { size: 22, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
    if (!won) r.text("Your franchise fell short — run it back.", r.width / 2, y + 188, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
    void x; void w;
  }
}
