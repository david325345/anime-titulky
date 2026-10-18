// scraper/sources/hannyasubs-cz.js — parser pro NOVÝ web HannyaSubs (www.hannya-subs.cz, 10/2026).
// Starý Blogspot (hannya-subs.blogspot.com + MEGA) dál řeší hannyasubs.js.
//
// Stahovat jde jen PŘIHLÁŠENÝM (env HANNYA_USER = přezdívka nebo e-mail, HANNYA_PASS).
// Nepřihlášenému vedou tlačítka na /login?redirect=… a soubor vrátí 303 na přihlášení.
//
// Přihlášení (klasický formulář, BEZ captchy — ověřeno 18.10.):
//   POST /login  csrf_token (skrytý, z libovolné stránky), redirect, username, password, remember_me
//   → 303 + Set-Cookie (relace). Cookie se sbírají RUČNĚ přes redirect:'manual' — při
//   automatickém přesměrování by se Set-Cookie z 303 ztratila.
//
// hiyori odkazuje na stránku anime: https://www.hannya-subs.cz/anime/<slug>
// (případně na stránku dílu /anime/<slug>/epizoda-N → bere se jen slug).
// Přihlášenému stránka anime ukazuje u každého dílu přímý odkaz na .ass:
//   <li class="ep-row is-ready"><span class="ep-num">04</span> …
//     <a class="… btn-download" href="https://www.hannya-subs.cz/soubory/subtitles/<slug>/<název>.ass">
//   Díl „Čeká na vysílání" = <li class="ep-row is-wait"> bez odkazu → NotYetAvailable (zůstane ve frontě).
// Release je v názvu souboru „… - 4 (SubsPlease  ASW).ass", jinak v boxu „Časováno na".

import * as cheerio from 'cheerio';
import { CONFIG } from '../../config.js';
import { saveSubFile } from '../download.js';
import { hostGate } from '../ratelimit.js';
import { AuthExpired, NotYetAvailable } from '../http.js';

export const name = 'hannya-subs.cz';
const DOMAIN = 'hannya-subs.cz';
const BASE = 'https://www.hannya-subs.cz';
const UA = CONFIG.userAgent ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── cookies (jednoduchý „jar" podle jména) ──────────────────────────────────
const jar = new Map();
function takeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = String(c).split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
    if (!v || /^deleted$/i.test(v)) jar.delete(k); else jar.set(k, v);
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
let loggedIn = false;

async function req(url, { method = 'GET', body = null, accept = 'text/html' } = {}) {
  await hostGate(url);
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      Accept: accept,
      'Accept-Language': 'cs-CZ,cs;q=0.9',
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: `${BASE}/` } : {}),
    },
    body,
  });
  takeCookies(res);
  return res;
}

// GET s ručním sledováním přesměrování (max 5). Vrací { res, url } konečné odpovědi.
async function getFollow(url, opts = {}) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const res = await req(cur, opts);
    const loc = res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return { res, url: cur };
    await res.arrayBuffer().catch(() => {});
    cur = new URL(loc, cur).href;
  }
  throw new Error('hannya-subs: příliš mnoho přesměrování.');
}

const isLoginUrl = (u) => /\/login(\?|$)/.test(new URL(u).pathname + new URL(u).search);
const pageLoggedIn = (html) => /action="[^"]*\/logout"/i.test(html);

async function login() {
  const { user, pass } = CONFIG.hannya;
  if (!user || !pass) throw new AuthExpired('hannya-subs: chybí HANNYA_USER / HANNYA_PASS (nastav v Coolify).', DOMAIN);
  jar.clear();
  loggedIn = false;
  // 1) libovolná stránka → cookie relace + čerstvý csrf_token
  const { res: g } = await getFollow(`${BASE}/`);
  const html = await g.text();
  const token = (html.match(/name="csrf_token"\s+value="([^"]+)"/i) || html.match(/CSRF_TOKEN\s*=\s*"([^"]+)"/) || [])[1];
  if (!token) throw new Error('hannya-subs: na stránce není csrf_token (změnil se web?).');
  // 2) přihlášení
  const body = new URLSearchParams({ csrf_token: token, redirect: '/', username: user, password: pass, remember_me: '1' }).toString();
  const p = await req(`${BASE}/login`, { method: 'POST', body });
  const loc = p.headers.get('location') || '';
  await p.arrayBuffer().catch(() => {});
  // 3) ověření: přihlášená stránka má formulář pro odhlášení
  const { res: chk } = await getFollow(new URL(loc || '/', BASE).href);
  const chkHtml = await chk.text();
  if (!pageLoggedIn(chkHtml)) {
    throw new AuthExpired('hannya-subs: přihlášení selhalo (zkontroluj HANNYA_USER / HANNYA_PASS).', DOMAIN);
  }
  loggedIn = true;
  console.log('[hannya-subs] přihlášeno');
}

