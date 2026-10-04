// scraper/czmask.js — příprava CZ titulku pro alass a dočištění výsledku.
//
// PROČ (4.10., Ladies versus Butlers E7): reference z BD je čistý DIALOG (PGS/ASS
// dialogová stopa, bez písní a cedulek). CZ titulek ale obsahuje i opening/ending
// (romaji + český překlad textu — ten bývá ve stylu Default!) a cedulky. alass pak
// hustý blok openingu „přilepí" na hustý úvod reference a skutečný úvod vystrčí do
// záporného času (E7: −70 až −95 s). Jiné nástroje (subflux, Nuvio AutoSync) to řeší
// stejně: písně/cedulky z porovnání vyřadit a výsledek ověřit konstantním posunem.
//
// POSTUP (jen CZ v ASS; SRT jde postaru, jen s kontrolou):
//  1) prepareCz — úseky písní = husté shluky ne-dialogových řádků (styl Sign/Song/OP/ED/
//     karaoke… nebo \k tagy; ≥ 8 řádků za ≥ 40 s). Z kopie pro alass se vyřadí VŠE
//     v těchto úsecích (i překlad textu) + ostatní ne-dialogové řádky (cedulky).
//  2) finishCz — po alassu:
//     a) každá část mezi písněmi (úvod, část A, část B…) se ověří proti referenci:
//        když jeden konstantní posun trefí výrazně víc replik než výsledek alassu,
//        použije se ten (E7: úvod −9,3 s → −0,9 s; alass ho přilepil k části A);
//     b) vyřazené řádky převezmou posun PŘEDCHOZÍ dialogové repliky (opening jde
//        s úvodem — skok −10 s za openingem je vystřižená TV cedulka sponzorů),
//        a když před nimi žádná není, posun NÁSLEDUJÍCÍ;
//     c) pojistka: úsek s posunem o desítky sekund jinak než okolí nebo do záporného
//        času se vrátí jako varování (do hlášky), nezůstane potichu rozbitý.
//  Celý soubor se pak složí z ORIGINÁLU (zachová styly, pořadí, formát řádků).

const NOT_DIALOG = /sign|song|kara|\bop\b|\bed\b|title|note|typeset|lyric|credit|insert/i;
const SONG_GAP = 6000;        // řádky písně od sebe max. 6 s
const SONG_MIN_LINES = 8;
const SONG_MIN_LEN = 40000;   // ≥ 40 s
const HIT_TOL = 500;          // replika „trefí" referenci do 0,5 s
const WARN_JUMP = 30000;      // úsek jinak než okolí o > 30 s → varování

