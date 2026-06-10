# Realistic player jersey skins (optional image overrides)

Drop a 512×512 PNG here to replace a team's procedural jersey with a realistic image.
The file name must match the entry in `JERSEY_SKIN_OVERRIDES` in `src/game/Scene3D.ts`
(keyed by the team's HOME jersey color):

  dal_home_jersey.png   →  Dallas Outlaws, home (jersey color 0x0a1c3f)

Rules so it maps correctly onto the model:
- Must be the SAME UV layout as the procedural texture (use the rendered base as the img2img source).
- Flat / albedo (no baked lighting or shadows). 512×512, square.
- The player number is baked into the image (every player on that team shows it) until we switch
  to a numberless base + a drawn number.

A missing/failed file falls back to the procedural jersey automatically — the game never breaks.
