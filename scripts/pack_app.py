#!/usr/bin/env python3
"""Pack the recorder into one archive to send to a voice actor.

    python3 scripts/pack_app.py
    -> dist/deadlock-vo-recorder.zip

Rebuilds the single-file app first, then zips it with a plain-text readme so
the archive explains itself without a covering message. Timestamps inside the
zip are fixed, so packing unchanged sources twice produces an identical file.
"""
import argparse, os, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "recorder", "dist", "deadlock-vo-recorder.html")
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)

README = """Deadlock VO Recorder
====================

Recording replacement voice lines for a Deadlock voice pack. Everything runs
on your machine -- nothing is uploaded anywhere, and no audio ships with this
file. The app reads the game's own voice lines straight out of your Deadlock
install so you can hear the original before recording over it.

Its one and only network request fetches the list of lines already recorded by
other people, from the project's public repository. Nothing about you is sent,
and the app works fine without it.

You need: Deadlock installed, Chrome or Edge, and a microphone.


Getting started
---------------

1. Open deadlock-vo-recorder.html (double-click it, or drag it into Chrome).

2. Choose your Deadlock folder -- the one containing "game". In Steam:
   right-click Deadlock -> Manage -> Browse local files.

3. Choose a folder for your recordings. An empty one is easiest. Every take is
   saved there the moment you stop recording.

4. Pick a character in the sidebar, then a category, then a line. Press Space
   to hear the original, R to record, P to hear your take.

Both folders are remembered, so next time you open the app it picks up where
you left off -- and any recordings already in your output folder show up as
done, ready to play back or redo.

The dot next to each line says where it stands: green means you have recorded
it, yellow means someone else already did and it is in the voice pack, and
grey means nobody has. There is no harm in recording a yellow one, but the
grey ones are where the work is. The yellow marks come from the project repo
each time you open the app, so they stay current even for an old copy -- and
if you're offline it falls back to the list built into the file.


The time limit matters
----------------------

Each line has a hard limit: the length of the original. The wave display is
that length -- the space to the right of the wave is the room you have left,
and recording stops itself at the end.

This is not a style preference. A take longer than the line it replaces plays
as SILENCE in game. If a line feels too tight, that's the constraint; say it
faster or more economically rather than running over.


Getting a good take
-------------------

- Record somewhere quiet with soft furnishings. A bare room adds echo, and
  echo cannot be removed afterwards.
- Watch the level meter. It turning red means the take is distorted and is
  unusable -- back off the mic or turn the input gain down and go again.
- Speak at a consistent distance, roughly a hand-span from the mic.
- Don't worry about background hiss or overall volume; both are fixed later.
  Distortion, echo and one-off noises (a door, a dog, a keyboard) are not.
- Listen to the original first. Matching its energy and pacing matters more
  than matching the voice.


When you're done
----------------

Zip up your recordings folder and send it back. The filenames are what map
each take onto the right line in the game, so don't rename anything.

You don't have to finish in one sitting, and you don't have to do a whole
character. Partial is fine -- just say which parts you did.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="deadlock-vo-recorder",
                    help="archive name without .zip (default: %(default)s)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"),
                    help="where to write it (default: dist/)")
    args = ap.parse_args()

    # always pack a fresh build, so the archive can't lag the sources
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_recorder.py")],
                   check=True)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, args.name + ".zip")
    files = [("deadlock-vo-recorder.html", open(APP).read()),
             ("README.txt", README)]

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files:
            info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, text)

    print(f"\nwrote {path}  ({os.path.getsize(path)/1024:.0f} KB)")
    for name, text in files:
        print(f"  {name}  ({len(text.encode())/1024:.0f} KB)")
    print("\nSend this one file. No install needed; its only network use is"
          "\nreading the packed-lines list, and it works without that.")


if __name__ == "__main__":
    main()
