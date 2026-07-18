// scraper/sources/nyasub.js — parser pro nyasub.cz (skupina NyāSub).
//
// Web jde ze serveru přímo (nginx, bez loginu). Používá WordPress Download
// Manager (wpdm): download odkazy mají ?wpdmdl=<id>&masterkey=<token>.
// masterkey je POVINNÝ a časově omezený → nesmíme spoléhat na uložený odkaz.
//
// hiyori odkazuje na STRÁNKU anime: https://nyasub.cz/hotove-preklady/<slug>/
// Parser proto načte stránku a vezme ČERSTVÝ masterkey pro daný díl.
// Download vrací ZIP s jedním .ass uvnitř → rozbalíme (adm-zip).
//
// Číslo dílu je v URL: "...-<slug>-01-1080p-<hash>/". Batch (celá série,
// "...-1-12-1080p/") se přeskočí, ať se neuloží jako díl.

import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { saveSubFile } from '../download.js';

export const name = 'nyasub.cz';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function filenameFromCD(cd) {
  const star = (cd || '').match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = (cd || '').match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// Číslo dílu z download URL. Batch rozsah (1-12) → null (přeskočit).
export function epFromDownloadUrl(url) {
  const m = String(url || '').match(/-(\d+)(?:-(\d+))?-1080p/i);
  if (!m) return null;
  if (m[2]) return null; // "-1-12-" batch
  return Number(m[1]);
}

// Ze stránky anime → mapa { episode: downloadUrl } (s čerstvým masterkey).
export function parseEpisodeMap($) {
  const map = {};
  $('a[href*="wpdmdl="]').each((_, a) => {
    let href = $(a).attr('href') || '';
    href = href.replace(/&#0?38;/g, '&').replace(/&amp;/g, '&'); // HTML entity → &
    if (!/masterkey=/i.test(href)) return; // bez masterkey nejde stáhnout
    const ep = epFromDownloadUrl(href);
    if (ep == null) return; // batch nebo nerozpoznané
    if (map[ep] == null) map[ep] = href; // první výskyt vyhrává
  });
  return map;
}

// skupina/release z názvu ([SubsPlease] … .ass)
function groupFromName(name) {
  return (String(name || '').match(/^\[([^\]]+)\]/) || [])[1] || null;
}

export async function download(sub) {
  // 1) načti stránku anime (čerstvé masterkey odkazy)
  const page = await fetch(sub.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!page.ok) throw new Error(`nyasub: HTTP ${page.status} (${sub.url}).`);
  const $ = cheerio.load(await page.text());

  const map = parseEpisodeMap($);
  const dlUrl = map[sub.episode];
  if (!dlUrl) {
    const known = Object.keys(map).sort((a, b) => a - b).join(', ') || 'žádné';
    throw new Error(`nyasub: na stránce není díl ${sub.episode} (nalezené: ${known}).`);
  }

  // 2) stáhni ZIP
  const r = await fetch(dlUrl, { headers: { 'User-Agent': UA, Referer: sub.url }, redirect: 'follow' });
  if (!r.ok) throw new Error(`nyasub: HTTP ${r.status} při stahování dílu ${sub.episode}.`);
  const zipBuf = Buffer.from(await r.arrayBuffer());

  const cdName = filenameFromCD(r.headers.get('content-disposition')) || '';
  if (!/\.zip$/i.test(cdName) && zipBuf.slice(0, 2).toString('utf8') !== 'PK') {
    throw new Error('nyasub: download nevrátil ZIP (možná vypršel masterkey).');
  }

  // 3) rozbal .ass ze ZIPu
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries();
  const entry =
    entries.find((e) => !e.isDirectory && /\.(ass|ssa|srt)$/i.test(e.entryName)) || null;
  if (!entry) throw new Error('nyasub: v ZIPu není .ass/.srt titulek.');
  const data = zip.readFile(entry);
  if (!data || !data.length) throw new Error('nyasub: prázdný titulek v ZIPu.');

  const rawName = entry.entryName.split('/').pop();
  return saveSubFile(
    { ...sub, group_name: sub.group_name || groupFromName(rawName) || 'NyāSub', release: sub.release || groupFromName(rawName) },
    data,
    rawName
  );
}
