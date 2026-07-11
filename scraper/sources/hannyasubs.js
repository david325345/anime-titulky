// scraper/sources/hannyasubs.js — parser pro HannyaSubs (hannya-subs.blogspot.com).
//
// Struktura: Blogger článek s tabulkou epizod — sloupce č. | Název epizody | Link | Staženo.
// Sloupec "Link" má tlačítko Stáhnout → odkaz na MEGA (mega.nz/file/{id}#{klíč}).
// MEGA soubory jsou šifrované; dešifrování řeší knihovna megajs (klíč je za # v URL).
//
// hiyori u těchto titulků odkazuje na blogspot ČLÁNEK (ne přímo na soubor),
// takže z něj podle čísla epizody vytáhneme správný MEGA odkaz.

import * as cheerio from 'cheerio';
import { File as MegaFile } from 'megajs';
import { saveSubFile } from '../download.js';
import { CONFIG } from '../../config.js';

export const name = 'hannya-subs.blogspot.com';

const MEGA_RE = /mega\.nz\/file\//i;

// z blogspot článku udělá mapu {episode: megaUrl}
async function episodeMap(articleUrl) {
  const res = await fetch(articleUrl, {
    headers: { 'User-Agent': CONFIG.userAgent, 'Accept-Language': 'cs,sk;q=0.9' },
  });
  if (!res.ok) throw new Error('Blog nedostupný: HTTP ' + res.status);
  const html = await res.text();
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
  const rawName = megaName || `hannyasubs-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, buf, rawName);
}
