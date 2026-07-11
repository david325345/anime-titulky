// scraper/download.js — stažení PŘÍMÝCH titulků z hiyori (/anime/downloadsubtitles?id=).
// Externí (wosir/hns) řeší scraper/sources/ (zatím placeholdery).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getBinary } from './http.js';
import { CONFIG } from '../config.js';
import { r2Enabled, r2Put, r2PublicUrl } from '../r2.js';

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

function contentTypeFor(name) {
  if (/\.(ass|ssa|srt|sub|vtt|txt)$/i.test(name)) return 'text/plain; charset=utf-8';
  if (/\.zip$/i.test(name)) return 'application/zip';
  return 'application/octet-stream';
}

// Sdílené uložení titulku: lokálně (DATA_DIR) + upload na R2 (pokud je nastaven).
// Vrací {filename, local_path, file_bytes, r2_key, r2_url}.
export async function saveSubFile(sub, buf, rawName) {
  const filename = sanitize(rawName || `sub-${sub.sub_id}.ass`);
  const animeKey = String(sub.anilist_id || `hiyori-${sub.hiyori_id}`);
  const epKey = sub.episode != null ? `E${sub.episode}` : 'E_';
  const outName = `${sub.sub_id}__${filename}`; // prefix sub_id proti kolizím názvů

  // 1) lokální kopie (pracovní cache)
  const dir = path.join(CONFIG.dataDir, 'files', animeKey, epKey);
  fs.mkdirSync(dir, { recursive: true });
  const local_path = path.join(dir, outName);
  fs.writeFileSync(local_path, buf);

  // 2) R2 (durable) — kanonický klíč anilist+episode, uloženo jako gzip (úspora místa)
  let r2_key = null;
  let r2_url = null;
  if (r2Enabled()) {
    r2_key = `${CONFIG.r2.prefix}/${animeKey}/${epKey}/${outName}.gz`;
    const gz = zlib.gzipSync(buf);
    await r2Put(r2_key, gz, 'application/gzip'); // chyba → probublá, status=failed
    r2_url = r2PublicUrl(r2_key);
  }

  return { filename: outName, local_path, file_bytes: buf.length, r2_key, r2_url };
}

// stáhne přímý titulek z hiyori a uloží. Vrací {filename, local_path, file_bytes}.
export async function downloadDirect(sub) {
  const { buf, contentDisposition } = await getBinary(sub.url, {
    referer: `https://hiyori.cz/anime/${sub.hiyori_id}`,
  });
  const rawName = filenameFromCD(contentDisposition, `sub-${sub.sub_id}.ass`);
  return await saveSubFile(sub, buf, rawName);
}
