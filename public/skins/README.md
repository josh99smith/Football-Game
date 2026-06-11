# Realistic player skins (recolorable uniform atlas)

These files come from the base player model's ORIGINAL texture pack (the rig's `Helmet_Uniform`
and `Face_and_arms` materials), processed into a team-recolorable form. The runtime logic lives in
`src/game/Scene3D.ts` (`loadSkinAtlas` / `recolorAtlas` / `composeJersey`).

  uniform_base.webp    512² neutral uniform template. The baked "17" / "WR" markings are erased,
                       and every recolorable region is normalized to gray (luma ~190) with the
                       pack's ambient-occlusion baked into the luma — so a team color × luma
                       reproduces seams/pad shading. Keep-regions (facemask, shoes, hardware)
                       keep their original colors.
  uniform_mask.png     512² region map (gray levels): 0 keep, ~60 jersey, ~120 pants/trim,
                       ~180 accent, ~240 helmet shell.
  uniform_normal.webp  512² tangent-space normal map (OpenGL +Y) for body + helmet materials.
  face.webp            512² face/arms albedo, luma-normalized to ~#d7d7d7 so the per-player skin
                       tone (material.color) tints it.
  face_normal.webp     512² face/arms normal map.

At runtime each team's jersey/trim/accent/helmet colors fill the mask regions and the player's own
number is drawn at the model's authored chest/back spots (uv (0.25, 0.75) and (0.75, 0.75)).
Missing/failed files fall back to the procedural painted textures automatically — the game never
breaks.

To regenerate from the original texture pack (`baseplayer_textures.zip`, extracted to
/tmp/baseplayer_textures), run `python3 tools/build_skins.py`.
