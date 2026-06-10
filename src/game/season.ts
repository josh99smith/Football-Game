/** Season mode: an 8-game regular season across the 8 teams, seeding a 4-team playoff
 *  (semifinals + final). Pure data + helpers; the user's franchise plays its games for real while
 *  the rest of the league is simulated so the standings/seeding mean something. Persisted to
 *  localStorage so a season survives a reload. */

import { TEAMS } from "./Team";
import { rand } from "../engine/math/random";
import { clamp } from "../engine/math/Vec2";

export type Difficulty = "rookie" | "pro" | "allpro";

/** A regular-season game; `home`/`away` are indices into TEAMS. */
export interface SeasonGame {
  week: number;
  home: number;
  away: number;
  homeScore: number;
  awayScore: number;
  played: boolean;
}

/** A playoff game; seeds are 1..4 (1 = top regular-season record). */
export interface PlayoffGame {
  round: "semi" | "final";
  seedHome: number;
  seedAway: number;
  home: number; // TEAMS index (resolved once the matchup is known)
  away: number;
  homeScore: number;
  awayScore: number;
  played: boolean;
}

export interface SeasonData {
  /** The user's franchise (index into TEAMS). */
  teamIndex: number;
  difficulty: Difficulty;
  quarterLength: number;
  /** Hidden per-team strength (0..1) driving simulated results — gives the standings a real spread. */
  ratings: number[];
  /** 8 weeks × 4 games. */
  schedule: SeasonGame[];
  /** 0-based current week (0..7 regular season, then the playoff). */
  week: number;
  phase: "regular" | "playoff" | "done";
  bracket: { semis: PlayoffGame[]; final: PlayoffGame | null; champion: number | null } | null;
}

export interface Standing {
  team: number;
  w: number;
  l: number;
  t: number;
  pf: number; // points for
  pa: number; // points against
  diff: number;
}

const N = 8; // teams
const REGULAR_WEEKS = 8;
const SEASON_KEY = "blitz.season.v1";

// ----------------------------------------------------------------------------------------------
// Schedule + simulation

/** Round-robin pairings (circle method): N-1 rounds, each pairing all N teams once. */
function roundRobin(): [number, number][][] {
  const arr = Array.from({ length: N }, (_, i) => i);
  const rounds: [number, number][][] = [];
  for (let r = 0; r < N - 1; r++) {
    const games: [number, number][] = [];
    for (let i = 0; i < N / 2; i++) {
      const a = arr[i], b = arr[N - 1 - i];
      games.push(r % 2 === 0 ? [a, b] : [b, a]); // alternate home/away across rounds for fairness
    }
    rounds.push(games);
    arr.splice(1, 0, arr.pop()!); // rotate all but the first
  }
  return rounds;
}

/** Build a fresh season for the user's `teamIndex`. 8 weeks: a 7-round round-robin + a rematch week. */
export function makeSeason(teamIndex: number, difficulty: Difficulty, quarterLength: number): SeasonData {
  const rounds = roundRobin();
  // Week 8 = rematches of week 1 with home/away flipped, so every team plays exactly 8 games.
  const weeks = [...rounds, rounds[0].map(([a, b]) => [b, a] as [number, number])];
  const schedule: SeasonGame[] = [];
  weeks.forEach((games, week) => {
    for (const [home, away] of games) {
      schedule.push({ week, home, away, homeScore: 0, awayScore: 0, played: false });
    }
  });
  const ratings = Array.from({ length: N }, () => 0.35 + rand() * 0.5); // 0.35..0.85
  return { teamIndex, difficulty, quarterLength, ratings, schedule, week: 0, phase: "regular", bracket: null };
}

/** Simulate one game's final score from the two teams' ratings (+ a small home edge + noise). */
export function simGame(home: number, away: number, ratings: number[]): { homeScore: number; awayScore: number } {
  const side = (off: number, def: number, edge: number) =>
    Math.round(clamp(9 + off * 34 + edge - def * 12 + rand(-9, 9), 0, 55));
  let homeScore = side(ratings[home], ratings[away], 3);
  let awayScore = side(ratings[away], ratings[home], 0);
  if (homeScore === awayScore) (rand() < 0.5 ? (homeScore += 3) : (awayScore += 3)); // no sim ties
  return { homeScore, awayScore };
}

// ----------------------------------------------------------------------------------------------
// Standings

/** League standings from the games played so far, sorted (wins, then point diff, then points for). */
export function standings(data: SeasonData): Standing[] {
  const rows: Standing[] = Array.from({ length: N }, (_, team) => ({ team, w: 0, l: 0, t: 0, pf: 0, pa: 0, diff: 0 }));
  for (const g of data.schedule) {
    if (!g.played) continue;
    const h = rows[g.home], a = rows[g.away];
    h.pf += g.homeScore; h.pa += g.awayScore;
    a.pf += g.awayScore; a.pa += g.homeScore;
    if (g.homeScore > g.awayScore) { h.w++; a.l++; }
    else if (g.awayScore > g.homeScore) { a.w++; h.l++; }
    else { h.t++; a.t++; }
  }
  for (const r of rows) r.diff = r.pf - r.pa;
  return rows.sort((x, y) => y.w - x.w || y.diff - x.diff || y.pf - x.pf);
}

/** The user's scheduled game for the current week (the one they actually play), or null. */
export function userGameThisWeek(data: SeasonData): SeasonGame | null {
  return data.schedule.find((g) => g.week === data.week && !g.played && (g.home === data.teamIndex || g.away === data.teamIndex)) ?? null;
}

