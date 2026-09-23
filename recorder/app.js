/* Deadlock VO Recorder — reads voice lines out of the player's own Deadlock
   install, records replacement takes, exports them named so the packing script
   can map each one back to the asset it replaces.

   Everything stays on the machine: the game files are read locally, takes live
   in IndexedDB until exported. No network calls at all. */

const $ = s => document.querySelector(s);
const SAMPLE_RATE = 44100;

/* ------------------------------------------------------------------ VPK */
/* Source 2 VPK v2 directory. Entries point into pak01_NNN.vpk chunks, which we
   read by byte range so nothing large is ever loaded whole. */
class Vpk {
  constructor(files) { this.files = files; this.entries = new Map(); }

  static async open(files) {
    const v = new Vpk(files);
    const dir = files.get('pak01_dir.vpk');
    if (!dir) throw new Error('pak01_dir.vpk not found in that folder');
    await v.readTree(await dir.arrayBuffer());
    return v;
  }

  async readTree(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (dv.getUint32(0, true) !== 0x55aa1234) throw new Error('not a VPK file');
    const version = dv.getUint32(4, true);
    let p = 12 + (version === 2 ? 16 : 0);
    const treeStart = p;
    const str = () => { let s = ''; while (u8[p]) s += String.fromCharCode(u8[p++]); p++; return s; };

    for (;;) {
      const ext = str(); if (!ext) break;
      for (;;) {
        const dir = str(); if (!dir) break;
        for (;;) {
          const name = str(); if (!name) break;
          const preload = dv.getUint16(p + 4, true);
          const archive = dv.getUint16(p + 6, true);
          const offset = dv.getUint32(p + 8, true);
          const length = dv.getUint32(p + 12, true);
          p += 18 + preload;
          const path = (dir === ' ' ? '' : dir + '/') + name + '.' + ext;
          this.entries.set(path, { archive, offset, length });
        }
      }
    }
    // inline entries (archive 0x7fff) are stored after header+tree
    this.inlineBase = treeStart + (new DataView(buf)).getUint32(8, true);
  }

  async read(path) {
    const e = this.entries.get(path);
    if (!e) throw new Error('missing ' + path);
    const file = e.archive === 0x7fff
      ? this.files.get('pak01_dir.vpk')
      : this.files.get(`pak01_${String(e.archive).padStart(3, '0')}.vpk`);
    if (!file) throw new Error('missing archive chunk for ' + path);
    const base = e.archive === 0x7fff ? this.inlineBase : 0;
    return file.slice(base + e.offset, base + e.offset + e.length).arrayBuffer();
  }

  /* A .vsnd_c is metadata then a plain MP3; the first uint32 says where it starts. */
  async readMp3(path) {
    const buf = await this.read(path);
    const meta = new DataView(buf).getUint32(0, true);
    return new Blob([buf.slice(meta)], { type: 'audio/mpeg' });
  }
}

/* ------------------------------------------------- locating the install */
async function filesFromDirHandle(root) {
  // accept the Deadlock root, game/, or citadel/ itself
  const tryDirs = async (h, names) => {
    for (const n of names) { try { h = await h.getDirectoryHandle(n); } catch { return null; } }
    return h;
  };
  let citadel = null;
  for (const path of [[], ['citadel'], ['game', 'citadel']]) {
    const h = path.length ? await tryDirs(root, path) : root;
    if (!h) continue;
    try { await h.getFileHandle('pak01_dir.vpk'); citadel = h; break; } catch { }
  }
  if (!citadel) throw new Error(
    'Could not find game/citadel/pak01_dir.vpk under that folder.\n' +
    'Pick the Deadlock folder itself (the one containing "game").');

  const files = new Map();
  for await (const [name, handle] of citadel.entries()) {
    if (handle.kind === 'file' && /^pak01_(dir|\d{3})\.vpk$/.test(name)) {
      files.set(name, await handle.getFile());
    }
  }
  return files;
}

function filesFromInput(list) {
  const files = new Map();
  for (const f of list) {
    const rel = f.webkitRelativePath || f.name;
    const m = rel.match(/(?:^|\/)citadel\/(pak01_(?:dir|\d{3})\.vpk)$/);
    if (m) files.set(m[1], f);
  }
  if (!files.has('pak01_dir.vpk')) throw new Error(
    'No game/citadel/pak01_dir.vpk in that folder.\n' +
    'Pick the Deadlock folder itself (the one containing "game").');
  return files;
}

