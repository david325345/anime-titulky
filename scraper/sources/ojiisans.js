// scraper/sources/ojiisans.js — parser pro ojiisans.top.
//
// Web je za CLOUDFLARE JS challenge → přímý fetch ze serveru dostane 403
// ("Just a moment..."). Agentova IP (webzdarma) ale Cloudflare PROJDE, takže
// vše jde PŘES AGENTA (jako 3mka/wosir).
//
// WordPress Download Manager (wpdm), podobně jako nyasub, ale:
//  - download odkaz: /download/<slug>-<N>-dil/?wpdmdl=<id>  (číslo dílu ve slugu "-N-dil")
//  - má i &refresh=<timestamp>, ale ten NENÍ povinný — stačí wpdmdl
//  - batch (celá série) má slug bez "-dil" nebo s rozsahem → přeskočí se
// Download vrací ZIP s jedním .ass uvnitř → rozbalíme (adm-zip).
//
// hiyori odkazuje na STRÁNKU anime: https://ojiisans.top/<slug>/

import AdmZip from 'adm-zip';
import { agentFetch, hasAgent, filenameFromHeaders } from '../agent.js';
import { saveSubFile } from '../download.js';

export const name = 'ojiisans.top';

// Ze stránky anime → mapa { episode: downloadUrl }.
// Download odkazy: href='https://ojiisans.top/download/<slug>-<N>-dil/?wpdmdl=<id>...'
// (POZOR: jednoduché i dvojité uvozovky; číslo dílu je ve slugu "-N-dil").
export function parseEpisodeMap(html) {
  const map = {};
  const re = /[\x27"](https:\/\/ojiisans\.top\/download\/[^\x27"]*wpdmdl=\d+[^\x27"]*)[\x27"]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1].replace(/&#0?38;/g, '&').replace(/&amp;/g, '&'); // HTML entity → &
    const slug = url.split('?')[0].replace(/\/$/, '');
    const ep = (slug.match(/-(\d+)-dil$/i) || [])[1]; // číslo dílu ze slugu "-N-dil"
    if (!ep) continue;                                 // batch / nerozpoznané → přeskoč
    const n = Number(ep);
    if (map[n] == null) map[n] = url;                  // první výskyt vyhrává
  }
  return map;
}

// skupina/release z názvu ([SubsPlease] … .ass / …-ToonsHub.ass)
function groupFromName(name) {
  const br = (String(name || '').match(/^\[([^\]]+)\]/) || [])[1];
  if (br) return br;
  const tail = (String(name || '').match(/-([A-Za-z0-9]+)\.(?:ass|srt|ssa)$/i) || [])[1];
  return tail || null;
}

export async function download(sub) {
  if (!hasAgent()) {
    throw new Error('ojiisans: chybí agent (AGENT_URL/AGENT_TOKEN) — web je za Cloudflare, nutný agent.');
  }

  // 1) načti stránku anime PŘES AGENTA (Cloudflare pouští jen agentovu IP)
  const page = await agentFetch(sub.url, { follow: true });
  if (page.status !== 200) throw new Error(`ojiisans: HTTP ${page.status} (${sub.url}).`);
  const html = page.buf.toString('utf8');
  if (/Just a moment|challenge-platform/i.test(html)) {
    throw new Error('ojiisans: Cloudflare challenge i přes agenta (změnila se IP reputace?).');
  }

  const map = parseEpisodeMap(html);
  const dlUrl = map[sub.episode];
  if (!dlUrl) {
    const known = Object.keys(map).sort((a, b) => a - b).join(', ') || 'žádné';
    throw new Error(`ojiisans: na stránce není díl ${sub.episode} (nalezené: ${known}).`);
  }

  // 2) stáhni ZIP PŘES AGENTA
  const r = await agentFetch(dlUrl, { follow: true });
  if (r.status !== 200) throw new Error(`ojiisans: HTTP ${r.status} při stahování dílu ${sub.episode}.`);
  const zipBuf = r.buf;
  if (zipBuf.slice(0, 2).toString('utf8') !== 'PK') {
    const head = zipBuf.slice(0, 80).toString('utf8');
    if (/Just a moment/i.test(head)) throw new Error('ojiisans: download blokován Cloudflarem.');
    throw new Error('ojiisans: download nevrátil ZIP.');
  }

  // 3) rozbal .ass ze ZIPu
  const zip = new AdmZip(zipBuf);
  const entry =
    zip.getEntries().find((e) => !e.isDirectory && /\.(ass|ssa|srt)$/i.test(e.entryName)) || null;
  if (!entry) throw new Error('ojiisans: v ZIPu není .ass/.srt titulek.');
  const data = zip.readFile(entry);
  if (!data || !data.length) throw new Error('ojiisans: prázdný titulek v ZIPu.');

  const rawName = entry.entryName.split('/').pop();
  return saveSubFile(
    { ...sub, group_name: sub.group_name || groupFromName(rawName), release: sub.release || groupFromName(rawName) },
    data,
    rawName
  );
}
