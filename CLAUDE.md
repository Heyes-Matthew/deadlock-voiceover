# Deadlock Voiceover Replacement Mod

A simple audio mod for Valve's **Deadlock** that swaps shipped voice lines for custom
recordings. Output is a single `pak01_dir.vpk` installed into the game's addons folder.

## Hard scope constraint

**This mod only replaces existing voice lines. It never adds new ones.**

Every custom clip takes the exact path and filename of a shipped clip, one for one. That
means:

- No `.vsndevts` files are edited or shipped. Ever.
- No new asset paths, no extra entries in any `vsnd_files` array, no new sound events.
- The line count per event is fixed by the game; a replacement set is a subset of the
  originals, never a superset.

If a change seems to need a soundevent edit, the change is out of scope — stop and pick a
different approach (e.g. replace a different existing line) rather than adding one.

Work happens **en masse** — hundreds of clips at a time, scripted. Any workflow that needs
a human to click through one file at a time is a non-starter, which is what rules out the
browser tools.

## Environment (verified on this machine)

| Thing | Path |
| --- | --- |
| Project root | `/mnt/d/Documents/Programming/deadlock-voiceover-mod` (also `~/programming/deadlock-voiceover-mod`, a symlink to the same place) |
| Game install | `/mnt/e/Steam/steamapps/common/Deadlock` |
| Game content root | `<game>/game/citadel` |
| Shipped assets | `<game>/game/citadel/pak01_dir.vpk` + `pak01_###.vpk` chunks |
| Addons (mods live here) | `<game>/game/citadel/addons` |
| Engine binaries | `<game>/game/bin/win64` |

- WSL2 on Windows; the game itself runs on the Windows side. Windows-only tools
  (Source2Viewer GUI, CSDK, Deadlock Mod Manager) are launched from Windows, not bash.
- `gameinfo.gi` is **already patched** by Deadlock Mod Manager to mount `citadel/addons`
  (original kept as `gameinfo.gi.bak`). Do not re-patch it; check the `SearchPaths`
  block first if addon loading breaks after a game update.
- Deadlock Mod Manager is installed and tracks enabled mods in
  `<game>/game/citadel/addons/.dmm.json`. There is already one addon VPK in that folder
  (a HUD mod) — do not overwrite it; ship this mod as its own distinctly-named VPK.
- `resourcecompiler.exe` is **not shipped** with Deadlock (only `resourcecompiler.dll`),
  so compiling `.vsnd` requires external community tooling (see Toolchain).
- Available in WSL: `python3`, `ffmpeg`. Not installed: `vpk`, `Source2Viewer-CLI`.

## How Deadlock voice audio is laid out

Verified by parsing `pak01_dir.vpk` (79,305 `.vsnd_c` entries total):

- **Voice clips**: `sounds/vo/<hero>/<line_name>.vsnd_c`
  - ~40 hero folders (`astro`, `haze`, `wraith`, `bebop`, …), 900–2200 clips each.
  - Clips nest in per-category subfolders: `sounds/vo/haze/ping/…`, `…/haze/emote/…`,
    with others sitting directly in the hero folder. **Resolve targets by basename against
    the VPK index rather than assuming a path.**
  - Announcer/patron lines: `sounds/vo/announcer/female_patron/…`,
    `sounds/vo/announcer/male_patron/…`, named
    `patron_{male|female}_{ally|enemy}_{hero}_{action}_{NN}.vsnd_c`.
  - NPC voices live outside `sounds/vo`, e.g. `sounds/npc/trooper/self_destruct/voice_NN.vsnd_c`.
- **Sound events** (`.vsndevts_c` under `soundevents/`) map a game event name to a list of
  clips, each with a `vsnd_files` array and a `vsnd_duration`. Read-only for this project —
  useful for finding *which* clips a given event plays, so you know what to replace:
  - `soundevents/vo/generated_vo_hero_<hero>.vsndevts_c` — per-hero VO events
  - `soundevents/vo/announcer.vsndevts_c`, `soundevents/vo/generated_vo_misc.vsndevts_c`
  - `soundevents/generated_vo_hero_death_vo.vsndevts_c`, `…_hero_pick_vo.vsndevts_c`
