import type { TeamId } from "./entities/Player";
import type { EmblemIcon } from "../ui/Emblems";

export interface TeamColors {
  /** Primary jersey base color. */
  jersey: string;
  /** Dark helmet / pants color. */
  trim: string;
  /** Bright contrast color for sleeve stripes, collar, and number outlines. */
  accent: string;
}

export interface TeamConfig {
  id: TeamId;
  /** Home city / region (shown in one end zone + on the matchup card). */
  city: string;
  /** Team nickname (shown in the other end zone). */
  nickname: string;
  /** Full display name "City Nickname" — used everywhere a single label is wanted. */
  name: string;
  abbr: string;
  icon: EmblemIcon;
  /** Home (colored) uniform — also the team's identity colors for crests / HUD. */
  colors: TeamColors;
  /** Away (road) uniform: a light shell with the team's color as numbers / trim. */
  away: TeamColors;
  /** Helmet shell color. */
  helmet: string;
}

/** Build a "City Nickname" config; keeps the verbose color literals readable below. */
function team(
  city: string, nickname: string, abbr: string, icon: EmblemIcon, helmet: string,
  colors: TeamColors, awayAccent: string,
): TeamConfig {
  return {
    id: "HOME", city, nickname, name: `${city} ${nickname}`, abbr, icon, helmet, colors,
    away: { jersey: "#eef0ee", trim: colors.trim, accent: awayAccent },
  };
}

/**
 * Fictional clubs set in real US cities — original nicknames + realistic, NFL-adjacent color
 * schemes (no licensed marks). Each carries a home (colored) and away (white road) uniform.
 */
export const TEAMS: TeamConfig[] = [
  team("Dallas", "Outlaws", "DAL", "star", "#c9ced6",
    { jersey: "#0a1c3f", trim: "#0a1c3f", accent: "#9aa6b2" }, "#0a1c3f"),
  team("Miami", "Tarpons", "MIA", "fin", "#0a2e33",
    { jersey: "#12b0ad", trim: "#06343a", accent: "#ff7a2f" }, "#12b0ad"),
  team("Chicago", "Maulers", "CHI", "horn", "#15171b",
    { jersey: "#2b2f36", trim: "#15171b", accent: "#f2b21e" }, "#2b2f36"),
  team("Seattle", "Surge", "SEA", "bolt", "#06203a",
    { jersey: "#0d3b66", trim: "#06203a", accent: "#86d11f" }, "#0d3b66"),
  team("Atlanta", "Talons", "ATL", "wing", "#161616",
    { jersey: "#161616", trim: "#161616", accent: "#d4202a" }, "#d4202a"),
  team("Phoenix", "Venom", "PHX", "viper", "#2a124a",
    { jersey: "#5b2a86", trim: "#2a124a", accent: "#b6e21e" }, "#5b2a86"),
  team("Houston", "Wildcats", "HOU", "claw", "#07172c",
    { jersey: "#0b2240", trim: "#07172c", accent: "#e0a52b" }, "#e0a52b"),
  team("Vegas", "Blaze", "LV", "flame", "#1a1a1a",
    { jersey: "#c41e2a", trim: "#1a1a1a", accent: "#f2c14e" }, "#c41e2a"),
];

/** How long ON FIRE lasts on a full meter with no further good plays. */
const FIRE_BURN_SECONDS = 24;

/**
 * Live per-game team state: score and the Blitz-style ON FIRE meter.
 *
 * Fire is BUILT UP from consecutive good plays (first downs, explosive gains, sacks, takeaways,
 * stops). `fireMeter` (0..1) fills with each good play and snuffs back down on a bad one; when it
 * tops out the WHOLE team catches fire — faster, near-unlimited turbo — until it burns out (good
 * plays refuel it) or the opponent scores.
 */
export class Team {
  readonly config: TeamConfig;
  score = 0;
  onFire = false;
  /** 0..1 — the build-up gauge toward ON FIRE, and (while lit) the burn-down that good plays refuel. */
  fireMeter = 0;

  constructor(config: TeamConfig) {
    this.config = config;
  }

  get colors(): TeamColors {
    return this.config.colors;
  }

  /** Reward a good play. While building it fills the meter (igniting at full); while lit it refuels
   *  the burn. Returns true only on the play that ignites the team. */
  addFire(amount: number): boolean {
    if (this.onFire) {
      this.fireMeter = Math.min(1, this.fireMeter + amount * 1.3); // good plays keep the fire stoked
      return false;
    }
    this.fireMeter = Math.min(1, this.fireMeter + amount);
    if (this.fireMeter >= 1) {
      this.onFire = true;
      this.fireMeter = 1;
      return true;
    }
    return false;
  }

  /** A bad play (sack / turnover / 3-and-out) breaks the streak — the build resets. An already-lit
   *  fire keeps burning (only the opponent scoring or time puts it out). */
  breakStreak(): void {
    if (!this.onFire) this.fireMeter = 0;
  }

  extinguish(): void {
    this.onFire = false;
    this.fireMeter = 0;
  }

  update(dt: number): void {
    if (this.onFire) {
      this.fireMeter -= dt / FIRE_BURN_SECONDS;
      if (this.fireMeter <= 0) this.extinguish();
    }
  }
}
