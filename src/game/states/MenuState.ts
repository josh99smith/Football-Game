import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { TEAMS } from "../Team";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { drawCrest, drawHardcoreBadge } from "../../ui/Emblems";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { saveSettings, loadSettings } from "../storage";
import { makeSeason, loadSeason, saveSeason } from "../season";
import { MatchupIntroState } from "./MatchupIntroState";
import { SeasonHubState } from "./SeasonHubState";
import { PlaySelectState } from "./PlaySelectState";
import { versionLabel, buildDate } from "../buildInfo";

const DIFFS: GameApp["config"]["difficulty"][] = ["rookie", "pro", "allpro"];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Title screen: pick your team, opponent, difficulty, then kick off. */
export class MenuState implements GameState {
  private readonly app: GameApp;
  private rects: Record<string, Rect> = {};
  private t = 0;
  /** True if a saved, still-in-progress season can be resumed (computed once on enter). */
  private resumable = false;

  // Layout values shared between layout() and render().
  private crestR = 40;
  private teamY = 0;
  private cxL = 0;
  private cxR = 0;
  private badgeR = 24;
  private badgeY = 0;
  private wordY = 0;
  private taglineY = 0;
  private titleSize = 40;

  constructor(app: GameApp) {
    this.app = app;
    const s = loadSettings();
    if (s.difficulty) app.config.difficulty = s.difficulty;
    if (typeof s.muted === "boolean") app.config.muted = s.muted;
    if (typeof s.homeTeamIndex === "number") app.config.homeTeamIndex = s.homeTeamIndex;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.layout();
    this.app.audio.setMuted(this.app.config.muted);
    const saved = loadSeason();
    this.resumable = !!saved && saved.phase !== "done";
    // Returning to the menu ends any debug session (tears down the overlay next tick).
    if (this.app.match) this.app.match.debugMode = false;
  }

  /**
   * Fully responsive, computed bottom-up so nothing ever overlaps — the previous
   * fixed-pixel layout collapsed the PLAY button onto the SOUND button in short
   * landscape viewports, which is why the start button "barely worked".
   */
  private layout(): void {
    const r = this.app.r;
    const W = r.width;
    const H = r.height;
    const cx = W / 2;

    const margin = clamp(H * 0.05, 12, 34);
    const playH = clamp(H * 0.13, 46, 66);
    const playY = H - playH - margin;
    const playW = clamp(W * 0.5, 200, 360);

    const optH = clamp(H * 0.085, 30, 44);
    const optY = playY - optH - clamp(H * 0.04, 10, 22);
    const optW = clamp(W * 0.3, 140, 240);

    this.crestR = clamp(Math.min(H * 0.13, W * 0.085), 22, 54);
    const aw = clamp(Math.min(H * 0.1, W * 0.07), 28, 44);
    const gap = 8;
    this.cxL = W * 0.28;
    this.cxR = W * 0.72;
    this.teamY = optY - optH * 0.3 - 22 - this.crestR;

    // Size the hero cluster (skull badge + wordmark + tagline) to the headroom above
    // the team row so it never collides on short landscape viewports.
    const topMargin = clamp(H * 0.03, 6, 16);
    const zoneBottom = this.teamY - this.crestR - 10;
    const headroom = zoneBottom - topMargin;
    const k = Math.min(clamp(headroom / 3.95, 16, 58), W * 0.085);
    this.badgeR = k;
    this.titleSize = clamp(Math.min(k * 1.18, W * 0.1), 18, 60);
    const clusterH = this.badgeR * 2.32 + 6 + this.titleSize + this.titleSize * 0.5;
    const startY = Math.max(topMargin, (zoneBottom - clusterH) / 2);
    this.badgeY = startY + this.badgeR * 1.16;
    this.wordY = this.badgeY + this.badgeR * 1.16 + 6 + this.titleSize * 0.5;
    this.taglineY = this.wordY + this.titleSize * 0.62;

    const arrow = (centre: number, side: number): Rect => ({
      x: side < 0 ? centre - this.crestR - gap - aw : centre + this.crestR + gap,
      y: this.teamY - aw / 2,
      w: aw,
      h: aw,
    });

    this.rects = {
      teamPrev: arrow(this.cxL, -1),
      teamNext: arrow(this.cxL, 1),
      oppPrev: arrow(this.cxR, -1),
      oppNext: arrow(this.cxR, 1),
      diff: { x: cx - optW - 6, y: optY, w: optW, h: optH },
      mute: { x: cx + 6, y: optY, w: optW, h: optH },
      // Play row: the two hero buttons — PLAY (exhibition) + SEASON.
      play: { x: cx - playW / 2, y: playY, w: playW * 0.5 - 5, h: playH },
      season: { x: cx - playW / 2 + playW * 0.5 + 5, y: playY, w: playW * 0.5 - 5, h: playH },
      // Small sandbox entries, tucked in the bottom-left safe area.
      debug: { x: 10, y: H - 34 - clamp(H * 0.02, 4, 12), w: 84, h: 34 },
      practice: { x: 100, y: H - 34 - clamp(H * 0.02, 4, 12), w: 96, h: 34 },
    };
  }