- **Hero codenames differ from display names.** Examples: Haze→`haze`, Seven→`gigawatt`,
  Infernus→`inferno`, Abrams→`atlas`, Lady Geist→`ghost`, Ivy→`tengu`, Bebop→`bebop`,
  Grey Talon→`orion`, Mo & Krill→`krill`, Paradox→`chrono`, Vindicta→`hornet`,
  Pocket→`synth`, McGinnis→`forge`, Calico→`nano`, Dynamo→`dynamo`, Lash→`lash`.
  **Always confirm a codename by listing `sounds/vo/` rather than guessing.**

## `.vsnd_c` file format (verified by taking shipped assets apart)

    [0:4]     uint32  size of the resource metadata = offset where audio begins
    [4:8]     uint16 header version (12), uint16 resource version (5)
    [8:16]    block table offset / count
    blocks    RED2  editing info (input deps, source .mp3 name, search path)
              DATA  present but EMPTY for VO assets
              CTRL  binary KV3: _class=CVoiceContainerDefault, m_nRate, Format,
                    Channels, SampleCount, LoopStart, flDuration, StreamingSize,
                    seek table, encodedHeader, m_Sentences
    [meta:]   a plain MP3 file — LAME 3.100, 44.1 kHz mono for VO

Metadata runs ~1976–3130 bytes across sampled clips. The size field covers metadata only,
**not** the payload, so swapping audio does not require touching the header.

Valve's own pipeline was MP3-in: the source filename is still embedded in RED2
(`haze_ally_astro_bounce_pad_01.mp3`), alongside a dependency on `sounds/encoding.txt`.

Consequence: **extracting all ~79k VO clips to MP3 is pure Python**, no external tools.
Read the VPK directory, read the 4-byte size, slice the tail. Confirmed with ffprobe.

## How a replacement works

Put the new clip at the *same path and filename* as the original inside the addon VPK; it
shadows the shipped asset at load time. Nothing else is required — the game keeps using its
own soundevent definitions.

Because `vsnd_duration` in the (unmodified) event still governs timing, **keep each new clip
at or under the original's length**. A longer clip gets cut off or overlaps whatever the
event does next; a much shorter one leaves dead air. Decode the original first and match it.

### RESOLVED: splicing works, no CTRL patching required

**Probe 3 (2026-09-22): all 10 Haze select lines played as Dynamo, including the raw
splice group.** Splicing a different MP3 onto a shipped asset's metadata is a valid way to
replace VO. Nothing needs compiling.

Lines 01-05 were spliced with CTRL left completely untouched, including one case that put a
0.99s Dynamo clip into a 2.46s Haze container — a 2.5x duration mismatch. It played as
Dynamo. So `StreamingSize`, `SampleCount`, `flDuration` and the seek table in CTRL are
**not** load-bearing for playback; the engine reads the MP3 stream itself.

Practical consequences:

- **The pipeline is pure Python + ffmpeg.** No CSDK 12, no resourcecompiler, no Forge, no
  Windows tooling in the loop.
- **New clips may be shorter than the original but never longer.** Probe 3 put a 0.99s
  clip into a 2.46s container and it played; going the other way is silent (see below).
  Probe 3 only ever tested shorter clips, which is why this took a real build to find.
- `vsnd.patch_ctrl()` is kept but is **off by default** (`--patch` turns it on). It finds
  fields by searching CTRL for the old value's bytes, which is a guess, not a parse: the
  `SampleCount` search accepts any unique uint32 within ±2048 of the expected count and
  the `flDuration` search any unique float within 0.02s, so both can land on an unrelated
  field (a seek-table entry, a loop point). On the first Abrams build it wrote a float in
  `atlas_select_02` that no other clip had. Raw splice is the configuration probe 3
  verified; use it.
- **A take longer than the line it replaces plays SILENT.** Confirmed on the first Abrams
  build: `atlas_select_02` (1.91s replaced by 2.01s) and `_05` (1.88s by 1.96s) were the
  silent lines; the three shorter ones played. CTRL still describes the original stream
  and the engine believes it. Both tools enforce this now:
  - the recorder app reads each line's length from the shipped MP3's frame headers, draws
    it as the width of the record canvas, stops recording at the end and hard-caps the
    rendered WAV. Its budget is `original − 60ms` (`MARGIN` in `app.js`) because MP3
    rounds up.
  - `build_mod.py` cuts each source to the original's length, then walks the cut back
    until the *encoded* duration is inside it (~26ms frames plus LAME delay overshoot a
    plain `-t` cut), then steps the bitrate down (128 → 112 → … → 48) if the payload is
    still larger in bytes. Every take it had to cut is listed at the end of the build.
    `--no-fit` opts out, for experiments only.

