// fonts.js — vkládání fontů do .ass titulků (sekce [Fonts] před [Events]).
//
// PROČ: přehrávač Nuvio (tvOS, libass) nemá fansub fonty (Calibri, Nyala, Open Sans…)
// a do Apple TV se nainstalovat nedají → libass vezme náhradní písmo. Font vložený
// přímo v .ass si libass načte sám (ověřeno 25.10. na Apple TV).
//
// CO TU JE (čistá logika, bez DB a R2 — to řeší fontjobs.js):
//  • Knihovna fontů = složka FONTS_DIR (výchozí /data/fonts): .ttf / .otf / .ttc / .otc,
//    klidně v podsložkách. Jména se čtou z name tabulky fontu (rodina, celé jméno,
//    PostScript), protože podle nich font hledá libass — název souboru je jedno.
//    Rejstřík se ukládá do .index.json, při startu se čtou jen nové/změněné soubory.
//  • Rozbor .ass: které fonty (a řezy — tučné / kurzíva) titulek OPRAVDU používá a jakými
//    znaky — styl řádku + přepínače \fn, \b, \i, \r; kresby (\p1) a \t(…) se přeskočí.
//  • Výběr řezu jako libass (ass_fontselect.c): shoda rodiny → nejbližší váha/kurzíva;
//    celé jméno / PostScript jen když žádná rodina nesedí.
//  • Font se zmenší jen na použité znaky (harfbuzz přes npm subset-font) a vloží jako
//    [Fonts] PŘED [Events] — Nuvio (FFmpeg) čte hlavičku zvlášť od dialogů, font za
//    [Events] by se nenačetl. Fonty, které už v souboru jsou, se nechají být.
//  • Zbytek souboru zůstává bajt po bajtu stejný (i staré soubory v CP1250).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import subsetFont from 'subset-font';
import { CONFIG } from './config.js';

export const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;
// když zmenšený font ztratí jméno (harfbuzz nechává jen anglická jména), vloží se celý —
// ale jen menší fonty, ať z titulku není několikamegabajtový soubor
const MAX_FULL_EMBED = 4 * 1024 * 1024;
// jména, která se při zmenšení zachovají (rodina, řez, celé jméno, PostScript, typografická…)
const KEEP_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 16, 17, 21, 22];
// OpenType funkce, které se při zmenšení ponechají — výchozí sada harfbuzz (hb-subset):
// běžné tvarování, kerning, ligatury, vertikální sazba, arabské/indické/hangul tvary.
// Ozdobné alternativy (salt, swsh, ss01…) se nepoužívají a jen by font zbytečně zvětšily.
const KEEP_FEATURES = [
  'abvm', 'blwm', 'ccmp', 'locl', 'mark', 'mkmk', 'rlig', 'calt', 'clig', 'curs', 'dist', 'kern',
  'liga', 'rclt', 'rvrn', 'frac', 'numr', 'dnom', 'valt', 'vert', 'vkna', 'vkrn', 'vpal', 'vrt2',
  'ltra', 'ltrm', 'rtla', 'rtlm', 'rand', 'jalt', 'chws', 'vchw', 'halt', 'vhal',
  'init', 'medi', 'fina', 'isol', 'med2', 'fin2', 'fin3', 'cswh', 'mset', 'stch',
  'ljmo', 'vjmo', 'tjmo', 'abvs', 'blws', 'nukt', 'akhn', 'rphf', 'rkrf', 'pref', 'blwf',
  'half', 'abvf', 'pstf', 'cfar', 'vatu', 'cjct', 'pres', 'psts', 'haln',
];

// ── čtení sfnt (TTF / OTF / TTC) ─────────────────────────────────────────────

function faceOffsets(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'ttcf') {
    const n = buf.readUInt32BE(8);
    const out = [];
    for (let i = 0; i < n && 16 + 4 * i <= buf.length; i++) out.push(buf.readUInt32BE(12 + 4 * i));
    return out;
  }
  return [0];
}

