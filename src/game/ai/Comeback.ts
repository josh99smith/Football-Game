import type { Match } from "../Match";
import type { TeamId } from "../entities/Player";
import { clamp } from "../../engine/math/Vec2";

/**
 * Blitz-style momentum management: graduated comeback assistance keyed on the score gap.
 * (Design studied from the NFL Blitz 2000 arcade source's handicap system — reimplemented
 * from scratch for this game's knobs.) The trailing team plays a touch faster and its defense
 * reacts a touch sharper; the leading team eases off by the same amount. Effects are small and
 * continuous — a one-score game feels untouched, a blowout quietly tightens — so comebacks stay
 * possible without ever feeling scripted.
 */
const STEP_POINTS = 8; // one assist "step" per 8 points down (≈ Blitz's diff/4 with 7-point TDs)
const MAX_STEPS = 2.5;

/** Signed assist level for `team`: positive when trailing, negative when leading, 0 when tied. */
export function comebackLevel(m: Match, team: TeamId): number {
  let steps = (m.team(m.opponent(team)).score - m.team(team).score) / STEP_POINTS;
  // Rookie mercy (Blitz's "drones lose" rule): on the easiest setting a CPU sitting on a big
  // lead eases off harder, so a beginner never gets buried 40-0.
  if (m.difficulty === "rookie" && team !== m.humanTeam && steps < 0) steps *= 1.5;
  return clamp(steps, -MAX_STEPS, MAX_STEPS);
}

/** Team-wide speed factor (≈ ±5.5% at the cap) — the trailing side finds an extra gear. */
export function comebackSpeed(m: Match, team: TeamId): number {
  return 1 + 0.022 * comebackLevel(m, team);
}

/** Additive bonus to the defense's post-snap reaction ramp (trailing defense gets home sooner). */
export function comebackReact(m: Match, defTeam: TeamId): number {
  return 0.05 * comebackLevel(m, defTeam);
}

/** Interception chance scaled by the defending team's desperation. */
export function comebackPick(m: Match, basePick: number, defTeam: TeamId): number {
  return clamp(basePick * (1 + 0.2 * comebackLevel(m, defTeam)), 0.04, 0.6);
}

/**
 * 0..1: how hard the defense is keying on a play the HUMAN keeps repeating (Blitz docks the
 * spammer's handicap; here the defense reads the play faster and DBs aren't fooled by the cuts).
 * First repeat is free — the read builds from the 2nd consecutive call of the same play.
 */
export function keyedOnPlay(m: Match, offenseTeam: TeamId): number {
  if (offenseTeam !== m.humanTeam) return 0;
  return clamp((m.playRepeat.count - 1) / 3, 0, 1);
}