  update(dt: number): void {
    this.t += dt;
    const taps = this.app.input.consumeTaps();
    if (taps.length === 0) return;
    this.app.audio.resume();
    const c = this.app.config;

    if (tappedIn(this.rects.teamPrev, taps)) c.homeTeamIndex = wrap(c.homeTeamIndex - 1);
    else if (tappedIn(this.rects.teamNext, taps)) c.homeTeamIndex = wrap(c.homeTeamIndex + 1);
    else if (tappedIn(this.rects.oppPrev, taps)) c.awayTeamIndex = wrap(c.awayTeamIndex - 1);
    else if (tappedIn(this.rects.oppNext, taps)) c.awayTeamIndex = wrap(c.awayTeamIndex + 1);
    else if (tappedIn(this.rects.diff, taps)) {
      c.difficulty = DIFFS[(DIFFS.indexOf(c.difficulty) + 1) % DIFFS.length];
    } else if (tappedIn(this.rects.mute, taps)) {
      c.muted = !c.muted;
      this.app.audio.setMuted(c.muted);
    } else if (tappedIn(this.rects.play, taps)) {
      this.startGame();
      return;
    } else if (tappedIn(this.rects.season, taps)) {
      this.startSeason();
      return;
    } else if (tappedIn(this.rects.practice, taps)) {
      this.startPractice();
      return;
    } else if (tappedIn(this.rects.debug, taps)) {
      this.startDebug();
      return;
    } else {
      this.app.audio.uiTap();
      return;
    }
    if (c.awayTeamIndex === c.homeTeamIndex) c.awayTeamIndex = wrap(c.awayTeamIndex + 1);
    this.app.audio.uiTap();
    saveSettings({ difficulty: c.difficulty, muted: c.muted, homeTeamIndex: c.homeTeamIndex });
  }

  private startGame(): void {
    this.app.audio.uiConfirm();
    this.app.season = null; // exhibition — not a season game
    this.app.newMatch();
    this.app.setState(new MatchupIntroState(this.app));
  }

  /** Enter season mode: resume a saved season if one exists, else start a fresh 8-game season with
   *  the franchise currently selected as YOUR CREW. */
  private startSeason(): void {
    this.app.audio.uiConfirm();
    const c = this.app.config;
    let s = loadSeason();
    // Resume an in-progress season; a finished (or missing) one starts fresh with the picked crew.
    if (!s || s.phase === "done") {
      s = makeSeason(c.homeTeamIndex, c.difficulty, c.quarterLength);
      saveSeason(s);
    }
    this.app.season = s;
    this.app.setState(new SeasonHubState(this.app));
  }

  /** Sandbox: the real game loop with full mechanics + controls, but the clock is frozen and the
   *  scoring/kickoff ceremonies are skipped — straight into the play-call to rep every move. */
  private startPractice(): void {
    this.app.audio.uiConfirm();
    this.app.newMatch();
    this.app.match.beginPractice();
    this.app.setState(new PlaySelectState(this.app));
  }

  /** Tuning sandbox: practice, plus the in-game DEBUG overlay (free camera, live animation tuning,
   *  screenshot / contact-sheet capture) so motion can be inspected and tuned on-device. */
  private startDebug(): void {
    this.app.audio.uiConfirm();
    this.app.newMatch();
    this.app.match.beginPractice();
    this.app.match.debugMode = true;
    this.app.setState(new PlaySelectState(this.app));
  }

  render(): void {
    const r = this.app.r;
    const W = r.width;
    this.app.r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, this.t);
    this.layout();
    const cx = W / 2;
    const ctx = r.ctx;

