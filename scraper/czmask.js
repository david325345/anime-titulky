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
//     a) KRÁTKÁ část mezi písněmi (do 40 replik, typicky úvod před openingem) se
//        váže na BLOK reference: v dialogové stopě BD je v místě písně dlouhá mezera
//        (≥ 30 s), takže část musí ležet celá v jednom bloku (±1 s). V těchto mezích
//        se vybere nejlepší oboustranná shoda (IoU). Samotná shoda bez té vazby je
//        u ~8 replik nejednoznačná (E7 úvod: alass −9,3 s, překryv +8,4 s, správně ~−1 s);
//     b) vyřazené řádky převezmou posun PŘEDCHOZÍ dialogové repliky (opening jde
//        s úvodem — skok −10 s za openingem je vystřižená TV cedulka sponzorů),
//        a když před nimi žádná není, posun NÁSLEDUJÍCÍ;
//     a2) plynulý posun: kde alass dělá jen malé schody (≤ 0,4 s, pomalé rozjíždění
//        časovače), posun v části proloží přímkou (ne přes skutečné střihy);
//     c) pojistka: úsek s posunem o desítky sekund jinak než okolí nebo do záporného
//        času se vrátí jako varování (do hlášky), nezůstane potichu rozbitý;
//     d) skóre: jak velkou část doby CZ replik pokrývají titulky reference, proti
//        „náhodné" shodě (hustota reference). Pod 1,2× náhody → ⚠ (env BD_SCORE_WARN).
//  Shoda se měří PŘEKRYVEM úseků, ne začátky — u husté reference trefí začátky
//  do 0,5 s i špatný posun (E7 úvod: −9,3 s trefil 5 z 8, správný jen 4).
//  Celý soubor se pak složí z ORIGINÁLU (zachová styly, pořadí, formát řádků).

const NOT_DIALOG = /sign|song|kara|\bop\b|\bed\b|title|note|typeset|lyric|credit|insert/i;
const SONG_GAP = 6000;        // řádky písně od sebe max. 6 s
const SONG_MIN_LINES = 8;
const SONG_MIN_LEN = 40000;   // ≥ 40 s
const WARN_JUMP = 30000;      // úsek jinak než okolí o > 30 s → varování
const SHORT_PART = 40;        // „krátká část" (úvod před openingem…) — ta se váže na blok reference
const BLOCK_GAP = 30000;      // mezera ≥ 30 s bez titulků v referenci = hranice bloku (píseň)
const BLOCK_TOL = 1000;       // část smí z bloku vyčnívat max. o 1 s
const AMBIG_RATIO = 0.9;      // posuny se shodou ≥ 90 % maxima…
const AMBIG_SPREAD = 1000;    // …pokrývající víc než 1 s = titulky nerozhodnou (0,5 s hlásilo i LvB E3 ±0,3 s)
const SCORE_WARN = Number(process.env.BD_SCORE_WARN) || 1.2;    // shoda < 1,2× náhodná → ⚠ (doladit podle reálných dílů)

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

