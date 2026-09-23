#!/usr/bin/env python3
"""Bulk-extract shipped VO to MP3, mirroring the in-game asset paths.

    python3 scripts/extract_vo.py --hero haze
    python3 scripts/extract_vo.py --all            # every sounds/vo/ clip
    python3 scripts/extract_vo.py --hero haze --filter select

Output: originals/sounds/vo/<hero>/<...>/<clip>.mp3

Pure Python -- the payload of a .vsnd_c is already an MP3, so this is a slice,
not a decode. Use it to build the reference corpus before replacing anything.
"""
import argparse, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlvpk, vsnd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hero", help="hero codename, e.g. haze (see CLAUDE.md)")
    ap.add_argument("--all", action="store_true", help="every clip under sounds/vo/")
    ap.add_argument("--filter", default="", help="substring the path must contain")
    ap.add_argument("--out", default=os.path.join(ROOT, "originals"))
    args = ap.parse_args()
    if not args.hero and not args.all:
        ap.error("pass --hero NAME or --all")

    idx = dlvpk.read_dir(os.path.join(dlvpk.GAME_CITADEL, "pak01_dir.vpk"))
    prefix = "sounds/vo/" if args.all else f"sounds/vo/{args.hero}/"
    keys = sorted(k for k in idx
                  if k.startswith(prefix) and k.endswith(".vsnd_c")
                  and args.filter in k)
    if not keys:
        sys.exit(f"no clips matched {prefix}*{args.filter}*")

    print(f"{len(keys)} clips -> {args.out}")
    t0, written = time.time(), 0
    for n, k in enumerate(keys, 1):
        data = dlvpk.read_file(idx[k])
        mp3 = vsnd.split(data)[1]
        dest = os.path.join(args.out, k[:-len(".vsnd_c")] + ".mp3")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(mp3)
        written += len(mp3)
        if n % 500 == 0 or n == len(keys):
            print(f"  {n}/{len(keys)}  {written/1e6:.1f} MB  {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
