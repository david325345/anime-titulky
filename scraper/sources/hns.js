// scraper/sources/hns.js — parser pro hns.sk (Yii2 + přihlášení).
//
// hiyori odkazuje na stránku epizody: https://hns.sk/anime/episode/{slug}/{id}
// Stažení = obyčejný <form method="POST"> na TÉŽE URL s hidden poli:
//   id, name, _csrf, action=download  → vrátí přímo .ass soubor.
// Login/session řeší hns-http.js (env HNS_EMAIL / HNS_PASS).

import * as cheerio from 'cheerio';
import { getHtml, postBinary } from './hns-http.js';
import { saveSubFile } from '../download.js';

export const name = 'hns.sk';

// název z Content-Disposition jako záloha, když by chybělo pole "name"
function filenameFromCD(cd) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

export async function download(sub) {
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);

  // najdi download formulář (obsahuje action=download + id)
  const form = $('form')
    .filter((_, f) => $(f).find('input[name="action"][value="download"]').length > 0)
    .first();
  if (!form.length) {
    throw new Error(`hns.sk: na stránce epizody není download formulář (${sub.url}).`);
  }

  const id = form.find('input[name="id"]').attr('value');
  const fname = form.find('input[name="name"]').attr('value');
  const csrf = form.find('input[name="_csrf"]').attr('value');
  if (!id || !csrf) {
    throw new Error('hns.sk: chybí id / _csrf v download formuláři.');
  }

  const { buf, contentDisposition } = await postBinary(sub.url, {
    _csrf: csrf,
    id,
    name: fname || '',
    action: 'download',
  });

  const rawName = fname || filenameFromCD(contentDisposition) || `hns-ep${sub.episode || '?'}.ass`;
  return saveSubFile(sub, buf, rawName);
}