/* --------------------------------------------------------------- storage */
const DB = {
  db: null,
  async open() {
    if (this.db) return;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('dlvo-recorder', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  /* A FileSystemDirectoryHandle survives in IndexedDB (a cookie cannot hold
     one), so the folder is located once and re-opened on later visits. */
  meta(mode) { return this.db.transaction('meta', mode).objectStore('meta'); },
  putHandle(h, k = 'dir') { return new Promise(r => { const q = this.meta('readwrite').put(h, k); q.onsuccess = q.onerror = () => r(); }); },
  getHandle(k = 'dir') { return new Promise(r => { const q = this.meta('readonly').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); },
  delHandle(k = 'dir') { return new Promise(r => { const q = this.meta('readwrite').delete(k); q.onsuccess = q.onerror = () => r(); }); },
  /* Takes written to the output folder keep only a tiny record here (duration,
     timestamp) -- the audio itself lives on disk, not in the browser. */
  putTakeMeta(path, v) { return this.putHandle(v, 'take:' + path); },
  getTakeMeta(path) { return this.getHandle('take:' + path); },
  delTakeMeta(path) { return this.delHandle('take:' + path); },
  tx(mode) { return this.db.transaction('takes', mode).objectStore('takes'); },
  get(k) { return new Promise(r => { const q = this.tx('readonly').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); },
  put(k, v) { return new Promise(r => { const q = this.tx('readwrite').put(v, k); q.onsuccess = q.onerror = () => r(); }); },
  del(k) { return new Promise(r => { const q = this.tx('readwrite').delete(k); q.onsuccess = q.onerror = () => r(); }); },
  keys() { return new Promise(r => { const q = this.tx('readonly').getAllKeys(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([]); }); },
  all() { return new Promise(r => { const q = this.tx('readonly').getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([]); }); },
};

/* ------------------------------------------------------- length budget

   A take longer than the line it replaces plays as SILENCE in game: the
   asset's CTRL block still describes the original stream and the engine
   believes it. So the original's length is a hard limit, enforced here rather
   than left for the packing script to discover.

   The limit is read straight off the shipped MP3's frame headers -- no
   decoding, so it is instant as you arrow down the list. */

const MP3_RATES = [44100, 48000, 32000];
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

function mp3Duration(buf) {
  const u8 = new Uint8Array(buf);
  let i = 0, frames = 0, rate = SAMPLE_RATE;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)   // ID3v2: skip the tag
    i = 10 + ((u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9]);

  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (u8[i + 1] >> 3) & 3, layer = (u8[i + 1] >> 1) & 3;
    const bi = (u8[i + 2] >> 4) & 15, ri = (u8[i + 2] >> 2) & 3, pad = (u8[i + 2] >> 1) & 1;
    if (ver !== 3 || layer !== 1 || bi === 0 || bi === 15 || ri === 3) { i++; continue; }
    rate = MP3_RATES[ri];
    const len = Math.floor(144 * MP3_BITRATES[bi] * 1000 / rate) + pad;
    if (len < 4) { i++; continue; }
    // a Xing/Info frame is a header, not audio
    let tag = '';
    for (let k = i + 4; k < Math.min(i + 40, u8.length); k++) tag += String.fromCharCode(u8[k]);
    if (!tag.includes('Xing') && !tag.includes('Info')) frames++;
    i += len;
  }
  return frames * 1152 / rate;
}

async function origDuration(path) {
  if (S.limits.has(path)) return S.limits.get(path);
  const d = mp3Duration(await (await S.vpk.readMp3(path)).arrayBuffer());
  S.limits.set(path, d);
  return d;
}

/* The packing script re-encodes takes to MP3, and MP3 rounds up: ~26ms frames
   plus LAME's encoder delay can add ~60ms. Recording that much under the
   original keeps the end of the performance instead of having it cut off. */
const MARGIN = 0.06;
const usable = d => Math.max(0.2, d - MARGIN);

/* ------------------------------------------------------------ WAV encode */
async function toWav(blob, maxDur) {
  const ac = new AudioContext();
  const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
  await ac.close();
  // hard cap: MediaRecorder can overshoot the stop by a few ms, and a take
  // even slightly longer than the original is silent in game
  const dur = maxDur ? Math.min(decoded.duration, maxDur) : decoded.duration;
  const frames = Math.ceil(dur * SAMPLE_RATE);
  const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  const out = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(out);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, SAMPLE_RATE, true);
  dv.setUint32(28, SAMPLE_RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { blob: new Blob([out], { type: 'audio/wav' }), duration: rendered.duration };
}

/* ------------------------------------------------------------ ZIP (store) */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return u8 => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

async function makeZip(files) { // [{name, blob}]
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name), crc = CRC(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------------------------------------------------- lines already packed

   Which lines someone has already recorded and committed to the mod. Lines in
   the list get a yellow dot: done, but not by you and not in your output
   folder. Green stays reserved for takes that are actually on this machine.

   The list is packed/main.tsv in the public repo, fetched at startup so a copy
   of this app handed out weeks ago still shows what is current. The fetch is
   the only network request the app makes, it is a public raw.githubusercontent
   URL (CORS-open, so it works from file:// too), and nothing is sent -- no
   query, no identifier, just a GET. It is also allowed to fail: the list built
   into this file is the fallback, and with neither one every line simply reads
   as not recorded, which costs nothing but a duplicated take. */
const PACKED_URL =
  'https://raw.githubusercontent.com/Heyes-Matthew/deadlock-voiceover/main/packed/main.tsv';
const PACKED = [];   /* snapshot baked in by build_recorder.py, used if offline */

/* First column of a packed/*.tsv, minus the comments and the column header. */
function parsePacked(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const asset = line.split('\t')[0].trim();
    if (asset.endsWith('.vsnd_c')) out.push(asset);
  }
  return out;
}

async function fetchPacked() {
  const r = await fetch(PACKED_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const list = parsePacked(await r.text());
  if (!list.length) throw new Error('no assets listed');
  return list;
}

/* Kicked off at startup and not awaited -- the app is usable while it lands,
   and the dots repaint when it does. */
async function loadPacked() {
  try {
    S.packed = new Set(await fetchPacked());
    S.packedFrom = 'repo';
  } catch (e) {
    S.packedFrom = PACKED.length ? 'built-in' : 'none';
    console.warn('packed list: using the built-in snapshot -', e.message);
  }
  renderPackedStatus();
  refresh();
}

function renderPackedStatus() {
  const el = $('#packedStatus');
  if (!el) return;
  el.textContent =
    S.packedFrom === 'repo' ? `${S.packed.size} already in the pack` :
    S.packedFrom === 'built-in' ? `${S.packed.size} in the pack (offline — list may be out of date)` :
    S.packedFrom === 'none' ? '' : 'checking the pack…';
  el.title = S.packedFrom === 'repo'
    ? 'Live from the project repo'
    : 'Could not reach the repo; showing the list built into this file';
}

/* ------------------------------------------------------------ app state */
const S = {
  vpk: null, clips: [], groups: new Map(), group: null,
  out: null, outFiles: new Map(), limits: new Map(), limit: 0, viz: 0,
  filtered: [], sel: -1, done: new Set(), packed: new Set(PACKED), packedFrom: null,
  audio: new Audio(), recorder: null, stream: null, chunks: [], recording: false,
};

const flatName = path => path.replace(/\.vsnd_c$/, '.wav').replace(/\//g, '~');
const assetOf = file => file.replace(/\.wav$/i, '').replace(/~/g, '/') + '.vsnd_c';

/* --------------------------------------------------- output folder (takes)

   Takes are written straight into a folder the actor picks during setup. The
   handle is remembered in IndexedDB, so on a later visit the same folder is
   re-opened and re-scanned: recordings made in an earlier session come back as
   done, and play back or get redone exactly like ones made a minute ago.
   Browsers without the File System Access API (and pages opened from file://)
   keep takes in IndexedDB and export a ZIP instead. */

async function scanOutput() {
  S.outFiles = new Map();
  if (!S.out) return;
  for await (const [name, h] of S.out.entries()) {
    if (h.kind !== 'file' || !/\.wav$/i.test(name)) continue;
    const path = assetOf(name);
    if (S.vpk.entries.has(path)) S.outFiles.set(path, h);
  }
}

async function saveTake(path, blob, duration) {
  if (S.out) {
    const fh = await S.out.getFileHandle(flatName(path), { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    S.outFiles.set(path, fh);
  } else {
    await DB.put(path, { blob, duration, at: Date.now() });
  }
  try { await DB.putTakeMeta(path, { duration, at: Date.now() }); } catch { /* optional */ }
}

async function readTake(path) {
  const fh = S.outFiles.get(path);
  if (fh) { try { return await fh.getFile(); } catch { /* fall through */ } }
  const rec = await DB.get(path);
  return rec ? rec.blob : null;
}

async function deleteTake(path) {
  if (S.outFiles.has(path) && S.out) {
    try { await S.out.removeEntry(flatName(path)); } catch { /* already gone */ }
    S.outFiles.delete(path);
  }
  await DB.del(path);
  try { await DB.delTakeMeta(path); } catch { /* optional */ }
}

/* ---------------------------------------------- in-game names (English)

   Deadlock's files use internal codenames; these maps turn them into the
   names players see. Group names are taken from the game's own
   resource/localization/citadel_gc_hero_names_english.txt, so they are the
   real display names rather than guesses. Categories are our own grouping of
   the filename conventions -- a curated map, with anything unrecognised
   falling back to a tidied-up version of the token itself.               */

const GROUP_NAMES = {
  astro: 'Holliday', atlas: 'Abrams', bebop: 'Bebop', boho: 'Boho',
  bookworm: 'Paige', chrono: 'Paradox', doorman: 'The Doorman',
  drifter: 'Drifter', dynamo: 'Dynamo', familiar: 'Rem', fencer: 'Apollo',
  forge: 'McGinnis', frank: 'Victor', ghost: 'Lady Geist', gigawatt: 'Seven',
  haze: 'Haze', hornet: 'Vindicta', inferno: 'Infernus', kelvin: 'Kelvin',
  krill: 'Mo & Krill', lash: 'Lash', magician: 'Sinclair', mirage: 'Mirage',
  nano: 'Calico', necro: 'Graves', orion: 'Grey Talon',
  paradox: 'Paradox (alt set)', priest: 'Venator', punkgoat: 'Billy',
  shiv: 'Shiv', synth: 'Pocket', tengu: 'Ivy', unicorn: 'Celeste',
  vampirebat: 'Mina', viper: 'Vyper', viscous: 'Viscous', warden: 'Warden',
  werewolf: 'Silver', wraith: 'Wraith', wrecker: 'Wrecker', yamato: 'Yamato',
  // non-hero voices
  'announcer/female_patron': 'Patron (Female)',
  'announcer/male_patron': 'Patron (Male)',
  spirit_jar: 'The Jar', shopkeeper: 'Shopkeeper', newscaster: 'Newscaster',
  seasonal: 'Newscaster (Seasonal)', neutral_gremlin: 'Gremlin',
};

/* Hero tokens as they appear inside ping filenames -- both codenames and
   display-name spellings are used there, so both are listed.             */
const HERO_TOKENS = new Set([
  ...Object.keys(GROUP_NAMES),
  'abrams', 'calico', 'cadence', 'druid', 'dynano', 'fairfax', 'fortuna',
  'geist', 'graf', 'holliday', 'incubus', 'infernus', 'ivy', 'mcginnis',
  'murphy', 'operative', 'pocket', 'sandeep', 'seven', 'skyrunner', 'slork',
  'succubus', 'swan', 'trapper', 'tvspirit',
]);

/* token -> category key. Anything missing keeps its own token as the key. */
const CAT_ALIAS = {
  hs: 'select',
  revenge: 'kill', assisted: 'kill', solo: 'kill', end: 'killstreak',
  allies: 'ally', see: 'enemy', start: 'match', idols: 'idol',
  close: 'closecall', near: 'closecall',
  last: 'situational', outnumbered: 'situational', low: 'situational',
  high: 'situational', be: 'situational',
  leaving: 'movement', leave: 'movement',
  t1: 'shop', t2: 'shop', t3: 'shop', t4: 'shop', ap: 'shop', hotdog: 'shop',
  happy: 'mood', sad: 'mood', angry: 'mood', concerned: 'mood',
  surprise: 'mood', idle: 'mood',
  hero: 'tutorial', guide: 'tutorial', controls: 'tutorial',
  training: 'tutorial',
  headline: 'news', newscaster: 'news', news: 'news', seasonal: 'news',
  asleep: 'sleep', sleepy: 'sleep',
  use: 'ability', bespoke: 'ability', power: 'ability', power2: 'ability', power4: 'ability',
  dash: 'ability', hook: 'ability', storm: 'ability', catch: 'ability',
  sticky: 'ability', heal: 'ability', uppercut: 'ability', massive: 'ability',
  multi: 'ability', repeat: 'ability', no: 'ability', ult: 'ability',
  parry: 'ability', attack: 'ability', boost: 'ability', dome: 'ability',
  bad: 'ability',
};

const PING_ALIAS = {
  can: 'ping:heal', with: 'ping:with',
  use: 'ping:cooldown', ability1: 'ping:cooldown', ability2: 'ping:cooldown',
  ability3: 'ping:cooldown', ability4: 'ping:cooldown', item: 'ping:cooldown',
  health: 'ping:cooldown', refresher: 'ping:cooldown', warp: 'ping:cooldown',
  silence: 'ping:cooldown', rupture: 'ping:cooldown', stim: 'ping:cooldown',
  glitch: 'ping:cooldown', kncokdown: 'ping:cooldown', curse: 'ping:cooldown',
  decay: 'ping:cooldown', heal: 'ping:cooldown',
  need: 'ping:request', request: 'ping:request', help: 'ping:request',
  blue: 'ping:request', yellow: 'ping:request', green: 'ping:request',
  orange: 'ping:request',
  headed: 'ping:tactics', defend: 'ping:tactics', push: 'ping:tactics',
  take: 'ping:tactics', missing: 'ping:tactics', theyre: 'ping:tactics',
  they: 'ping:tactics', going: 'ping:tactics', retreat: 'ping:tactics',
  returning: 'ping:tactics', on: 'ping:tactics', meet: 'ping:tactics',
  flank: 'ping:tactics', gank: 'ping:tactics', clear: 'ping:tactics',
  press: 'ping:tactics', danger: 'ping:tactics', rejuv: 'ping:tactics',
  idols: 'ping:tactics', jar: 'ping:tactics', t1: 'ping:tactics',
  t2: 'ping:tactics', titan: 'ping:tactics', avatar: 'ping:tactics',
  enemy: 'ping:tactics', stay: 'ping:tactics', wait: 'ping:tactics',
  be: 'ping:tactics', right: 'ping:tactics', leaving: 'ping:tactics',
  lets: 'ping:tactics', no: 'ping:tactics',
  thanks: 'ping:social', thank: 'ping:social', sorry: 'ping:social',
  nice: 'ping:social', well: 'ping:social', good: 'ping:social',
  welcome: 'ping:social', nevermind: 'ping:social', negative: 'ping:social',
  affermative: 'ping:social', pre: 'ping:social', post: 'ping:social',
  henry: 'ping:variant', savannah: 'ping:variant', wolf: 'ping:variant',
  asleep: 'ping:variant', prof: 'ping:variant',
};

const EMOTE_ALIAS = {
  effort: 'emote:effort', efforts: 'emote:effort', melee: 'emote:effort',
  dash: 'emote:effort', pain: 'emote:pain', wolf: 'emote:wolf',
  henry: 'emote:variant', savannah: 'emote:variant',
};

const PATRON_ALIAS = {
  killing: 'patron:streak', urn: 'patron:objectives',
  rejuv: 'patron:objectives', rejuvinator: 'patron:objectives',
  base: 'patron:objectives', broadway: 'patron:objectives',
  greenwich: 'patron:objectives', york: 'patron:objectives',
  mid: 'patron:objectives', titan: 'patron:objectives',
  networth: 'patron:networth', update: 'patron:networth',
};

const CAT_LABELS = {
  select: 'Hero Select', unselect: 'Hero Deselect', kill: 'Kills',
  killstreak: 'Kill Streaks', melee: 'Melee Kills', dies: 'Deaths',
  ally: 'Ally Callouts', enemy: 'Enemy Callouts',
  match: 'Match Start Banter', ability: 'Ability Lines',
  upgrade: 'Ability Upgrades', desperation: 'Desperation',
  shop: 'Shop & Reminders', mood: 'Moods & Reactions', pick: 'Pickups',
  idol: 'Idols', tower: 'Towers', congrats: 'Congratulations',
  closecall: 'Close Calls', situational: 'Situational',
  movement: 'Leaving & Returning', hunt: 'Hunting',
  interrupt: 'Interruptions', koth: 'King of the Hill', win: 'Victory',
  lose: 'Defeat', tutorial: 'Tutorial & Guide', news: 'News Headlines',
  holder: 'Idol Holder', jar: 'Jar Lines', sleep: 'Sleep Lines',
  wolf: 'Wolf Form', henry: 'Henry', savannah: 'Savannah', vote: 'Voting',

  'ping:see': 'Ping · Enemy Spotted', 'ping:careful': 'Ping · Careful',
  'ping:attack': 'Ping · Attack Hero', 'ping:saw': 'Ping · Saw Hero',
  'ping:heal': 'Ping · Can Heal', 'ping:stun': 'Ping · Stun Hero',
  'ping:with': 'Ping · Grouped With', 'ping:ignore': 'Ping · Ignore Hero',
  'ping:teammate': 'Ping · Teammate Status',
  'ping:cooldown': 'Ping · Ability & Item Status',
  'ping:request': 'Ping · Requests', 'ping:tactics': 'Ping · Map & Tactics',
  'ping:social': 'Ping · Social', 'ping:variant': 'Ping · Variant Lines',

  'emote:effort': 'Efforts & Grunts', 'emote:pain': 'Pain & Death',
  'emote:wolf': 'Wolf Form Efforts', 'emote:variant': 'Variant Efforts',

  'patron:ally': 'Ally Lines', 'patron:enemy': 'Enemy Lines',
  'patron:street': 'Street Brawl', 'patron:big': 'Big Heals',
  'patron:many': 'Assists', 'patron:praise': 'Praise',
  'patron:grant': 'Boons', 'patron:tutorial': 'Tutorial',
  'patron:choose': 'Item Choice', 'patron:help': 'Help Out',
  'patron:streak': 'Killing Streaks', 'patron:match': 'Match Start',
  'patron:objectives': 'Objectives', 'patron:networth': 'Net Worth',
};

const prettify = k => k.replace(/^[a-z]+:/, '').replace(/_/g, ' ')
  .replace(/\b[a-z]/g, c => c.toUpperCase());
const groupLabel = g => GROUP_NAMES[g] || prettify(g.split('/').pop());
const catLabel = c => CAT_LABELS[c] || prettify(c);

function groupOf(path) {
  const seg = path.slice('sounds/vo/'.length).split('/');
  if (seg[0] === 'announcer' && seg.length > 2) return 'announcer/' + seg[1];
  return seg[0];
}

function categoryOf(path, group) {
  const seg = path.slice(`sounds/vo/${group}/`.length)
    .replace(/\.vsnd_c$/, '').split('/');
  const sub = seg.length > 1 ? seg[0] : '';
  let name = seg[seg.length - 1];
  const speaker = group.split('/').pop();
  if (name.startsWith(speaker + '_')) name = name.slice(speaker.length + 1);

  if (group.startsWith('announcer/')) {
    const t = name.replace(/^patron_(fe)?male_/, '').split('_')[0];
    return PATRON_ALIAS[t] || 'patron:' + t;
  }
  if (sub === 'ping' || name.startsWith('ping_')) {
    const t = name.replace(/^ping_/, '').split('_')[0];
    if (HERO_TOKENS.has(t)) return 'ping:teammate';
    return PING_ALIAS[t] || 'ping:' + t;
  }
  if (sub === 'emote') {
    const t = name.split('_')[0];
    return EMOTE_ALIAS[t] || 'emote:' + t;
  }
  const t = name.split('_')[0];
  return CAT_ALIAS[t] || t;
}

function buildIndex() {
  S.clips = [];
  for (const path of S.vpk.entries.keys()) {
    if (!path.startsWith('sounds/vo/') || !path.endsWith('.vsnd_c')) continue;
    const group = groupOf(path);
    S.clips.push({ path, group, name: path.split('/').pop().replace(/\.vsnd_c$/, ''),
                   cat: categoryOf(path, group), size: S.vpk.entries.get(path).length });
  }
  S.clips.sort((a, b) => a.path.localeCompare(b.path));
  S.groups = new Map();
  for (const c of S.clips) S.groups.set(c.group, (S.groups.get(c.group) || 0) + 1);
}

/* --------------------------------------------------------------- render */
const sortedGroups = () =>
  [...S.groups].sort((a, b) => groupLabel(a[0]).localeCompare(groupLabel(b[0])));

/* A line is covered if it has a take here (green) or is already in the pack
   (yellow). Local always wins: a take on this machine is the one that would be
   sent back, whatever the committed list says. */
const covered = path => S.done.has(path) || S.packed.has(path);
const dotClass = path =>
  S.done.has(path) ? ' done' : S.packed.has(path) ? ' packed' : '';
const dotTitle = path =>
  S.done.has(path) ? 'Recorded \u2014 saved here' :
  S.packed.has(path) ? 'Already recorded and in the voice pack' : 'Not recorded yet';

function renderGroups() {
  const host = $('#groups');
  host.innerHTML = '';
  for (const [g, n] of sortedGroups()) {
    const b = document.createElement('button');
    b.className = 'grp';
    b.setAttribute('aria-current', String(g === S.group));
    const doneN = S.clips.filter(c => c.group === g && covered(c.path)).length;
    b.innerHTML = `<span>${groupLabel(g)}</span><span class="n">${doneN ? doneN + '/' : ''}${n}</span>`;
    b.onclick = () => { S.group = g; $('#q').value = ''; refresh(); };
    host.appendChild(b);
  }
}

function applyFilter() {
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#cat').value;
  const todo = $('#todo').checked;
  S.filtered = S.clips.filter(c => {
    if (q) { if (!c.path.toLowerCase().includes(q)) return false; }
    else if (c.group !== S.group) return false;
    if (cat && c.cat !== cat) return false;
    if (todo && covered(c.path)) return false;
    return true;
  });
}

function renderCats() {
  const sel = $('#cat'), cur = sel.value;
  const cats = [...new Set(S.clips.filter(c => c.group === S.group).map(c => c.cat))]
    .sort((a, b) => catLabel(a).localeCompare(catLabel(b)));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${c}"${c === cur ? ' selected' : ''}>${catLabel(c)}</option>`).join('');
}

function renderList() {
  const host = $('#list');
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  S.filtered.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('aria-selected', String(i === S.sel));
    row.innerHTML =
      `<span class="dot${dotClass(c.path)}" title="${dotTitle(c.path)}"></span>` +
      `<span class="nm">${c.name}</span>` +
      `<span class="dur">${(c.size / 1024).toFixed(0)} KB</span>` +
      `<button class="mini">▶</button>`;
    row.onclick = e => { select(i); if (e.target.tagName === 'BUTTON') playOriginal(); };
    frag.appendChild(row);
  });
  host.appendChild(frag);
  $('#empty').classList.toggle('hide', S.filtered.length > 0);
  const mine = S.clips.filter(c => c.group === S.group);
  const total = mine.length;
  const done = mine.filter(c => S.done.has(c.path)).length;
  const packed = mine.filter(c => !S.done.has(c.path) && S.packed.has(c.path)).length;
  $('#count').textContent = `${S.filtered.length} shown · ${done}/${total} recorded` +
    (packed ? ` · ${packed} already in the pack` : '');
  $('#prog i').style.width = total ? ((done + packed) / total * 100) + '%' : '0';
}

function refresh() { $('#who').textContent = groupLabel(S.group); renderCats(); applyFilter(); if (S.sel >= S.filtered.length) S.sel = -1; renderGroups(); renderList(); renderPanel(); }

async function renderPanel() {
  const c = S.filtered[S.sel];
  $('#pName').textContent = c ? c.name : 'Select a line';
  $('#pPath').textContent = c ? c.path : '—';
  if (!S.recording) {
    const orig = c ? await origDuration(c.path) : 0;
    if (c !== S.filtered[S.sel]) return;   // selection moved while we read
    const limit = orig ? usable(orig) : 0;
    S.limit = limit;
    $('#vizLimit').textContent = orig
      ? `original ${orig.toFixed(2)}s — record up to ${limit.toFixed(2)}s`
      : '';
    $('#vizTime').textContent = limit ? '0.00s' : '—';
    $('#vizTime').className = '';
    vizIdle(limit);
  }
  const has = c && S.done.has(c.path);
  $('#playMine').disabled = !has;
  $('#del').disabled = !has;
  $('#play').disabled = !c;
  $('#record').disabled = !c;
  const badge = $('#tookBadge');
  if (has) {
    let m = null;
    try { m = await DB.getTakeMeta(c.path); } catch { /* optional */ }
    badge.textContent = m && m.duration ? `take ${m.duration.toFixed(2)}s / ${S.limit.toFixed(2)}s`
      : S.outFiles.has(c.path) ? 'saved in folder' : 'recorded';
    badge.classList.remove('hide');
    badge.className = 'badge';
  } else if (c && S.packed.has(c.path)) {
    // recorded by someone else already; recording over it is allowed, not asked for
    badge.textContent = 'already in the pack';
    badge.className = 'badge packed';
    badge.classList.remove('hide');
  } else badge.classList.add('hide');
}

function select(i) {
  S.sel = Math.max(0, Math.min(i, S.filtered.length - 1));
  [...$('#list').children].forEach((r, n) => r.setAttribute('aria-selected', String(n === S.sel)));
  const row = $('#list').children[S.sel];
  if (row) row.scrollIntoView({ block: 'nearest' });
  renderPanel();
}

/* -------------------------------------------------------------- actions */
async function playOriginal() {
  const c = S.filtered[S.sel]; if (!c) return;
  const blob = await S.vpk.readMp3(c.path);
  S.audio.src = URL.createObjectURL(blob);
  S.audio.play();
}

async function playMine() {
  const c = S.filtered[S.sel]; if (!c) return;
  const blob = await readTake(c.path); if (!blob) return;
  S.audio.src = URL.createObjectURL(blob);
  S.audio.play();
}

async function toggleRecord() {
  const c = S.filtered[S.sel]; if (!c) return;
  if (S.recording) { S.recorder.stop(); return; }

  const orig = await origDuration(c.path);
  const limit = usable(orig);
  S.limit = limit;
  if (!S.stream) {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    meterFor(S.stream);
  }
  S.chunks = [];
  S.recorder = new MediaRecorder(S.stream, { mimeType: 'audio/webm' });
  S.recorder.ondataavailable = e => S.chunks.push(e.data);
  S.recorder.onstop = async () => {
    S.recording = false;
    vizStop();
    $('#record').textContent = '● Record';
    $('#record').classList.add('rec');
    const raw = new Blob(S.chunks, { type: 'audio/webm' });
    const { blob, duration } = await toWav(raw, limit);
    try {
      await saveTake(c.path, blob, duration);
      $('#saveStatus').textContent = S.out ? `saved to ${S.out.name}` : 'saved in browser';
    } catch (e) {
      // folder write failed (permission revoked, disk full) -- keep the take
      await DB.put(c.path, { blob, duration, at: Date.now() });
      $('#saveStatus').textContent = `couldn't write to folder — kept in browser`;
    }
    S.done.add(c.path);
    renderGroups(); renderList(); renderPanel();
  };
  S.recorder.start();
  S.recording = true;
  $('#record').textContent = '■ Stop';
  $('#record').classList.remove('rec');
  vizStart(limit, () => { if (S.recording) S.recorder.stop(); });
}

function meterFor(stream) {
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  S.an = an; S.anBuf = buf;
  const bar = $('#meter i'), box = $('#meter');
  (function tick() {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    bar.style.width = Math.min(100, peak * 140) + '%';
    box.classList.toggle('clip', peak > 0.98);
    requestAnimationFrame(tick);
  })();
}

function micPeak() {
  if (!S.an) return 0;
  S.an.getFloatTimeDomainData(S.anBuf);
  let peak = 0;
  for (const v of S.anBuf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/* ---------------------------------------------------------- visualiser

   The canvas is the whole budget: the full width is the original line's
   length, so the wave growing left to right shows exactly how much room is
   left. Past 80% it turns amber, and recording stops itself at the end -- the
   take can't come out longer than the line it replaces. */

function vizCtx() {
  const cv = $('#viz'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function vizIdle(limit) {
  const { ctx, w, h } = vizCtx();
  ctx.strokeStyle = cssVar('--line');
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!limit) return;
  ctx.fillStyle = cssVar('--muted');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${limit.toFixed(2)}s of room`, w / 2, h / 2 - 8);
}

function vizStart(limit, onFull) {
  const peaks = [];
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / 1000;
    peaks.push(Math.max(micPeak(), 0.004));
    const { ctx, w, h } = vizCtx();
    const mid = h / 2, frac = Math.min(1, t / limit);

    ctx.strokeStyle = cssVar('--line');
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    ctx.strokeStyle = frac > 0.8 ? cssVar('--rec') : cssVar('--ok');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * frac * w;
      const a = Math.min(1, peaks[i]) * (mid - 3);
      ctx.moveTo(x, mid - a); ctx.lineTo(x, mid + a);
    }
    ctx.stroke();

    // the 80% mark, so there's warning before the wall
    ctx.strokeStyle = cssVar('--line');
    ctx.beginPath(); ctx.moveTo(w * 0.8, 0); ctx.lineTo(w * 0.8, h); ctx.stroke();

    $('#vizTime').textContent = `${t.toFixed(2)}s`;
    $('#vizTime').className = frac > 0.8 ? 'over' : '';

    if (t >= limit) { onFull(); return; }
    S.viz = requestAnimationFrame(step);
  };
  S.viz = requestAnimationFrame(step);
}

function vizStop() {
  if (S.viz) cancelAnimationFrame(S.viz);
  S.viz = 0;
}

async function exportTakes() {
  const keys = await DB.keys();

  /* With an output folder there is nothing to export -- takes are already
     there. Flush anything that landed in IndexedDB (a failed write, or takes
     made before the folder was chosen) and say where the files are. */
  if (S.out) {
    let moved = 0;
    if (keys.length) {
      const all = await DB.all();
      for (let i = 0; i < keys.length; i++) {
        try { await saveTake(keys[i], all[i].blob, all[i].duration); await DB.del(keys[i]); moved++; }
        catch { /* leave it in the browser */ }
      }
    }
    alert(`${S.outFiles.size} take(s) are saved in "${S.out.name}".` +
      (moved ? `\n(${moved} moved out of browser storage just now.)` : '') +
      '\n\nZip that folder and send it back.');
    return;
  }

  if (!keys.length) { alert('No recordings yet.'); return; }
  const all = await DB.all();
  const files = keys.map((k, i) => ({ name: flatName(k), blob: all[i].blob }));

  if (window.showDirectoryPicker) {
    let dir = null;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { if (e && e.name === 'AbortError') return; }
    if (dir) {
      let n = 0;
      for (const f of files) {
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob); await w.close(); n++;
      }
      alert(`Wrote ${n} file(s) to the folder you picked.\nZip that folder and send it back.`);
      return;
    }
  }
  const zip = await makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = 'deadlock-vo-takes.zip';
  a.click();
}

/* ------------------------------------------------------------------ boot */

/* Setup step 2: the folder takes are written to. Resolves once the actor has
   granted a folder or chosen to skip; on a repeat visit the folder from last
   time is reused, silently if its permission survived. */
function outputStep() {
  return new Promise(resolve => {
    const card = $('#outCard'), status = $('#outStatus'), err = $('#outErr');
    const finish = () => { card.classList.add('hide'); resolve(); };
    if (!window.showDirectoryPicker) { resolve(); return; }  // ZIP-fallback browser

    const use = async h => {
      S.out = h;
      try { await DB.putHandle(h, 'out'); } catch { /* not storable; no matter */ }
      await scanOutput();
      finish();
    };
    const show = () => { $('#gameCard').classList.add('hide'); card.classList.remove('hide'); };

    $('#outPick').onclick = async () => {
      err.classList.add('hide');
      let h;
      try { h = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (e) {
        if (e && e.name === 'AbortError') return;
        err.textContent = 'This browser will not let the page write to a folder here. ' +
          'Takes will be kept in the browser and exported as a ZIP instead.';
        err.classList.remove('hide');
        return;
      }
      try { await use(h); }
      catch (e) { err.textContent = e.message || String(e); err.classList.remove('hide'); }
    };
    $('#outSkip').onclick = finish;

    (async () => {
      let saved = null;
      try { saved = await DB.getHandle('out'); } catch { /* none */ }
      if (saved && saved.queryPermission) {
        let perm = 'prompt';
        try { perm = await saved.queryPermission({ mode: 'readwrite' }); } catch { /* stale */ }
        if (perm === 'granted') {
          try { await use(saved); return; } catch { /* fall through to picking */ }
        }
        if (perm === 'prompt') {
          status.textContent = `Your recordings from last time are in "${saved.name}".`;
          status.classList.remove('hide');
          $('#outPick').textContent = `Use ${saved.name} again`;
          const pickAnother = $('#outPick').onclick;
          $('#outPick').onclick = async () => {
            let ok = false;
            try { ok = (await saved.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { }
            if (ok) { try { await use(saved); return; } catch { } }
            try { await DB.delHandle('out'); } catch { }
            status.classList.add('hide');
            $('#outPick').textContent = 'Choose folder for recordings';
            $('#outPick').onclick = pickAnother;
          };
        } else {
          try { await DB.delHandle('out'); } catch { }
        }
      }
      show();
    })();
  });
}

async function start(files) {
  S.vpk = await Vpk.open(files);
  buildIndex();
  if (!S.clips.length) throw new Error('No sounds/vo/ entries found in that VPK.');
  await DB.open();
  await outputStep();
  S.done = new Set([...await DB.keys(), ...S.outFiles.keys()]);
  S.group = sortedGroups()[0][0];
  $('#saveStatus').textContent = S.out ? `saving to ${S.out.name}` : 'saving in browser';
  $('#setup').classList.add('hide');
  $('#app').classList.remove('hide');
  renderPackedStatus();
  refresh();
  loadPacked();          // deliberately not awaited: the dots repaint when it lands
}

function pickViaInput(err) {
  const input = document.createElement('input');
  input.type = 'file'; input.webkitdirectory = true;
  input.onchange = async () => {
    try { await start(filesFromInput(input.files)); }
    catch (e) { err.textContent = e.message; err.classList.remove('hide'); }
  };
  input.click();
}

$('#pick').onclick = async () => {
  const err = $('#setupErr');
  err.classList.add('hide');
  if (window.showDirectoryPicker) {
    let root;
    try {
      root = await window.showDirectoryPicker();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // blocked (e.g. opened from file://) -- use the plain directory input
      pickViaInput(err); return;
    }
    try {
      const files = await filesFromDirHandle(root);
      try { await DB.open(); await DB.putHandle(root); } catch { /* not storable; no matter */ }
      await start(files);
    }
    catch (e) { err.textContent = e.message || String(e); err.classList.remove('hide'); }
  } else {
    pickViaInput(err);
  }
};

$('#q').oninput = () => { S.sel = -1; applyFilter(); renderList(); renderPanel(); };
$('#cat').onchange = () => { S.sel = -1; applyFilter(); renderList(); renderPanel(); };
$('#todo').onchange = () => { S.sel = -1; applyFilter(); renderList(); renderPanel(); };
$('#play').onclick = playOriginal;
$('#playMine').onclick = playMine;
$('#record').onclick = toggleRecord;
$('#next').onclick = () => select(S.sel + 1);
$('#prev').onclick = () => select(S.sel - 1);
$('#export').onclick = exportTakes;
$('#del').onclick = async () => {
  const c = S.filtered[S.sel]; if (!c) return;
  await deleteTake(c.path); S.done.delete(c.path);
  renderGroups(); renderList(); renderPanel();
};
$('#theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
};

/* On load, try the folder from last time before asking for one. Chrome keeps
   the handle but usually re-asks for permission once per session, so that case
   becomes a single click instead of navigating the folder tree again. */
(async function boot() {
  let h = null;
  try { await DB.open(); h = await DB.getHandle(); } catch { return; }
  if (!h || !h.queryPermission) return;

  const status = $('#autoStatus'), pick = $('#pick');
  const label = h.name || 'Deadlock folder';
  const forget = async () => { try { await DB.delHandle(); } catch { } };

  let perm;
  try { perm = await h.queryPermission({ mode: 'read' }); } catch { return; }

  if (perm === 'granted') {
    status.textContent = `Reopening ${label}…`;
    status.classList.remove('hide');
    try { await start(await filesFromDirHandle(h)); return; }
    catch { await forget(); status.classList.add('hide'); return; }
  }

  if (perm === 'prompt') {
    status.textContent = `Remembered "${label}" from last time.`;
    status.classList.remove('hide');
    pick.textContent = `Reopen ${label}`;
    pick.onclick = async () => {
      let granted = false;
      try { granted = (await h.requestPermission({ mode: 'read' })) === 'granted'; } catch { }
      if (granted) {
        try { await start(await filesFromDirHandle(h)); return; } catch { }
      }
      await forget();
      location.reload();
    };
  }
})();

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ($('#app').classList.contains('hide')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); playOriginal(); }
  else if (k === 'r') { e.preventDefault(); toggleRecord(); }
  else if (k === 'p') { e.preventDefault(); playMine(); }
  else if (k === 'n' || k === 'arrowdown') { e.preventDefault(); select(S.sel + 1); }
  else if (k === 'arrowup') { e.preventDefault(); select(S.sel - 1); }
});
