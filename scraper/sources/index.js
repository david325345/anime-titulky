// scraper/sources/index.js — dispatcher stahování z EXTERNÍCH webů podle domény.
// Zatím jen kostra: nové parsery přidáváš registrací do SOURCES.
// Každý parser: async (sub) => { buf, filename }  (nebo hodí chybu / vrátí null).
import * as wosir from './wosir.js';
import * as hns from './hns.js';
import * as hannyasubs from './hannyasubs.js';

const SOURCES = {
  'wosir.cz': wosir,
  'hns.sk': hns,
  'hannya-subs.blogspot.com': hannyasubs,
  // 'dalsi-web.cz': dalsiModul,
};

export function hasSourceFor(domain) {
  return !!(domain && SOURCES[domain] && SOURCES[domain].download);
}

// Vrátí { supported:false } pokud pro doménu ještě nemáme parser (necháme pending_extern).
export async function downloadExtern(sub) {
  const mod = sub.extern_domain ? SOURCES[sub.extern_domain] : null;
  if (!mod || !mod.download) {
    return { supported: false };
  }
  const result = await mod.download(sub);
  return { supported: true, ...result };
}
