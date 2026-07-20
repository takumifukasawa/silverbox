# Research note: Adobe creative-profile LookTable encoding

Status: OPEN forensic note (2026-07-20, Fable session). Concrete
findings toward decoding the obfuscated `crs:LookTable` payload that
`dcp-profile.md`'s re-measurement identified as the missing lever
between silverbox and "Adobe Color" (Adobe Standard DCP + this Look,
layered). NOT a solve — a documented starting point so the next
attempt doesn't re-derive the container facts. No Adobe content is
reproduced here (only structural statistics + the symbol alphabet).

## Where the payload actually lives

The Look profiles are ACR creative-profile XMPs at
`/Library/Application Support/Adobe/CameraRaw/Settings/Adobe/Profiles/Adobe Raw/*.xmp`
(system-wide copy present on this machine; the per-user copy under
`~/Library/...` was ABSENT — dcp-profile.md's `~/`-path assumption
should be widened to the `/Library` location).

Two distinct XMP attributes, do not confuse them (the earlier brief
conflated them):
- `crs:LookTable="E1095149FDB39D7A057BAB208837E2E1"` — just a
  32-hex-char IDENTIFIER/hash (the Look's table id), NOT data.
- `crs:Table_<that-same-hash>="…106395 chars…"` — the actual payload.
  The attribute NAME embeds the id, so a profile references its table
  by the hash. (Adobe Color: 106,395 chars.)

## Corpus available for a known-plaintext / frequency attack

942 XMPs under that CameraRaw tree; **503 carry a `crs:Table_*`
payload**, ~39 MB of encoded data pooled. This is a large corpus —
enough for position/frequency analysis and, more powerfully, a
KNOWN-PLAINTEXT approach: several profiles are near-identity looks
(Adobe Monochrome's chroma behavior, "Camera Standard"-style) whose
decoded 2.5D HueSatValue table values are strongly predictable
(monochrome ⇒ saturation-scale ≈ 0 everywhere), giving crib pairs.

## What the encoding is NOT (ruled out this session)

- **Not a standard base85.** Symbol set is 85 chars (below), but it
  equals neither Z85 (82/85 shared), Ascii85 '!'–'u' (77/85), nor
  RFC1924 (79/85). Custom alphabet.
- **Not straightforward base85-of-bytes in any obvious digit order.**
  Under 5-char→4-byte grouping with sorted/negated/substituted
  alphabets and both endianness, 100–730 of the 21,279 groups exceed
  2^32 — a real base85 encoding of bytes never overflows, so either
  the alphabet ordering is non-trivial OR the grouping/stride
  differs.
- **Grouping is likely NOT globally period-5.** Adobe Color's length
  (106,395 = 5×21,279) is a multiple of 5, but across the 503-table
  corpus most lengths are NOT multiples of 5 (28k–246k, arbitrary
  residues). So a clean 5→4 base85 block scheme cannot be the whole
  story corpus-wide; the period-5 chi-square dip is weak (period 7/8
  score lower) and the "% caps position 4" structure found earlier
  was an artifact of forcing stride 5 on a non-stride-5 stream.

## The symbol alphabet (85 chars, this payload)

```
!#$%'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^`abcdefghijklmnopqrstuvwxyz{|}
```
Absent vs printable-ASCII: space and `"` `&` `,` `;` `<` `>` `\` `_`
`~` — i.e. exactly the XML-attribute-unsafe chars plus a few. This is
consistent with a base85 variant deliberately chosen to be
XML-attribute-safe (no `"` `&` `<` `>`), which is WHY it can't be a
stock alphabet. The excluded set is the strongest structural clue:
recover the digit VALUE of each symbol (not its ASCII order) and the
overflow test becomes the oracle — the correct value-assignment is
the one making all 5-tuples < 2^32 for the multiple-of-5 tables.

## Recommended next attack (for whoever picks this up)

1. Restrict to the multiple-of-5 tables first (Adobe Color is one).
   Treat symbol→value as 85 unknowns; the "no 5-tuple ≥ 2^32"
   constraint over ~21k groups is a tight integer-feasibility problem
   (ILP / CP-SAT). Solve for a consistent value map; expect it near
   an affine function of ASCII with the excluded chars skipped.
2. With a candidate value map, decode Adobe Monochrome (crib: its
   HueSatValue sat-scale channel ≈ 0) and check the byte pattern for
   the DNG-spec HueSatMapDims header shape (H×S×V × 3 float32, or a
   fixed-point variant). Table dims are the tell.
3. If multiple-of-5 tables decode but others don't, the non-mult-5
   ones likely carry a small header/length prefix before the base85
   body — strip and retry.
4. Cross-check any decoded float table against dcamprof's open DCP
   HueSatMap semantics.

## Legal line (unchanged from dcp-profile.md)

Reading the user's own locally-installed profiles for their own
rendering is fine (their license, their machine). Never bundle or
redistribute Adobe payloads or decoded tables. Any silverbox feature
stays "point at the user's own installed profile," and this note
publishes only statistics + the symbol set, never Adobe data.

## Relation to the shipped pipeline

DCP stages 1-2 (dcp-profile.md) already execute ordinary per-camera
DCPs (ForwardMatrix/HueSatDelta/ToneCurve). This Look layer is the
SEPARATE creative table stacked on top for the "Adobe Color" look
specifically; decoding it is what would close dcp-profile.md's
measured gap. Until then, `profile.source` stays `builtin` by
default and the honest camera-faithful story (Camera ST DCPs) is the
recommended DCP-mode payoff, per that brief's cross-check addenda.
