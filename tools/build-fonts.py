#!/usr/bin/env python3
"""Builds SONIQ's self-hosted font files (fonts/*.woff + fonts/fonts.css).

Source: the OFL font files from github.com/google/fonts (ofl/outfit, ofl/inter,
ofl/ibmplexsanshebrew, ofl/ibmplexsansarabic, ofl/ibmplexmono).
Usage: python3 tools/build-fonts.py /path/to/google/fonts
Each font is cut to the weights and scripts the app uses, like Google Fonts does,
and split by unicode-range so a browser only downloads the scripts on the page.
Outfit and Inter have no Reserved Font Name, so OFL 1.1 lets us subset them and keep their names.
IBM Plex has the Reserved Font Name "Plex": under the OFL a subset is a Modified Version and could
not keep that name, so the Plex files are copied byte for byte, unmodified. unicode-range in the CSS
only decides when a browser downloads a file; it does not change the font.
The OFL texts are copied to fonts/licenses/.
"""
import io, os, shutil, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/google/fonts'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fonts')
os.makedirs(os.path.join(OUT, 'licenses'), exist_ok=True)

LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0304,U+0308,U+0329,U+2000-206F,U+2070-209F,U+20AC,U+2100-22FF,U+2500-27BF,U+FEFF,U+FFFD'
LATIN_EXT = 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
CYRILLIC = 'U+0400-052F,U+1C80-1C88,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'
HEBREW = 'U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F'
ARABIC = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC'

def codepoints(ranges):
    out = set()
    for part in ranges.split(','):
        a, _, b = part[2:].partition('-')
        out.update(range(int(a, 16), int(b or a, 16) + 1))
    return out

# family, source file, weights in CSS, variable-axis limits (None = static), subsets
FONTS = [
    ('Outfit', 'outfit/Outfit[wght].ttf', '500 700', {'wght': (500, 700)}, {'latin': LATIN, 'latin-ext': LATIN_EXT}),
    ('Inter', 'inter/Inter[opsz,wght].ttf', '400 600', {'opsz': 14, 'wght': (400, 600)}, {'latin': LATIN, 'latin-ext': LATIN_EXT, 'cyrillic': CYRILLIC}),
    ('IBM Plex Sans Hebrew', 'ibmplexsanshebrew/IBMPlexSansHebrew-Regular.ttf', '400', None, {'hebrew': HEBREW}),
    ('IBM Plex Sans Hebrew', 'ibmplexsanshebrew/IBMPlexSansHebrew-SemiBold.ttf', '600', None, {'hebrew': HEBREW}),
    ('IBM Plex Sans Arabic', 'ibmplexsansarabic/IBMPlexSansArabic-Regular.ttf', '400', None, {'arabic': ARABIC}),
    ('IBM Plex Sans Arabic', 'ibmplexsansarabic/IBMPlexSansArabic-SemiBold.ttf', '600', None, {'arabic': ARABIC}),
    ('IBM Plex Mono', 'ibmplexmono/IBMPlexMono-SemiBold.ttf', '600', None, {'latin': LATIN, 'latin-ext': LATIN_EXT, 'cyrillic': CYRILLIC}),
]

css = ['/* SONIQ fonts, served from this site (no request to Google). SIL Open Font License 1.1: see fonts/licenses/.\n   Built by tools/build-fonts.py from github.com/google/fonts. */']
for family, rel, weights, axes, subsets in FONTS:
    if 'plex' in rel:  # Reserved Font Name: ship the original file unchanged
        fn = os.path.basename(rel)
        shutil.copy(os.path.join(SRC, 'ofl', rel), os.path.join(OUT, fn))
        css.append(f"@font-face {{ font-family: '{family}'; font-style: normal; font-weight: {weights}; font-display: swap;\n"
                   f"  src: url('{fn}') format('truetype'); unicode-range: {','.join(subsets.values())}; }}")
        shutil.copy(os.path.join(SRC, 'ofl', rel.split('/')[0], 'OFL.txt'), os.path.join(OUT, 'licenses', rel.split('/')[0] + '-OFL.txt'))
        continue
    base = TTFont(os.path.join(SRC, 'ofl', rel))
    if axes:
        base = instancer.instantiateVariableFont(base, axes)
    buf = io.BytesIO(); base.save(buf); data = buf.getvalue()  # reload so subsetting sees plain tables
    cmap = set(base.getBestCmap())
    slug = family.lower().replace(' ', '-') + '-' + weights.replace(' ', '-')
    for name, ranges in subsets.items():
        want = cmap & codepoints(ranges)
        if not want:
            continue
        f = TTFont(io.BytesIO(data))
        opts = subset.Options()
        opts.layout_features = ['*']
        opts.name_IDs = ['*']
        opts.name_languages = ['*']
        opts.notdef_outline = True
        opts.flavor = 'woff'
        s = subset.Subsetter(opts)
        s.populate(unicodes=want)
        s.subset(f)
        fn = f'{slug}-{name}.woff'
        f.flavor = 'woff'
        f.save(os.path.join(OUT, fn))
        css.append(f"@font-face {{ font-family: '{family}'; font-style: normal; font-weight: {weights}; font-display: swap;\n"
                   f"  src: url('{fn}') format('woff'); unicode-range: {ranges}; }}")
    lic = os.path.join(SRC, 'ofl', rel.split('/')[0], 'OFL.txt')
    shutil.copy(lic, os.path.join(OUT, 'licenses', rel.split('/')[0] + '-OFL.txt'))

with open(os.path.join(OUT, 'fonts.css'), 'w') as fh:
    fh.write('\n'.join(css) + '\n')
print('\n'.join(sorted(os.listdir(OUT))))
