// scraper/sources/hanabi.js — hanabi.fan.
//
// Přihlášená stránka překladu obsahuje odkazy na ZIP soubory na veřejném CDN
// (img.hanabi.fan). Přihlášení nejde přenést (device binding), ALE samotné ZIPy
// na CDN jsou veřejné. Proto: uživatel z prohlížeče zkopíruje přesný ZIP odkaz,
// vloží ho v dashboardu, a server ho stáhne z CDN (veřejně) → .ass → R2.
//
// Nemá automatický download(sub) jako ostatní parsery — odkaz dodává uživatel.

import AdmZip from 'adm-zip';
import { saveSubFile } from '../download.js';

export const name = 'hanabi.fan';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// povolený host — server smí stahovat JEN z hanabi CDN (bezpečnost)
export function isValidHanabiUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'img.hanabi.fan' && /\.zip$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// skupina z názvu souboru ([Erai-raws] ... → Erai-raws)
function groupFromName(nm) {
  const m = (nm || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// Stáhne ZIP z daného CDN odkazu, vytáhne .ass a uloží pod daný sub.
// url = přesný odkaz na img.hanabi.fan/.../*.zip (dodá uživatel).
export async function downloadFromUrl(sub, url) {
  if (!isValidHanabiUrl(url)) {
    throw new Error('Neplatný odkaz — musí být https://img.hanabi.fan/…/*.zip');
  }

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    throw new Error(`hanabi CDN: HTTP ${res.status} při stahování ZIP.`);
  }
  const zipBuf = Buffer.from(await res.arrayBuffer());

  // vytáhni .ass z archivu (bez hesla)
  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntries().find((e) => /\.ass$/i.test(e.entryName) && !e.isDirectory)
    || zip.getEntries().find((e) => /\.(srt|ssa)$/i.test(e.entryName) && !e.isDirectory);
  if (!entry) {
    throw new Error('hanabi ZIP: uvnitř není .ass/.srt titulek.');
  }
  const assBuf = entry.getData();
  const rawName = entry.entryName.split('/').pop();

  // release/skupina z názvu souboru, když v DB chybí
  const saved = await saveSubFile(
    { ...sub, group_name: sub.group_name || groupFromName(rawName) },
    assBuf,
    rawName
  );
  return saved;
}