    // Brand-orange glow behind the emblem, then the spiked skull + stamped wordmark.
    const badgeY = this.badgeY;
    const glow = ctx.createRadialGradient(cx, badgeY, this.badgeR * 0.4, cx, badgeY, this.badgeR * 2.6);
    glow.addColorStop(0, "rgba(217,86,15,0.45)");
    glow.addColorStop(1, "rgba(217,86,15,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - this.badgeR * 3, badgeY - this.badgeR * 3, this.badgeR * 6, this.badgeR * 6);
    drawHardcoreBadge(ctx, cx, badgeY, this.badgeR);
    const titleSize = this.titleSize;
    this.stampedTitle(r, "BOBBLE BOWL", cx, this.wordY, titleSize);

    // Gritty tagline strip.
    ctx.save();
    ctx.letterSpacing = "3px";
    r.text("BIG HEADS · BIG HITS · STREET RULES", cx, this.taglineY, {
      size: clamp(titleSize * 0.24, 9, 14),
      align: "center",
      color: COLORS.blood,
      baseline: "middle",
      weight: "normal",
      font: FONT.ui,
    });
    ctx.restore();

    if (this.app.highScores.length > 0) {
      const hs = this.app.highScores[0];
      r.text(`BEST: ${hs.team} ${hs.points}–${hs.opponentPoints} ${hs.opponent}`, cx, this.taglineY + titleSize * 0.45, {
        size: 11,
        align: "center",
        color: COLORS.ash,
        weight: "normal",
        baseline: "middle",
      });
    }

    const c = this.app.config;
    const home = TEAMS[c.homeTeamIndex % TEAMS.length];
    const away = TEAMS[c.awayTeamIndex % TEAMS.length];
    this.teamColumn(r, this.cxL, "YOUR CREW", home, this.rects.teamPrev, this.rects.teamNext);
    this.teamColumn(r, this.cxR, "RIVALS", away, this.rects.oppPrev, this.rects.oppNext);

    drawButton(r, this.rects.diff, `DIFF: ${c.difficulty.toUpperCase()}`, { fill: COLORS.concrete, size: 15 });
    drawButton(r, this.rects.mute, c.muted ? "SOUND: OFF" : "SOUND: ON", { fill: COLORS.concrete, size: 14 });
    drawButton(r, this.rects.play, "PLAY", {
      fill: COLORS.blood,
      accent: COLORS.hazard,
      size: clamp(this.rects.play.h * 0.36, 16, 26),
    });
    drawButton(r, this.rects.season, this.resumable ? "RESUME" : "SEASON", {
      fill: COLORS.concrete,
      accent: COLORS.hazard,
      size: clamp(this.rects.season.h * 0.32, 14, 22),
      sub: this.resumable ? "SEASON" : "8 GAMES + PLAYOFF",
    });
    drawButton(r, this.rects.debug, "DEBUG", { fill: COLORS.steel, size: 13 });
    drawButton(r, this.rects.practice, "PRACTICE", { fill: COLORS.steel, size: 13 });

    // Build stamp: version + last-updated date/time (bumped automatically on every build/push).
    ctx.save();
    ctx.letterSpacing = "1px";
    r.text(versionLabel(), cx, r.height - 26, {
      size: 11, align: "center", color: COLORS.steel, weight: "normal", baseline: "middle", font: FONT.ui,
    });
    r.text(`UPDATED ${buildDate().toUpperCase()}`, cx, r.height - 12, {
      size: 10, align: "center", color: COLORS.ash, weight: "normal", baseline: "middle", font: FONT.ui,
    });
    ctx.restore();
  }

  /** Heavy poster wordmark with a blood-red mis-registration shadow + dark outline. */
  private stampedTitle(r: GameApp["r"], text: string, cx: number, y: number, size: number): void {
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = `${Math.round(size * 0.02)}px`;
    // Blood offset.
    r.text(text, cx + size * 0.04, y + size * 0.05, {
      size,
      align: "center",
      color: COLORS.bloodDeep,
      baseline: "middle",
      font: FONT.display,
    });
    // Outline.
    ctx.font = `${size}px ${FONT.display}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, size * 0.06);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.strokeText(text, cx, y);
    // Face.
    r.text(text, cx, y, { size, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
    ctx.restore();
  }

  private teamColumn(r: GameApp["r"], cx: number, label: string, team: (typeof TEAMS)[number], prev: Rect, next: Rect): void {
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "2px";
    r.text(label, cx, this.teamY - this.crestR - 8, { size: 12, align: "center", color: COLORS.blood, baseline: "bottom", weight: "normal", font: FONT.ui });
    ctx.restore();
    drawCrest(r.ctx, cx, this.teamY, this.crestR, team);
    drawButton(r, prev, "‹", { fill: COLORS.concrete, size: 24 });
    drawButton(r, next, "›", { fill: COLORS.concrete, size: 24 });
    r.text(team.name.toUpperCase(), cx, this.teamY + this.crestR + 16, { size: clamp(this.crestR * 0.42, 13, 19), align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
  }
}

function wrap(i: number): number {
  return ((i % TEAMS.length) + TEAMS.length) % TEAMS.length;
}
