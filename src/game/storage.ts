/** Tiny localStorage wrapper for high scores and persisted settings. */

const HS_KEY = "blitz.highscores.v1";
const SETTINGS_KEY = "blitz.settings.v1";

export interface HighScore {
  team: string;
  points: number;
  opponent: string;
  opponentPoints: number;
  date: number;
}

export function loadHighScores(): HighScore[] {
  try {
    const raw = localStorage.getItem(HS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as HighScore[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveHighScore(entry: HighScore): HighScore[] {
  const list = loadHighScores();
  list.push(entry);
  list.sort((a, b) => b.points - a.points || a.opponentPoints - b.opponentPoints);
  const top = list.slice(0, 10);
  try {
    localStorage.setItem(HS_KEY, JSON.stringify(top));
  } catch {
    /* storage may be unavailable (private mode) */
  }
  return top;
}

export interface PersistedSettings {
  difficulty?: "rookie" | "pro" | "allpro";
  quarterLength?: number;
  muted?: boolean;
  homeTeamIndex?: number;
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as PersistedSettings) : {};
  } catch {
    return {};
  }
}

export function saveSettings(s: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