/** The opponent of the user in a game. */
export function opponentOf(g: SeasonGame | PlayoffGame, teamIndex: number): number {
  return g.home === teamIndex ? g.away : g.home;
}

function recordUser(g: SeasonGame | PlayoffGame, userTeam: number, userScore: number, oppScore: number): void {
  if (g.home === userTeam) { g.homeScore = userScore; g.awayScore = oppScore; }
  else { g.awayScore = userScore; g.homeScore = oppScore; }
  g.played = true;
}

// ----------------------------------------------------------------------------------------------
// Week / playoff advancement

/** Record the user's result for the current week, simulate the rest of the week, advance. At the end
 *  of the regular season this builds the 4-team bracket and flips to the playoff phase. */
export function advanceWeek(data: SeasonData, userScore: number, oppScore: number): void {
  for (const g of data.schedule) {
    if (g.week !== data.week || g.played) continue;
    if (g.home === data.teamIndex || g.away === data.teamIndex) recordUser(g, data.teamIndex, userScore, oppScore);
    else { const r = simGame(g.home, g.away, data.ratings); g.homeScore = r.homeScore; g.awayScore = r.awayScore; g.played = true; }
  }
  data.week++;
  if (data.week >= REGULAR_WEEKS) buildBracket(data);
}

function buildBracket(data: SeasonData): void {
  const seeds = standings(data).slice(0, 4).map((s) => s.team); // [1,2,3,4] seeds → TEAMS indices
  const semi = (sh: number, sa: number): PlayoffGame => ({
    round: "semi", seedHome: sh, seedAway: sa, home: seeds[sh - 1], away: seeds[sa - 1], homeScore: 0, awayScore: 0, played: false,
  });
  data.bracket = { semis: [semi(1, 4), semi(2, 3)], final: null, champion: null };
  data.phase = "playoff";
}

function winnerTeam(g: PlayoffGame): number { return g.homeScore >= g.awayScore ? g.home : g.away; }
function winnerSeed(g: PlayoffGame): number { return g.homeScore >= g.awayScore ? g.seedHome : g.seedAway; }

function buildFinalIfReady(b: NonNullable<SeasonData["bracket"]>): void {
  if (b.final || !b.semis.every((g) => g.played)) return;
  const [s1, s2] = b.semis;
  // Higher seed (lower number) hosts the final.
  const hi = winnerSeed(s1) <= winnerSeed(s2) ? s1 : s2;
  const lo = hi === s1 ? s2 : s1;
  b.final = {
    round: "final", seedHome: winnerSeed(hi), seedAway: winnerSeed(lo),
    home: winnerTeam(hi), away: winnerTeam(lo), homeScore: 0, awayScore: 0, played: false,
  };
}

function simInto(g: PlayoffGame, ratings: number[]): void {
  const r = simGame(g.home, g.away, ratings);
  g.homeScore = r.homeScore; g.awayScore = r.awayScore; g.played = true;
}

/** The user's next unplayed playoff game (with a determined matchup), or null. */
export function userPlayoffGame(data: SeasonData): PlayoffGame | null {
  const b = data.bracket;
  if (!b) return null;
  const isUser = (g: PlayoffGame) => g.home === data.teamIndex || g.away === data.teamIndex;
  const semi = b.semis.find((g) => !g.played && isUser(g));
  if (semi) return semi;
  if (b.final && !b.final.played && isUser(b.final)) return b.final;
  return null;
}

function finalize(data: SeasonData): void {
  const b = data.bracket!;
  if (b.final?.played) { b.champion = winnerTeam(b.final); data.phase = "done"; }
}

/** Record the user's playoff result, then resolve every other game whose matchup is set (the other
 *  semi, and the final if the user isn't in it). Leaves the user's NEXT game unplayed for them. */
export function recordPlayoffResult(data: SeasonData, userScore: number, oppScore: number): void {
  const b = data.bracket;
  if (!b) return;
  const g = userPlayoffGame(data);
  if (g) recordUser(g, data.teamIndex, userScore, oppScore);
  // Sim any ready non-user games (the other semi now; the final later if it's CPU-only).
  for (const s of b.semis) if (!s.played && s.home !== data.teamIndex && s.away !== data.teamIndex) simInto(s, data.ratings);
  buildFinalIfReady(b);
  if (b.final && !b.final.played && b.final.home !== data.teamIndex && b.final.away !== data.teamIndex) simInto(b.final, data.ratings);
  finalize(data);
}

/** Simulate the ENTIRE remaining playoff to a champion (user missed the bracket, or chose to sim). */
export function simWholePlayoff(data: SeasonData): void {
  const b = data.bracket;
  if (!b) return;
  for (const s of b.semis) if (!s.played) simInto(s, data.ratings);
  buildFinalIfReady(b);
  if (b.final && !b.final.played) simInto(b.final, data.ratings);
  finalize(data);
}

/** Is the user's franchise a top-4 seed (in the playoff bracket)? */
export function userInPlayoff(data: SeasonData): boolean {
  if (!data.bracket) return false;
  return data.bracket.semis.some((g) => g.home === data.teamIndex || g.away === data.teamIndex);
}

export function teamName(i: number): string { return TEAMS[i].name; }

// ----------------------------------------------------------------------------------------------
// Persistence

export function loadSeason(): SeasonData | null {
  try {
    const raw = localStorage.getItem(SEASON_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SeasonData;
    return d && Array.isArray(d.schedule) && Array.isArray(d.ratings) ? d : null;
  } catch {
    return null;
  }
}

export function saveSeason(data: SeasonData): void {
  try { localStorage.setItem(SEASON_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

export function clearSeason(): void {
  try { localStorage.removeItem(SEASON_KEY); } catch { /* ignore */ }
}
