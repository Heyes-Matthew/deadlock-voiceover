"""Read and write Source 2 VPK v2 archives (Deadlock's pak01 format).

Read side targets the game's multi-chunk pak01_dir.vpk + pak01_NNN.vpk set.
Write side emits a single self-contained pak01_dir.vpk with all data inline,
mirroring the layout of addon VPKs the game is known to load.
"""
import struct, zlib, hashlib, os

SIG = 0x55AA1234
INLINE = 0x7FFF
GAME_CITADEL = "/mnt/e/Steam/steamapps/common/Deadlock/game/citadel"


class Entry:
    __slots__ = ("path", "archive", "offset", "length", "preload", "crc")

    def __init__(self, path, archive, offset, length, preload, crc):
        self.path, self.archive, self.offset = path, archive, offset
        self.length, self.preload, self.crc = length, preload, crc

    def __repr__(self):
        return f"<Entry {self.path} arc={self.archive} len={self.length}>"


def read_dir(dir_vpk):
    """Parse a *_dir.vpk directory tree. Returns {path: Entry}."""
    f = open(dir_vpk, "rb")
    sig, ver, tree_size = struct.unpack("<III", f.read(12))
    if sig != SIG:
        raise ValueError(f"not a VPK: {dir_vpk}")
    if ver == 2:
        f.read(16)  # fileData/archiveMD5/otherMD5/signature section sizes

    def rstr():
        b = bytearray()
        while True:
            c = f.read(1)
            if c in (b"\x00", b""):
                return b.decode("utf8", "replace")
            b += c

    out = {}
    while True:
        ext = rstr()
        if not ext:
            break
        while True:
            path = rstr()
            if not path:
                break
            while True:
                name = rstr()
                if not name:
                    break
                crc, pre, arc, off, ln, _term = struct.unpack("<IHHIIH", f.read(18))
                pd = f.read(pre) if pre else b""
                full = f"{name}.{ext}" if path in ("", " ") else f"{path}/{name}.{ext}"
                out[full] = Entry(full, arc, off, ln, pd, crc)
    f.close()
    return out


def read_file(entry, base=GAME_CITADEL, prefix="pak01"):
    """Pull one entry's bytes, following it into the right archive chunk."""
    if entry.archive == INLINE:
        with open(os.path.join(base, f"{prefix}_dir.vpk"), "rb") as f:
            sig, ver, tree_size = struct.unpack("<III", f.read(12))
            data_start = 12 + (16 if ver == 2 else 0) + tree_size
            f.seek(data_start + entry.offset)
            return entry.preload + f.read(entry.length)
    arc = os.path.join(base, f"{prefix}_{entry.archive:03d}.vpk")
    with open(arc, "rb") as f:
        f.seek(entry.offset)
        return entry.preload + f.read(entry.length)


def _split(path):
    """'sounds/vo/haze/x.vsnd_c' -> ('vsnd_c', 'sounds/vo/haze', 'x')"""
    d, _, base = path.replace("\\", "/").rpartition("/")
    name, _, ext = base.rpartition(".")
    if not name:  # no extension
        name, ext = base, " "
    return ext, d if d else " ", name


def write_vpk(out_path, files):
    """Write a single-file VPK v2. `files` is {archive_path: bytes}."""
    tree = {}
    for path, data in files.items():
        ext, d, name = _split(path)
        tree.setdefault(ext, {}).setdefault(d, []).append((name, data))

    blob = bytearray()
    offsets = {}
    for ext in tree:
        for d in tree[ext]:
            for name, data in tree[ext][d]:
                offsets[(ext, d, name)] = len(blob)
                blob += data

    t = bytearray()

    def wstr(s):
        t.extend(s.encode("utf8") + b"\x00")

    for ext in sorted(tree):
        wstr(ext)
        for d in sorted(tree[ext]):
            wstr(d)
            for name, data in sorted(tree[ext][d]):
                wstr(name)
                t.extend(struct.pack(
                    "<IHHIIH", zlib.crc32(data) & 0xFFFFFFFF, 0, INLINE,
                    offsets[(ext, d, name)], len(data), 0xFFFF))
            t.extend(b"\x00")
        t.extend(b"\x00")
    t.extend(b"\x00")

    tree_md5 = hashlib.md5(bytes(t)).digest()
    arc_md5 = hashlib.md5(b"").digest()
    header = struct.pack("<7I", SIG, 2, len(t), len(blob), 0, 48, 0)
    body = header + bytes(t) + bytes(blob)
    whole = hashlib.md5(body + tree_md5 + arc_md5).digest()
    with open(out_path, "wb") as f:
        f.write(body + tree_md5 + arc_md5 + whole)
    return len(body) + 48
