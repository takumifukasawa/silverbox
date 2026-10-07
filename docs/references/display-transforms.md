# Display transforms (base tones) — sources and licenses

Checked 2026-10-07. Used by `src/renderer/engine/color/baseTone.ts` and
`scripts/drt-compare/`. Notices that must ship: `THIRD_PARTY_NOTICES.md`
(bundled into the app's Resources via package.json `build.extraResources`).

| base tone | source | license | what we take |
|---|---|---|---|
| `agx` | Benjamin Wrensch, "Minimal AgX Implementation" — https://iolite-engine.com/blog_posts/minimal_agx_implementation (license header verified via https://gist.github.com/nxrighthere/eb208dae8b66dbe452af223f276e46cc) | MIT, "Copyright (c) 2024 Missing Deadlines (Benjamin Wrensch)" — notice must ship | inset/outset matrices, log2 range, 6th-order polynomial; the "Punchy" look values (power 1.35, sat 1.4) are in the same code |
| (upstream of `agx`) | Troy Sobotka, https://github.com/sobotka/AgX `config.ocio` | NO license stated (no LICENSE file, GitHub license null, none in config) | Wrensch derived his values from it. The inset matrix and the log2 range −12.47393 / 4.026069 match `config.ocio` lines 83–84 verbatim. Only numeric parameters, no code, reach us — generally treated as non-copyrightable facts, but this is the one item with no explicit grant |
| `aces` | Krzysztof Narkowicz, "ACES Filmic Tone Mapping Curve" — https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/ | "free to use under public domain CC0 or MIT license" — taken as CC0 | rational fit a/b/c/d/e and the ×0.6 input scale ("for the original ACES curve") |
| `reinhard` | Reinhard et al. 2002, "Photographic Tone Reproduction for Digital Images" (extended operator) | a published formula, no code | white point 2.83 is our choice (pre-gained sensor peak) |
| `agx_punchy` | same Wrensch publication (its `AGX_LOOK == 2` "Punchy" look, his approximation of Blender's Punchy) | MIT (same notice) | ASC-CDL power 1.35 and saturation 1.4 around Rec.709 luma, in AgX space after the curve |
| `sigmoid` | darktable `sigmoid` module (src/iop/sigmoid.c), DEFAULT parameters only: contrast 1.5, skew 0, target white 100 %, target black 0.0152 %, middle grey 0.1845, per-channel with hue preservation 100 %, base primaries = working space (linear Rec.2020 in both apps) | darktable is GPLv3 → NO code is used. Parameter values and the curve family (generalized log-logistic) are facts/math | The curve constants (fog, paper exposure) are solved by us in closed form from the targets f(0)=black, f(grey)=grey, f(∞)=white; with skew 0 and white 1 the exponent equals the contrast. Hue preservation is our own hexcone version (curve on min/max channels, middle channel keeps (mid−min)/(max−min)); darktable additionally redistributes energy between channels, which we do not, so saturated mid-hues can differ slightly. Negative channels are desaturated toward the mean first. Replaced our earlier own-coefficient sigmoid before release (user 2026-10-07: 「darktable sigmoid 準拠」) |

User decision 2026-10-07: shipping `agx` is acceptable — the only values
without an explicit grant (Sobotka's) reach us as numeric parameters through
Wrensch's MIT-licensed publication.
