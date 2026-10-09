// notify.js — dá vědět jiným službám (anime addon), že přibyl nebo ubyl stažený titulek.
//
// PROČ: addon si „Dnes přidané" bral z /api/recent hodinovým cronem → nový titulek byl
// v katalogu vidět až za hodinu, a addon se ptal i ve dnech, kdy nic nepřibylo.
// Teď se ozve služba titulků sama a JEN když se opravdu něco změnilo. Cron v addonu
// zůstává jako záloha (addon neběžel, zpráva se ztratila…).
//
// KDY SE POSÍLÁ
//  • Dávka (hodinový běh / „jen stahování" z fronty, hromadné nahrání ZIPu):
//    během dávky se změny jen počítají, zpráva odejde JEDNOU na konci dávky — i když
//    dávka skončí chybou nebo vyčerpaným limitem (pošle se, co se stihlo). Dávka bez
//    změny nepošle nic.
//  • RUČNÍ nahrání po jednom (📤, hanabi odkaz, ⬇): čeká se, až má anime nahrané VŠECHNY
//    díly (v tomtéž jazyce) — katalog pak neukáže neúplné anime, které se po kouskách
//    doplňuje. Kontroluje se 30 s po posledním nahrání. Pojistka: když k anime 10 min
//    nic nepřibude (zbytek dílů zatím není), odejde zpráva s tím, co je.
//  • Ostatní jednotlivé akce (BD přečas, smazání, ♻…): sdružení 30 s po poslední změně,
//    nejpozději 5 min od první (hromadný BD přečas posílá prohlížeč díl po dílu).
//
// ODESLÁNÍ: POST na každou adresu z NOTIFY_URLS (oddělené čárkou), hlavička
// X-Notify-Token: NOTIFY_TOKEN, tělo {"event":"subs-changed","count":N}, timeout 5 s.
// Chyba (addon neběží, timeout) se jen zaloguje — stahování titulků jede dál.
// Bez NOTIFY_URLS modul nedělá nic.

const URLS = String(process.env.NOTIFY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = String(process.env.NOTIFY_TOKEN || '').trim();
const DEBOUNCE_MS = 30_000;      // sdružení jednotlivých akcí
const MAX_WAIT_MS = 300_000;     // ostatní akce: nejpozději 5 min od první čekající změny
const HOLD_IDLE_MS = 600_000;    // ruční nahrávání: pojistka 10 min bez dalšího dílu
const TIMEOUT_MS = 5_000;

let pending = 0;                 // počet změn od poslední odeslané zprávy
let batchDepth = 0;              // > 0 = běží dávka, posílá se až na jejím konci
let timer = null;
let autoFirstAt = 0;             // první čekající NE-ruční změna (pro 5min strop)
let autoLastAt = 0;              // poslední NE-ruční změna (pro 30s sdružení)
const holds = new Map();         // ruční nahrávání: klíč anime → čas posledního nahraného dílu
let manualKey = null;            // klíč anime právě probíhající ruční akce (viz asManualUpload)
let isIncomplete = () => false;  // dodá db.js: má anime ještě nenahrané díly?

if (URLS.length) {
  console.log(`[notify] zapnuto → ${URLS.length} ${URLS.length === 1 ? 'adresa' : 'adresy'}${TOKEN ? '' : ' (bez NOTIFY_TOKEN!)'}`);
}

/** Klíč anime pro čekání na kompletní anime: AniList → MAL → hiyori, + jazyk. */
export function manualKeyOf(sub) {
  if (!sub) return null;
  const lang = String(sub.lang || '');
  if (sub.anilist_id) return `al:${sub.anilist_id}:${lang}`;
  if (sub.mal_id) return `mal:${sub.mal_id}:${lang}`;
  if (sub.hiyori_id) return `hy:${sub.hiyori_id}:${lang}`;
  return null;
}

/** db.js sem předá kontrolu „má anime (klíč) ještě nenahrané díly?". */
export function setIncompleteCheck(fn) {
  if (typeof fn === 'function') isIncomplete = fn;
}

/**
 * Obal RUČNÍ akce (📤, hanabi odkaz, ⬇): změna, kterou `fn` vyvolá (markDownloaded),
 * počká, až bude anime kompletní. `fn` musí být synchronní (better-sqlite3 zápis).
 */
export function asManualUpload(key, fn) {
  const prev = manualKey;
  manualKey = key || null;
  try { return fn(); } finally { manualKey = prev; }
}

/** Přibyl/ubyl stažený titulek (volá db.js po úspěšném zápisu). */
export function notifySubsChanged(n = 1) {
  if (!URLS.length || !(n > 0)) return;
  pending += n;
  const now = Date.now();
  if (batchDepth > 0) return;    // dávka → odešle endSubsBatch()
  if (manualKey) {
    holds.set(manualKey, now);
  } else {
    if (!autoFirstAt) autoFirstAt = now;
    autoLastAt = now;
  }
  arm(Math.min(DEBOUNCE_MS, autoFirstAt ? autoFirstAt + MAX_WAIT_MS - now : DEBOUNCE_MS));
}

/** Začátek dávky (běh z fronty, hromadné nahrání). Volat VŽDY v páru s endSubsBatch (finally). */
export function beginSubsBatch() {
  batchDepth++;
  if (timer) { clearTimeout(timer); timer = null; }   // čekající změny pojedou s koncem dávky
}

/** Konec dávky — pošle jednu zprávu, pokud během ní (nebo před ní) něco přibylo. */
export function endSubsBatch() {
  batchDepth = Math.max(0, batchDepth - 1);
  if (batchDepth > 0 || !pending) return;
  if (timer) { clearTimeout(timer); timer = null; }
  flush();
}

function arm(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; onTimer(); }, Math.max(0, ms));
  timer.unref?.();
}

