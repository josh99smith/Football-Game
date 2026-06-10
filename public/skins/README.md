# Realistic player skins (optional image overrides)

Drop PNGs here to replace a team's procedural jersey/helmet with realistic images. File names
must match the entries in `JERSEY_SKIN_OVERRIDES` / `HELMET_SKIN_OVERRIDES` in
`src/game/Scene3D.ts` (keyed by the team's color):

  dal_home_jersey.webp   →  Dallas Outlaws home jersey  (512×512, jersey color 0x0a1c3f)
  dal_helmet.webp        →  Dallas Outlaws helmet        (256×256, shell color 0xc9ced6)

Rules so they map correctly onto the model:
- SAME UV layout as the procedural texture (use the rendered base as the img2img source).
- Flat / albedo — no baked lighting or shadows. Square.
- The jersey's player number is baked in (every player on that team shows it) until we switch to a
  numberless base + a drawn number.

A missing/failed file falls back to the procedural texture automatically — the game never breaks.