const ms = (h, m, s, f) => ((+h * 60 + +m) * 60 + +s) * 1000 + Math.round(+(`0.${f}`) * 1000);
const parseTime = (x) => { const t = String(x).trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/); return t ? ms(t[1], t[2], t[3], t[4]) : null; };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtAss = (t) => { const c = Math.round(Math.max(0, t) / 10); return `${Math.floor(c / 360000)}:${pad(Math.floor(c / 6000) % 60)}:${pad(Math.floor(c / 100) % 60)}.${pad(c % 100)}`; };
export const mmss = (t) => `${t < 0 ? '−' : ''}${Math.floor(Math.abs(t) / 60000)}:${pad(Math.floor(Math.abs(t) / 1000) % 60)}`;
const sec = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(d / 1000).toFixed(1).replace('.', ',')} s`;

export function decodeText(buf) {
  if (typeof buf === 'string') return buf;
  let b = Buffer.from(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1250').decode(b); }
}

// ASS → { lines, events:[{li, kind, f, s, e, style, text}], iS, iE } nebo null
function parseAss(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const evIdx = lines.findIndex((l) => /^\s*\[events\]/i.test(l));
  if (evIdx < 0) return null;
  const fmtLine = lines.slice(evIdx + 1).find((l) => /^\s*format\s*:/i.test(l));
  const cols = (fmtLine || 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
    .replace(/^\s*format\s*:/i, '').split(',').map((c) => c.trim().toLowerCase());
  const iS = cols.indexOf('start'), iE = cols.indexOf('end'), iSt = cols.indexOf('style'), iT = cols.length - 1;
  if (iS < 0 || iE < 0) return null;
  const events = [];
  for (let li = evIdx + 1; li < lines.length; li++) {
    const m = lines[li].match(/^(\s*)(Dialogue|Comment)\s*:\s?(.*)$/i);
    if (!m) continue;
    const parts = m[3].split(',');
    if (parts.length < cols.length) continue;
    const f = [...parts.slice(0, iT), parts.slice(iT).join(',')];
    const s = parseTime(f[iS]), e = parseTime(f[iE]);
    if (s == null || e == null) continue;
    events.push({ li, kind: m[2], f, s, e, style: iSt >= 0 ? f[iSt] || '' : '', text: f[iT] || '' });
  }
  return { lines, events, iS, iE };
}

// časy začátků (ms) z textového titulku (reference) — SRT i ASS
export function startsOf(text) {
  text = String(text).replace(/\r\n?/g, '\n');
  if (/-->/.test(text)) return [...text.matchAll(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->/g)].map((m) => ms(m[1], m[2], m[3], m[4]));
  const a = parseAss(text);
  return a ? a.events.filter((x) => x.kind.toLowerCase() === 'dialogue').map((x) => x.s) : [];
}

/** Připraví kopii CZ pro alass. Vrací { mode:'ass', sendBuf, … } nebo { mode:'plain' }. */
export function prepareCz(czBuf, czName) {
  if (/\.srt$/i.test(czName || '')) return { mode: 'plain' };
  const text = decodeText(czBuf);
  const ass = parseAss(text);
  if (!ass || ass.events.length < 10) return { mode: 'plain' };

  const ev = ass.events.map((x) => ({
    ...x, nd: x.kind.toLowerCase() === 'comment' || NOT_DIALOG.test(x.style) || /\\k/i.test(x.text),
  }));
  const nd = ev.filter((x) => x.nd && x.kind.toLowerCase() !== 'comment').sort((a, b) => a.s - b.s);
  const shluky = [];
  for (const x of nd) {
    const c = shluky[shluky.length - 1];
    if (c && x.s - c.e <= SONG_GAP) { c.e = Math.max(c.e, x.e); c.n++; }
    else shluky.push({ s: x.s, e: x.e, n: 1 });
  }
  const songs = shluky.filter((c) => c.n >= SONG_MIN_LINES && c.e - c.s >= SONG_MIN_LEN);
  const inSong = (t) => songs.some((c) => t >= c.s - 1000 && t <= c.e + 1000);
  for (const x of ev) x.out = x.nd || inSong(x.s);

  const kept = ev.filter((x) => !x.out);
  if (kept.length < 10) return { mode: 'plain' };       // skoro nic by nezbylo → postaru
  const drop = new Set(ev.filter((x) => x.out).map((x) => x.li));
  const sendText = ass.lines.filter((l, i) => !drop.has(i)).join('\n');
  return {
    mode: 'ass', ass, ev, kept, songs,
    excluded: ev.length - kept.length,
    sendBuf: Buffer.from(sendText, 'utf8'),
  };
}

function hitsFor(times, refSorted) {
  let hit = 0, j = 0;
  const t = [...times].sort((a, b) => a - b);
  for (const x of t) {
    while (j < refSorted.length && refSorted[j] < x - HIT_TOL) j++;
    if (j < refSorted.length && Math.abs(refSorted[j] - x) <= HIT_TOL) hit++;
  }
  return hit;
}
function bestConstant(origStarts, refSorted) {
  // nejvíc trefených replik; ze všech posunů se stejným maximem vezmi STŘED
  // (tolerance ±0,5 s dělá „plato" — jeho kraj by byl o půl sekundy vedle)
  let max = -1, offs = [];
  for (let off = -150000; off <= 150000; off += 100) {
    const h = hitsFor(origStarts.map((x) => x + off), refSorted);
    if (h > max) { max = h; offs = [off]; } else if (h === max) offs.push(off);
  }
  // více oddělených plat → to nejblíž nule (nejméně odvážné)
  const plata = [];
  for (const o of offs) { const p = plata[plata.length - 1]; if (p && o - p[p.length - 1] <= 100) p.push(o); else plata.push([o]); }
  const best = plata.reduce((a, b) => (Math.abs(b[b.length >> 1]) < Math.abs(a[a.length >> 1]) ? b : a));
  return { off: best[best.length >> 1], hit: max };
}
// úseky stejného posunu (tolerance 250 ms) přes repliky seřazené dle původního času
function runsOf(items) {
  const u = [];
  for (const x of [...items].sort((a, b) => a.s - b.s)) {
    const d = x.ns - x.s, l = u[u.length - 1];
    if (l && Math.abs(d - l.d) <= 250) { l.n++; l.do = x.s; } else u.push({ d, n: 1, od: x.s, do: x.s });
  }
  return u;
}
function warningsFor(items) {
  const warn = [];
  const neg = items.filter((x) => x.ns < 0).length;
  const runs = runsOf(items), big = runs.filter((r) => r.n >= 15);
  for (const r of runs) {
    if (r.n < 3 || r.n >= 15 || !big.length) continue;
    const near = big.reduce((a, b) => (Math.abs(b.od - r.od) < Math.abs(a.od - r.od) ? b : a));
    if (Math.abs(r.d - near.d) > WARN_JUMP) {
      warn.push(`repliky ${mmss(r.od)}–${mmss(r.do)} (${r.n}) posunuté o ${sec(r.d)}, okolí o ${sec(near.d)} — zkontroluj`);
    }
  }
  if (neg) warn.push(`${neg} replik by vyšlo před začátek videa (oříznuto na 0:00) — úvod nejspíš nesedí`);
  return warn;
}

/**
 * Dočistí výsledek alassu a složí celý CZ soubor.
 * @param prep výsledek prepareCz (mode 'ass')
 * @param outputText výstup alassu pro odeslanou kopii
 * @param refStarts začátky replik reference v ms (nebo null → bez ověření částí)
 * @returns {{output, notes:string[], warnings:string[]}|null} null = výstup nesedí (zkus postaru)
 */
export function finishCz(prep, outputText, refStarts) {
  const out = parseAss(String(outputText));
  if (!out) return null;
  const outEv = out.events;
  if (outEv.length !== prep.kept.length) return null;
  // alass ořezává záporné časy na 0:00 → takovou repliku označ jako „před začátkem" (−1)
  prep.kept.forEach((x, i) => { const z = outEv[i].s === 0 && x.s > 500; x.ns = z ? -1 : outEv[i].s; x.ne = z ? -1 : outEv[i].e; });

  const notes = [];
  if (prep.excluded) {
    notes.push(`z porovnání vyřazeno ${prep.excluded} řádků písní/cedulek` +
      (prep.songs.length ? ` (písně ${prep.songs.map((c) => `${mmss(c.s)}–${mmss(c.e)}`).join(', ')})` : ''));
  }

  // a) ověření částí mezi písněmi konstantním posunem proti referenci
  const ref = refStarts && refStarts.length >= 20 ? [...refStarts].sort((a, b) => a - b) : null;
  if (ref) {
    const hr = [-Infinity, ...prep.songs.map((c) => c.s), Infinity];
    for (let k = 0; k + 1 < hr.length; k++) {
      const part = prep.kept.filter((x) => x.s >= hr[k] && x.s < hr[k + 1]);
      const n = part.length;
      if (n < 4) continue;
      const cur = hitsFor(part.map((x) => x.ns), ref);
      const best = bestConstant(part.map((x) => x.s), ref);
      if (best.hit >= Math.max(4, Math.ceil(n * 0.5)) && best.hit >= cur + Math.max(2, Math.ceil(n * 0.25))) {
        const was = part.map((x) => x.ns - x.s).sort((a, b) => a - b)[n >> 1];
        for (const x of part) { x.ns = x.s + best.off; x.ne = x.e + best.off; }
        notes.push(`část ${mmss(part[0].s)}–${mmss(part[n - 1].s)} (${n} replik): posun opraven z ${sec(was)} na ${sec(best.off)} ` +
          `(sedí ${best.hit} z ${n} replik místo ${cur})`);
      }
    }
  }

  // b) vyřazené řádky: posun předchozí dialogové repliky, jinak následující
  const keptByTime = [...prep.kept].sort((a, b) => a.s - b.s);
  for (const x of prep.ev) {
    if (!x.out) continue;
    let ref1 = null;
    for (const k of keptByTime) { if (k.s <= x.s) ref1 = k; else { if (!ref1) ref1 = k; break; } }
    const d = ref1 ? ref1.ns - ref1.s : 0;
    x.ns = x.s + d; x.ne = x.e + d;
  }

  // c) pojistka
  const warnings = warningsFor(prep.kept);

  // složit celý soubor z originálu
  const lines = [...prep.ass.lines];
  for (const x of prep.ev) {
    const f = [...x.f];
    f[prep.ass.iS] = fmtAss(x.ns);
    f[prep.ass.iE] = fmtAss(Math.max(x.ne, x.ns));
    const lead = (lines[x.li].match(/^\s*/) || [''])[0];
    lines[x.li] = `${lead}${x.kind}: ${f.join(',')}`;
  }
  return { output: lines.join('\n'), notes, warnings };
}

/** Jen kontrola výsledku (SRT/postaru): porovná vstup a výstup replik po pořadí. */
export function checkOnly(czBuf, outputText) {
  const a = decodeText(czBuf), b = String(outputText);
  const A = startsOf(a), B = startsOf(b);
  if (!A.length || A.length !== B.length) return [];
  // záporné časy alass ořízne na 0 → „posun" k nule u repliky, co původně nebyla na 0
  const items = A.map((s, i) => ({ s, ns: B[i] === 0 && s > 0 ? -1 : B[i] }));
  return warningsFor(items);
}
