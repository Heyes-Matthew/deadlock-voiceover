#!/usr/bin/env python3
"""Probe 2: isolate WHY probe 1 produced no audible change.

Probe 1 replaced only the _01 variant of each line. Deadlock picks randomly
among variants (haze_select has 10, haze_pain_death has 6), so a trigger had a
1-in-10 / 1-in-6 chance of hitting the replaced file. That alone could explain
a null result, independent of whether splicing works.

This build replaces EVERY variant in each group and separates three questions:

  canary   scripts/ai_lod.vdata_c + scripts/npc_squad_modes.vdata_c
           The game logs both as missing at startup (ERROR_FILEOPEN). We supply
           valid files at those paths. If the startup errors change or vanish,
           the engine is genuinely reading content out of our VPK -- proved from
           console.log alone, with NO gameplay required.

  verbatim all 10 haze_select_*  <- dynamo's select clips, copied byte for byte
           A shipped, valid, uncompiled-by-us asset at a new path. Tests packing,
           mounting and VO path resolution with splicing taken out of the picture.

  splice   all 6 haze_pain_death_*  <- reversed, equal duration
           plus haze_ping_thanks (single variant, reliable trigger)
           Only these involve a spliced payload.

Reading the result:
  canary fails               -> the VPK is mounted but its contents aren't used
  canary ok + verbatim fails -> VO paths resolve elsewhere than we think
  verbatim ok + splice fails -> splicing is rejected; CTRL fields matter
  all ok                     -> probe 1 was just the variant-randomisation trap
"""
import os, subprocess, sys, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlvpk, vsnd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "probe2_isolate")
WORK = os.path.join(OUT, "work")

# paths the game reports as missing at startup; we fill them with valid files
CANARY = {
    "scripts/ai_lod.vdata_c": "scripts/navlinks.vdata_c",
    "scripts/npc_squad_modes.vdata_c": "scripts/precipitation.vdata_c",
}


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stderr[-800:]}")


def reversed_payload(original, label):
    """Same duration, same encode params, audio reversed."""
    meta, mp3 = vsnd.split(original)
    o = os.path.join(WORK, f"{label}.orig.mp3")
    n = os.path.join(WORK, f"{label}.new.mp3")
    open(o, "wb").write(mp3)
    info = vsnd.probe_mp3(o)
    wav = os.path.join(WORK, f"{label}.rev.wav")
    sh(["ffmpeg", "-y", "-v", "error", "-i", o, "-af", "areverse", wav])
    sh(["ffmpeg", "-y", "-v", "error", "-i", wav,
        "-ar", str(info["rate"]), "-ac", str(info["channels"]),
        "-c:a", "libmp3lame", "-b:a", f"{max(64, round(info['bitrate']/1000))}k",
        "-map_metadata", "-1", "-id3v2_version", "0", "-write_xing", "1", n])
    os.remove(wav)
    return vsnd.splice(original, open(n, "rb").read()), info


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)

    print("reading game VPK directory...")
    idx = dlvpk.read_dir(os.path.join(dlvpk.GAME_CITADEL, "pak01_dir.vpk"))
    payload = {}

    # --- canary -------------------------------------------------------
    for dest, src in CANARY.items():
        payload[dest] = dlvpk.read_file(idx[src])
        print(f"  canary   {dest:36} <- {src} ({len(payload[dest])}B)")

    # --- verbatim: haze_select_NN <- dynamo_select_NN -------------------
    for i in range(1, 11):
        dst = f"sounds/vo/haze/haze_select_{i:02d}.vsnd_c"
        src = f"sounds/vo/dynamo/dynamo_select_{i:02d}.vsnd_c"
        if dst in idx and src in idx:
            payload[dst] = dlvpk.read_file(idx[src])
            print(f"  verbatim {os.path.basename(dst):28} <- {os.path.basename(src)}")

    # --- splice: every pain_death variant + the thanks ping -------------
    targets = [k for k in idx if "haze_pain_death" in k]
    targets += [k for k in idx if k.endswith("haze/ping/haze_ping_thanks.vsnd_c")]
    for k in sorted(targets):
        label = os.path.basename(k).replace(".vsnd_c", "")
        data, info = reversed_payload(dlvpk.read_file(idx[k]), label)
        payload[k] = data
        print(f"  splice   {label:28} reversed, {info['duration']:.2f}s")

    vpk = os.path.join(OUT, "pak01_dir.vpk")
    size = dlvpk.write_vpk(vpk, payload)
    print(f"\nwrote {vpk} ({size} bytes, {len(payload)} files)")
    print("""
TEST STEPS
  1. In DMM, update/replace the "voice replace test" mod with this VPK
     (or disable the old one and add this as a new local mod).
  2. Launch the game and go no further than the main menu.
  3. Quit, then check console.log for these two lines:
        Failed loading resource "scripts/ai_lod.vdata_c"
        Failed loading resource "scripts/npc_squad_modes.vdata_c"
     GONE or CHANGED -> the engine reads our VPK. STILL IDENTICAL -> it does not.
  4. Open the hero picker and click Haze several times. Every select line
     should now be DYNAMO's voice. (All 10 variants were replaced.)
  5. In a match/sandbox as Haze: thanks ping and death lines play BACKWARDS.
""")


if __name__ == "__main__":
    main()
