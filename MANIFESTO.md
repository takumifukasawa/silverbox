# Silverbox — a manifesto

*Why another RAW developer?*

## Your edits are worth keeping

Open a photo you developed fifteen years ago. If the tool that made it
is gone — and it probably is — what remains? A JPEG. The *decisions*
that made it, the twenty minutes of judgment about that highlight and
that green, live in a proprietary database you can no longer read.

Silverbox starts from a refusal: **the edit is a document, and documents
belong to you.** Every look you build is a plain JSON file sitting next
to the photo. You can read it. You can diff it. You can put it in git
and watch your taste evolve commit by commit. You can email it to a
friend, check it out on another machine, or regenerate every JPEG in
your archive ten years from now and *prove* — pixel by pixel — that
nothing drifted.

## Intent, not pixels

A Silverbox document stores no pixels. It stores *intent*: raise the
shadows, key that green, heal that spot, this crop. The engine turns
intent into pixels deterministically — same document, same photo, same
result, forever. That discipline shapes everything:

- **Non-destructive is not a feature here; it is the data model.**
  There is nothing destructive to opt out of.
- **The default look is visible.** When Silverbox opens a RAW, the
  brightness curve and sharpening it applies are sitting right there in
  the develop panel as editable values — fitted, documented, removable.
  No hidden rendering magic that your files depend on.
- **The archive can test itself.** Commit a small reference render next
  to each photo; one command re-renders everything and reports any
  drift. Engine updates become choices you accept, not accidents you
  discover.

## A graph, worn lightly

Under the hood every edit is a node graph — the structure DaVinci
Resolve got right. Local adjustments are real masks feeding real blend
nodes; a second export is a second output node; a look you like can
flow into two different crops. But you don't pay for the graph until
you need it: open a photo and you get a develop panel that feels like
the one you already know. The graph is there when one photo needs two
outputs, when a mask should reuse another image, when you want to see
any intermediate step with one click.

The controls themselves are deliberately unoriginal: calibrated,
side-by-side, against the tools photographers already trust. Your
muscle memory is a spec we implement.

## The file is the interface

Because the document is text, *anything that writes text can edit
photos*. An AI assistant can propose a look by writing JSON; Silverbox
hot-reloads it into the open window, shows you what changed in plain
language, and lets you take it or leave it — code review, for looks. A
shell script can batch-develop a folder. A CI job can regression-test
your portfolio. None of this needed a plugin API, because the file *is*
the API.

The same conviction, inverted, sets the boundary: Silverbox will not
become a catalog. No database, no import ceremony, no keywords engine.
Your folders are your library; git is your history; the sidecar is the
single source of truth. Views may help you browse — they will never
own your photos.

## What this costs

Honesty about the trade: Silverbox is not trying to win at AI-powered
one-click everything, cloud sync, or managing 100,000 photos. It is
trying to be the tool where your development work is *durable* —
legible in twenty years, reproducible to the pixel, versioned like the
craft it is, and open to whatever tools (human or machine) you choose
to bring.

If your photos deserve that, this is for you.
