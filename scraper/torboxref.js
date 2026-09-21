// scraper/torboxref.js — reference pro přečas z VLOŽENÝCH titulků BD souboru.
//
// Místo stahování přílohy z Anime Tosho: pro BD release (infohash z indexeru)
// si od TorBoxu vezmeme odkaz na PŘESNĚ ten díl (i v batchi), přes HTTP range
// přečteme jen hlavičku + index Cues MKV (desítky až stovky kB z ~GB souboru),
// z něj časovou osu titulkových událostí vybrané dialogové stopy a postavíme
// z ní referenční SRT. alass pracuje jen s časy, text reference nepotřebuje.
//
// Ověřeno 21.9.: Solo Leveling [Breeze] batch → díl 1 podle jména z 12 MKV,
// 26 titulkových stop, 975 kB ze 697 MB, 7,3 s.
import { CONFIG } from '../config.js';

// ── TorBox API ──────────────────────────────────────────────────────────────
async function tb(path, opts = {}) {
  const r = await fetch(CONFIG.torbox.api + path, {
    ...opts,
    headers: { Authorization: `Bearer ${CONFIG.torbox.key}`, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.success === false) throw new Error(`TorBox ${path.split('?')[0]}: ${j.detail || j.error || r.status}`);
  return j;
}

const base = (p) => String(p || '').split('/').pop().toLowerCase();

/** Které z infohashů jsou v cache TorBoxu — jedním dotazem (po dávkách 50). */
export async function cachedHashes(hashes) {
  const list = [...new Set((hashes || []).map((h) => String(h || '').toLowerCase()).filter((h) => /^[0-9a-f]{40}$/.test(h)))];
  const out = new Set();
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const cc = await tb(`/torrents/checkcached?hash=${chunk.join(',')}&format=object`);
    for (const h of Object.keys((cc && cc.data) || {})) out.add(h.toLowerCase());
  }
  return out;
}

/**
 * Odkaz na konkrétní soubor dílu v (batch) releasu.
 * @param {{infohash:string, filename?:string, filesize?:number}} target
 * @returns {Promise<{url,file,how,total,cleanup}|{skip:string,reason:string}>}
 *   reason: 'uncached' | 'no-files' | 'zip' | 'no-mkv' | 'no-file'
 */
export async function episodeLink(target, { assumeCached = false } = {}) {
  const hash = String(target.infohash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return { reason: 'no-hash', skip: 'release nemá infohash' };

  // jen cached — necached by se musel stahovat (a to nechceme)
  if (!assumeCached) {
    const cc = await tb(`/torrents/checkcached?hash=${hash}&format=object`);
    if (!cc.data || !cc.data[hash]) return { reason: 'uncached', skip: 'release není v cache TorBoxu' };
  }

  // už je v účtu? → použij a NEMAŽ. Jinak přidej a po přečtení smaž.
  const mine = await tb('/torrents/mylist?bypass_cache=true');
  const existing = (Array.isArray(mine.data) ? mine.data : [])
    .find((t) => String(t.hash || '').toLowerCase() === hash);
  let tid, added = false;
  if (existing) tid = existing.id;
  else {
    const fd = new FormData();
    fd.append('magnet', `magnet:?xt=urn:btih:${hash}`);
    const cr = await tb('/torrents/createtorrent', { method: 'POST', body: fd });
    tid = cr.data && cr.data.torrent_id;
    added = true;
  }
  if (!tid) return { reason: 'no-files', skip: 'TorBox nevrátil torrent_id' };

  const cleanup = async () => {
    if (!added) return;
    await tb('/torrents/controltorrent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent_id: tid, operation: 'delete' }),
    }).catch(() => {});
  };

  let files = [];
  for (let i = 0; i < 10 && !files.length; i++) {
    const ml = await tb(`/torrents/mylist?id=${tid}&bypass_cache=true`);
    files = (ml.data && ml.data.files) || [];
    if (!files.length) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!files.length) { await cleanup(); return { reason: 'no-files', skip: 'TorBox nevrátil seznam souborů' }; }

  const mkv = files.filter((f) => /\.(mkv|webm)$/i.test(f.short_name || f.name || ''));
  if (!mkv.length) {
    const zip = files.some((f) => /zip/i.test(f.mimetype || '') || /\.zip$/i.test(f.short_name || ''));
    await cleanup();
    return zip
      ? { reason: 'zip', skip: 'TorBox drží release jako .zip (range nefunguje)' }
      : { reason: 'no-mkv', skip: 'release neobsahuje MKV' };
  }

  // Výběr dílu PODLE INDEXERU: jeho jméno souboru → přesná velikost → ±0,1 %.
  // NIKDY files[index] (TorBox má jiné pořadí) a nic se neluští z názvů — když
  // soubor podle údajů indexeru nenajdeme, release přeskočíme.
  let pick = null, how = null;
  if (target.filename) {
    pick = mkv.find((f) => base(f.short_name || f.name) === base(target.filename));
    if (pick) how = 'jméno';
  }
  const size = Number(target.filesize) || 0;
  if (!pick && size) {
    pick = mkv.find((f) => Number(f.size) === size);
    if (pick) how = 'velikost';
  }
  if (!pick && size) {
    pick = mkv.find((f) => Math.abs(Number(f.size) - size) / size < 0.001);
    if (pick) how = 'velikost ±0,1 %';
  }
  if (!pick && target.singleFile && mkv.length === 1) { pick = mkv[0]; how = 'jediný soubor (dle indexeru)'; }
  if (!pick) { await cleanup(); return { reason: 'no-file', skip: `soubor dílu se mezi ${mkv.length} MKV nenašel` }; }

  const dl = await tb(`/torrents/requestdl?token=${CONFIG.torbox.key}&torrent_id=${tid}&file_id=${pick.id}`);
  if (!dl.data) { await cleanup(); return { reason: 'no-file', skip: 'TorBox nevrátil odkaz na soubor' }; }
  return { url: dl.data, file: pick.short_name || pick.name, how, total: mkv.length, cleanup };
}

// ── MKV: hlavička + Tracks + Cues přes HTTP range ──────────────────────────
const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPos: 0x53AC,
  Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7,
  TrackType: 0x83, CodecID: 0x86, Language: 0x22B59C, LangBCP47: 0x22B59D, Name: 0x536E,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7,
  CueDuration: 0xB2, Cluster: 0x1F43B675,
};