function tableDir(buf, off) {
  const num = buf.readUInt16BE(off + 4);
  const t = {};
  for (let i = 0; i < num; i++) {
    const r = off + 12 + 16 * i;
    t[buf.toString('latin1', r, r + 4)] = {
      checksum: buf.readUInt32BE(r + 4),
      offset: buf.readUInt32BE(r + 8),
      length: buf.readUInt32BE(r + 12),
    };
  }
  return t;
}

const utf16be = (b) => Buffer.from(b.length % 2 ? b.subarray(0, b.length - 1) : b).swap16().toString('utf16le');

// váha jako ji počítá libass (usWeightClass 1–9 jsou staré fonty se škálou 1–9)
const OLD_WEIGHTS = { 1: 100, 2: 200, 3: 300, 4: 350, 5: 400, 6: 600, 7: 800, 8: 900, 9: 950 };

// Jména (malými písmeny), váha a kurzíva jednoho řezu. libass bere jména jen
// z Microsoft platformy — když tam font nic nemá, vezme se cokoli.
function faceInfo(buf, off) {
  const t = tableDir(buf, off);
  const ms = { fam: new Set(), full: new Set(), ps: new Set() };
  const any = { fam: new Set(), full: new Set(), ps: new Set() };
  if (t.name) {
    const base = t.name.offset;
    const count = buf.readUInt16BE(base + 2);
    const strOff = base + buf.readUInt16BE(base + 4);
    for (let i = 0; i < count; i++) {
      const r = base + 6 + 12 * i;
      const platform = buf.readUInt16BE(r);
      const enc = buf.readUInt16BE(r + 2);
      const id = buf.readUInt16BE(r + 6);
      const kind = id === 1 ? 'fam' : id === 4 ? 'full' : id === 6 ? 'ps' : null;
      if (!kind) continue;
      const len = buf.readUInt16BE(r + 8);
      const o = buf.readUInt16BE(r + 10);
      const raw = buf.subarray(strOff + o, strOff + o + len);
      let s;
      if (platform === 3 || platform === 0) s = utf16be(raw);
      else if (platform === 1 && enc === 0) s = raw.toString('latin1');
      else continue;
      s = s.replace(/\0/g, '').trim().toLowerCase();
      if (!s) continue;
      any[kind].add(s);
      if (platform === 3) ms[kind].add(s);
    }
  }
  const use = ms.fam.size || ms.full.size ? ms : any;
  let weight = 400;
  let italic = false;
  let boldFlag = false;
  if (t.head && t.head.length >= 46) {
    const mac = buf.readUInt16BE(t.head.offset + 44);
    boldFlag = !!(mac & 1);
    italic = !!(mac & 2);
  }
  if (t['OS/2'] && t['OS/2'].length >= 64) {
    const w = buf.readUInt16BE(t['OS/2'].offset + 4);
    weight = w === 0 ? (boldFlag ? 700 : 400) : OLD_WEIGHTS[w] || w;
    const sel = buf.readUInt16BE(t['OS/2'].offset + 62);
    italic = !!(sel & 1) || italic;
  } else {
    weight = boldFlag ? 700 : 400;
  }
  return {
    fam: [...use.fam],
    full: [...use.full],
    ps: [...use.ps],
    weight,
    italic,
    cff: buf.toString('latin1', off, off + 4) === 'OTTO',
  };
}

// jeden řez z kolekce (TTC) jako samostatný font (harfbuzz bere jen řez č. 0)
function extractFace(buf, off) {
  const t = tableDir(buf, off);
  const tags = Object.keys(t).sort();
  const n = tags.length;
  const es = Math.floor(Math.log2(n || 1));
  const head = Buffer.alloc(12 + 16 * n);
  head.writeUInt32BE(buf.readUInt32BE(off), 0);
  head.writeUInt16BE(n, 4);
  head.writeUInt16BE(16 * 2 ** es, 6);
  head.writeUInt16BE(es, 8);
  head.writeUInt16BE(n * 16 - 16 * 2 ** es, 10);
  const parts = [head];
  let pos = head.length;
  tags.forEach((tag, i) => {
    const { checksum, offset, length } = t[tag];
    const r = 12 + 16 * i;
    head.write(tag, r, 'latin1');
    head.writeUInt32BE(checksum, r + 4);
    head.writeUInt32BE(pos, r + 8);
    head.writeUInt32BE(length, r + 12);
    const pad = (4 - (length % 4)) % 4;
    parts.push(buf.subarray(offset, offset + length), Buffer.alloc(pad));
    pos += length + pad;
  });
  return Buffer.concat(parts);
}

