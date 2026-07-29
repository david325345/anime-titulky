// scraper/sources/kamui.js — parser pro kamui-subs.cz (WordPress + zaheslovaný ZIP).
//
// hiyori odkazuje na stránku anime; na ní jsou tlačítka "N. Díl" (Elementor)
// s odkazem https://kamui-subs.cz/download/{id}/ → stáhne ZIP (ZipCrypto),
// uvnitř je .ass. Archiv je zaheslovaný — heslo 'kamui' (env KAMUI_ZIP_PASSWORD).
// Login/session řeší kamui-http.js (env KAMUI_USER / KAMUI_PASS).

import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { getHtml, getBinary } from './kamui-http.js';
import { saveSubFile } from '../download.js';

export const name = 'kamui-subs.cz';

const ZIP_PASSWORD = process.env.KAMUI_ZIP_PASSWORD || 'kamui';

// ze stránky anime udělá mapu {episode: '/download/{id}/'}
function episodeMap($) {
  const map = {};
  $('a[href*="/download/"]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!/\/download\/\d+\/?/.test(href)) return;
    const txt = ($(a).find('.elementor-button-text').text() || $(a).text())
      .replace(/\s+/g, ' ')
      .trim();
    // "1. Díl" → 1 (fallback: první číslo v textu)
    const ep = Number(txt.match(/(\d+)\s*\.?\s*D[íi]l/i)?.[1] ?? txt.match(/\d+/)?.[0]);
    if (!Number.isNaN(ep) && map[ep] == null) map[ep] = href;
  });
  return map;
}

// z bufferu ZIPu vytáhne první titulkový soubor (rozbalí heslem)
function extractSub(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const entry =
    entries.find((e) => /\.(ass|ssa|srt|sub|vtt)$/i.test(e.entryName)) || entries[0];
  if (!entry) throw new Error('kamui-subs: ZIP je prázdný.');

  let data;
  try {
    data = zip.readFile(entry, ZIP_PASSWORD); // heslo pro ZipCrypto/AES
  } catch (e) {
    throw new Error('kamui-subs: rozbalení heslem selhalo — ' + e.message);
  }
  if (!data || !data.length) {
    throw new Error('kamui-subs: špatné heslo k archivu nebo prázdný soubor.');
  }
  return { name: entry.entryName.split('/').pop(), data };
}

export async function download(sub) {
  // 1) stránka anime → najdi /download/{id}/ pro daný díl
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);
  const map = episodeMap($);
  let dlUrl = map[sub.episode];

  // FILM / jednodílné: tlačítko nemá „N. Díl" (třeba „Celovečerní film") → mapa je
  // prázdná. Když na stránce není ŽÁDNÝ číslovaný díl a je jediný /download/ odkaz,
  // ber ho jako ten titulek. U seriálu (mapa má díly) se fallback nespustí → chybu
  // pro nevyšlý díl korektně nahlásí dál.
  if (!dlUrl && Object.keys(map).length === 0) {
    const links = [
      ...new Set(
        $('a[href*="/download/"]')
          .map((_, a) => ($(a).attr('href') || '').trim())
          .get()
          .filter((h) => /\/download\/\d+\/?/.test(h))
      ),
    ];
    if (links.length === 1) dlUrl = links[0];
  }

  if (!dlUrl) {
    throw new Error(
      `kamui-subs: na stránce není tlačítko pro díl ${sub.episode} (možná ještě nevyšel).`
    );
  }

  // 2) stáhni ZIP
  const { buf } = await getBinary(dlUrl, { referer: sub.url });

  // 3) rozbal heslem + ulož .ass
  const { name: assName, data } = extractSub(buf);
  const rawName = assName || `kamui-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, data, rawName);
}
