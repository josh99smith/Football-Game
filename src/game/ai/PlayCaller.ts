import type { Match } from "../Match";
import {
  OFFENSE_PLAYS,
  DEFENSE_PLAYS,
  type OffensePlay,
  type DefensePlay,
} from "../Playbook";
import { chance } from "../../engine/math/random";

function offById(id: string): OffensePlay {
  return OFFENSE_PLAYS.find((p) => p.id === id) ?? OFFENSE_PLAYS[0];
}
function defById(id: string): DefensePlay {
  return DEFENSE_PLAYS.find((p) => p.id === id) ?? DEFENSE_PLAYS[0];
}

/**
 * Situational CPU offensive play call: run in short yardage, throw on obvious
 * passing downs, and heave it deep when trailing late.
 */
export function cpuOffensePlay(m: Match): OffensePlay {
  const dist = m.distanceYards;
  const me = m.possession;
  const behind = m.team(me).score < m.team(m.opponent(me)).score;
  const late = m.quarter >= m.totalQuarters && m.clock < 75;

  if (late && behind) return offById(chance(0.5) ? "streaks" : "hailmary");
  if (dist <= 4) return offById(chance(0.6) ? "hbdive" : "slants");
  if (m.down >= 3 && dist >= 12) return offById(chance(0.6) ? "streaks" : "slants");

  const r = Math.random();
  if (r < 0.35) return offById("hbdive");
  if (r < 0.7) return offById("slants");
  return offById("streaks");
}

/**
 * Situational CPU defensive call: blitz the obvious passing downs, spy/contain in
 * short yardage, otherwise mostly play coverage.
 */
export function cpuDefensePlay(m: Match): DefensePlay {
  const dist = m.distanceYards;
  if (m.down >= 3 && dist >= 10) return defById(chance(0.45) ? "blitz" : "cover");
  if (dist <= 4) return defById(chance(0.5) ? "spy" : "cover");

  const r = Math.random();
  if (r < 0.2) return defById("blitz");
  if (r < 0.45) return defById("spy");
  return defById("cover");
}
