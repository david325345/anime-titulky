// scraper/sources/underkotatsu-http.js — session pro underkotatsusubs.cz.
// Login má reCAPTCHA v3, takže NEpřihlašujeme programově — použijeme hotovou
// přihlašovací cookie z prohlížeče (env UK_COOKIE). Cookie s "remember me" platí ~14 dní.
//
// UK_COOKIE = "wordpress_logged_in_...=...; wordpress_sec_...=..."
// (zkopíruj z DevTools → Application → Cookies; přihlas se se zaškrtnutým Remember me)

import { CONFIG } from '../../config.js';
import { hostGate } from '../ratelimit.js';

const BASE = 'https://www.underkotatsusubs.cz';

function cookie() {
  return (process.env.UK_COOKIE || '').trim();
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

function assertCookie() {
  if (!cookie()) {
    throw new Error(
      'Chybí UK_COOKIE (přihlašovací cookie underkotatsusubs.cz z prohlížeče). Nastav v Coolify env.'
    );
  }
}

export async function getHtml(url) {
  assertCookie();
  const abs = url.startsWith('http') ? url : BASE + url;
  await hostGate(abs);
  await hostGate(abs);
  const res = await fetch(abs, { headers: headers(), redirect: 'follow' });
  const text = await res.text();
  if (!/logged-in|logout|wp-admin|Odhlás/i.test(text)) {
    throw new Error('underkotatsusubs: cookie neplatí (nejsme přihlášeni). Obnov UK_COOKIE.');
  }
  return text;
}

// GET souboru. Sleduje redirect na /no-access/ (= odhlášeno) a hlásí to.
export async function getBinary(url, { referer } = {}) {
  assertCookie();
  const abs = url.startsWith('http') ? url : BASE + url;
  await hostGate(abs);
  const res = await fetch(abs, {
    headers: headers({ Referer: referer || BASE + '/' }),
    redirect: 'manual',
  });
  const loc = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400) {
    await res.arrayBuffer().catch(() => {});
    if (/no-access/i.test(loc)) {
      throw new Error('underkotatsusubs: no-access (cookie vypršela?). Obnov UK_COOKIE.');
    }
    throw new Error('underkotatsusubs: neočekávaný redirect: ' + loc);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    await res.arrayBuffer().catch(() => {});
    throw new Error('underkotatsusubs: dostal jsem HTML místo souboru (odhlášeno?).');
  }
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentDisposition: res.headers.get('content-disposition') || '',
    contentType: ct,
  };
}

export { BASE as UK_BASE };