### How the conclusion was reached (do not redo this work)

| probe | question | result |
| --- | --- | --- |
| 1 | does a spliced replacement play? | inconclusive — only `_01` of each variant group was replaced, so the trigger usually picked an untouched file |
| 2 canary | does the engine read our VPK? | **yes** — two startup `Failed loading resource` lines vanished from `console.log` |
| 2 verbatim | do VO paths resolve and shadow? | **yes** — 10/10 select lines became Dynamo |
| 2 splice | does a spliced payload play? | no change heard, but the test was reversed grunts on hard-to-trigger lines — an unreliable signal, not evidence |
| 3 | splice, on a known-good trigger, unmistakable change | **yes, 15/15 Dynamo**, raw and patched alike |
| Abrams 1 | 5 real takes, CTRL patched | 3 played, **2 silent** — the 2 were the only ones longer than the line they replaced |
| Abrams 2 | raw splice, every take cut to fit | **both played**, including one cut back 65ms from over-length — confirms the length rule and the fix |

Lessons that generalise:
- **Replace every variant in a group.** `haze_select` has 10, `haze_pain_death` 6. Testing
  one variant means the trigger usually plays an untouched file.
- **Pick a change that cannot be misheard.** A different character's voice beats reversed
  audio; reversed grunts sound like grunts.
- **Pick a trigger you control.** The hero picker fires select lines on demand; death lines
  and pings need a match.
- **`console.log` answers infrastructure questions without gameplay** — it lists the whole
  mounted search path at startup and every failed resource load.

## Toolchain

- **`scripts/dlvpk.py`** (in-repo) — reads the game's multi-chunk `pak01_dir.vpk` +
  `pak01_NNN.vpk` set, and writes a single self-contained addon VPK v2 with all data
  inline. Header layout mirrors the addon VPK already installed and loading in this game
  (`archiveMD5=0`, `otherMD5=48`, no signature section). Roundtrip-verified.
- **`scripts/vsnd.py`** (in-repo) — split a `.vsnd_c` into metadata + MP3, splice a new
  payload in, read the block table, ffprobe an MP3. Strips ID3 tags, since shipped
  payloads begin on a frame sync.
- **`ffmpeg`** (WSL) — decode/encode/trim. Note `-id3v2_version 0` is the flag that
  actually suppresses the tag; `-write_id3v2 0` does **not** work here.
- **Deadlock Mod Manager** — installs the built VPK into `addons/`, tracks it in `.dmm.json`.
- **CSDK 12** (community Citadel SDK) — **not needed.** Probe 3 showed splicing works, so
  nothing in this project compiles resources. Listed only so it isn't re-proposed.
- **Deadlock Forge** (`deadlockforge.net/sound`) — browser-only, no local build, no CLI, no
  public source. One file at a time through a web UI, and it uploads your audio to a third
  party. **Not usable for bulk work.** Listed here so it doesn't get re-proposed.

## Suggested project layout

```
scripts/
  dlvpk.py       VPK v2 read (game's chunked set) + write (single addon VPK)
  vsnd.py        .vsnd_c split / splice / CTRL patching / ffprobe
  extract_vo.py  bulk-dump shipped VO to originals/ as MP3
  build_mod.py   source/ -> build/<name>/pak01_dir.vpk   ← the pipeline
  build_recorder.py  inline recorder/ into one distributable HTML file
  probe*.py      the three format investigations; kept as a record, not part of a build
recorder/      the voice actors' browser app (index.html + app.js, dist/ = what you send)
originals/     extracted shipped clips, path-mirrored: sounds/vo/<hero>/…
source/        replacement audio, same paths, any ffmpeg-readable extension
build/         generated output; each build gets its own subfolder + manifest.json
packed/        <name>.tsv — the committed record of which lines are done
```

## Recording kit (for the voice actors)

