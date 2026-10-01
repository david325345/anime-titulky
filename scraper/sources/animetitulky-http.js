// scraper/sources/animetitulky-http.js — session pro animetitulky.com.
// Login má reCAPTCHA v3 (server ji kontroluje — bez tokenu vrátí „Ověření proti robotům
// se nepodařilo"), takže NEpřihlašujeme programově — použijeme hotovou přihlašovací
// cookie z prohlížeče (env ANIMETITULKY_COOKIE, získá ji PC skript at-cookie.mjs).
//
// ANIMETITULKY_COOKIE = "wordpress_logged_in_...=...; wordpress_sec_...=..."
//
// Stránky anime jsou veřejné (cookie se posílá, ale nevyžaduje).
// /stahnout/<id>/ bez přihlášení → 302 na /prihlaseni/?…at_notice=error → AuthExpired.

import { CONFIG } from '../../config.js';
import { hostGate } from '../ratelimit.js';
import { AuthExpired } from '../http.js';

const BASE = 'https://animetitulky.com';
const DOMAIN = 'animetitulky.com';

function cookie() {
  return (process.env.ANIMETITULKY_COOKIE || '').trim();
}

function headers(extra = {}) {
  const c = cookie();
  const h = {
    'User-Agent': CONFIG.userAgent,
    'Accept-Language': 'cs,sk;q=0.9,en;q=0.8',
    ...extra,
  };
  if (c) h.Cookie = c;
  return h;
}

const abs = (url) => (url.startsWith('http') ? url : BASE + url);

// veřejná stránka (seznam dílů) — přihlášení nekontrolujeme.
// Web je za CDN WEDOS (cache-control: max-age=300) → bez triku může vrátit až
// 5 min starou stránku, kde nový díl ještě chybí. Parametr _=<čas> cache obejde.
export async function getHtml(url) {
  const u0 = abs(url);
  const u = u0 + (u0.includes('?') ? '&' : '?') + '_=' + Date.now();
  await hostGate(u);
  const res = await fetch(u, { headers: headers(), redirect: 'follow' });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`animetitulky: stránka vrátila HTTP ${res.status} (${u})`);
  }
  return res.text();
}

// GET souboru titulků. Redirect na /prihlaseni/ = nepřihlášeno → AuthExpired.
export async function getBinary(url, { referer } = {}) {
  if (!cookie()) {
    throw new AuthExpired(
      'Chybí ANIMETITULKY_COOKIE (přihlašovací cookie animetitulky.com z prohlížeče, skript at-cookie.mjs). Nastav v Coolify env.',
      DOMAIN
    );
  }
  const u = abs(url);
  await hostGate(u);
  const res = await fetch(u, {
    headers: headers({ Referer: referer || BASE + '/' }),
    redirect: 'manual',
  });
  const loc = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400) {
    await res.arrayBuffer().catch(() => {});
    if (/prihlaseni|at_auth=login|at_notice=error/i.test(loc)) {
      throw new AuthExpired('animetitulky: nepřihlášeno (cookie vypršela?). Obnov ANIMETITULKY_COOKIE.', DOMAIN);
    }
    throw new Error('animetitulky: neočekávaný redirect: ' + loc);
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`animetitulky: stažení vrátilo HTTP ${res.status} (${u})`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    await res.arrayBuffer().catch(() => {});
    throw new Error('animetitulky: dostal jsem HTML místo souboru (odhlášeno?).');
  }
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentDisposition: res.headers.get('content-disposition') || '',
    contentType: ct,
  };
}

// ── Udržování přihlášení ─────────────────────────────────────────────────
// Web odhlašuje po 24 h neaktivity (plugin animetitulky-core, session-idle.js:
// timeout 86400 s) i když cookie platí 14 dní. Načtení stránky s cookie server
// počítá jako aktivitu → stačí se ozvat párkrát denně.
const KEEPALIVE_HOURS = Number(process.env.AT_KEEPALIVE_HOURS) || 12;
const RETRY_MIN = 30;          // při výpadku sítě zkus znovu za 30 min (ať nepřetáhneme 24 h)
const WARN_DAYS = 2;           // upozornit, když cookie vyprší do 2 dnů

// datum vypršení z wordpress_logged_in_ (hodnota = user|expirace|token|hmac)
function cookieExpiry() {
  const m = cookie().match(/wordpress_logged_in_[^=]*=([^;]+)/);
  if (!m) return null;
  let v = m[1];
  try { v = decodeURIComponent(v); } catch {}
  const exp = Number(v.split('|')[1]);
  return exp ? new Date(exp * 1000) : null;
}

// Jedno načtení hlavní stránky s cookie → { loggedIn, expires }
export async function keepAlive() {
  const u = `${BASE}/?_=${Date.now()}`;
  await hostGate(u);
  const res = await fetch(u, { headers: headers(), redirect: 'follow' });
  const html = await res.text();
  const loggedIn = /<body[^>]*class="[^"]*\blogged-in\b/i.test(html);
  return { loggedIn, status: res.status, expires: cookieExpiry() };
}

let keepAliveTimer = null;
export function startKeepAlive({ log = console.log } = {}) {
  if (keepAliveTimer) return;
  if (!cookie()) {
    log('[animetitulky] ANIMETITULKY_COOKIE není nastavená — udržování přihlášení vypnuto.');
    return;
  }
  const fmt = (d) => d.toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  const tick = async () => {
    let nextMs = KEEPALIVE_HOURS * 3600000;
    try {
      const r = await keepAlive();
      if (!r.loggedIn) {
        log(`[animetitulky] 🔒 ODHLÁŠENO (HTTP ${r.status}) — obnov ANIMETITULKY_COOKIE (C:\\at → node at-cookie.mjs).`);
      } else if (r.expires) {
        const days = (r.expires - Date.now()) / 86400000;
        if (days <= WARN_DAYS) {
          log(`[animetitulky] ⚠ přihlášení udrženo, ale cookie vyprší ${fmt(r.expires)} (za ${days.toFixed(1)} dne) — obnov ANIMETITULKY_COOKIE.`);
        } else {
          log(`[animetitulky] přihlášení udrženo (cookie platí do ${fmt(r.expires)}).`);
        }
      } else {
        log('[animetitulky] přihlášení udrženo.');
      }
    } catch (e) {
      nextMs = RETRY_MIN * 60000;
      log(`[animetitulky] udržování přihlášení selhalo (${e.message}) — zkusím znovu za ${RETRY_MIN} min.`);
    }
    keepAliveTimer = setTimeout(tick, nextMs);
  };
  // první ping chvíli po startu (restart = nový odpočet), pak každých KEEPALIVE_HOURS
  keepAliveTimer = setTimeout(tick, 60000);
}

export { BASE as AT_BASE };
