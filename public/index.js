// scraper/sources/index.js — dispatcher stahování z EXTERNÍCH webů podle domény.
// Zatím jen kostra: nové parsery přidáváš registrací do SOURCES.
// Každý parser: async (sub) => { buf, filename }  (nebo hodí chybu / vrátí null).
import * as wosir from './wosir.js';
import * as hns from './hns.js';
import * as hannyasubs from './hannyasubs.js';
import * as kamui from './kamui.js';
import * as underkotatsu from './underkotatsu.js';
import * as hanabi from './hanabi.js';
import * as hajimarisubs from './hajimarisubs.js';
import * as ange3mka from './ange3mka.js';
import * as gensubs from './gensubs.js';
import * as legiekondor from './legiekondor.js';

const SOURCES = {
  'wosir.cz': wosir,
  'hns.sk': hns,
  'hannya-subs.blogspot.com': hannyasubs,
  'kamui-subs.cz': kamui,
  'underkotatsusubs.cz': underkotatsu,
  'hanabi.fan': hanabi,
  'hajimarisubs.net': hajimarisubs,
  'ange.3mka.cz': ange3mka,
  'gensubs.cz': gensubs,
  'anime4.legiekondor.cz': legiekondor,
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
