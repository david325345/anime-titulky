// scraper/sources/animetitulky.js — parser pro animetitulky.com (WordPress + plugin animetitulky-core).
//
// Hiyori odkazuje na stránku anime (/anime/<slug>/). Každý díl je karta:
//   article.hs-episode-card
//     .hs-episode-number   → "01"
//     .hs-episode-meta     → "Verze 1.0", datum
//     .hs-episode-actions  → <a href="…/stahnout/<id>/">
// Balíček celé série (/stahnout-balicek/<id>/) je mimo karty → ignorujeme.
//
// Stažení vyžaduje přihlášení → cookie z prohlížeče (env ANIMETITULKY_COOKIE),
// řeší animetitulky-http.js. /stahnout/<id>/ vrátí .ass/.srt, nebo ZIP — formát detekujeme.

import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { getHtml, getBinary } from './animetitulky-http.js';
import { saveSubFile } from '../download.js';
import { NotYetAvailable } from '../http.js';

export const name = 'animetitulky.com';

const SUB_EXT = /\.(ass|ssa|srt|sub|vtt)$/i;

function filenameFromCD(cd) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// "1.10" > "1.9" — porovnání verzí po číslech
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// všechny karty dílů: { episode, href, version, text }
function episodeCards($) {
  const cards = [];
  $('article.hs-episode-card').each((_, el) => {
    const card = $(el);
    const numTxt = card.find('.hs-episode-number').first().text().trim();
    if (!/^\d+$/.test(numTxt)) return; // SP / OVA apod. → přeskoč
    const a = card
      .find('a[href*="/stahnout/"]')
      .filter((_, x) => !/stahnout-balicek/i.test($(x).attr('href') || ''))
      .first();
    const href = (a.attr('href') || '').trim();
    if (!href) return;
    const text = card.text().replace(/\s+/g, ' ').trim();
    const ver = (card.find('.hs-episode-meta').text().match(/Verze\s*([\d.]+)/i) || [])[1] || null;
    cards.push({ episode: parseInt(numTxt, 10), href, version: ver, text });
  });
  return cards;
}

// víc karet se stejným číslem → přednost té, kde je release ze záznamu, pak nejvyšší verze
function pickCard(cards, sub) {
  if (cards.length <= 1) return cards[0] || null;
  const rel = String(sub.release || '').toLowerCase().trim();
  const byRelease = rel ? cards.filter((c) => c.text.toLowerCase().includes(rel)) : [];
  const pool = byRelease.length ? byRelease : cards;
  return [...pool].sort((a, b) => cmpVersion(b.version, a.version))[0];
}

// z bufferu vytáhne titulek: přímý .ass/.srt, nebo ZIP
function toSubtitle(buf, contentDisposition) {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  if (isZip) {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const entry = entries.find((e) => SUB_EXT.test(e.entryName)) || entries[0];
    if (!entry) throw new Error('animetitulky: ZIP je prázdný.');
    const data = zip.readFile(entry);
    if (!data || !data.length) throw new Error('animetitulky: nešlo rozbalit ZIP.');
    return { data, name: entry.entryName.split('/').pop() };
  }
  return { data: buf, name: filenameFromCD(contentDisposition) };
}

export async function download(sub) {
  // 1) stránka anime → karta dílu
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);
  const all = episodeCards($);
  const matches = all.filter((c) => c.episode === sub.episode);
  const card = pickCard(matches, sub);
  if (!card) {
    const nums = [...new Set(all.map((c) => c.episode))].sort((a, b) => a - b);
    // díl tam (zatím) není — nahraje se později / web ukázal starou stránku → zkusit znovu
    throw new NotYetAvailable(
      `animetitulky: díl ${sub.episode} na stránce zatím není (jsou tam díly: ${nums.join(', ') || 'žádné'}).`
    );
  }

  // 2) stáhni + detekuj formát + ulož
  const { buf, contentDisposition } = await getBinary(card.href, { referer: sub.url });
  const { data, name: fname } = toSubtitle(buf, contentDisposition);
  const rawName = fname && SUB_EXT.test(fname) ? fname : `animetitulky-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, data, rawName);
}
