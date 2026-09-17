// Klasifikace kvality titulku (na jaký video zdroj je načasovaný) + vytažení
// video skupiny z pole `release`.
//
// Kvalita: 'BD' | 'DVD' | 'WEB-DL' | null
//   - explicitní BD/Blu-ray/remux → BD (přebíjí název skupiny: „SubsPlease/Blu-ray" = BD)
//   - explicitní DVD (i 720x480 = NTSC rozlišení) → DVD
//   - smetí (Hns.sk, webshare, samá čísla, „EP174 - FSP", „&") → null
//   - všechno ostatní → WEB-DL (web skupiny jako SubsPlease/Erai-raws sem spadnou samy)
//
// Skupiny: release „Subsplease/ASW" → ['SubsPlease', 'ASW'] — kanonický zápis se
// bere ze slovníku skupin indexeru (scraper/release-groups.json), aby se dal
// porovnat se skupinou streamu (addon podle shody kreslí korunku). Skupina, která
// ve slovníku není, se vrátí jen očištěná — korunku stejně dostat nemůže, protože
// takový stream v indexeru neexistuje.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- slovník skupin (kanonické zápisy z indexeru) ---
let GROUPS = [];
try {
  GROUPS = JSON.parse(readFileSync(path.join(__dirname, 'release-groups.json'), 'utf8'));
} catch {
  GROUPS = []; // bez slovníku se skupiny vrací jen očištěné
}
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GROUP_MAP = new Map(GROUPS.map((g) => [normKey(g), g]));
// překlepy / varianty, které se liší i po normalizaci
const ALIAS = { subplease: 'subsplease', erai: 'erairaws', eraiiraws: 'erairaws' };
const canonKey = (s) => ALIAS[normKey(s)] || normKey(s);

// --- vzory ---
const HASH    = /\[[0-9A-Fa-f]{8}\]/g;                 // CRC v názvu souboru
const DVD_RE  = /\bdvd\b|\br2\s*dvd\b|720x480/i;
const BD_RE   = /(^|[^a-z0-9])bd([^a-z0-9]|$)|\bbd-?rip\b|\bblu-?ray\b|\bremux\b/i;
const JUNK_RE = /^(hns\.sk|webshare|\d+|ep\d+\s*-\s*fsp|\[720p\]|\[uncensored\])$/i;

const QUAL    = /\b(\d{3,4}p|4k|720x480|hi10|10bit|8bit|x?26[45]|hevc|avc|aac\d?(\.\d)?|eac3|ac3|flac|multisub|multiple subtitle|dual-audio)\b/gi;
const SRC     = /\b(bd-?rip|bd|blu-?ray|dvd-?rip|dvd|web-?dl|web-?rip|web|amzn|nf|netflix|remux|uncensored|necenzurovaný|auto|jp|ch|v\d)\b/gi;
const BARENUM = /(^|\s)\d{2,4}(\s|$)/g;
const NOISE   = /\.(mkv|mp4|ass|srt)\b|\bbez cenzury\b|\bprodloužené\b|\bjakýkoliv?\b|\brip videa\b|\bvelikost\b|\d+[,.]\d+\s*gb/gi;
const SEP     = /[,;/|+&()]| - (?=[A-Za-z])/;
// slova, která nejsou skupina (české poznámky, obecné pojmy)
const STOP = new Set([
  'necenzurovan', 'hnssk', 'webshare', 'jine', 'jiny', 'jakykoli', 'jakykoliv',
  'raws', 'ostatni', 'uncensored', 'preair', 'jinecasovani', 'jinycasovani', 'casovani',
]);

/** Kvalita z pole `release`. Vrací 'BD' | 'DVD' | 'WEB-DL' | null. */
export function classifyQuality(release) {
  const s = String(release || '').trim();
  if (!s) return null;
  const bezHashu = s.replace(HASH, ' '); // aby [BD613191] neplatil jako BD
  if (DVD_RE.test(bezHashu)) return 'DVD';
  if (BD_RE.test(bezHashu)) return 'BD';
  if (JUNK_RE.test(s) || !/[a-zA-Z\u00C0-\u024F]/.test(s)) return null;
  return 'WEB-DL';
}

/** Video skupiny z pole `release` — kanonicky dle slovníku indexeru. */
export function releaseGroups(release) {
  let s = String(release || '').trim();
  if (!s) return [];
  s = s.replace(HASH, ' ').replace(NOISE, ' ')
    .replace(/^🤖\s*(BD|DVD)\s*·?\s*/i, ' ')  // „🤖 BD · EMBER" = přečas proti EMBER BD
    .replace(/^🤖\s*(BD|DVD)\s*$/i, ' ');

  // celý název souboru „[Group] Title - 01 (720p)" → ber jen [Group]
  const brackets = [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((b) => {
    const t = b.replace(QUAL, '').replace(SRC, '').trim();
    return t && !/^[0-9A-Fa-f]{8}$/.test(b) && /[a-zA-Z]/.test(t);
  });
  if (brackets.length && /^\s*\[/.test(s)) s = brackets.join(' / ');
  else s = s.replace(/\[[^\]]*\]/g, ' '); // jinak jsou závorky poznámka → pryč
  s = s.replace(/\s-\s\d+.*$/, ' ');      // „Group Title - 01" → utni za číslem dílu

  const out = [];
  for (let part of s.split(SEP)) {
    part = part.replace(QUAL, ' ').replace(SRC, ' ').replace(BARENUM, ' ').trim()
      .replace(/^[\s.·-]+|[\s.·-]+$/g, '');
    if (!part || !/[a-zA-Z]/.test(part) || part.length < 2) continue;
    const k = canonKey(part);
    if (k.length < 2 || STOP.has(k) || /^\d+$/.test(k)) continue;
    const canon = GROUP_MAP.get(k) || part;     // kanonický zápis z indexeru, jinak očištěný
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/** Je skupina známá indexeru? (jen ty můžou dostat korunku u streamu) */
export function isKnownGroup(name) {
  return GROUP_MAP.has(canonKey(name));
}
