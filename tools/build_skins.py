"""Build the game's recolorable player-skin assets from the original baseplayer texture pack."""
import numpy as np
from PIL import Image

SRC = '/tmp/baseplayer_textures'  # extracted baseplayer_textures.zip (the model's original texture pack)
OUT = '/home/user/Football-Game/public/skins'

base = np.asarray(Image.open(f'{SRC}/Helmet_Uniform_Base_Color.png').convert('RGB'), dtype=np.float64)
ao   = np.asarray(Image.open(f'{SRC}/Helmet_Uniform_Ambient_occlusion.png').convert('L'), dtype=np.float64) / 255.0
H, W, _ = base.shape
yy, xx = np.mgrid[0:H, 0:W]
u = xx / W
v = 1.0 - yy / H          # texture v (flipY: canvas row 0 = v 1)

def lum(a): return a @ [0.2126, 0.7152, 0.0722]
luma = lum(base)
r, g, b = base[...,0], base[...,1], base[...,2]
orange = (r > 120) & (r > g*1.4) & (g > b*1.15) & (r - b > 60)

# ---- 1) erase the baked chest/back "17" and the shoulder "WR" position text -------------------
TORSO = v >= 0.455
numbox = TORSO & (v > 0.65) & (v < 0.85) & (((u > 0.12) & (u < 0.38)) | ((u > 0.62) & (u < 0.88)))
topband = TORSO & (v > 0.83)
marking = (numbox | topband) & (orange | (np.abs(luma - 44) > 6))
rng = np.random.default_rng(7)
fill = 44 + rng.normal(0, 1.2, size=(H, W))
for c in range(3):
    base[...,c][marking] = fill[marking]
luma = lum(base)
orange = orange & ~marking
white  = (luma > 200) & (base.max(-1) - base.min(-1) < 35)

# ---- 2) classify regions -----------------------------------------------------------------------
mask = np.zeros((H, W), dtype=np.uint8)          # 0 = keep
JERSEY, PANTS, ACCENT, SHELL = 60, 120, 180, 240
silver = (~orange) & (luma > 107) & (luma <= 200) & (base.max(-1) - base.min(-1) < 40)
charcoal = (~orange) & (luma >= 18) & (luma <= 107)
HELMZONE = (~TORSO) & (u < 0.56)
PANTZONE = (~TORSO) & (u >= 0.56)
waistband = TORSO & (v < 0.56)

mask[TORSO & ~waistband & charcoal] = JERSEY
mask[TORSO & silver] = PANTS
mask[TORSO & white & (v < 0.70)] = PANTS      # AA seam at the jersey/pants boundary + towel
mask[waistband & charcoal] = PANTS            # belt / hip-pad band reads as pants top
mask[PANTZONE & silver] = PANTS
mask[HELMZONE & (luma < 14)] = SHELL          # shell is pure black; facemask/straps are #20-#2c
mask[HELMZONE & white] = SHELL                # the white shell design patch joins the shell
mask[orange] = ACCENT

# ---- 3) build the neutral template -------------------------------------------------------------
aod = ao ** 0.75
out = base * aod[..., None]                   # keep-regions: original * AO
REF = {JERSEY: 44.0, PANTS: 170.0, ACCENT: 165.0, SHELL: 60.0}
TEMPLATE = 190.0
for region, ref in REF.items():
    m = mask == region
    ratio = np.ones_like(luma) if region == SHELL else np.clip(luma / ref, 0.7, 1.3)
    val = np.clip(TEMPLATE * aod * ratio, 0, 255)
    for c in range(3):
        out[...,c][m] = val[m]

Image.fromarray(out.astype(np.uint8)).resize((512,512), Image.LANCZOS).save(f'{OUT}/uniform_base.webp', quality=88)
Image.fromarray(mask).resize((512,512), Image.NEAREST).save(f'{OUT}/uniform_mask.png', optimize=True)
Image.open(f'{SRC}/Helmet_Uniform_Normal_OpenGL.png').convert('RGB').resize((512,512), Image.LANCZOS)\
    .save(f'{OUT}/uniform_normal.webp', quality=90)

# ---- 4) face/arms: grayscale luma-normalized so material.color (skin tone) tints it -------------
# (the pack's face AO map is a sparse island mask — unusable — so albedo luma carries the detail)
fb = np.asarray(Image.open(f'{SRC}/Face_and_arms_Base_Color.png').convert('RGB'), dtype=np.float64)
fl = lum(fb)
mapL = np.clip(fl / 79.0, 0.22, 1.35) * 215.0   # 79 = measured mean skin luma
fmap = np.repeat(np.clip(mapL,0,255)[...,None], 3, axis=2)
Image.fromarray(fmap.astype(np.uint8)).resize((512,512), Image.LANCZOS).save(f'{OUT}/face.webp', quality=85)
Image.open(f'{SRC}/Face_and_arms_Normal_OpenGL.png').convert('RGB').resize((512,512), Image.LANCZOS)\
    .save(f'{OUT}/face_normal.webp', quality=90)
print('done')
