#!/usr/bin/env python3
"""Inline the recorder into one self-contained HTML file to hand to voice actors.

    python3 scripts/build_recorder.py
    -> recorder/dist/deadlock-vo-recorder.html

One file, no install, no bundled audio: it reads the voice lines out of the
recorder's own Deadlock install via pak01_dir.vpk.

The list of lines already recorded and committed to the mod (packed/main.tsv,
written by build_mod.py) is baked into the build, so the app can mark them
yellow -- done, but not by the person holding this copy. It is a snapshot: a
build is only as current as the tsv it was made from.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "recorder")
OUT = os.path.join(SRC, "dist", "deadlock-vo-recorder.html")
PACKED_TSV = os.path.join(ROOT, "packed", "main.tsv")
PACKED_DECL = "const PACKED = [];"


def packed_assets(path):
    """Asset paths from a packed/*.tsv -- the first column, minus comments."""
    if not os.path.exists(path):
        return []
    assets = []
    for line in open(path):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        asset = line.split("\t")[0]
        if asset == "asset":          # the column header
            continue
        if asset.endswith(".vsnd_c"):
            assets.append(asset)
    return sorted(set(assets))

html = open(os.path.join(SRC, "index.html")).read()
js = open(os.path.join(SRC, "app.js")).read()
if "<script src=\"app.js\"></script>" not in html:
    sys.exit("index.html no longer references app.js")
assets = packed_assets(PACKED_TSV)
if PACKED_DECL not in js:
    sys.exit("app.js no longer declares PACKED the way this script expects")
js = js.replace(PACKED_DECL,
                "const PACKED = [\n" + "".join(f"  {a!r},\n".replace("'", '"')
                                                for a in assets) + "];", 1)

html = html.replace("<script src=\"app.js\"></script>",
                    "<script>\n" + js + "\n</script>")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write(html)
print(f"wrote {OUT}  ({len(html)/1024:.0f} KB)")
print(f"  {len(assets)} line(s) marked as already in the pack"
      + ("" if assets else f"  (no {os.path.relpath(PACKED_TSV, ROOT)} yet)"))