function vint(buf, pos, keepMarker) {
  const b = buf[pos];
  if (b === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > buf.length) return null;
  let v = keepMarker ? b : (b & (mask - 1));
  let ones = (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) ones = false; }
  return { v, len, unknown: !keepMarker && ones };
}
function el(buf, pos) {
  const id = vint(buf, pos, true); if (!id) return null;
  const sz = vint(buf, pos + id.len, false); if (!sz) return null;
  const ds = pos + id.len + sz.len;
  return { id: id.v, size: sz.v, unknown: sz.unknown, dataStart: ds, dataEnd: sz.unknown ? buf.length : ds + sz.v };
}
const uint = (buf, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + buf[i]; return v; };
const str = (buf, s, e) => buf.slice(s, e).toString('utf8').replace(/\0+$/, '');
function* kids(buf, s, e) {
  let p = s;
  while (p < e) { const x = el(buf, p); if (!x) return; yield x; if (x.unknown) return; p = x.dataEnd; }
}

/**
 * Časová osa titulkových stop z indexu Cues.
 * @returns {Promise<{tracks:Array<{num,codec,lang,name,cues:Array<{t,d}>}>, scale:number, bytes:number, noCues?:boolean}>}
 */
export async function readTimeline(url) {
  let bytes = 0;
  async function range(s, e) {
    const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (r.status !== 206) {            // server range neumí → NIKDY nestahuj celé video
      try { await r.body?.cancel(); } catch {}
      throw new Error(`server nevrátil 206 (vrátil ${r.status})`);
    }
    const b = Buffer.from(await r.arrayBuffer());
    bytes += b.length;
    return b;
  }
  async function at(abs, max) {
    const h = await range(abs, abs + 15);
    const x = el(h, 0);
    if (!x || x.unknown) throw new Error('neplatný MKV element');
    if (x.size > max) throw new Error(`MKV element je moc velký (${x.size} B)`);
    const b = await range(abs, abs + x.dataStart + x.size - 1);
    return { buf: b, s: x.dataStart, e: x.dataStart + x.size };
  }

  const first = await range(0, 65535);
  const eb = el(first, 0);
  if (!eb || eb.id !== ID.EBML) throw new Error('soubor není Matroska');
  const seg = el(first, eb.dataEnd);
  if (!seg || seg.id !== ID.Segment) throw new Error('MKV Segment nenalezen');

  const seek = {};
  const segEnd = Math.min(first.length, seg.unknown ? first.length : seg.dataEnd);
  for (const c of kids(first, seg.dataStart, segEnd)) {
    if (c.id === ID.SeekHead) {
      for (const s of kids(first, c.dataStart, c.dataEnd)) {
        if (s.id !== ID.Seek) continue;
        let sid = null, spos = null;
        for (const f of kids(first, s.dataStart, s.dataEnd)) {
          if (f.id === ID.SeekID) sid = uint(first, f.dataStart, f.dataEnd);
          if (f.id === ID.SeekPos) spos = uint(first, f.dataStart, f.dataEnd);
        }
        if (sid != null && spos != null) seek[sid] = seg.dataStart + spos;
      }
    }
    if (c.id === ID.Cluster) break;
  }

  let scale = 1_000_000;
  if (seek[ID.Info] != null) {
    const i = await at(seek[ID.Info], 1 << 20);
    for (const f of kids(i.buf, i.s, i.e)) if (f.id === ID.TimecodeScale) scale = uint(i.buf, f.dataStart, f.dataEnd);
  }
  if (seek[ID.Tracks] == null) throw new Error('MKV nemá Tracks v SeekHead');

  const tr = await at(seek[ID.Tracks], 4 << 20);
  const subs = {};
  for (const te of kids(tr.buf, tr.s, tr.e)) {
    if (te.id !== ID.TrackEntry) continue;
    const t = {};
    for (const f of kids(tr.buf, te.dataStart, te.dataEnd)) {
      if (f.id === ID.TrackNumber) t.num = uint(tr.buf, f.dataStart, f.dataEnd);
      if (f.id === ID.TrackType) t.type = uint(tr.buf, f.dataStart, f.dataEnd);
      if (f.id === ID.CodecID) t.codec = str(tr.buf, f.dataStart, f.dataEnd);
      if (f.id === ID.Language || f.id === ID.LangBCP47) t.lang = str(tr.buf, f.dataStart, f.dataEnd);
      if (f.id === ID.Name) t.name = str(tr.buf, f.dataStart, f.dataEnd);
    }
    if (t.type === 0x11) subs[t.num] = { num: t.num, codec: t.codec || '', lang: t.lang || '', name: t.name || '', cues: [] };
  }

  if (seek[ID.Cues] == null) return { tracks: Object.values(subs), scale, bytes, noCues: true };

  const cu = await at(seek[ID.Cues], 32 << 20);
  for (const cp of kids(cu.buf, cu.s, cu.e)) {
    if (cp.id !== ID.CuePoint) continue;
    let time = null;
    const pos = [];
    for (const f of kids(cu.buf, cp.dataStart, cp.dataEnd)) {
      if (f.id === ID.CueTime) time = uint(cu.buf, f.dataStart, f.dataEnd);
      if (f.id === ID.CueTrackPositions) {
        let t = null, d = null;
        for (const g of kids(cu.buf, f.dataStart, f.dataEnd)) {
          if (g.id === ID.CueTrack) t = uint(cu.buf, g.dataStart, g.dataEnd);
          if (g.id === ID.CueDuration) d = uint(cu.buf, g.dataStart, g.dataEnd);
        }
        pos.push({ t, d });
      }
    }
    for (const p of pos) if (subs[p.t] && time != null) subs[p.t].cues.push({ t: time, d: p.d });
  }
  return { tracks: Object.values(subs), scale, bytes };
}

