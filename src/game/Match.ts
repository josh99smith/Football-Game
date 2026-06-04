import { Team, type TeamConfig } from "./Team";
import type { TeamId } from "./entities/Player";
import {
  LEFT_GOAL_X,
  RIGHT_GOAL_X,
  PX_PER_YARD,
  xFromLeftGoal,
  yardLineLabel,
} from "./Field";

export type OutcomeType =
  | "tackle"
  | "sack"
  | "touchdown"
  | "incomplete"
  | "interception"
  | "fumbleLost"
  | "outOfBounds"
  | "safety"
  | "turnoverOnDowns";

export interface PlayOutcome {
  type: OutcomeType;
  /** Final world position of the ball when the play ended. */
  ballX: number;
  ballY: number;
  /** Team that ends up with possession after the play. */
  possessionAfter: TeamId;
  /** Net yards gained by the offense on the play (for display). */
  yards: number;
  /** Whether the offense achieved a new set of downs. */
  firstDown: boolean;
  /** Headline for the result banner. */
  headline: string;
}

export const FIRST_DOWN_YARDS = 30; // NFL Blitz: 30 yards to go
export const TOUCHDOWN_POINTS = 6;
export const PAT_POINTS = 1;
export const SAFETY_POINTS = 2;

/** Holds all game-flow / rules state for a single match. */
export class Match {
  readonly home: Team;
  readonly away: Team;
  /** The human always controls HOME. */
  readonly humanTeam: TeamId = "HOME";

  quarter = 1;
  readonly totalQuarters = 4;
  quarterLength: number; // seconds
  clock: number;
  difficulty: "rookie" | "pro" | "allpro";

  possession: TeamId = "HOME";
  down = 1;
  distanceYards = FIRST_DOWN_YARDS;
  losX = 0;
  firstDownX = 0;

  constructor(
    homeCfg: TeamConfig,
    awayCfg: TeamConfig,
    opts: { quarterLength?: number; difficulty?: Match["difficulty"] } = {},
  ) {
    this.home = new Team(homeCfg);
    this.away = new Team({ ...awayCfg, id: "AWAY" });
    this.quarterLength = opts.quarterLength ?? 90;
    this.clock = this.quarterLength;
    this.difficulty = opts.difficulty ?? "pro";
  }

  team(id: TeamId): Team {
    return id === "HOME" ? this.home : this.away;
  }

  opponent(id: TeamId): TeamId {
    return id === "HOME" ? "AWAY" : "HOME";
  }

  /** +1 if the team attacks toward +X (right), -1 toward -X (left). */
  attackDir(id: TeamId): number {
    return id === "HOME" ? 1 : -1;
  }

  /** World X of a yardline measured from a team's OWN goal line. */
  ownYardX(id: TeamId, yardsFromOwnGoal: number): number {
    return id === "HOME"
      ? xFromLeftGoal(yardsFromOwnGoal)
      : xFromLeftGoal(100 - yardsFromOwnGoal);
  }

  /** World X of the end zone the given team is attacking. */
  attackGoalX(id: TeamId): number {
    return id === "HOME" ? RIGHT_GOAL_X : LEFT_GOAL_X;
  }

  /** Begin a fresh set of downs for `team` with the ball spotted at `losX`. */
  startSeries(team: TeamId, losX: number): void {
    this.possession = team;
    this.down = 1;
    const dir = this.attackDir(team);
    const goalX = this.attackGoalX(team);
    const yardsToGoal = Math.abs(goalX - losX) / PX_PER_YARD;
    this.distanceYards = Math.min(FIRST_DOWN_YARDS, Math.round(yardsToGoal));
    this.losX = losX;
    this.firstDownX =
      dir > 0
        ? Math.min(losX + FIRST_DOWN_YARDS * PX_PER_YARD, goalX)
        : Math.max(losX - FIRST_DOWN_YARDS * PX_PER_YARD, goalX);
  }

  /** Place the ball after a kickoff (receiving team starts at its own 25). */
  kickoffTo(team: TeamId): void {
    this.startSeries(team, this.ownYardX(team, 25));
  }

  get yardLineLabel(): number {
    return yardLineLabel(this.losX);
  }

