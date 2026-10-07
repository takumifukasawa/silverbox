# Third-party notices

Silverbox includes material from the following third parties. Their licenses
are reproduced here as their terms require.

## Minimal AgX implementation — Benjamin Wrensch (MIT)

Used in `src/renderer/engine/color/baseTone.ts` (base tone `agx`: the inset /
outset matrices, the log2 range and the 6th-order contrast polynomial).
Source: https://iolite-engine.com/blog_posts/minimal_agx_implementation
Its author notes that all values used to derive it are sourced from Troy
Sobotka's AgX OCIO config (https://github.com/sobotka/AgX).

```
MIT License

Copyright (c) 2024 Missing Deadlines (Benjamin Wrensch)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ACES filmic curve fit — Krzysztof Narkowicz (CC0 / MIT)

Used in `src/renderer/engine/color/baseTone.ts` (base tone `aces`: the
rational fit with a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14 and the
0.6 input scale). Source:
https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/ —
offered by its author as "free to use under public domain CC0 or MIT
license". Taken under CC0; no notice is required, kept here for provenance.
