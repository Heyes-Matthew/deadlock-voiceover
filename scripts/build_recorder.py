#!/usr/bin/env python3
"""Inline the recorder into one self-contained HTML file to hand to voice actors.

    python3 scripts/build_recorder.py
    -> recorder/dist/deadlock-vo-recorder.html

One file, no install, no bundled audio: it reads the voice lines out of the
recorder's own Deadlock install via pak01_dir.vpk.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "recorder")
OUT = os.path.join(SRC, "dist", "deadlock-vo-recorder.html")

html = open(os.path.join(SRC, "index.html")).read()
js = open(os.path.join(SRC, "app.js")).read()
if "<script src=\"app.js\"></script>" not in html:
    sys.exit("index.html no longer references app.js")
html = html.replace("<script src=\"app.js\"></script>",
                    "<script>\n" + js + "\n</script>")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write(html)
print(f"wrote {OUT}  ({len(html)/1024:.0f} KB)")