function onTimer() {
  if (!pending) return;
  const now = Date.now();
  // ruční nahrávání: anime kompletní nebo 10 min bez dalšího dílu → už nečekat
  for (const [key, last] of holds) {
    let incomplete = false;
    try { incomplete = isIncomplete(key); } catch (e) { console.warn(`[notify] kontrola ${key}: ${e.message}`); }
    if (!incomplete || now - last >= HOLD_IDLE_MS) holds.delete(key);
  }
  const autoDue = autoFirstAt && (now - autoLastAt >= DEBOUNCE_MS - 50 || now - autoFirstAt >= MAX_WAIT_MS);
  if (!holds.size || autoDue) { flush(); return; }
  // pořád se čeká na zbytek dílů: další kontrola při vypršení pojistky (nebo dřív, když
  // čeká i ne-ruční změna); nahrání dalšího dílu kontrolu stejně spustí za 30 s
  let next = Math.min(...[...holds.values()].map((last) => last + HOLD_IDLE_MS)) - now;
  if (autoFirstAt) next = Math.min(next, autoLastAt + DEBOUNCE_MS - now, autoFirstAt + MAX_WAIT_MS - now);
  const keys = [...holds.keys()].join(', ');
  console.log(`[notify] čekám na zbytek dílů (${keys}) — nejpozději za ${Math.round(next / 60000)} min`);
  arm(next);
}

async function flush() {
  if (!pending || !URLS.length) return;
  const count = pending;
  pending = 0;
  autoFirstAt = 0;
  autoLastAt = 0;
  holds.clear();
  const body = JSON.stringify({ event: 'subs-changed', count });
  await Promise.all(URLS.map(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Notify-Token': TOKEN } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) console.log(`[notify] ${url} ← ${count} ${count === 1 ? 'změna' : count < 5 ? 'změny' : 'změn'} (HTTP ${res.status})`);
      else console.warn(`[notify] ${url} odmítl zprávu: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[notify] ${url} nedostupné: ${e.message} — addon to dožene hodinovou zálohou`);
    }
  }));
}