// slug anime z odkazu hiyori (stránka anime i stránka dílu)
export function slugFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/anime\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

// Ze stránky anime (přihlášený) → { map: {ep: {url, filename}}, waiting: Set(ep), timing }
export function parseAnimePage(html) {
  const $ = cheerio.load(html);
  const map = {};
  const waiting = new Set();
  $('li.ep-row').each((_, li) => {
    const $li = $(li);
    const num = $li.find('.ep-num').first().text().trim();
    if (!/^\d+$/.test(num)) return;                    // speciály „SP", „6.5" … zatím nebereme
    const ep = Number(num);
    const href = $li.find('a.btn-download, a[href*="/soubory/subtitles/"]').first().attr('href');
    if (href && /\/soubory\/subtitles\//.test(href)) {
      const url = new URL(href, BASE).href;
      let filename = url.split('/').pop();
      try { filename = decodeURIComponent(filename); } catch {}
      if (map[ep] == null) map[ep] = { url, filename };
    } else if ($li.hasClass('is-wait') || !href) {
      waiting.add(ep);
    }
  });
  const timing = $('section.timing .info-big').first().text().trim() || null;
  return { map, waiting, timing, loggedIn: pageLoggedIn(html) };
}

// stránka anime si drží 15 min (víc dílů téhož anime v běhu = jeden dotaz)
const PAGE_TTL_MS = 15 * 60 * 1000;
const pageCache = new Map(); // slug -> { at, page }
async function animePage(slug, { fresh = false } = {}) {
  const hit = pageCache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.page;
  const { res, url } = await getFollow(`${BASE}/anime/${encodeURIComponent(slug)}`);
  if (isLoginUrl(url)) return { map: {}, waiting: new Set(), timing: null, loggedIn: false };
  if (res.status === 404) throw new Error(`hannya-subs: anime „${slug}" na webu není (404).`);
  if (!res.ok) throw new Error(`hannya-subs: HTTP ${res.status} (${url}).`);
  const page = parseAnimePage(await res.text());
  if (page.loggedIn) pageCache.set(slug, { at: Date.now(), page });
  return page;
}

// release z názvu „… - 4 (SubsPlease  ASW).ass" → „SubsPlease ASW"
function releaseFromName(filename) {
  const m = String(filename || '').match(/\(([^()]+)\)\s*\.(?:ass|ssa|srt)$/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

export async function download(sub) {
  const slug = slugFromUrl(sub.url);
  if (!slug) throw new Error(`hannya-subs: z odkazu nejde poznat anime (${sub.url}).`);

  if (!loggedIn) await login();
  let page = await animePage(slug);
  if (!page.loggedIn) {                                // relace vypršela → jednou znovu
    await login();
    page = await animePage(slug, { fresh: true });
    if (!page.loggedIn) throw new AuthExpired('hannya-subs: nepřihlášeno ani po novém přihlášení. Zkontroluj HANNYA_USER / HANNYA_PASS.', DOMAIN);
  }

  const hit = page.map[sub.episode];
  if (!hit) {
    if (page.waiting.has(sub.episode)) {
      throw new NotYetAvailable(`hannya-subs: díl ${sub.episode} je na webu „Čeká na vysílání".`);
    }
    const known = Object.keys(page.map).sort((a, b) => a - b).join(', ') || 'žádné';
    throw new NotYetAvailable(`hannya-subs: na stránce není díl ${sub.episode} (ke stažení: ${known}).`);
  }

  // stáhni .ass; přesměrování na /login = relace mezitím vypršela → jednou znovu
  let { res, url } = await getFollow(hit.url, { accept: '*/*' });
  if (isLoginUrl(url)) {
    await login();
    ({ res, url } = await getFollow(hit.url, { accept: '*/*' }));
    if (isLoginUrl(url)) throw new AuthExpired('hannya-subs: soubor chce přihlášení i po novém přihlášení.', DOMAIN);
  }
  if (!res.ok) throw new Error(`hannya-subs: HTTP ${res.status} při stahování dílu ${sub.episode}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 600).toString('utf8');
  if (!/\[Script Info\]|Dialogue:|-->/i.test(head) && !/Dialogue:/.test(buf.toString('utf8'))) {
    throw new Error('hannya-subs: stažený soubor nevypadá jako titulky.');
  }

  const release = sub.release || releaseFromName(hit.filename) || page.timing || null;
  return saveSubFile({ ...sub, group_name: sub.group_name || 'HannyaSubs', release }, buf, hit.filename);
}
