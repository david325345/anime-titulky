// scraper/ratelimit.js — per-web (per-doména) rozestup mezi requesty.
// Každá doména má vlastní frontu: dva requesty na TÝŽ web nejdou blíž než perHostDelayMs.
// Requesty na RŮZNÉ weby se navzájem nezdržují.
import { CONFIG } from '../config.js';

// doména -> Promise posledního naplánovaného slotu
const chains = new Map();

function hostOf(urlOrHost) {
  try {
    if (/^https?:\/\//i.test(urlOrHost)) return new URL(urlOrHost).hostname.replace(/^www\./, '');
  } catch {}
  return String(urlOrHost).replace(/^www\./, '');
}

// Zavolej PŘED requestem: await hostGate(url). Zajistí min. rozestup pro danou doménu.
export async function hostGate(urlOrHost) {
  const delay = CONFIG.perHostDelayMs;
  if (!delay || delay <= 0) return;
  const host = hostOf(urlOrHost);

  const prev = chains.get(host) || Promise.resolve(0);
  // naplánuj svůj slot: počkej na předchozí, pak drž doménu obsazenou po dobu delay
  const mine = prev.then(async (lastEnd) => {
    const now = Date.now();
    const wait = Math.max(0, (lastEnd || 0) - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return Date.now() + delay; // kdy se uvolní slot pro další request na tuto doménu
  });
  chains.set(host, mine);
  await mine;
}
