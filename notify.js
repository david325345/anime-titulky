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
//  • Jednotlivé akce mimo dávku (⬇, 📤, hanabi odkaz, BD přečas, smazání…): sdružení
//    30 s po poslední změně, nejpozději ale 5 min od první (hromadný BD přečas posílá
//    prohlížeč díl po dílu, server konec dávky nezná).
//
// ODESLÁNÍ: POST na každou adresu z NOTIFY_URLS (oddělené čárkou), hlavička
// X-Notify-Token: NOTIFY_TOKEN, tělo {"event":"subs-changed","count":N}, timeout 5 s.
// Chyba (addon neběží, timeout) se jen zaloguje — stahování titulků jede dál.
// Bez NOTIFY_URLS modul nedělá nic.

const URLS = String(process.env.NOTIFY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = String(process.env.NOTIFY_TOKEN || '').trim();
const DEBOUNCE_MS = 30_000;      // sdružení jednotlivých akcí
const MAX_WAIT_MS = 300_000;     // …ale nejpozději 5 min od první čekající změny
const TIMEOUT_MS = 5_000;

let pending = 0;                 // počet změn od poslední odeslané zprávy
let batchDepth = 0;              // > 0 = běží dávka, posílá se až na jejím konci
let timer = null;
let firstPendingAt = 0;

if (URLS.length) {
  console.log(`[notify] zapnuto → ${URLS.length} ${URLS.length === 1 ? 'adresa' : 'adresy'}${TOKEN ? '' : ' (bez NOTIFY_TOKEN!)'}`);
}

/** Přibyl/ubyl stažený titulek (volá db.js po úspěšném zápisu). */
export function notifySubsChanged(n = 1) {
  if (!URLS.length || !(n > 0)) return;
  pending += n;
  if (!firstPendingAt) firstPendingAt = Date.now();
  if (batchDepth > 0) return;    // dávka → odešle endSubsBatch()
  schedule();
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

function schedule() {
  if (timer) clearTimeout(timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - Date.now()));
  timer = setTimeout(() => { timer = null; flush(); }, wait);
  timer.unref?.();
}

async function flush() {
  if (!pending || !URLS.length) return;
  const count = pending;
  pending = 0;
  firstPendingAt = 0;
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