`recorder/` is a browser app handed to whoever records the lines. Built to one
self-contained file:

```bash
python3 scripts/build_recorder.py   # -> recorder/dist/deadlock-vo-recorder.html (51 KB)
```

**It ships no audio.** Everyone recording has Deadlock installed, so the app parses
*their* `pak01_dir.vpk` in JavaScript and slices the MP3 payloads out of the chunk
archives by byte range. One file to send, always matching their game version, nothing
uploaded anywhere. (Shipping the clips instead would have meant 2.19 GB / 69,228 files.)

- `recorder/index.html` + `recorder/app.js` are the sources; `dist/` is the artifact to send.
- The JS VPK reader is verified against `scripts/dlvpk.py`: same 130,731 entries and
  identical archive/offset/length. Keep them in step if either changes.
- Covers all 48 VO groups — every hero, both patrons, the jar, the shopkeeper, the
  newscaster and the gremlin. `announcer` is split into two groups (Patron (Female) /
  Patron (Male)) so each is one voice for one actor.
- **The UI shows in-game names, never codenames.** Hardcoded English maps in `app.js`:
  `GROUP_NAMES` (speaker, e.g. `gigawatt` → Seven, `bookworm` → Paige, `frank` → Victor)
  and `CAT_LABELS` + `CAT_ALIAS`/`PING_ALIAS`/`EMOTE_ALIAS`/`PATRON_ALIAS` (categories,
  e.g. `t1`/`t2`/`ap`/`hotdog` → "Shop & Reminders"). Unmapped tokens fall back to a
  tidied form of the token, so a game update that adds lines degrades gracefully rather
  than breaking. `GROUP_NAMES` was taken from the game's own
  `resource/localization/citadel_gc_hero_names/citadel_gc_hero_names_english.txt`
  (`"hero_<codename>:n" "<display name>"`) — **re-read that file rather than guessing**
  when a hero is added. The one ambiguity: both `chrono` and `paradox` are Paradox;
  `chrono` (1585 clips) is labelled Paradox and `paradox` (777) "Paradox (alt set)".
- Categories are derived from filename conventions: the subfolder (`ping`, `emote`,
  `female_patron`) then the first token after the speaker prefix. Pings are the bulk of
  the corpus (36,694 clips) so they are subdivided further — teammate status, careful,
  enemy spotted, cooldowns, requests, tactics, social.
- Takes are recorded raw (echo cancellation, noise suppression and auto gain all off),
  normalised to 44.1 kHz mono 16-bit WAV via `OfflineAudioContext`.
- **The record canvas is the length budget.** Its full width is the original line's
  length, the wave fills left to right as you speak, there's a mark at 80%, and recording
  stops itself at the end. `mp3Duration()` gets the limit from the shipped MP3's frame
  headers — verified against ffprobe on 13 clips, matching to 4 decimal places.
- **Setup is two folders: the game, then an output folder for the takes.** Each take is
  written into the output folder the moment recording stops, so there is no export step
  and nothing is lost if the browser closes. On a later visit that folder is re-scanned
  (`scanOutput()`): any `.wav` whose unflattened name matches a real VPK asset is marked
  done and can be played back, re-recorded or deleted exactly like a take made that
  session. Files that don't match an asset are ignored, so a shared folder is harmless.
  Only a tiny `{duration, at}` record stays in IndexedDB, for the take-length badge.
- A page **cannot** save to the folder it was launched from — it has no idea what that
  folder is, and `file://` pages get no write access. Every write goes through a handle
  granted by a picker. Picking the folder once and remembering the handle is as close as
  the platform allows; don't re-propose auto-saving next to the HTML file.
- Without the File System Access API (Firefox, or `file://` where Chrome refuses the
  picker) the app falls back to keeping takes in IndexedDB and exporting a ZIP. **Export**
  then still exists; with an output folder it just reports where the files are and
  flushes anything stranded in browser storage.
- **Folders are located once, not once per session.** Both the game folder and the
  output folder are handled the same way: the picked
  `FileSystemDirectoryHandle` is kept in IndexedDB (a cookie cannot hold one — it stores
  strings, and a path string would be useless without the permission that comes with the
  handle). On a later visit the app reopens it silently if permission survived, otherwise
  offers a single "Reopen <folder>" click (the output folder needs `readwrite`, the game folder only `read`). A stale or revoked handle is forgotten and the
  normal picker returns. Browsers without the File System Access API fall back to the
  directory input, whose `File` objects cannot be persisted at all.