  /** "OWN 25" / "OPP 40" style side label for the HUD. */
  fieldSideLabel(): string {
    const fromLeft = (this.losX - LEFT_GOAL_X) / PX_PER_YARD;
    const ownSide =
      this.possession === "HOME" ? fromLeft <= 50 : fromLeft >= 50;
    return `${ownSide ? "OWN" : "OPP"} ${this.yardLineLabel}`;
  }

  isGoalToGo(): boolean {
    const goalX = this.attackGoalX(this.possession);
    return Math.abs(goalX - this.losX) / PX_PER_YARD <= this.distanceYards;
  }

  /**
   * Apply a finished play to the rules state. Returns flags telling the flow what
   * to do next (kickoff after score, or just spot the ball for the next snap).
   */
  applyOutcome(o: PlayOutcome): {
    scored: boolean;
    changedPossession: boolean;
    kickoff: boolean;
    scoringTeam?: TeamId;
    kickReceiver?: TeamId;
  } {
    const offense = this.possession;
    const defense = this.opponent(offense);

    if (o.type === "touchdown") {
      const t = this.team(offense);
      t.score += TOUCHDOWN_POINTS + PAT_POINTS; // auto PAT for v1
      this.team(defense).extinguish(); // opponent scoring puts out their fire
      // Scoring team kicks off; the team that was on defense receives.
      return { scored: true, changedPossession: true, kickoff: true, scoringTeam: offense, kickReceiver: defense };
    }

    if (o.type === "safety") {
      this.team(defense).score += SAFETY_POINTS;
      // The team that conceded (offense) free-kicks; the scoring team (defense) receives.
      return { scored: true, changedPossession: true, kickoff: true, scoringTeam: defense, kickReceiver: defense };
    }

    if (o.type === "interception" || o.type === "fumbleLost" || o.type === "turnoverOnDowns") {
      this.startSeries(defense, clampToField(o.ballX));
      return { scored: false, changedPossession: true, kickoff: false };
    }

    // Tackle / incomplete / out of bounds / sack: advance the ball & downs.
    const dir = this.attackDir(offense);
    let newLos = clampToField(o.ballX);
    if (o.type === "incomplete") newLos = this.losX; // ball returns to LOS

    const reachedFirst =
      dir > 0 ? newLos >= this.firstDownX - 1 : newLos <= this.firstDownX + 1;

    this.losX = newLos;
    if (reachedFirst) {
      this.startSeries(offense, newLos);
      o.firstDown = true;
    } else {
      this.down++;
      if (this.down > 4) {
        // Turnover on downs.
        this.startSeries(defense, newLos);
        return { scored: false, changedPossession: true, kickoff: false };
      }
      // Recompute distance to the existing first-down marker.
      this.distanceYards = Math.max(
        1,
        Math.round(Math.abs(this.firstDownX - newLos) / PX_PER_YARD),
      );
    }
    return { scored: false, changedPossession: false, kickoff: false };
  }

  /** Run the play clock down, clamped at 0. The quarter is NOT advanced here — the
   * clock simply stops at 0 mid-play; the caller advances the quarter between plays. */
  tickClock(dt: number): void {
    this.clock = Math.max(0, this.clock - dt);
  }

  get clockExpired(): boolean {
    return this.clock <= 0;
  }

  /** Advance to the next quarter (called between plays once the clock hits 0). Returns
   * the boundary crossed, or "game" if that was the final quarter. */
  advanceQuarter(): "quarter" | "half" | "game" {
    if (this.quarter >= this.totalQuarters) return "game";
    const wasHalf = this.quarter === 2;
    this.quarter++;
    this.clock = this.quarterLength;
    return wasHalf ? "half" : "quarter";
  }

  get isOver(): boolean {
    return this.quarter >= this.totalQuarters && this.clock <= 0;
  }

  winner(): TeamId | "TIE" {
    if (this.home.score > this.away.score) return "HOME";
    if (this.away.score > this.home.score) return "AWAY";
    return "TIE";
  }
}

function clampToField(x: number): number {
  return Math.max(LEFT_GOAL_X, Math.min(RIGHT_GOAL_X, x));
}
