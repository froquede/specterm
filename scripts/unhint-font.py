# Builds the bundled UI/terminal font in src/assets/fonts from a Monaspace
# release (github.com/githubnext/monaspace, the "variable" zip), with the
# TrueType hinting stripped. Hinting is what makes Windows' DirectWrite snap
# stems to the pixel grid — the thin, jagged look text has there and not on
# Linux. With no hints and a gasp table asking for symmetric smoothing, Windows
# draws the outlines as they are.
#
# Axes other than weight are pinned with AXIS=VALUE arguments, which keeps the
# file small: the italic is the same variable font pinned at full slant.
#
# The output is renamed "Specterm Mono". Monaspace's license reserves the name
# "Monaspace" (and "Neon"), and under the OFL a font changed this way — hints
# stripped, axes pinned — is a modified version, which may not use a reserved
# name. The CSS refers to it by the new name too.
#
#   pip install fonttools brotli
#   V="Monaspace Neon Var.ttf"
#   python scripts/unhint-font.py "$V" src/assets/fonts/SpectermMono.woff2 wdth=100 slnt=0
#   python scripts/unhint-font.py "$V" src/assets/fonts/SpectermMono-Italic.woff2 wdth=100 slnt=-11
import io
import sys
from fontTools.ttLib import TTFont, newTable
from fontTools import subset
from fontTools.varLib import instancer

src, dst, *pins = sys.argv[1:]
font = TTFont(src)
if pins:
    axes = {tag: float(value) for tag, value in (p.split("=") for p in pins)}
    font = instancer.instantiateVariableFont(font, axes)
    # Round-trip so the subsetter sees fully built tables, not lazy ones.
    buf = io.BytesIO()
    font.save(buf)
    buf.seek(0)
    font = TTFont(buf)

FAMILY = "Specterm Mono"
STYLE = "Italic" if any(p.startswith("slnt=") and float(p.split("=")[1]) != 0 for p in pins) else "Regular"
name = font["name"]
for rec in list(name.names):
    if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 25):
        name.removeNames(nameID=rec.nameID)
name.setName(FAMILY, 1, 3, 1, 0x409)
name.setName(STYLE, 2, 3, 1, 0x409)
name.setName(f"{FAMILY} {STYLE}; derived from Monaspace Neon", 3, 3, 1, 0x409)
name.setName(f"{FAMILY} {STYLE}", 4, 3, 1, 0x409)
name.setName(f"{FAMILY.replace(' ', '')}-{STYLE}", 6, 3, 1, 0x409)

opts = subset.Options()
opts.unicodes = ["*"]
opts.glyph_names = True
opts.layout_features = ["*"]
opts.hinting = False
opts.flavor = "woff2"
opts.notdef_outline = True
opts.name_IDs = ["*"]
opts.name_languages = ["*"]
subsetter = subset.Subsetter(opts)
subsetter.populate(glyphs=font.getGlyphOrder())
subsetter.subset(font)

# Tell the rasteriser: smooth, never grid-fit (there are no hints to fit to).
gasp = newTable("gasp")
gasp.version = 1
gasp.gaspRange = {0xFFFF: 0x000A}
font["gasp"] = gasp

subset.save_font(font, dst, opts)
out = TTFont(dst)
print(dst, out["name"].getDebugName(4), [a.axisTag for a in out["fvar"].axes] if "fvar" in out else "static")