// Načte všechny řezy ze souboru fontu (vyhodí chybu, když to není font).
export function readFontFaces(buf) {
  const offs = faceOffsets(buf);
  if (!offs.length) throw new Error('prázdná kolekce');
  const sig = buf.toString('latin1', offs[0], offs[0] + 4);
  if (!['\0\x01\0\0', 'OTTO', 'true'].includes(sig)) throw new Error('není TTF/OTF');
  return offs.map((o, i) => ({ idx: offs.length > 1 ? i : -1, ...faceInfo(buf, o) }));
}

// ── knihovna fontů ───────────────────────────────────────────────────────────

const lib = { dir: CONFIG.fonts.dir, faces: [], files: 0, bytes: 0, version: '', loadedAt: null, byFam: new Map(), byName: new Map() };
export const library = () => lib;

function* walk(dir, rel = '') {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (FONT_EXT.test(e.name)) yield r;
  }
}

const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

// (Znovu)načte knihovnu. Nové a změněné soubory přečte, ostatní vezme z .index.json.
export function loadLibrary() {
  const dir = lib.dir;
  fs.mkdirSync(dir, { recursive: true });
  const idxPath = path.join(dir, '.index.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
  const next = {};
  const faces = [];
  const sig = [];
  let bytes = 0;
  let bad = 0;
  for (const rel of walk(dir)) {
    let st;
    try { st = fs.statSync(path.join(dir, rel)); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs);
    let entry = cache[rel];
    if (!entry || entry.size !== st.size || entry.mtime !== mtime) {
      try {
        entry = { size: st.size, mtime, faces: readFontFaces(fs.readFileSync(path.join(dir, rel))) };
      } catch (e) {
        entry = { size: st.size, mtime, faces: [], error: String(e.message).slice(0, 120) };
      }
    }
    if (entry.error) bad++;
    next[rel] = entry;
    bytes += st.size;
    sig.push(`${rel}:${st.size}`);
    for (const f of entry.faces) faces.push({ file: rel, ...f });
  }
  try { fs.writeFileSync(idxPath, JSON.stringify(next)); } catch (e) { console.warn('[fonty] .index.json:', e.message); }
  const byFam = new Map();
  const byName = new Map();
  for (const f of faces) {
    for (const n of f.fam) push(byFam, n, f);
    for (const n of [...f.full, ...f.ps]) push(byName, n, f);
  }
  Object.assign(lib, {
    faces,
    files: Object.keys(next).length,
    bad,
    bytes,
    byFam,
    byName,
    version: sig.length ? crypto.createHash('sha1').update(sig.sort().join('\n')).digest('hex').slice(0, 12) : '',
    loadedAt: new Date().toISOString(),
  });
  return lib;
}

// skóre podobnosti řezu jako v libass: rozdíl vah + kurzíva (chybějící kurzíva lacino,
// nechtěná kurzíva dráž)
function score(f, weight, italic) {
  let s = Math.abs(f.weight - weight);
  if (italic && !f.italic) s += 1;
  else if (!italic && f.italic) s += 4;
  return s;
}
const best = (list, weight, italic) =>
  list.reduce((a, f) => (!a || score(f, weight, italic) < score(a, weight, italic) ? f : a), null);

export function findFace(name, weight = 400, italic = false) {
  const n = String(name || '').trim().toLowerCase();
  const fam = lib.byFam.get(n);
  if (fam?.length) return best(fam, weight, italic);
  return lib.byName.get(n)?.[0] || null;
}

// shoda proti libovolnému seznamu řezů (fonty, které už v .ass vložené jsou)
function matchIn(faces, name) {
  const n = String(name || '').trim().toLowerCase();
  return faces.some((f) => f.fam.includes(n) || f.full.includes(n) || f.ps.includes(n));
}

// ── ASS: kódování vložených fontů (UUE varianta z SSA: 6 bitů + 33, řádky po 80) ─

export function uuencode(data) {
  let s = '';
  for (let i = 0; i < data.length; i += 3) {
    const n = Math.min(3, data.length - i);
    const v = (data[i] << 16) | ((n > 1 ? data[i + 1] : 0) << 8) | (n > 2 ? data[i + 2] : 0);
    const c = [(v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63];
    for (let k = 0; k <= n; k++) s += String.fromCharCode(c[k] + 33);
  }
  const out = [];
  for (let i = 0; i < s.length; i += 80) out.push(s.slice(i, i + 80));
  return out;
}

export function uudecode(str) {
  const s = str.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    if (chunk.length < 2) break;
    const c = [...chunk].map((ch) => ch.charCodeAt(0) - 33);
    const v = (c[0] << 18) | (c[1] << 12) | ((c[2] || 0) << 6) | (c[3] || 0);
    bytes.push((v >> 16) & 255);
    if (chunk.length > 2) bytes.push((v >> 8) & 255);
    if (chunk.length > 3) bytes.push(v & 255);
  }
  return Buffer.from(bytes);
}

// ── ASS: rozbor ──────────────────────────────────────────────────────────────

// rozdělí na nejvýš n částí podle čárky (poslední část = zbytek, např. Text)
function splitN(s, n) {
  const out = [];
  let rest = s;
  for (let i = 0; i < n - 1; i++) {
    const k = rest.indexOf(',');
    if (k < 0) break;
    out.push(rest.slice(0, k));
    rest = rest.slice(k + 1);
  }
  out.push(rest);
  return out;
}

// váha z ASS: -1 / 1 = tučné (700), 0 = normální, jiné číslo = přímo váha (\b600)
const assWeight = (b) => (b === 1 || b === -1 ? 700 : b <= 0 ? 400 : b);

function parseAss(text) {
  const styles = new Map();
  const events = [];
  let section = null;
  let stFmt = null;
  let evFmt = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('[') && s.endsWith(']')) { section = s.toLowerCase(); continue; }
    if (section === '[v4+ styles]' || section === '[v4 styles]') {
      if (/^format\s*:/i.test(s)) stFmt = s.replace(/^format\s*:/i, '').split(',').map((x) => x.trim().toLowerCase());
      else if (/^style\s*:/i.test(s) && stFmt) {
        const v = splitN(s.replace(/^style\s*:/i, ''), stFmt.length);
        const d = Object.fromEntries(stFmt.map((k, i) => [k, (v[i] ?? '').trim()]));
        styles.set(d.name, {
          font: (d.fontname || 'Arial').replace(/^@/, ''),
          weight: assWeight(parseInt(d.bold || '0', 10) || 0),
          italic: (parseInt(d.italic || '0', 10) || 0) !== 0,
        });
      }
    } else if (section === '[events]') {
      if (/^format\s*:/i.test(s)) evFmt = s.replace(/^format\s*:/i, '').split(',').map((x) => x.trim().toLowerCase());
      else if (/^dialogue\s*:/i.test(s) && evFmt) {
        const v = splitN(line.replace(/^\s*dialogue\s*:\s*/i, ''), evFmt.length);
        const d = Object.fromEntries(evFmt.map((k, i) => [k, v[i] ?? '']));
        events.push({ style: String(d.style || '').trim(), text: String(d.text || '') });
      }
    }
  }
  return { styles, events };
}

