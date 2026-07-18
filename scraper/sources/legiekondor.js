// scraper/sources/legiekondor.js — parser pro legiekondor.cz (skupina LKCSR / Legie Kondor).
//
// Nejjednodušší případ: hiyori dává PŘÍMÝ odkaz na titulek, bez přihlášení:
//   https://anime4.legiekondor.cz/subdwl/hanashura.101/
// Ten vrací rovnou .ass (Content-Disposition má název se vším:
//   "[LKCSR](SubsPlease) Hana wa Saku, Shura no Gotoku S01e04.ass").
// Parser jen stáhne, číslo dílu bere z hiyori (sub.episode), release/skupinu z názvu.

import { saveSubFile } from '../download.js';

export const name = 'legiekondor.cz';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function filenameFromCD(cd) {
  const star = (cd || '').match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = (cd || '').match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// z názvu ([LKCSR](SubsPlease) … S01e04.ass) vytáhne skupinu a release
function metaFromName(name) {
  const base = String(name || '');
  const group = (base.match(/^\[([^\]]+)\]/) || [])[1] || null;
  const release = (base.match(/\(([^)]+)\)/) || [])[1] || null;
  return { group, release };
}

export async function download(sub) {
  const res = await fetch(sub.url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`legiekondor: HTTP ${res.status} (${sub.url}).`);
  const buf = Buffer.from(await res.arrayBuffer());

  // ověř, že je to titulek, ne HTML chybovka
  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head)) {
    throw new Error('legiekondor: odkaz nevrátil titulek (HTML stránka).');
  }

  const rawName =
    filenameFromCD(res.headers.get('content-disposition')) ||
    `legiekondor-ep${sub.episode}.ass`;

  const m = metaFromName(rawName);
  return saveSubFile(
    { ...sub, group_name: sub.group_name || m.group || 'LKCSR', release: sub.release || m.release },
    buf,
    rawName
  );
}