// ── výběr dialogové stopy ───────────────────────────────────────────────────
// Zjištěno na Breeze (26 stop): „Signs & Songs" má 8185 událostí za ~1,5 min
// (karaoke po snímcích), stopy dialog+karaoke 8528 → takové jako reference
// rozhodí alass. Čistý dialog ~340. SRT (S_TEXT/UTF8) stopy byly o ~1,4 s
// POZADU za ASS protějšky (převzaté odjinud, nepřečasované na BD) → ASS přednost.
const TEXT_CODEC = /^S_TEXT\/(ASS|SSA|UTF8|WEBVTT)$/i;
const NOT_DIALOG = /sign|song|karaoke|forced|lyrics|\bop\b|\bed\b/i;

// Úrovně (David): 1 = anglická ASS (překlady se dělají z EN → podobné dělení
// replik), 2 = ASS jiného jazyka, 3 = anglická SRT (SRT stopy bývají posunuté
// — na Breeze ~1,4 s za ASS), 4 = ostatní. V rámci úrovně: ne-SDH, pak hustota.
const isAss = (t) => /ASS|SSA/i.test(t.codec || '');
const isEn = (t) => /^en/i.test(t.lang || '');
const tierOf = (t) => (isEn(t) && isAss(t) ? 1 : isAss(t) ? 2 : isEn(t) ? 3 : 4);
const TIER_TXT = { 1: 'anglická ASS', 2: 'ASS jiného jazyka', 3: 'anglická SRT', 4: 'jiná stopa' };

