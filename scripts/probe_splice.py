#!/usr/bin/env python3
"""Probe: can we replace VO by splicing a new MP3 into a shipped .vsnd_c?

The audio payload of a Deadlock VO asset is a plain MP3 appended after ~2-3 KB
of resource metadata (see scripts/vsnd.py). Splicing is trivial; the open
question is whether the engine tolerates the CTRL-block fields (SampleCount,
flDuration, StreamingSize, seek table) still describing the OLD audio.

This builds one addon VPK containing three deliberately different cases so a
single install answers the question:

  A same   -- reversed audio, identical duration/rate/bitrate. Metadata stays
              accurate, so this tests the splice mechanism alone.
  B short  -- reversed then truncated to ~50%. Metadata now overstates length.
  C long   -- reversed then looped to ~150%. Metadata now understates length.

Each replacement is the original played backwards, so "did it work" needs no
careful listening -- backwards speech is unmistakable.

Usage:  python3 scripts/probe_splice.py [--hero haze]
Output: build/probe_splice/pak01_dir.vpk  + work/ (the wavs and mp3s)
"""
import argparse, os, subprocess, sys, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlvpk, vsnd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "probe_splice")
WORK = os.path.join(OUT, "work")

# VO assets are nested in per-category subfolders (ping/, emote/, ...), so
# targets are given as clip basenames and resolved against the VPK index.
CASES = [
    ("A_same", "haze_ping_thanks", 1.0),
    ("B_short", "haze_select_01", 0.5),
    ("C_long", "haze_pain_death_01", 1.5),
]


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stderr[-800:]}")
    return r


def build_variant(orig_mp3, dest_mp3, factor, info):
    """Reverse the audio, then scale its length by `factor` (truncate or loop)."""
    rev = dest_mp3 + ".rev.wav"
    sh(["ffmpeg", "-y", "-v", "error", "-i", orig_mp3, "-af", "areverse", rev])
    target = info["duration"] * factor
    filters = []
    if factor < 1.0:
        filters = ["-t", f"{target:.3f}"]
    elif factor > 1.0:
        filters = ["-stream_loop", "-1", "-t", f"{target:.3f}"]
    # match the shipped encode: same rate, channel count, nominal bitrate
    kbps = max(64, round(info["bitrate"] / 1000))
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if factor > 1.0:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-i", rev]
    if factor != 1.0:
        cmd += ["-t", f"{target:.3f}"]
    # shipped VO carries a Xing header but no ID3 tag -- match that, since the
    # payload must begin on an MP3 frame sync the way the originals do
    cmd += ["-ar", str(info["rate"]), "-ac", str(info["channels"]),
            "-c:a", "libmp3lame", "-b:a", f"{kbps}k",
            "-map_metadata", "-1", "-id3v2_version", "0",
            "-write_xing", "1", dest_mp3]
    sh(cmd)
    os.remove(rev)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hero", default="haze")
    args = ap.parse_args()

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)

    print("reading game VPK directory...")
    index = dlvpk.read_dir(os.path.join(dlvpk.GAME_CITADEL, "pak01_dir.vpk"))

    prefix = f"sounds/vo/{args.hero}/"
    by_name = {k.rsplit("/", 1)[1][:-len(".vsnd_c")]: k
               for k in index if k.startswith(prefix) and k.endswith(".vsnd_c")}

    payload, report = {}, []
    for label, clip, factor in CASES:
        asset = by_name.get(clip)
        if asset is None:
            print(f"  !! {clip} not found under {prefix}, skipping")
            continue
        original = dlvpk.read_file(index[asset])
        meta, mp3 = vsnd.split(original)

        o_mp3 = os.path.join(WORK, f"{label}.orig.mp3")
        n_mp3 = os.path.join(WORK, f"{label}.new.mp3")
        open(o_mp3, "wb").write(mp3)
        info = vsnd.probe_mp3(o_mp3)
        build_variant(o_mp3, n_mp3, factor, info)
        new = open(n_mp3, "rb").read()
        payload[asset] = vsnd.splice(original, new)

        n_info = vsnd.probe_mp3(n_mp3)
        report.append((label, asset, len(meta), info, n_info,
                       len(mp3), len(new)))
        print(f"  {label:8} {clip:22} meta={len(meta)}B "
              f"{info['duration']:.2f}s -> {n_info['duration']:.2f}s  "
              f"payload {len(mp3)}B -> {len(new)}B")

    if not payload:
        sys.exit("nothing built")

    vpk = os.path.join(OUT, "pak01_dir.vpk")
    size = dlvpk.write_vpk(vpk, payload)
    print(f"\nwrote {vpk} ({size} bytes, {len(payload)} assets)")

    lines = ["# probe_splice results", "",
             "| case | asset | meta bytes | orig dur | new dur | orig payload | new payload |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for label, asset, ms, oi, ni, ol, nl in report:
        lines.append(f"| {label} | `{asset}` | {ms} | {oi['duration']:.2f}s | "
                     f"{ni['duration']:.2f}s | {ol} | {nl} |")
    lines += ["", "## Install", "",
              "Copy pak01_dir.vpk into the game addons folder under a new name,",
              "or add it via Deadlock Mod Manager:", "",
              f"    {dlvpk.GAME_CITADEL}/addons/", "",
              "## Expected", "",
              "Each line should play BACKWARDS if the splice works.",
              "- A plays backwards, full length  -> splicing works, metadata accurate",
              "- B plays backwards but may cut/pad -> stale length fields tolerated?",
              "- C plays backwards but may truncate at the old duration",
              "- silence / original audio / hitch -> that case is rejected", "",
              "## Verdict to record", "",
              "If A works and B/C truncate, splicing is viable only at equal",
              "duration, and the CTRL fields must be patched for anything else.",
              "If all three work, the whole pipeline can stay pure Python."]
    open(os.path.join(OUT, "RESULTS.md"), "w").write("\n".join(lines) + "\n")
    print(f"wrote {os.path.join(OUT, 'RESULTS.md')}")


if __name__ == "__main__":
    main()