// tagy jednoho {…} bloku bez obsahu \t(…) (tam \fn/\b/\i nic nedělají)
function blockTags(block) {
  let out = '';
  for (let i = 0; i < block.length; i++) {
    if (block[i] === '\\' && block[i + 1] === 't' && block[i + 2] === '(') {
      let depth = 0;
      for (i += 2; i < block.length; i++) {
        if (block[i] === '(') depth++;
        else if (block[i] === ')' && --depth === 0) break;
      }
      continue;
    }
    out += block[i];
  }
  return out.split('\\').slice(1).map((t) => t.trim());
}

// Které fonty a řezy titulek opravdu kreslí a jakými znaky.
// Vrací Map klíč → { name, weight, italic, chars:Set, lines }
function usage(styles, events) {
  const used = new Map();
  const first = styles.values().next().value || { font: 'Arial', weight: 400, italic: false };
  const styleOf = (n) => styles.get(n) || styles.get(n.replace(/^\*+/, '')) || styles.get('Default') || first;
  for (const ev of events) {
    const base = styleOf(ev.style);
    let cur = { ...base };
    let drawing = false;
    const seen = new Set();
    const add = (seg) => {
      if (!seg || drawing) return;
      const txt = seg.replace(/\\[Nn]/g, '').replace(/\\h/g, ' ');
      if (!txt) return;
      const key = `${cur.font.toLowerCase()}|${cur.weight}|${cur.italic ? 1 : 0}`;
      if (!used.has(key)) used.set(key, { name: cur.font, weight: cur.weight, italic: cur.italic, chars: new Set(), lines: 0 });
      const u = used.get(key);
      for (const ch of txt) u.chars.add(ch);
      if (!seen.has(key)) { u.lines++; seen.add(key); }
    };
    const re = /\{([^}]*)\}/g;
    let pos = 0;
    let m;
    while ((m = re.exec(ev.text))) {
      add(ev.text.slice(pos, m.index));
      pos = re.lastIndex;
      for (const t of blockTags(m[1])) {
        if (t.startsWith('fn')) cur.font = (t.slice(2).trim() || base.font).replace(/^@/, '');
        else if (/^b\d+$/.test(t)) cur.weight = assWeight(Number(t.slice(1)));
        else if (/^i\d$/.test(t)) cur.italic = t[1] !== '0';
        else if (t.startsWith('r')) {
          const rs = t.slice(1).trim();
          cur = { ...(rs ? styles.get(rs) || base : base) };
        } else if (/^p\d+$/.test(t)) drawing = Number(t.slice(1)) > 0;
      }
    }
    add(ev.text.slice(pos));
  }
  return used;
}