/** @returns {{track:object, tier:number, why:string}|{track:null, reason:string}} */
export function pickDialogueTrack(tracks) {
  const text = tracks.filter((t) => TEXT_CODEC.test(t.codec || ''));
  if (!text.length) {
    const bitmap = tracks.some((t) => /PGS|VOBSUB|HDMV/i.test(t.codec || ''));
    return { track: null, reason: bitmap ? 'only-bitmap' : 'no-text-track' };
  }
  let cand = text.filter((t) => !NOT_DIALOG.test(t.name || '') && t.cues.length >= 20); // i krátké specialy
  if (!cand.length) {
    const hasCues = text.some((t) => t.cues.length);
    return { track: null, reason: hasCues ? 'only-signs' : 'no-cues-for-subs' };
  }
  // karaoke/typesetting: počet událostí nepřirozeně nad mediánem → pryč
  const sorted = cand.map((t) => t.cues.length).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const clean = cand.filter((t) => t.cues.length <= median * 3);
  if (clean.length) cand = clean;

  const sdh = (t) => /sdh|\bcc\b|hearing/i.test(t.name || '');
  cand.sort((a, b) =>
    tierOf(a) - tierOf(b) ||
    (sdh(a) ? 1 : 0) - (sdh(b) ? 1 : 0) ||
    Math.abs(a.cues.length - median) - Math.abs(b.cues.length - median));
  const t = cand[0], tier = tierOf(t);
  return {
    track: t, tier,
    why: `${TIER_TXT[tier]}${t.name ? ` „${t.name}"` : ''} (${t.lang || '?'}, ${t.cues.length} replik)`,
  };
}

// ── časy → referenční SRT (text je pro alass lhostejný) ─────────────────────
export function timelineToSrt(track, scale) {
  if (!track || !track.cues || !track.cues.length) return null;
  const ms = (u) => Math.round((u * scale) / 1e6);
  const f = (m) => {
    const h = Math.floor(m / 3600000), mi = Math.floor(m / 60000) % 60, s = Math.floor(m / 1000) % 60, x = m % 1000;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`;
  };
  const cues = [...track.cues].sort((a, b) => a.t - b.t);
  const out = [];
  cues.forEach((c, i) => {
    const start = ms(c.t);
    const end = start + (c.d != null ? Math.max(ms(c.d), 1) : 2000);
    out.push(String(i + 1), `${f(start)} --> ${f(end)}`, '.', '');
  });
  return Buffer.from(out.join('\n'), 'utf8');
}
