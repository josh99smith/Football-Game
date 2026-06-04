# 🏈 Gridiron Blitz

A **mobile-first arcade American football game** in the spirit of *NFL Blitz* and
*Tecmo Bowl* — fast, loud, and over-the-top. Built from scratch with **HTML5 Canvas +
TypeScript** (custom engine, no game framework) and **zero external assets**: all art
is drawn procedurally and all sound is synthesized with the Web Audio API.

> 7-on-7. 30 yards for a first down. Turbo. Big hits. ON FIRE. Pick a play and go.

**▶ Play it live:** https://josh99smith.github.io/Football-Game/ (auto-deployed from the
default branch via GitHub Pages — see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

## Play

```bash
npm install
npm run dev      # open the printed URL (works on a phone over your LAN, landscape)
```

Build a static bundle (also type-checks via `tsc`):

```bash
npm run build    # outputs to dist/ — deploy anywhere (e.g. GitHub Pages)
npm run preview
```

## Controls

Touch (mobile) and keyboard (desktop) are both supported.

| Action | Touch | Keyboard |
| --- | --- | --- |
| Move | Left-side virtual joystick | `WASD` / arrows |
| Sprint | **TURBO** button (hold) | `Shift` |
| Offense — throw (QB) | **PASS** button; aim with the joystick | `Space` |
| Offense — dive (ball carrier) | **ACTION** tap | `Space` |
| Offense — spin/juke (ball carrier) | **ACTION** double-tap | double-tap `Space` |
| Defense — switch player | **SWITCH** tap | `Space` |
| Defense — dive tackle | **SWITCH** double-tap | double-tap `Space` |
| Snap the ball (offense) | tap **ACTION** (or wait for auto-snap) | `Space` |

The **TURBO meter** (bottom-left) drains while sprinting and refills when you let off —
sprint for the burst, but pick your moments.

## Game rules (arcade)

- **7-on-7**, 4 downs, **30 yards** to a first down, four short quarters.
- **Big hits**: turbo or a closing dive can blow up the ball carrier — screen shake,
  slow-mo, sparks, and a chance to force a **FUMBLE**.
- **ON FIRE**: string together two big defensive stops to ignite your whole team with a
  speed/power boost (flames included) until the opponent scores.
- Touchdowns, sacks, interceptions, safeties, and turnovers on downs all handled.

## How it's built

A clean split between a reusable **engine** and the **game** logic:

```
src/
  engine/     fixed-timestep loop, renderer, camera, unified touch+keyboard input,
              synthesized audio, and FX (particles, screen shake, floating text, slow-mo)
  game/       field geometry, players/ball, playbook, steering + offense/defense AI,
              the Match/rules model, and the state machine (menu → kickoff → play
              select → live play → result → game over)
  ui/         HUD scoreboard, on-screen touch controls, menu widgets
```

- **Fixed-timestep** simulation (60 Hz) with interpolated rendering for stable feel.
- **Camera** follows the action and scrolls the field; DPR-aware crisp rendering.
- **Steering-based AI**: blockers wall rushers via mass-weighted body collisions,
  receivers run routes, defenders cover/blitz/spy and pursue ball carriers.
- **PWA-ready** (`manifest.webmanifest`) so it can be installed to a phone home screen.

## Roadmap ideas

- Kickoff/punt return mini-games, field goals, 2-point conversions.
- More plays, audibles, and formations; difficulty-scaled CPU playcalling.
- Season/tournament mode and online or local 2-player.

Teams and players are fictional — no real-world licensing.
