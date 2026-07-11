// scraper/download.js — stažení PŘÍMÝCH titulků z hiyori (/anime/downloadsubtitles?id=).
// Externí (wosir/hns) řeší scraper/sources/ (zatím placeholdery).
import fs from 'node:fs';
import path from 'node:path';
import { getBinary } from './http.js';
import { CONFIG } from '../config.js';

// název z Content-Disposition: filename="..." (příp. filename*=UTF-8''...)
function filenameFromCD(cd, fallback) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {}
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return (plain ? plain[1] : fallback).trim();
}

function sanitize(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .trim()
    .slice(0, 180);
}

// Sdílené uložení titulku na disk (používá direct i externí parsery).
// Vrací {filename, local_path, file_bytes}.
export function saveSubFile(sub, buf, rawName) {
  const filename = sanitize(rawName || `sub-${sub.sub_id}.ass`);

  // struktura: {DATA_DIR}/files/{anilist_id|hiyori_id}/E{episode}/{filename}
  const animeDir = String(sub.anilist_id || `hiyori-${sub.hiyori_id}`);
  const epDir = sub.episode != null ? `E${sub.episode}` : 'E_';
  const dir = path.join(CONFIG.dataDir, 'files', animeDir, epDir);
  fs.mkdirSync(dir, { recursive: true });

  // prefix sub_id, ať se různé skupiny se stejným názvem nepřepíšou
  const outName = `${sub.sub_id}__${filename}`;
  const local_path = path.join(dir, outName);
  fs.writeFileSync(local_path, buf);

  return { filename: outName, local_path, file_bytes: buf.length };
}

// stáhne přímý titulek z hiyori a uloží. Vrací {filename, local_path, file_bytes}.
export async function downloadDirect(sub) {
  const { buf, contentDisposition } = await getBinary(sub.url, {
    referer: `https://hiyori.cz/anime/${sub.hiyori_id}`,
  });
  const rawName = filenameFromCD(contentDisposition, `sub-${sub.sub_id}.ass`);
  return saveSubFile(sub, buf, rawName);
}