// fonty, které už v .ass jsou ([Fonts]) — rozkóduje je a přečte jejich jména
function embeddedFaces(text) {
  const out = [];
  let section = null;
  let cur = null;
  const flush = () => {
    if (cur?.data.length) {
      try { out.push(...readFontFaces(uudecode(cur.data.join('')))); } catch {}
    }
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      if (section === '[fonts]') flush();
      section = s.toLowerCase();
      continue;
    }
    if (section !== '[fonts]') continue;
    if (/^fontname\s*:/i.test(s)) { flush(); cur = { data: [] }; } else if (cur && s) cur.data.push(s);
  }
  if (section === '[fonts]') flush();
  return out;
}

// ── zmenšení a vložení ───────────────────────────────────────────────────────

// harfbuzz (wasm) se volá po jednom
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

const namesOf = (buf) => {
  try {
    const f = readFontFaces(buf)[0];
    return new Set([...f.fam, ...f.full, ...f.ps]);
  } catch { return new Set(); }
};

async function subsetFace(face, chars, wants) {
  const raw = fs.readFileSync(path.join(lib.dir, face.file));
  const src = face.idx >= 0 ? extractFace(raw, faceOffsets(raw)[face.idx]) : raw;
  const text = [...new Set([...chars, ' '])].join('');
  let out = null;
  let err = null;
  try {
    // bez hintingu (libass ho nepoužívá) — u fontů typu Calibri je to většina velikosti
    out = Buffer.from(await serial(() => subsetFont(src, text, {
      targetFormat: 'truetype',
      preserveNameIds: KEEP_NAME_IDS,
      keepFeatures: KEEP_FEATURES,
      noHinting: true,
    })));
  } catch (e) { err = e; }
  const keepsNames = (b) => { const n = namesOf(b); return [...wants].every((w) => n.has(w)); };
  if (out && keepsNames(out)) return { data: out, full: false };
  if (src.length <= MAX_FULL_EMBED && keepsNames(src)) return { data: src, full: true };
  throw new Error(out ? 'zmenšený font ztratil jméno a celý je moc velký' : `zmenšení selhalo: ${err?.message}`);
}

