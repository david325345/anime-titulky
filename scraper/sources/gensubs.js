// scraper/sources/gensubs.js — parser pro gensubs.cz (skupina Gensubs).
//
// Web je ze serveru přístupný přímo (žádný geo blok → agenta nepotřebuje),
// ale vyžaduje vlastní účet (env GENSUBS_USER / GENSUBS_PASS).
//
// Login: POST /prihlaseni.php  (jmeno, heslo, residentlogin=true) — BEZ csrf tokenu.
//        Session = cookie PHPSESSID. residentlogin drží session déle.
//
// hiyori odkazuje na stránku anime: https://gensubs.cz/anime.php?id=142
// Na ní je (až po přihlášení) tabulka:
//   <div class="anime_titulky"><table>
//     <tr class="header">… Název souboru | Release | Překladatel | Korektor | Stáhnout</tr>
//     <tr><td><input class="cbox"></td>
//         <td>ingoku_danchi_01_cs_cz.ass</td>   ← číslo dílu je TADY
//         <td>ToonsHub</td>                      ← release
//         <td>KDan</td><td>Keiiko</td>
//         <td><a href="stahnout.php?id=142&id_tit=1">…</a></td></tr>
//
// POZOR na číslování: id_tit ANI pořadí řádku NEJSOU číslo dílu.
//   [TeamNS] SK8 - 9.5 (recap).ass  je 13. řádek s id_tit=13, ale je to recap 9.5.
// Proto se číslo bere z NÁZVU SOUBORU (poslední číslo; desetinné = speciál/recap → přeskočí).
// Když v názvech čísla nejsou vůbec (filmy: "1.0.ass", "…Special_Eizou.ass"),
// spadne se na pořadí řádku — u jednosouborových filmů to dá správně díl 1.

import * as cheerio from 'cheerio';
import { CONFIG } from '../../config.js';
import { saveSubFile } from '../download.js';

export const name = 'gensubs.cz';

const BASE = 'https://gensubs.cz';
const LOGIN_URL = `${BASE}/prihlaseni.php`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// session držíme mezi stahováními (šetří logins)
let sessionCookie = null;

function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
}

function filenameFromCD(cd) {
  const star = (cd || '').match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = (cd || '').match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// Číslo dílu z názvu souboru. Poslední číslo v názvu; desetinné (9.5 = recap,
// 1.0 = název filmu) → null. Ověřeno na všech vzorech, které gensubs používá.
export function epFromName(name) {
  const base = String(name || '').replace(/\.(ass|srt|ssa)$/i, '');
  const toks = base.match(/\d+(?:[.,]\d+)?/g);
  if (!toks) return null;
  const last = toks[toks.length - 1];
  if (/[.,]/.test(last)) return null;
  const n = Number(last);
  return Number.isInteger(n) && n > 0 && n < 2000 ? n : null;
}

async function login() {
  const { user, pass } = CONFIG.gensubs;
  if (!user || !pass) {
    throw new Error('gensubs: chybí GENSUBS_USER / GENSUBS_PASS (nastav v Coolify).');
  }

  // 1) GET kvůli session cookie
  const g = await fetch(LOGIN_URL, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  let cookie = cookieFrom(g);

  // 2) POST přihlášení
  const body = new URLSearchParams({
    jmeno: user,
    heslo: pass,
    residentlogin: 'true',
  }).toString();

  const p = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
    redirect: 'follow',
  });
  const fresh = cookieFrom(p);
  if (fresh) cookie = fresh;

  const html = await p.text();
  if (!/odhl[aá]sit/i.test(html)) {
    throw new Error('gensubs: přihlášení selhalo (zkontroluj GENSUBS_USER / GENSUBS_PASS).');
  }

  sessionCookie = cookie;
  return cookie;
}

async function ensureSession() {
  return sessionCookie || login();
}

async function getPage(url, cookie) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`gensubs: HTTP ${r.status} (${url}).`);
  return r.text();
}

// Z tabulky na stránce anime udělá mapu { episode: {url, filename, release} }.
export function parseEpisodeMap($) {
  const rows = [];
  $('div.anime_titulky table tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.hasClass('header')) return;
    const href = $tr.find('a[href*="stahnout.php"]').first().attr('href');
    if (!href) return;
    const tds = $tr.find('td').map((_, td) => $(td).text().trim()).get();
    // 1. buňka je checkbox → název souboru je první neprázdná
    const filename = tds.find((t) => /\.(ass|srt|ssa)$/i.test(t)) || null;
    const fnIdx = tds.indexOf(filename);
    rows.push({
      url: href.startsWith('http') ? href : `${BASE}/${href.replace(/^\.?\//, '')}`,
      filename,
      release: fnIdx >= 0 ? tds[fnIdx + 1] || null : null,
    });
  });

  const map = {};
  let any = false;
  for (const r of rows) {
    const ep = epFromName(r.filename);
    if (ep == null) continue;
    any = true;
    if (map[ep] == null) map[ep] = r;
  }

  // Žádný název nedal číslo (filmy / speciály) → spadni na pořadí řádku.
  if (!any) rows.forEach((r, i) => { map[i + 1] = r; });

  return map;
}

export async function download(sub) {
  let cookie = await ensureSession();

  let html = await getPage(sub.url, cookie);

  // session vypršela → přihlas se jednou znovu
  if (!/odhl[aá]sit/i.test(html)) {
    cookie = await login();
    html = await getPage(sub.url, cookie);
  }

  const $ = cheerio.load(html);
  const map = parseEpisodeMap($);
  const hit = map[sub.episode];
  if (!hit) {
    const known = Object.keys(map).sort((a, b) => a - b).join(', ') || 'žádné';
    throw new Error(
      `gensubs: na stránce není díl ${sub.episode} (nalezené díly: ${known}).`
    );
  }

  // stažení
  const r = await fetch(hit.url, {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: sub.url },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`gensubs: HTTP ${r.status} při stahování titulku.`);
  const buf = Buffer.from(await r.arrayBuffer());

  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head)) {
    throw new Error('gensubs: download nevrátil titulek (vypršela session?).');
  }

  const rawName =
    filenameFromCD(r.headers.get('content-disposition')) ||
    hit.filename ||
    `gensubs-ep${sub.episode}.ass`;

  return saveSubFile(
    { ...sub, group_name: sub.group_name || 'Gensubs', release: sub.release || hit.release },
    buf,
    rawName
  );
}
