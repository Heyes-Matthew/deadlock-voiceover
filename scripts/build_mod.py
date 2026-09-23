#!/usr/bin/env python3
"""Build the mod VPK from a tree of replacement audio.

Layout: put your audio under source/, with any extension ffmpeg can read. Two
naming styles work, and they can be mixed:

  mirrored   source/sounds/vo/haze/haze_select_01.wav
             source/sounds/vo/haze/ping/haze_ping_thanks.mp3

  flattened  source/from_alex/sounds~vo~haze~haze_select_01.wav
             (what the recorder app exports -- '~' stands in for '/', so a
             returned zip can be unpacked anywhere under source/ and just work)

Each file is matched to the shipped .vsnd_c at the same path, re-encoded to match
that clip's format, and spliced onto its metadata (see CLAUDE.md: splicing is
verified to work, nothing is compiled).

    python3 scripts/build_mod.py                 # -> build/mod/pak01_dir.vpk
    python3 scripts/build_mod.py --name haze_pack
    python3 scripts/build_mod.py --patch         # also rewrite CTRL (not needed)

Install the result with Deadlock Mod Manager (Add Mods -> drag the .vpk in).
"""
import argparse, hashlib, os, subprocess, sys, shutil, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlvpk, vsnd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aiff", ".aif"}


LADDER = [128, 112, 96, 80, 64, 56, 48]


def encode_like(src, dest, info, kbps=None, limit=None):
    """Re-encode `src` to MP3 matching a shipped clip's rate/channels/bitrate."""
    if kbps is None:
        kbps = max(64, round(info["bitrate"] / 1000))
    cut = ["-t", f"{limit:.3f}"] if limit else []
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, *cut,
         "-ar", str(info["rate"]), "-ac", str(info["channels"]),
         "-c:a", "libmp3lame", "-b:a", f"{kbps}k",
         "-map_metadata", "-1", "-id3v2_version", "0", "-write_xing", "1", dest],
        check=True, capture_output=True)
    return kbps


def encode_to_fit(src, dest, info, budget, limit):
    """Encode so the take fits inside the clip it replaces.

    Two constraints, and the first is the one that matters: a take LONGER than
    the original plays as silence in game (confirmed in testing -- the CTRL
    block still describes the original stream and the engine believes it).

    Cutting at `limit` is not enough on its own: MP3 frames are ~26ms each and
    LAME adds encoder delay, so the encoded result overshoots by up to ~60ms.
    The cut is therefore walked back until the *encoded* duration is inside the
    limit. The byte budget is then met by stepping the bitrate down, which does
    not change the length. Returns (bytes, kbps, info).
    """
    target = limit
    data, n_info, kbps = None, None, None
    for _ in range(5):
        kbps = encode_like(src, dest, info, limit=target)
        data = open(dest, "rb").read()
        n_info = vsnd.probe_mp3(dest)
        if n_info["duration"] <= limit:
            break
        target -= (n_info["duration"] - limit) + 0.005
        if target <= 0.05:
            break

    if len(data) <= budget:
        return data, kbps, n_info
    for k in [b for b in LADDER if b < kbps]:
        encode_like(src, dest, info, k, limit=target)
        data = open(dest, "rb").read()
        n_info = vsnd.probe_mp3(dest)
        if len(data) <= budget:
            return data, k, n_info
    return data, LADDER[-1], n_info


INDEX_COLUMNS = ["asset", "source", "sha256", "orig_s", "take_s", "packed_s",
                 "packed_bytes", "cut"]


