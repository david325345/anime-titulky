// scraper/sources/hanabi.js — parser pro hanabi.fan.
//
// Přihlášená stránka překladu má tabulku dílů (.divTableRow):
//   .table-dil = číslo dílu, .table-down a[href] = ZIP na CDN img.hanabi.fan.
// Přihlášení přes 3 cookies v env HANABI_COOKIE (hcdn + _lscache_vary + wordpress_logged_in_).
// ZIP na CDN je veřejný (stahuje se i bez cookie), ale seznam odkazů je jen po přihlášení.
//
// download(sub)      — automatický: z sub.url najde ZIP pro sub.episode, stáhne.
// downloadFromUrl()  — ruční záloha: uživatel vloží přesný ZIP odkaz (ikonka v UI).

import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { getHtml, getBinary, hasCookie } from './hanabi-http.js';
import { saveSubFile } from '../download.js';

export const name = 'hanabi.fan';

// povolený host pro ruční vkládání (bezpečnost)
export function isValidHanabiUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'img.hanabi.fan' && /\.zip$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function groupFromName(nm) {
  const m = (nm || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// z přihlášené stránky překladu udělá mapu { episode: zipUrl }
function parseEpisodeMap($) {
  const map = {};
  $('.divTableRow').each((_, row) => {
    const $row = $(row);
    const epTxt = $row.find('.table-dil').first().text().trim();
    const ep = Number(epTxt);
    if (!ep || Number.isNaN(ep)) return;
    const href = ($row.find('.table-down a[href]').first().attr('href') || '').trim();
    if (href && /\.zip$/i.test(href) && map[ep] == null) map[ep] = href;
  });
  return map;
}

// vytáhne .ass z bufferu ZIP a uloží pod sub
async function saveFromZip(sub, zipBuf) {
  const zip = new AdmZip(zipBuf);
  const entry =
    zip.getEntries().find((e) => /\.ass$/i.test(e.entryName) && !e.isDirectory) ||
    zip.getEntries().find((e) => /\.(srt|ssa)$/i.test(e.entryName) && !e.isDirectory);
  if (!entry) throw new Error('hanabi ZIP: uvnitř není .ass/.srt titulek.');
  const rawName = entry.entryName.split('/').pop();
  return saveSubFile(
    { ...sub, group_name: sub.group_name || groupFromName(rawName) },
    entry.getData(),
    rawName
  );
}

// AUTOMATICKÝ režim — z hiyori URL (stránka překladu) najde ZIP pro sub.episode
export async function download(sub) {
  if (!hasCookie()) {
    throw new Error('hanabi: chybí HANABI_COOKIE (přihlašovací cookies).');
  }
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);

  if (/Tady nic nenajdeš/i.test(html)) {
    throw new Error('hanabi: nepřihlášeno (cookies vypršely?) — obnov HANABI_COOKIE.');
  }

  const map = parseEpisodeMap($);
  const zipUrl = map[sub.episode];
  if (!zipUrl) {
    throw new Error(`hanabi: na stránce není ZIP pro díl ${sub.episode} (${sub.url}).`);
  }
  const zipBuf = await getBinary(zipUrl);
  return saveFromZip(sub, zipBuf);
}

// RUČNÍ režim (záloha) — uživatel vloží přesný ZIP odkaz z prohlížeče
export async function downloadFromUrl(sub, url) {
  if (!isValidHanabiUrl(url)) {
    throw new Error('Neplatný odkaz — musí být https://img.hanabi.fan/…/*.zip');
  }
  const zipBuf = await getBinary(url);
  return saveFromZip(sub, zipBuf);
}
