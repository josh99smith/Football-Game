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
  if (dist <= 4) return offById(chance(0.55) ? "hbdive" : "toss");
  if (m.down >= 3 && dist >= 12) return offById(chance(0.4) ? "streaks" : chance(0.5) ? "flood" : "outs");

  // First/second down: mix runs (incl. the draw), quick game, crossers, floods and shots.
  const r = Math.random();
  if (r < 0.18) return offById("hbdive");
  if (r < 0.30) return offById("toss");
  if (r < 0.38) return offById("draw");
  if (r < 0.52) return offById("slants");
  if (r < 0.64) return offById("mesh");
  if (r < 0.74) return offById("outs");
  if (r < 0.83) return offById("flood");
  if (r < 0.90) return offById("wheel");
  if (r < 0.96) return offById("papost");
  return offById("streaks");
}

/**
 * Situational CPU defensive call: blitz the obvious passing downs, spy/contain in
 * short yardage, otherwise mostly play coverage.
 */
export function cpuDefensePlay(m: Match): DefensePlay {
  const dist = m.distanceYards;
  // Obvious passing down: bring pressure or sit back in a deep zone.
  if (m.down >= 3 && dist >= 10) return defById(chance(0.4) ? "blitz" : chance(0.5) ? "zone" : "cover");
  if (dist <= 4) return defById(chance(0.5) ? "spy" : "cover");

  const r = Math.random();
  if (r < 0.18) return defById("blitz");
  if (r < 0.38) return defById("spy");
  if (r < 0.62) return defById("zone");
  return defById("cover");
}