def write_index(path, manifest):
    """Write the git-trackable record of what has been packed.

    One line per asset, sorted, tab separated, no timestamps or paths outside
    the project -- so a rebuild of unchanged audio produces an identical file
    and `git diff` shows exactly which lines were added or re-recorded. The
    sha256 is of the source audio as the actor sent it, not of the packed
    payload, so it survives changes to the encoder settings.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rows = []
    for m in sorted(manifest, key=lambda m: m["asset"]):
        cut = "cut" if m["source_duration"] > m["orig_duration"] + 0.01 else "-"
        rows.append("\t".join([
            m["asset"], m["source"], m["sha256"],
            f"{m['orig_duration']:.3f}", f"{m['source_duration']:.3f}",
            f"{m['new_duration']:.3f}", str(m["new_bytes"]), cut,
        ]))
    with open(path, "w", newline="\n") as f:
        f.write("# every line packed into this mod, one per replaced asset\n")
        f.write("# sha256 is of the source audio; 'cut' marks a take that was\n")
        f.write("# longer than the line it replaces and had its tail removed\n")
        f.write("\t".join(INDEX_COLUMNS) + "\n")
        f.write("\n".join(rows) + "\n")
    return path


def variant_siblings(idx, asset):
    """Other _NN variants of the same line, which the game picks among at random."""
    base = asset[:-len(".vsnd_c")]
    if len(base) < 3 or not base[-2:].isdigit() or base[-3] != "_":
        return []
    stem = base[:-2]
    return sorted(k for k in idx
                  if k.startswith(stem) and k.endswith(".vsnd_c")
                  and k[len(stem):-len(".vsnd_c")].isdigit())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=os.path.join(ROOT, "source"))
    ap.add_argument("--name", default="mod")
    ap.add_argument("--patch", action="store_true",
                    help="also rewrite CTRL's StreamingSize/SampleCount/flDuration "
                         "(off by default: it locates the fields by byte pattern, "
                         "which can hit the wrong ones -- see CLAUDE.md)")
    ap.add_argument("--index", default=None,
                    help="where to write the tracked list of packed lines "
                         "(default: packed/<name>.tsv)")
    ap.add_argument("--no-fit", action="store_true",
                    help="don't cut takes to the original's length (they will be "
                         "silent in game -- for experiments only)")
    args = ap.parse_args()

    if not os.path.isdir(args.source):
        sys.exit(f"no source tree at {args.source}\n"
                 f"put replacement audio at source/sounds/vo/<hero>/<clip>.wav")

    out = os.path.join(ROOT, "build", args.name)
    work = os.path.join(out, "work")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    print("reading game VPK directory...")
    idx = dlvpk.read_dir(os.path.join(dlvpk.GAME_CITADEL, "pak01_dir.vpk"))

    payload, manifest, missing, replaced, oversized, trimmed = {}, [], [], set(), [], []
    for dirpath, _, files in os.walk(args.source):
        for fn in sorted(files):
            stem, ext = os.path.splitext(fn)
            if ext.lower() not in AUDIO_EXT:
                continue
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, args.source).replace(os.sep, "/")
            digest = hashlib.sha256(open(src, "rb").read()).hexdigest()
            if "~" in fn:
                # flattened name from the recorder app: path separators as '~'
                asset = stem.replace("~", "/") + ".vsnd_c"
            else:
                asset = rel[:-len(ext)] + ".vsnd_c"
            if asset not in idx:
                missing.append(rel)
                continue

            original = dlvpk.read_file(idx[asset])
            o_mp3 = os.path.join(work, stem + ".orig.mp3")
            open(o_mp3, "wb").write(vsnd.split(original)[1])
            o_info = vsnd.probe_mp3(o_mp3)

            n_mp3 = os.path.join(work, stem + ".new.mp3")
            budget = len(vsnd.split(original)[1])
            s_info = vsnd.probe_mp3(src)
            if args.no_fit:
                kbps = encode_like(src, n_mp3, o_info)
                new = open(n_mp3, "rb").read()
                n_info = vsnd.probe_mp3(n_mp3)
            else:
                new, kbps, n_info = encode_to_fit(src, n_mp3, o_info, budget,
                                                  o_info["duration"])
            if s_info["duration"] > o_info["duration"] + 0.01:
                trimmed.append((asset, s_info["duration"], o_info["duration"]))

            if args.patch:
                data, status = vsnd.patch_ctrl(original, new, n_info, o_info)
            else:
                data, status = vsnd.splice(original, new), {}
            payload[asset] = data
            replaced.add(asset)
            over = len(new) > budget
            if over:
                oversized.append((asset, len(new), budget))
            manifest.append({"asset": asset, "source": rel, "sha256": digest,
                             "orig_duration": round(o_info["duration"], 3),
                             "source_duration": round(s_info["duration"], 3),
                             "new_duration": round(n_info["duration"], 3),
                             "orig_bytes": budget, "new_bytes": len(new),
                             "kbps": kbps, "ctrl": status})
            print(f"  {asset}\n      <- {rel}  "
                  f"{o_info['duration']:.2f}s -> {n_info['duration']:.2f}s  "
                  f"{budget}B -> {len(new)}B @{kbps}k{'  !! OVER' if over else ''}")

    if missing:
        print(f"\n!! {len(missing)} source file(s) have no matching shipped asset:")
        for m in missing[:10]:
            print(f"     {m}")
        print("   check the path and spelling against the VPK listing")

    if trimmed:
        print(f"\n!! {len(trimmed)} take(s) were longer than the line they replace and")
        print("   have been CUT to fit — anything past the cut is gone. Re-record these")
        print("   shorter (the recorder app shows the limit and stops at it):")
        for a, sd, od in trimmed:
            print(f"     {a.split('/')[-1]}: {sd:.2f}s -> {od:.2f}s")

    if oversized:
        print(f"\n!! {len(oversized)} clip(s) are still larger in bytes than the asset they")
        print("   replace even at the lowest bitrate -- they may play silent in game.")
        for a, n, b in oversized:
            print(f"     {a}: {n}B vs {b}B")
        print("   shorten the take, or trim leading/trailing silence.")

    # the variant trap: a half-covered group means the game still plays originals
    gaps = []
    for asset in sorted(replaced):
        sibs = variant_siblings(idx, asset)
        uncovered = [s for s in sibs if s not in replaced]
        if uncovered:
            gaps.append((asset, len(sibs), uncovered))
    if gaps:
        print("\n!! INCOMPLETE VARIANT GROUPS — the game picks among variants at random,")
        print("   so these lines will still play the original audio some of the time:")
        seen = set()
        for asset, total, uncovered in gaps:
            stem = asset[:-len(".vsnd_c")].rsplit("_", 1)[0]
            if stem in seen:
                continue
            seen.add(stem)
            print(f"     {stem}_NN: {total - len(uncovered)}/{total} replaced")

    if not payload:
        sys.exit("\nnothing to build")

    vpk = os.path.join(out, "pak01_dir.vpk")
    size = dlvpk.write_vpk(vpk, payload)
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=2)
    index = write_index(args.index or os.path.join(ROOT, "packed", args.name + ".tsv"),
                        manifest)
    print(f"\nwrote {vpk}")
    print(f"  {len(payload)} assets, {size/1e6:.2f} MB")
    print(f"  manifest: {os.path.join(out, 'manifest.json')}")
    print(f"  index:    {index}  (commit this — it's the record of what's done)")
    print("\nInstall: DMM -> Add Mods -> drag in the .vpk (disable older test builds first)")


if __name__ == "__main__":
    main()
