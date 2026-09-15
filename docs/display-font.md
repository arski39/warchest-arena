# The menu display font

The menu nameplate (`<site-nameplate>`, `src/client/components/SiteNameplate.ts`)
renders `SITE_NAME` in **Grenze Gotisch ExtraBold**, shipped from
`resources/fonts/GrenzeGotisch-ExtraBold.woff2`.

## Licence

SIL Open Font License 1.1, Omnibus-Type — <https://github.com/Omnibus-Type/Grenze-Gotisch>.
Free for commercial use, and **free to redistribute**, which is why the binary is
committed like any other asset rather than kept out of the repo.

`resources/fonts/GrenzeGotisch-OFL.txt` ships beside it because the OFL requires
the licence to travel with the font. It is published as an asset too, which is
the point.

The copyright line carries **no Reserved Font Name**, so this modified build may
keep the family name. The header prepended to `GrenzeGotisch-OFL.txt` records the
modifications anyway.

## What was modified

Mechanical only — no outline was redrawn:

| step                                               | result           |
| -------------------------------------------------- | ---------------- |
| source: `GrenzeGotisch[wght].ttf` variable         | 193,492 bytes    |
| pin the weight axis to `wght=800`                  | 96,460 bytes     |
| subset to Latin-1 + Latin Extended-A + punctuation | 35,180 bytes     |
| re-encode WOFF2                                    | **15,424 bytes** |

380 glyphs. The subset is deliberately **not** cut to the letters in "Warchest
Arena": `SITE_NAME` is operator-chosen and the name is a placeholder, so a
name-specific subset would break on the rename it is waiting for. Accented and
Extended-A names render correctly.

To rebuild after changing the weight or coverage, with `fontTools` and `brotli`:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

inst = instantiateVariableFont(TTFont("GrenzeGotisch[wght].ttf"),
                               {"wght": 800}, inplace=False, updateFontNames=True)
inst.save("GG-800.ttf")

opts = subset.Options()
opts.layout_features = ["kern", "liga", "calt", "ccmp", "locl"]
opts.name_IDs = ["*"]        # keep the OFL-required name records
opts.name_legacy = True
font = subset.load_font("GG-800.ttf", opts)
s = subset.Subsetter(options=opts)
s.populate(unicodes=list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) +
                    [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x00B7])
s.subset(font)
subset.save_font(font, "GG-800-latin.ttf", opts)

w = TTFont("GG-800-latin.ttf"); w.flavor = "woff2"
w.save("GrenzeGotisch-ExtraBold.woff2")
```

`fontTools` is a build-time tool, deliberately **not** a repo dependency — it is
needed to regenerate the file, never to build or run the site.

## Why this face

Hold Money Blackletter (Alit Design) was the visual reference. It could not be
used: the distributed bundle is a demo whose ReadMe says _"personal use, Not
permitted for commercial use"_, and this site takes real stakes with a
configurable rake. Committing it would also have been redistribution from a
public repo, a separate violation. Buying the licence remains an option if the
exact face matters — <https://alitdesign.net/product/hold-money-blackletter-typeface/>.

Grenze Gotisch was chosen by rendering every plausible OFL blackletter at the
sizes actually used (88px desktop, ~43px phone), in the real colour, against
Hold Money:

| candidate              | why not                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Grenze Gotisch 800** | **chosen** — closest weight to the reference, most legible of the blackletters at phone size, clean numerals |
| Pirata One             | noticeably lighter and narrower; less presence                                                               |
| UnifrakturCook Bold    | denser traditional Fraktur; lowercase hard to read at 43px                                                   |
| Fruktur                | very heavy and wide; "Arena" reads as "Arenu"                                                                |
| UnifrakturMaguntia     | too light                                                                                                    |
| Metal Mania            | rough metal, a different genre                                                                               |

Numerals mattered: the menu quotes stake tiers beside the wordmark.

## If the file is absent

Nothing breaks. `SiteNameplate` declares the face with `font-display: swap` over
an explicit fallback serif stack, so a missing or undecodable font renders the
name in the fallback and the layout does not shift. jsdom has no `FontFace` at
all, so every test run exercises that path.
