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
| `sigmoid` | our own log-logistic `x^c / (x^c + s^c)`, normalized; same idea as darktable's sigmoid module (GPL) but no darktable code is used | ours | c = 1.5 and the 0.18 → 0.18 / 2.83 → 1 constraints are our choices |
