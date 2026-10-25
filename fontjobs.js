// fontjobs.js — verze titulků s vloženými fonty (R2 + evidence v DB).
//
// KDY SE FONTY VKLÁDAJÍ
//  • Nově uložený titulek (stažení, 📤, ZIP, hanabi odkaz, BD přečas): automaticky
//    na pozadí hned po uložení (háček z db.js).
//  • Starší titulky: až když si je addon vyžádá (GET /api/subs s číslem dílu) — poprvé
//    se zpracují, addon čeká nejvýš FONTS_BUDGET_MS (3 s), jinak dostane zatím originál
//    a fonty se dodělají na pozadí. Hromadně se nic nezpracovává.
//  • Ručně tlačítkem 🔤 v dashboardu.
//
// JAK
//  • Originál na R2 zůstává. Verze s fonty se uloží vedle pod novým klíčem
//    (…/123__nazev.fonts-<hash>.ass.gz) a addon dostává tu. Nový klíč zároveň obejde
//    cache Cloudflare. Nic se nemění na tom, kolik titulků addon vidí.
//  • Výsledek platí jen pro soubor, ze kterého vznikl (r2_key). Když se titulek změní
//    (♻, nové 📤, přečas), zpracuje se znovu. Titulky s chybějícími fonty se zkusí znovu,
//    až se změní knihovna fontů (nahraješ nové fonty).

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { r2Enabled, r2Get, r2Put, r2Delete } from './r2.js';
import {
  getSub, getAkiSub, getSubFonts, setSubFonts, dropSubFonts, setFontHooks, subFontsServed,
} from './db.js';
import { library, embedFonts } from './fonts.js';

const ASS_KEY = /\.(ass|ssa)(\.gz)?$/i;
const RETRY_ERROR_MS = 60 * 60 * 1000;  // po chybě (třeba výpadek R2) zkusit znovu nejdřív za hodinu
const PARALLEL = 2;

export const fontsEnabled = () => r2Enabled() && library().faces.length > 0;
export const isAssKey = (key) => ASS_KEY.test(String(key || ''));

// klíč verze s fonty: subs/al/1/E1/123__x.ass.gz → subs/al/1/E1/123__x.fonts-<hash>.ass.gz
const fontsKeyFor = (key, hash) =>
  /\.gz$/i.test(key)
    ? key.replace(/(\.(?:ass|ssa))?\.gz$/i, (_, ext = '') => `.fonts-${hash}${ext}.gz`)
    : `${key}.fonts-${hash}.gz`;

// Platí uložený výsledek pro tenhle soubor?
export function isFresh(fr, r2Key) {
  if (!fr || fr.r2_key !== r2Key) return false;
  if (fr.state === 'missing' && fr.lib_version !== library().version) return false;
  if (fr.state === 'error' && Date.now() - Date.parse(fr.at || 0) > RETRY_ERROR_MS) return false;
  return true;
}

// aktuální soubor titulku (null = titulek už není / není stažený)
function currentKey(src, id) {
  if (src === 'aki') return getAkiSub(id)?.r2_key || null;
  const s = getSub(id);
  return s && s.status === 'downloaded' ? s.r2_key || null : null;
}

// ── fronta (nejvýš 2 naráz, stejný titulek se nezpracovává dvakrát současně) ──
let active = 0;
const waiting = [];
const inflight = new Map();
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (active < PARALLEL) run(); else waiting.push(run);
  });
}