const safeName = (s) => String(s).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 60) || 'font';

/**
 * Vloží chybějící fonty do .ass. Vstup i výstup jsou Buffery (bajty mimo vložený
 * blok zůstanou beze změny).
 * Vrací { state, out|null, embedded[], missing[], have[], note? }
 *   state: 'ok' (vše vloženo) | 'missing' (něco chybí i v knihovně) | 'none' (nic
 *          není potřeba — fonty už v souboru jsou / nic se nekreslí) | 'skip' (není ASS)
 */
export async function embedFonts(buf) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    return { state: 'skip', out: null, note: 'UTF-16 soubor', embedded: [], missing: [], have: [] };
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1250').decode(buf); }
  if (!/\[Script Info\]/i.test(text) || !/^[ \t]*\[Events\]/im.test(text)) {
    return { state: 'skip', out: null, note: 'není .ass', embedded: [], missing: [], have: [] };
  }

  const { styles, events } = parseAss(text);
  const used = usage(styles, events);
  const already = embeddedFaces(text);

  const groups = new Map();   // soubor#řez → { face, chars, wants }
  const missing = new Map();  // jméno (malými) → { font, lines }
  const have = new Set();
  for (const u of used.values()) {
    if (already.length && matchIn(already, u.name)) { have.add(u.name); continue; }
    const f = findFace(u.name, u.weight, u.italic);
    if (!f) {
      const k = u.name.toLowerCase();
      if (!missing.has(k)) missing.set(k, { font: u.name, lines: 0 });
      missing.get(k).lines += u.lines;
      continue;
    }
    const k = `${f.file}#${f.idx}`;
    if (!groups.has(k)) groups.set(k, { face: f, chars: new Set(), wants: new Set(), names: new Set() });
    const g = groups.get(k);
    for (const c of u.chars) g.chars.add(c);
    g.wants.add(u.name.toLowerCase());
    g.names.add(u.name);
  }

  const lines = [];
  const embedded = [];
  const usedNames = new Set();
  for (const g of groups.values()) {
    try {
      const { data, full } = await subsetFace(g.face, g.chars, g.wants);
      let name = `${safeName(path.basename(g.face.file))}_${g.face.idx >= 0 ? g.face.idx : 0}.${g.face.cff ? 'otf' : 'ttf'}`;
      while (usedNames.has(name)) name = `x${name}`;
      usedNames.add(name);
      lines.push(`fontname: ${name}`, ...uuencode(data));
      embedded.push({ font: [...g.names].join(', '), file: g.face.file, bytes: data.length, full });
    } catch (e) {
      for (const n of g.names) missing.set(n.toLowerCase(), { font: n, lines: 0, error: e.message });
    }
  }

  const miss = [...missing.values()];
  if (!lines.length) {
    return { state: miss.length ? 'missing' : 'none', out: null, embedded, missing: miss, have: [...have] };
  }
  // vložení před [Events] na úrovni bajtů — latin1 zachová pozice bajtů 1:1
  const latin = buf.toString('latin1');
  const m = /^[ \t]*\[Events\]/im.exec(latin);
  const nl = latin.includes('\r\n') ? '\r\n' : '\n';
  const block = Buffer.from(`[Fonts]${nl}${lines.join(nl)}${nl}${nl}`, 'latin1');
  const out = Buffer.concat([buf.subarray(0, m.index), block, buf.subarray(m.index)]);
  return { state: miss.length ? 'missing' : 'ok', out, embedded, missing: miss, have: [...have] };
}
