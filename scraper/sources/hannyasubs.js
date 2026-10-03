// scraper/sources/hannyasubs.js — parser pro HannyaSubs (hannya-subs.blogspot.com).
//
// Struktura: Blogger článek s tabulkou epizod — sloupce č. | Název epizody | Link | Staženo.
// Sloupec "Link" má tlačítko Stáhnout → odkaz na MEGA (mega.nz/file/{id}#{klíč}).
// MEGA soubory jsou šifrované; dešifrování řeší knihovna megajs (klíč je za # v URL).
//
// hiyori u těchto titulků odkazuje na blogspot ČLÁNEK (ne přímo na soubor),
// takže z něj podle čísla epizody vytáhneme správný MEGA odkaz.
//
// MEGA soubor bývá i ZIP (na blogu „(Full i Split)" / „(Split)"):
//   full/   … celý díl v jednom .ass           → bereme tohle
//   split/  … díl rozdělený na 2 segmenty (S01Exx = 1. půlka, S00Exx = 2. půlka),
//             každý časovaný od 0:00 (pro releasy, které díl vydávají jako 2 videa)
//             → automaticky nejde spojit (neznámý posun) → chyba, nahrát ručně.

import * as cheerio from 'cheerio';
import { File as MegaFile } from 'megajs';
import AdmZip from 'adm-zip';
import { saveSubFile } from '../download.js';
import { CONFIG } from '../../config.js';
import { hostGate } from '../ratelimit.js';

export const name = 'hannya-subs.blogspot.com';

const MEGA_RE = /mega\.nz\/file\//i;

// GET blogspot článku s retry na přechodný rate-limit (Google 429/503): 2→4→8 s
async function fetchArticle(articleUrl) {
  const MAX = 3;
  for (let tries = 0; ; tries++) {
    await hostGate(articleUrl);
    const res = await fetch(articleUrl, {
      headers: { 'User-Agent': CONFIG.userAgent, 'Accept-Language': 'cs,sk;q=0.9' },
    });
    if (res.status === 429 || res.status === 503) {
      await res.text().catch(() => {});
      if (tries >= MAX) {
        throw new Error(`Blog nedostupný: HTTP ${res.status} i po ${MAX} pokusech (rate-limit) — zkusí se příště.`);
      }
      const wait = 2000 * Math.pow(2, tries); // 2s, 4s, 8s
      console.log(`  ⏳ hannya-subs HTTP ${res.status}, čekám ${wait / 1000}s a zkouším znovu (${tries + 1}/${MAX})…`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error('Blog nedostupný: HTTP ' + res.status);
    return res.text();
  }
}

// z blogspot článku udělá mapu {episode: megaUrl}. Výsledek si pamatuje 15 min —
// víc dílů téhož anime v jednom běhu = jeden dotaz na Blogspot (ten rád hází 429).
const ARTICLE_TTL_MS = 15 * 60 * 1000;
const articleCache = new Map(); // url -> { at, map }
async function episodeMap(articleUrl) {
  const hit = articleCache.get(articleUrl);
  if (hit && Date.now() - hit.at < ARTICLE_TTL_MS) return hit.map;
  const map = await parseArticle(articleUrl);
  articleCache.set(articleUrl, { at: Date.now(), map });
  return map;
}
async function parseArticle(articleUrl) {
  const html = await fetchArticle(articleUrl);
  const $ = cheerio.load(html);

  const map = {};
  $('a[href*="mega.nz/file"]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!MEGA_RE.test(href)) return;
    // číslo epizody = první buňka řádku, ve kterém odkaz je ("1." → 1)
    const tr = $(a).closest('tr');
    const firstCell = tr.find('td').first().text().replace(/\s+/g, ' ').trim();
    const ep = parseInt(firstCell, 10);
    if (!Number.isNaN(ep) && map[ep] == null) map[ep] = href;
  });
  return map;
}

// stáhne a dešifruje MEGA soubor → { buf, name }
async function megaDownload(megaUrl) {
  const file = MegaFile.fromURL(megaUrl);
  await file.loadAttributes(); // získá name + size
  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = file.download();
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { buf: Buffer.concat(chunks), name: file.name };
}

const SUB_RE = /\.(ass|ssa|srt)$/i;
const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b; // "PK"
const isRar = (b) => b.slice(0, 4).toString('latin1') === 'Rar!';
const is7z = (b) => b.length > 2 && b[0] === 0x37 && b[1] === 0x7a; // "7z"

// MEGA vrátí buď rovnou titulek, nebo ZIP → vyber z něj ten správný .ass
function pickSubtitle(buf, megaName, episode) {
  if (isRar(buf) || is7z(buf)) {
    throw new Error(`HannyaSubs: na MEGA je archiv ${isRar(buf) ? 'RAR' : '7z'} (${megaName}) — zatím neumím rozbalit, nahraj ručně.`);
  }
  if (!isZip(buf)) return { data: buf, name: megaName };

  const subs = new AdmZip(buf).getEntries()
    .filter((e) => !e.isDirectory && SUB_RE.test(e.entryName))
    .map((e) => ({ path: e.entryName.replace(/\\/g, '/'), entry: e }));
  const inFull = subs.filter((x) => /(^|\/)full\//i.test(x.path));
  const inSplit = subs.filter((x) => /(^|\/)split\//i.test(x.path));
  let pick = null;
  if (inFull.length === 1) pick = inFull[0];                      // 1) celý díl
  else if (subs.length === 1) pick = subs[0];                     // 2) jediný titulek v archivu
  else if (!inFull.length && inSplit.length && inSplit.length === subs.length) {
    throw new Error(`HannyaSubs: díl ${episode} je jen ve split verzi (rozdělený na 2 části: ${inSplit.map((x) => x.path.split('/').pop()).join(' + ')}) — nahraj ručně.`);
  }
  if (!pick) {
    throw new Error(`HannyaSubs: v archivu ${megaName} nevím, který titulek vzít (${subs.map((x) => x.path).join(', ') || 'žádný .ass/.srt'}) — nahraj ručně.`);
  }
  return { data: pick.entry.getData(), name: pick.path.split('/').pop() };
}

// hlavní vstup dispatcheru. Uloží soubor a vrátí {filename, local_path, file_bytes}.
export async function download(sub) {
  let megaUrl;
  if (MEGA_RE.test(sub.url || '')) {
    megaUrl = sub.url; // hiyori někdy může odkazovat přímo na MEGA
  } else {
    const map = await episodeMap(sub.url);
    megaUrl = map[sub.episode];
    if (!megaUrl) {
      throw new Error(
        `Na blogu není MEGA odkaz pro epizodu ${sub.episode} (možná ještě nevyšla).`
      );
    }
  }

  const { buf, name: megaName } = await megaDownload(megaUrl);
  const { data, name } = pickSubtitle(buf, megaName || '?', sub.episode);
  const rawName = name && SUB_RE.test(name) ? name : `hannyasubs-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, data, rawName);
}