- Export writes straight into a folder the actor picks (File System Access API) or falls
  back to a ZIP download. Both paths are also the fallback for each other, since the
  directory API is refused on `file://` in some browsers.
- **Exported filenames are the flattened asset path**: `sounds/vo/haze/haze_select_01.vsnd_c`
  comes back as `sounds~vo~haze~haze_select_01.wav`. Basenames alone would not do — 93 of
  them collide across the corpus.

## The pipeline

```bash
python3 scripts/extract_vo.py --hero haze          # originals/ as reference MP3s
#   ...put replacement audio at source/sounds/vo/haze/<clip>.<wav|mp3|flac|…>
python3 scripts/build_mod.py --name haze_pack      # build/haze_pack/pak01_dir.vpk
```

Returned takes need no sorting: unzip an actor's folder anywhere under `source/` and
build. `build_mod.py` reads flattened names as well as mirrored paths, so
`source/from_alex/sounds~vo~haze~haze_select_01.wav` resolves on its own.

Every build also writes `packed/<name>.tsv`: one sorted, tab-separated line per packed
asset with the sha256 of the source audio, the durations and whether the take had to be
cut. It is the one generated file that belongs in git — deterministic, no timestamps, so
an unchanged rebuild produces an identical file and `git diff` shows exactly which lines
were added or re-recorded. Everything else under `build/` is ignored.

`build_mod.py` matches each source file to the shipped asset at the same path, re-encodes
it to that clip's rate/channels/bitrate (dropping the bitrate if needed so the payload
fits inside the original's byte count), splices, and packs. It refuses
nothing silently: unmatched source paths are listed, and **incomplete variant groups are
reported** (`haze_select_NN: 3/10 replaced`) because a half-covered group still plays
originals at random.

Mirror the in-game path under `source/` for every clip. Path-and-name exactness is what
makes replacement work; a typo silently does nothing.

## Verified about installing

- DMM accepts local VPKs: drag and drop under **Add Mods**, plus **Analyze Local Addons**
  to adopt files already in the folder. It renumbers to the next free `pakNN_dir.vpk` and
  records the mod in `addons/.dmm.json` and its own `state.json`.
- Its `gamePath` here is `E:\Steam\steamapps\common\Deadlock`; `ingestToolEnabled` is on.
- Prefer DMM over hand-copying: its VPK manifest is the single owner of installed files,
  and a file it doesn't know about can be clobbered by its cleanup.
- `console.log` in `game/citadel/` is the best diagnostic on this install — it lists the
  full mounted search path at startup and every failed resource load.

## Testing

1. Build the VPK and install it into `<game>/game/citadel/addons` under a name that does
   not collide with the HUD mod already there (via Mod Manager, or copied in directly).
2. Launch Deadlock, open console (needs `-console` / dev console enabled).
3. Trigger a clip. Console: `play sounds/vo/<hero>/<line>.vsnd` or
   `snd_sos_start_soundevent <event_name>` — *neither verified yet on this install.*
   In-game without console: the thanks ping fires `haze_ping_thanks` directly, which is
   why the probe uses it for case A.
4. If nothing changes: confirm the addon VPK is enabled in `.dmm.json`, confirm
   `SearchPaths` in `gameinfo.gi` still lists `Game citadel/addons`, and re-check the
   asset path spelling against the VPK listing.

## Conventions and cautions

- Audio mods are client-side and cosmetic; they do not affect other players.
- Game updates can rewrite `gameinfo.gi` and change asset paths — re-verify after patches.
- Never edit files inside the game's own `pak01_*.vpk`; ship changes as an addon VPK only.
- Never ship a `.vsndevts` and never introduce a path that isn't already in the shipped VPK
  — see the scope constraint at the top.
- Use only audio you have the rights to. Shipped Valve VO stays in `originals/` as local
  reference and is not redistributed.
- Working in WSL: game paths are under `/mnt/e/...`; keep scratch work in the project, and
  only write into the game directory when installing a build.
