#!/usr/bin/env python3
"""Probe 3: is a spliced payload used at all, and does patching CTRL help?

Probe 2 settled the infrastructure: the canary proved the engine reads our VPK
(two startup 'Failed loading resource' lines vanished), and all 10 haze_select
lines became Dynamo's when replaced with shipped assets byte for byte. Only the
SPLICED groups (death, thanks ping) showed no change -- but those were also the
hardest to judge by ear (a reversed grunt still sounds like a grunt) and the
hardest to trigger.

So this probe moves the splice test onto the trigger we KNOW works and the
voice change we KNOW is unmistakable: Haze's hero-select lines, spoken by Dynamo.
The only difference from probe 2's successful verbatim group is that the audio
arrives by splice rather than as a whole shipped file.

  01-05  raw splice     haze metadata + dynamo MP3 payload, CTRL untouched
                        (CTRL still describes Haze's audio: wrong StreamingSize,
                         SampleCount, seek table)
  06-10  patched splice same, but StreamingSize and SampleCount rewritten in
                        place to describe the new payload

Reading the result, clicking Haze in the hero picker repeatedly:
  all 10 Dynamo      -> splicing works; probe 2's null was ear/trigger, not format
  only 06-10 Dynamo  -> splicing works but CTRL must be patched
  none Dynamo        -> spliced payloads are rejected; CSDK 12 is the route
  garbled / silence  -> payload is read but the seek table matters too
"""
import os, sys, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlvpk, vsnd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "probe3_splice_vs_patch")
WORK = os.path.join(OUT, "work")


def info_of(data, label):
    p = os.path.join(WORK, f"{label}.mp3")
    open(p, "wb").write(data)
    return vsnd.probe_mp3(p)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    idx = dlvpk.read_dir(os.path.join(dlvpk.GAME_CITADEL, "pak01_dir.vpk"))

    payload, rows = {}, []
    for i in range(1, 11):
        dst = f"sounds/vo/haze/haze_select_{i:02d}.vsnd_c"
        src = f"sounds/vo/dynamo/dynamo_select_{i:02d}.vsnd_c"
        if dst not in idx or src not in idx:
            continue
        haze = dlvpk.read_file(idx[dst])
        dyn = dlvpk.read_file(idx[src])
        h_mp3 = vsnd.split(haze)[1]
        d_mp3 = vsnd.split(dyn)[1]
        h_info = info_of(h_mp3, f"{i:02d}_haze")
        d_info = info_of(d_mp3, f"{i:02d}_dynamo")

        if i <= 5:
            payload[dst] = vsnd.splice(haze, d_mp3)
            mode, status = "raw splice", {}
        else:
            payload[dst], status = vsnd.patch_ctrl(haze, d_mp3, d_info, h_info)
            mode = "patched"
        rows.append((i, mode, h_info["duration"], d_info["duration"],
                     len(h_mp3), len(d_mp3), status))
        print(f"  {i:02d} {mode:11} haze {h_info['duration']:.2f}s/{len(h_mp3)}B "
              f"-> dynamo {d_info['duration']:.2f}s/{len(d_mp3)}B "
              f"{' '.join(f'{k}={v}' for k, v in status.items())}")

    vpk = os.path.join(OUT, "pak01_dir.vpk")
    size = dlvpk.write_vpk(vpk, payload)
    print(f"\nwrote {vpk} ({size} bytes, {len(payload)} files)")
    print("""
TEST: hero picker, click Haze ~15 times and note what you hear.
  Every select line is either Haze (unchanged) or Dynamo (splice worked).
  Lines 01-05 are the raw splice, 06-10 the patched one, but you cannot tell
  which variant fired -- so just report the ROUGH MIX, e.g. "all Dynamo",
  "about half Dynamo, half Haze", "all Haze", or "some garbled/silent".
  About half Dynamo => patching is what makes splicing work.
""")


if __name__ == "__main__":
    main()