// úseky replik [{s,e}] (ms) z textového titulku — SRT i ASS (jen Dialogue)
export function intervalsOf(text) {
  text = String(text).replace(/\r\n?/g, '\n');
  if (/-->/.test(text)) {
    return [...text.matchAll(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/g)]
      .map((m) => ({ s: ms(m[1], m[2], m[3], m[4]), e: ms(m[5], m[6], m[7], m[8]) }));
  }
  const a = parseAss(text);
  return a ? a.events.filter((x) => x.kind.toLowerCase() === 'dialogue').map((x) => ({ s: x.s, e: x.e })) : [];
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

// ── měřítko shody: PŘEKRYV časových úseků (jako alass), ne jen začátky ─────
// Pouhé „začátek do 0,5 s" u husté reference trefuje i náhodou (LvB E7 úvod:
// špatný posun −9,3 s trefil 5 z 8 replik, správný −0,9 s jen 4). Překryv doby,
// kdy CZ replika svítí, s dobou, kdy svítí titulek reference, rozliší jasně
// (12,7 s vs 8,7 s z 16 s).
const capDur = (s, e) => Math.min(Math.max(e - s, 0), 8000);
function mergeIv(iv) {                       // sjednocení úseků reference
  const a = iv.filter((x) => x.e > x.s).sort((x, y) => x.s - y.s), out = [];
  for (const x of a) { const l = out[out.length - 1]; if (l && x.s <= l.e) l.e = Math.max(l.e, x.e); else out.push({ s: x.s, e: x.e }); }
  return out;
}
function overlap(pairs, ref) {               // pairs: [[s,e]…] seřazené dle s; ref: sjednocené
  let sum = 0, j = 0;
  for (const [s, e0] of pairs) {
    const e = s + capDur(s, e0);
    if (e <= 0) continue;                      // před začátkem videa = nic
    while (j < ref.length && ref[j].e <= s) j++;
    for (let k = j; k < ref.length && ref[k].s < e; k++) sum += Math.min(e, ref[k].e) - Math.max(s, ref[k].s);
  }
  return sum;
}
const totalDur = (items) => items.reduce((a, x) => a + capDur(x.s, x.e), 0) || 1;
// repliky „před začátkem videa" (ns < 0, alass je ořízl) se počítají jako nulová shoda
const covNow = (items, ref) =>
  overlap(items.filter((x) => x.ns >= 0).sort((a, b) => a.ns - b.ns).map((x) => [x.ns, x.ns + capDur(x.s, x.e)]), ref) / totalDur(items);
const pct = (x) => `${Math.round(x * 100)} %`;
// „náhodná" shoda = jak hustě reference pokrývá čas v rozsahu CZ replik; skutečná
// shoda se s ní porovná (u cizí reference vyjde skoro stejně jako náhoda)
function baseline(items, ref) {
  const ok = items.filter((x) => x.ns >= 0);
  if (!ok.length) return 0;
  const a = Math.min(...ok.map((x) => x.ns)), b = Math.max(...ok.map((x) => x.ns));
  if (b <= a) return 0;
  let c = 0;
  for (const r of ref) c += Math.max(0, Math.min(b, r.e) - Math.max(a, r.s));
  return c / (b - a);
}
function scoreOf(items, ref) {
  const cov = covNow(items, ref), base = baseline(items, ref);
  const lift = base > 0 ? cov / base : 0;
  return { cov, base, lift, note: `shoda s referencí ${pct(cov)} (při náhodném posunu by byla ~${pct(base)})`,
    warn: lift < SCORE_WARN ? `nízká shoda s referencí (${pct(cov)}, náhodně ~${pct(base)}) — reference k titulku nejspíš nepasuje, zkontroluj celý díl` : null };
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
  // −1 = alass repliku ořízl na 0:00; menší záporný posun (do 1 s) jen tiše ořízneme
  const neg = items.filter((x) => x.ns === -1 || x.ns < -1000).length;
  const runs = runsOf(items.filter((x) => x.ns >= 0)), big = runs.filter((r) => r.n >= 15);
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

// Plynulý posun místo schodů: alass dělá u pomalého rozjíždění (jiné FPS/časovač)
// skoky ~0,26 s každé ~4 min. V části, kde jsou JEN takové malé skoky, posun
// proložím přímkou — když tím zbytky nepřekročí 0,35 s a shoda s referencí
// neklesne. Skutečný střih (skok > 0,4 s) přímkou nikdy nevyhlazuji.
function smoothDrift(part, ref) {
  const ok = part.filter((x) => x.ns >= 0);
  if (ok.length < 30) return null;
  const runs = runsOf(ok);
  if (runs.length < 2) return null;                        // jeden posun → není co hladit
  for (let i = 1; i < runs.length; i++) if (Math.abs(runs[i].d - runs[i - 1].d) > 400) return null;
  const n = ok.length, mx = ok.reduce((a, x) => a + x.s, 0) / n, my = ok.reduce((a, x) => a + (x.ns - x.s), 0) / n;
  let sxy = 0, sxx = 0;
  for (const x of ok) { sxy += (x.s - mx) * (x.ns - x.s - my); sxx += (x.s - mx) ** 2; }
  if (!sxx) return null;
  const k = sxy / sxx, q = my - k * mx;
  if (Math.abs(k) > 0.002) return null;                    // víc než 0,2 % → to není drift časovače
  if (ok.some((x) => Math.abs(x.ns - x.s - (q + k * x.s)) > 350)) return null;
  const before = ref ? covNow(part, ref) : null;
  const save = part.map((x) => [x.ns, x.ne]);
  for (const x of part) { if (x.ns < 0) continue; x.ns = Math.round(x.s + q + k * x.s); x.ne = Math.round(x.e + q + k * x.e); }
  if (ref && covNow(part, ref) < before - 0.02) { part.forEach((x, i) => { [x.ns, x.ne] = save[i]; }); return null; }
  return { from: q + k * ok[0].s, to: q + k * ok[n - 1].s };
}

// repliky, které alass ořízl na 0:00: posun k nule nesedí s posunem další repliky
function markClamped(items, ns, ne) {
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    x.ns = ns[i]; x.ne = ne[i];
    if (ns[i] !== 0 || x.s <= 500) continue;
    let d2 = null;
    for (let j = i + 1; j < items.length; j++) if (ns[j] > 0) { d2 = ns[j] - items[j].s; break; }
    if (d2 == null || Math.abs(-x.s - d2) > 500) { x.ns = -1; x.ne = -1; }
  }
}

// bloky reference = sjednocené úseky rozdělené mezerami ≥ BLOCK_GAP (tam bývají písně)
function blocksOf(ref) {
  const out = [];
  for (const r of ref) {
    const l = out[out.length - 1];
    if (l && r.s - l.e < BLOCK_GAP) { l.e = Math.max(l.e, r.e); l.iv.push(r); } else out.push({ s: r.s, e: r.e, iv: [r] });
  }
  for (const b of out) b.dur = b.iv.reduce((a, r) => a + (r.e - r.s), 0);
  return out;
}
// oboustranná shoda (IoU) části s blokem: penalizuje i titulky bloku bez protějšku
function iouWith(pairs, blk, czDur) {
  const ov = overlap(pairs, blk.iv);
  return ov / (czDur + blk.dur - ov || 1);
}
function fitInBlock(part, bloky) {
  if (!bloky.length) return null;
  const ok = part.filter((x) => x.ns >= 0);
  const ds = ok.map((x) => x.ns - x.s).sort((a, b) => a - b);
  const was = ds.length ? ds[ds.length >> 1] : null;
  const first = Math.min(...part.map((x) => x.s));
  const lastEnd = Math.max(...part.map((x) => x.s + capDur(x.s, x.e)));
  // blok, kam část umístil alass (největší překryv rozsahu), jinak nejbližší
  const a = first + (was ?? 0), b = lastEnd + (was ?? 0);
  let blk = null, bestSc = -Infinity;
  for (const k of bloky) {
    const ov = Math.min(b, k.e) - Math.max(a, k.s);
    const sc = ov > 0 ? ov : -Math.min(Math.abs(k.s - b), Math.abs(a - k.e));
    if (sc > bestSc) { bestSc = sc; blk = k; }
  }
  let lo = blk.s - BLOCK_TOL - first, hi = blk.e + BLOCK_TOL - lastEnd;
  // dlouhý blok (bez mezer) část skoro neomezí → hledej jen do ±30 s od posunu alassu
  if (was != null) { lo = Math.max(lo, was - 30000); hi = Math.min(hi, was + 30000); }
  if (lo > hi && blk.e - blk.s < lastEnd - first) return { skip: `část ${mmss(first)}–${mmss(lastEnd)} je delší než blok reference ${mmss(blk.s)}–${mmss(blk.e)} — ponechán posun alassu` };
  const base = [...part].sort((x, y) => x.s - y.s);
  const czDur = totalDur(part);
  let best = null;
  const krivka = [];                                       // shoda pro každý posun (po 0,1 s)
  for (let off = Math.ceil(lo / 100) * 100; off <= hi; off += 100) {
    const v = iouWith(base.map((x) => [x.s + off, x.e + off]), blk, czDur);
    krivka.push([off, v]);
    if (!best || v > best.v + 1e-9) best = { off, v, plato: [off] };
    else if (Math.abs(v - best.v) <= 1e-9) best.plato.push(off);
  }
  if (!best) return null;                                  // alass je mimo blok o víc než 30 s → nesahám
  const off = best.plato[best.plato.length >> 1];
  // NEJEDNOZNAČNOST: posuny se shodou ≥ 90 % maxima — když pokrývají víc než 0,5 s,
  // titulky samy nerozhodnou (LvB E7 úvod: plochá shoda −1,9 … +1,6 s)
  const dobre = krivka.filter(([, v]) => v >= best.v * AMBIG_RATIO).map(([o]) => o);
  const rozpeti = dobre.length ? [Math.min(...dobre), Math.max(...dobre)] : [off, off];
  // kolik titulků reference v místě části je (BD tam může mlčet / mít jen cedulky)
  const refN = blk.iv.filter((r) => r.e > first + off && r.s < lastEnd + off).length;
  const curPairs = ok.sort((x, y) => x.ns - y.ns).map((x) => [x.ns, x.ns + capDur(x.s, x.e)]);
  const curIou = iouWith(curPairs, blk, czDur);
  const inside = ok.length === part.length && ok.every((x) => x.ns >= blk.s - BLOCK_TOL && x.ns + capDur(x.s, x.e) <= blk.e + BLOCK_TOL);
  // změna, když alass část z bloku vystrčil (nebo ořízl), nebo když je v bloku výrazně líp
  const change = (!inside || best.v >= curIou + 0.1) && (was == null || Math.abs(off - was) > 300);
  return { off, iou: best.v, curIou, was, blk, change, inside, rozpeti, refN, lo, hi };
}

/**
 * Dočistí výsledek alassu a složí celý CZ soubor.
 * @param prep výsledek prepareCz (mode 'ass')
 * @param outputText výstup alassu pro odeslanou kopii
 * @param refIv úseky replik reference [{s,e}] v ms (nebo null → bez ověření částí a skóre)
 * @returns {{output, notes:string[], warnings:string[], score:number|null}|null} null = výstup nesedí (zkus postaru)
 */
export function finishCz(prep, outputText, refIv, opts = {}) {
  const forced = opts.forced || [];   // [{from, off, note}] — posun části určený podle zvuku
  const out = parseAss(String(outputText));
  if (!out) return null;
  const outEv = out.events;
  if (outEv.length !== prep.kept.length) return null;
  // alass ořezává záporné časy na 0:00 (DÉLKU repliky přitom nechá!) → takovou repliku
  // označ jako „před začátkem" (−1). Pozná se tak, že její posun nesedí s posunem
  // nejbližší další repliky (LvB E7: 0:00,9 / 4,7 / 7,0 → 0:00, další repliky −9,3 s).
  markClamped(prep.kept, outEv.map((o) => o.s), outEv.map((o) => o.e));

  const notes = [], warnings = [];
  if (prep.excluded) {
    notes.push(`z porovnání vyřazeno ${prep.excluded} řádků písní/cedulek` +
      (prep.songs.length ? ` (písně ${prep.songs.map((c) => `${mmss(c.s)}–${mmss(c.e)}`).join(', ')})` : ''));
  }

  const ref = refIv && refIv.length >= 20 ? mergeIv(refIv) : null;
  const hr = [-Infinity, ...prep.songs.map((c) => c.s), Infinity];
  const parts = [];
  for (let k = 0; k + 1 < hr.length; k++) parts.push(prep.kept.filter((x) => x.s >= hr[k] && x.s < hr[k + 1]));

  // a) KRÁTKÉ části mezi písněmi (úvod před openingem, mezihra…) — vazba na BLOK reference.
  //    V dialogové stopě BD je tam, kde je píseň, dlouhá mezera bez titulků. Krátká část
  //    CZ proto musí ležet CELÁ uvnitř jednoho bloku reference (mezi dlouhými mezerami).
  //    Samotná shoda (alass i překryv) je u ~8 replik proti husté referenci nejednoznačná
  //    (LvB E7 úvod: alass −9,3 s, překryv +8,4 s, správně ~−1 s).
  //    Kde titulky nerozhodnou, část se zapíše do audioParts (kandidát na srovnání
  //    podle zvuku) a do varování — zvuk zatím NEstahujeme, jen ukazujeme, kde by pomohl.
  const audioParts = [];
  if (ref) {
    const bloky = blocksOf(ref);
    for (const part of parts) {
      const n = part.length;
      if (n < 4 || n > SHORT_PART) continue;
      const od0 = Math.min(...part.map((x) => x.s));
      const f = forced.find((q) => Math.abs(q.from - od0) < 1);
      if (f) {                                   // posun určený podle zvuku (2. průchod)
        for (const x of part) { x.ns = x.s + f.off; x.ne = x.e + f.off; }
        notes.push(f.note);
        continue;
      }
      const r = fitInBlock(part, bloky);
      if (!r) continue;
      if (r.skip) { notes.push(r.skip); continue; }
      const proc = [];
      if (r.rozpeti[1] - r.rozpeti[0] > AMBIG_SPREAD) proc.push(`shoda je plochá ${sec(r.rozpeti[0])} … ${sec(r.rozpeti[1])}`);
      if (!r.inside) proc.push('alass ji vystrčil z bloku reference');
      if (r.refN < n / 2) proc.push(`reference tam má jen ${r.refN} titulků na ${n} replik`);
      if (r.change) {
        for (const x of part) { x.ns = x.s + r.off; x.ne = x.e + r.off; }
        notes.push(`část ${mmss(part[0].s)}–${mmss(part[n - 1].s)} (${n} replik): posun ${r.was != null ? `opraven z ${sec(r.was)} ` : ''}na ${sec(r.off)} ` +
          `(musí ležet v bloku reference ${mmss(r.blk.s)}–${mmss(r.blk.e)}; shoda ${pct(r.curIou)} → ${pct(r.iou)})`);
      }
      // jen „vystrčeno z bloku" po opravě už nevadí; nejednoznačnost a řídká reference ano
      const vazne = proc.filter((t) => !/vystrčil/.test(t));
      if (vazne.length) {
        const od = Math.min(...part.map((x) => x.s)), doo = Math.max(...part.map((x) => x.e));
        const pouzit = r.change || r.was == null ? r.off : r.was;          // posun, který opravdu platí
        audioParts.push({ from: od, to: doo, n, off: pouzit, range: r.rozpeti, lo: r.lo, hi: r.hi, reasons: proc });
        warnings.push(`krátká část ${mmss(od)}–${mmss(doo)} (${n} replik, posun ${sec(pouzit)}): ${proc.join('; ')} — ` +
          `podle titulků nejde spolehlivě určit, zkontroluj (tady by pomohlo srovnání podle zvuku)`);
      }
    }
  }

  // a2) plynulý posun místo schodů
  const hladke = [];
  for (const part of parts) { const r = smoothDrift(part, ref); if (r) hladke.push(r); }
  if (hladke.length) notes.push(`posun vyhlazen v ${hladke.length} ${hladke.length === 1 ? 'části' : 'částech'} ` +
    `(${hladke.map((r) => `${sec(r.from)} → ${sec(r.to)}`).join(', ')})`);

  // b) vyřazené řádky: posun předchozí dialogové repliky, jinak následující
  const keptByTime = [...prep.kept].filter((x) => x.ns >= 0).sort((a, b) => a.s - b.s);
  const shiftAt = (t) => {     // posun dialogu v čase t (předchozí replika; mezi dvěma s plynulým posunem)
    let ref1 = null;
    for (const k of keptByTime) { if (k.s <= t) ref1 = k; else { if (!ref1) ref1 = k; break; } }
    return ref1 ? ref1.ns - ref1.s : 0;
  };
  for (const x of prep.ev) {
    if (!x.out) continue;
    const d = shiftAt(x.s);
    x.ns = x.s + d; x.ne = x.e + d;
  }

  // c) pojistka + skóre jistoty
  warnings.push(...warningsFor(prep.kept));
  let score = null;
  if (ref) {
    const sc = scoreOf(prep.kept, ref);
    score = Math.round(sc.cov * 100);
    notes.push(sc.note);
    if (sc.warn) warnings.push(sc.warn);
  }

  // složit celý soubor z originálu
  const lines = [...prep.ass.lines];
  for (const x of prep.ev) {
    const f = [...x.f];
    f[prep.ass.iS] = fmtAss(x.ns);
    f[prep.ass.iE] = fmtAss(Math.max(x.ne, x.ns));
    const lead = (lines[x.li].match(/^\s*/) || [''])[0];
    lines[x.li] = `${lead}${x.kind}: ${f.join(',')}`;
  }
  return { output: lines.join('\n'), notes, warnings, score, audioParts };
}

// Úloha pro službu audiosync: výřez zvuku kolem části (±10 s) v čase VIDEA a titulky
// části s časy relativně k začátku výřezu (s dnešním posunem). Výsledný posun části
// = ap.off + offset_ms z LAPSE.
const AUDIO_PAD = 10000, AUDIO_MAX = 180000;
export function audioJob(prep, ap) {
  const lines = prep.kept.filter((x) => x.s >= ap.from && x.s <= ap.to).sort((a, b) => a.s - b.s);
  if (lines.length < 3) return null;
  const w0 = Math.max(0, ap.from + ap.off - AUDIO_PAD);
  const w1 = Math.max(...lines.map((x) => x.e)) + ap.off + AUDIO_PAD;
  if (w1 - w0 > AUDIO_MAX) return null;
  const f = (v) => { v = Math.max(0, Math.round(v)); return `${pad(Math.floor(v / 3600000))}:${pad(Math.floor(v / 60000) % 60)}:${pad(Math.floor(v / 1000) % 60)},${pad(v % 1000, 3)}`; };
  const srt = lines.map((x, i) => {
    const txt = x.text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').trim() || '.';
    return `${i + 1}\n${f(x.s + ap.off - w0)} --> ${f(x.e + ap.off - w0)}\n${txt}\n`;
  }).join('\n');
  return { start_ms: Math.round(w0), dur_ms: Math.round(w1 - w0), srt, cues: lines.length };
}

/** Jen kontrola výsledku (SRT/postaru): porovná vstup a výstup replik po pořadí (+ skóre). */
export function checkOnly(czBuf, outputText, refIv = null) {
  const A = intervalsOf(decodeText(czBuf)), B = intervalsOf(String(outputText));
  if (!A.length || A.length !== B.length) return { warnings: [], notes: [], score: null };
  // záporné časy alass ořízne na 0:00 → pozná se podle nesouladu s další replikou
  const items = A.map((a) => ({ s: a.s, e: a.e }));
  markClamped(items, B.map((b) => b.s), B.map((b) => b.e));
  const warnings = warningsFor(items), notes = [];
  let score = null;
  if (refIv && refIv.length >= 20) {
    const sc = scoreOf(items, mergeIv(refIv));
    score = Math.round(sc.cov * 100);
    notes.push(sc.note);
    if (sc.warn) warnings.push(sc.warn);
  }
  return { warnings, notes, score };
}
