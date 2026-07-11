// scraper/sources/underkotatsu.js — parser pro underkotatsusubs.cz (WordPress + Download Monitor).
//
// Login má reCAPTCHA v3 → přihlášení přes hotovou cookie z prohlížeče (env UK_COOKIE),
// řeší underkotatsu-http.js.
//
// Stránka anime: číslovaný seznam dílů, tlačítka "Stáhnout díl" v <li> v POŘADÍ (1. = díl 1).
// "Stáhnout všechny díly" (batch) je mimo seznam → přeskočíme.
// /download/{id}/ vrátí buď přímo .ass/.srt, nebo ZIP — parser formát detekuje sám.

import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { getHtml, getBinary } from './underkotatsu-http.js';
import { saveSubFile } from '../download.js';

export const name = 'underkotatsusubs.cz';

const ZIP_PASSWORD = process.env.UK_ZIP_PASSWORD || ''; // většinou bez hesla

function filenameFromCD(cd) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// seznam per-epizodních download odkazů v pořadí (index+1 = číslo dílu)
function episodeLinks($) {
  const links = [];
  $('a[href*="/download/"]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!/\/download\/\d+\/?/.test(href)) return;
    const txt = $(a).text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (/v[šs]echny|all/.test(txt)) return; // "Stáhnout všechny díly" = batch, přeskoč
    if (!/díl|dil|stáhn|stahn|download/.test(txt)) return;
    links.push(href);
  });
  return links;
}

// z bufferu vytáhne titulek: přímý .ass/.srt, nebo z(a)heslovaný ZIP
function toSubtitle(buf, contentDisposition) {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  if (isZip) {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const entry =
      entries.find((e) => /\.(ass|ssa|srt|sub|vtt)$/i.test(e.entryName)) || entries[0];
    if (!entry) throw new Error('underkotatsusubs: ZIP je prázdný.');
    const data = ZIP_PASSWORD ? zip.readFile(entry, ZIP_PASSWORD) : zip.readFile(entry);
    if (!data || !data.length) {
      throw new Error('underkotatsusubs: nešlo rozbalit ZIP (heslo? nastav UK_ZIP_PASSWORD).');
    }
    return { data, name: entry.entryName.split('/').pop() };
  }
  // přímý soubor
  const name = filenameFromCD(contentDisposition);
  return { data: buf, name };
}

export async function download(sub) {
  // 1) stránka anime → seznam dílů → N-tý odkaz
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);
  const links = episodeLinks($);
  const dlUrl = links[(sub.episode || 0) - 1];
  if (!dlUrl) {
    throw new Error(
      `underkotatsusubs: nenašel jsem díl ${sub.episode} (na stránce je ${links.length} dílů).`
    );
  }

  // 2) stáhni + detekuj formát + ulož
  const { buf, contentDisposition } = await getBinary(dlUrl, { referer: sub.url });
  const { data, name: fname } = toSubtitle(buf, contentDisposition);
  const rawName = fname || `underkotatsu-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, data, rawName);
}
