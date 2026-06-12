# 🏈 Bobble Bowl

**Bighead arcade American football** in the spirit of *NFL Blitz* and *Tecmo Bowl* — fast,
loud, and over-the-top, starring a **photo-scanned bobblehead player**. Rendered in real 3D
with **Three.js (WebGL)** on a custom TypeScript game engine, with a 2D canvas HUD/controls
overlay. The turf texture is generated procedurally and all sound is synthesized with the
Web Audio API.

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

## The player model (single-file character)

Every player on the field is one rigged character that ships — mesh, texture, and its whole
animation set — in a single `public/player.glb` (~4 MB), built by
[`tools/convert-tripo.mjs`](tools/convert-tripo.mjs) from a Tripo-generated FBX:

- decimated to a mobile triangle budget (UVs and skin weights survive the simplify),
- its bones **renamed to the mixamorig names** the game is built around (foot IK, the
  physics tackle ragdoll, the procedural QB throw, and replay pose capture all look bones
  up by name),
- each take's base orientation normalized (the merged takes pointed different directions)
  and the long "relax" take trimmed to a clean standing window for the pre-snap idle,
- five takes baked as named glTF animations — `idle / walk / run / catch / dive`; moves
  without a take (throws, tackles, get-ups, spins…) fall back to the renderer's procedural
  motions and the physics ragdoll,
- **team colorways**: each texel is classified (cool uniform base / warm camo+trim / keep)
  into the texture's **alpha channel**; at load the game palette-swaps the two uniform
  classes to each team's jersey/accent colors, preserving the baked shading.

Rebuild with:

```bash
node tools/convert-tripo.mjs <character.fbx> public/player.glb
```

(`tools/build-player-asset.mjs` remains for rigging raw photogrammetry scans against a
Mixamo-fitted skeleton.)

## How it's built

A clean split between a reusable **engine**, the **game** logic, and **rendering**:

```
src/
  engine/     fixed-timestep loop, 2D overlay renderer, unified touch+keyboard input,
              synthesized audio, and FX (particles, screen shake, floating text, slow-mo)
  game/       field geometry, players/ball, playbook, steering + offense/defense AI,
              the Match/rules model, the Three.js scene (Scene3D), and the state machine
              (menu → kickoff → play select → live play → result → game over)
  ui/         HUD scoreboard, on-screen touch controls, menu widgets
tools/        offline asset pipeline (scan → rigged, vertex-colored player.glb)
```

- **2D simulation, 3D presentation**: all gameplay (AI, rules, physics) runs in 2D field
  space; `Scene3D` renders it as a real 3D world (perspective camera, 3D player models,
  lit turf, blob shadows) and projects FX/text back onto the 2D overlay.
- **Fixed-timestep** simulation (60 Hz) with a high camera that follows the ball from
  behind the offense.
- **Steering-based AI**: blockers wall rushers via mass-weighted body collisions,
  receivers run routes, defenders cover/blitz/spy and pursue ball carriers.
- **PWA-ready** (`manifest.webmanifest`) so it can be installed to a phone home screen.

## Roadmap ideas

- Kickoff/punt return mini-games, field goals, 2-point conversions.
- More plays, audibles, and formations; difficulty-scaled CPU playcalling.
- Season/tournament mode and online or local 2-player.

Teams and players are fictional — no real-world licensing.