/** Vloží fonty do jednoho titulku (když už platný výsledek je, jen ho vrátí). */
export function ensureFonts(src, id, { force = false } = {}) {
  const k = `${src}:${id}`;
  if (inflight.has(k)) {
    if (!force) return inflight.get(k);
    // titulek se změnil během zpracování → po doběhnutí ještě jednou
    return inflight.get(k).catch(() => {}).then(() => ensureFonts(src, id, { force: true }));
  }
  const p = limited(() => processSub(src, Number(id), force)).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function processSub(src, id, force) {
  if (!fontsEnabled()) return { state: 'off' };
  const key = currentKey(src, id);
  if (!key) return { state: 'gone' };
  const prev = getSubFonts(src, id);
  if (!force && isFresh(prev, key)) return prev;

  const lib = library();
  const base = { src, sub_id: id, r2_key: key, lib_version: lib.version, at: new Date().toISOString() };
  if (!isAssKey(key)) {
    setSubFonts({ ...base, state: 'skip', note: 'není .ass' });
    return getSubFonts(src, id);
  }
  try {
    const gz = await r2Get(key);
    if (!gz) throw new Error('soubor na R2 chybí');
    const r = await embedFonts(zlib.gunzipSync(gz));
    let fontsKey = null;
    let fontsBytes = null;
    if (r.out) {
      const hash = crypto.createHash('sha1').update(r.out).digest('hex').slice(0, 10);
      fontsKey = fontsKeyFor(key, hash);
      if (fontsKey !== prev?.fonts_key) await r2Put(fontsKey, zlib.gzipSync(r.out), 'application/gzip');
      fontsBytes = r.out.length;
    }
    if (prev?.fonts_key && prev.fonts_key !== fontsKey) {
      r2Delete(prev.fonts_key).catch((e) => console.warn(`[fonty] mazání staré verze ${prev.fonts_key}: ${e.message}`));
    }
    setSubFonts({
      ...base,
      fonts_key: fontsKey,
      fonts_bytes: fontsBytes,
      state: r.state,
      embedded: JSON.stringify(r.embedded || []),
      missing: JSON.stringify(r.missing || []),
      note: r.note || null,
    });
    const emb = [...new Set((r.embedded || []).map((e) => e.font))].join(', ');
    const miss = [...new Set((r.missing || []).map((m) => m.font))].join(', ');
    console.log(`[fonty] ${src}:${id} ${r.state}${emb ? ` · vloženo: ${emb}` : ''}${miss ? ` · chybí: ${miss}` : ''}`);
  } catch (e) {
    // starou verzi s fonty necháme, pokud pořád patří k tomuhle souboru
    const keep = prev?.r2_key === key ? prev : null;
    setSubFonts({
      ...base,
      fonts_key: keep?.fonts_key || null,
      fonts_bytes: keep?.fonts_bytes || null,
      state: 'error',
      embedded: keep?.embedded || null,
      missing: keep?.missing || null,
      note: String(e.message).slice(0, 300),
    });
    console.warn(`[fonty] ${src}:${id} chyba: ${e.message}`);
  }
  return getSubFonts(src, id);
}

/**
 * Addon si vyžádal titulky (/api/subs s dílem): zpracuj ty, které ještě zpracované
 * nejsou, a počkej nejvýš budgetMs. Co nestihne, doběhne na pozadí.
 */
export async function ensureFontsFor(rows, budgetMs) {
  if (!fontsEnabled()) return;
  const todo = rows.filter((r) => r.src && isAssKey(r.r2_key) && !isFresh(getSubFonts(r.src, r.sub_id), r.r2_key));
  if (!todo.length) return;
  const all = Promise.allSettled(todo.map((r) => ensureFonts(r.src, r.sub_id)));
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(res, budgetMs); timer.unref?.(); });
  await Promise.race([all, timeout]);
  clearTimeout(timer);
}

/**
 * Který soubor dát addonu: verze s fonty, pokud k aktuálnímu souboru existuje.
 * rows = [{src, sub_id, r2_key}] → Map 'src:id' → { key, bytes } (jen titulky s fonty)
 * Bez rows = všechny (pro /api/all).
 */
export function servedFonts(rows = null) {
  const map = subFontsServed(rows ? rows.filter((r) => r.src) : null);
  const out = new Map();
  for (const [k, fr] of map) {
    if (fr.fonts_key) out.set(k, { key: fr.fonts_key, bytes: fr.fonts_bytes, r2_key: fr.r2_key });
  }
  return {
    get(r) {
      const f = out.get(`${r.src}:${r.sub_id}`);
      return f && f.r2_key === r.r2_key ? f : null;
    },
  };
}

// ── háčky z db.js ────────────────────────────────────────────────────────────
setFontHooks({
  // nově uložený / změněný titulek → vložit fonty hned (na pozadí)
  saved(src, id) {
    if (!fontsEnabled()) return;
    ensureFonts(src, id, { force: true }).catch((e) => console.warn(`[fonty] ${src}:${id}: ${e.message}`));
  },
  // soubor titulku zmizel (♻ / smazání) → smazat i verzi s fonty
  dropped(src, id) {
    const old = dropSubFonts(src, id);
    if (old?.fonts_key) r2Delete(old.fonts_key).catch((e) => console.warn(`[fonty] mazání ${old.fonts_key}: ${e.message}`));
  },
});
