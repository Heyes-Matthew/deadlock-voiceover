"""Split and splice Deadlock .vsnd_c voice assets.

Layout of a Deadlock VO .vsnd_c (verified against shipped assets):

    [0:4]        uint32 = size of the resource metadata, i.e. the offset
                 where the audio payload begins
    [4:8]        uint16 header version (12), uint16 resource version (5)
    [8:16]       block table offset / count
    blocks       RED2 (editing info) and CTRL (binary KV3 holding
                 _class=CVoiceContainerDefault, m_nRate, Format, Channels,
                 SampleCount, flDuration, StreamingSize, seek table...).
                 DATA is present but empty for VO assets.
    [meta:]      a plain MP3 file (LAME 3.100, 44.1 kHz mono for VO)

The size field covers metadata only, not the payload, so swapping the payload
does not require touching the header. Fields inside CTRL that describe the
audio (SampleCount / flDuration / StreamingSize / seek table) DO go stale --
that is what the splice probe exists to measure.
"""
import struct, subprocess, json


def meta_size(data: bytes) -> int:
    return struct.unpack("<I", data[:4])[0]


def split(data: bytes):
    """-> (metadata_bytes, mp3_bytes)"""
    n = meta_size(data)
    return data[:n], data[n:]


def strip_id3(mp3: bytes) -> bytes:
    """Drop a leading ID3v2 tag. Shipped payloads start on a frame sync and
    encoders love to prepend tags, so normalise before splicing."""
    if mp3[:3] != b"ID3":
        return mp3
    # syncsafe 28-bit size in bytes 6..10, not counting the 10-byte header
    b = mp3[6:10]
    size = (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]
    return mp3[10 + size:]


def splice(original: bytes, new_mp3: bytes) -> bytes:
    """Original asset's metadata + a different MP3 payload."""
    meta, _ = split(original)
    new_mp3 = strip_id3(new_mp3)
    if not (new_mp3[0] == 0xFF and (new_mp3[1] & 0xE0) == 0xE0):
        raise ValueError("payload does not start on an MP3 frame sync")
    return meta + new_mp3


def blocks(data: bytes):
    """-> {name: (absolute_offset, size)}"""
    bo, bc = struct.unpack("<II", data[8:16])
    pos, out = 8 + bo, {}
    for _ in range(bc):
        name = data[pos:pos + 4].decode()
        off, size = struct.unpack("<II", data[pos + 4:pos + 12])
        out[name] = (pos + 4 + off, size)
        pos += 12
    return out


def probe_mp3(path):
    """ffprobe summary of an mp3 on disk."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams",
         "-of", "json", path], capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    return {
        "duration": float(j["format"]["duration"]),
        "rate": int(s["sample_rate"]),
        "channels": int(s["channels"]),
        "bitrate": int(j["format"].get("bit_rate", 0)),
    }


# --- CTRL field patching -------------------------------------------------
# The CTRL block is binary KV3 v5 ("\x053VK"). Writing a real KV3 encoder is a
# big job, but the numeric fields we care about appear as plain little-endian
# values in the block, so they can be patched in place without changing its
# length. Each field is only patched when its current value occurs EXACTLY once
# in the block -- otherwise we would be guessing which copy is the real one.

def find_unique(buf: bytes, pattern: bytes):
    i = buf.find(pattern)
    if i < 0 or buf.find(pattern, i + 1) >= 0:
        return None
    return i


def patch_ctrl(asset: bytes, new_mp3: bytes, new_info: dict, old_info: dict):
    """Splice new_mp3 in AND update CTRL's description of the audio.

    Returns (new_asset_bytes, {field: 'patched'|'ambiguous'}).
    """
    import struct as _s
    meta, old_mp3 = split(asset)
    new_mp3 = strip_id3(new_mp3)
    off, size = blocks(asset)["CTRL"]
    ctrl = bytearray(meta[off:off + size])
    status = {}

    # StreamingSize: byte length of the payload
    i = find_unique(bytes(ctrl), _s.pack("<I", len(old_mp3)))
    if i is None:
        status["StreamingSize"] = "ambiguous"
    else:
        ctrl[i:i + 4] = _s.pack("<I", len(new_mp3))
        status["StreamingSize"] = "patched"

    # SampleCount: nearest uint32 to duration*rate
    old_samples = round(old_info["duration"] * old_info["rate"])
    hit = None
    for cand in range(old_samples - 2048, old_samples + 2048):
        j = find_unique(bytes(ctrl), _s.pack("<I", cand))
        if j is not None and abs(cand - old_samples) < 2048:
            hit = (j, cand)
            break
    if hit is None:
        status["SampleCount"] = "ambiguous"
    else:
        j, _ = hit
        ctrl[j:j + 4] = _s.pack("<I", round(new_info["duration"] * new_info["rate"]))
        status["SampleCount"] = "patched"

    # flDuration: a float close to the known duration
    cands = []
    for k in range(len(ctrl) - 4):
        v = _s.unpack_from("<f", ctrl, k)[0]
        if abs(v - old_info["duration"]) < 0.02:
            cands.append(k)
    if len(cands) != 1:
        status["flDuration"] = "ambiguous"
    else:
        ctrl[cands[0]:cands[0] + 4] = _s.pack("<f", new_info["duration"])
        status["flDuration"] = "patched"

    patched_meta = bytearray(meta)
    patched_meta[off:off + size] = ctrl
    return bytes(patched_meta) + new_mp3, status
