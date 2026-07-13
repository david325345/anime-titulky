// scraper/sources/hanabi-http.js — HTTP vrstva pro hanabi.fan.
// Přihlášení přes tři cookies z env HANABI_COOKIE:
//   hcdn=... ; _lscache_vary=... ; wordpress_logged_in_...=...
// (hcdn je httpOnly, generovaná serverem — získává se přes Playwright session.)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COOKIE = process.env.HANABI_COOKIE || '';

export function hasCookie() {
  return !!COOKIE && /wordpress_logged_in_/.test(COOKIE);
}

// načte HTML přihlášené stránky (s cache-bustem, aby LiteSpeed nedal guest verzi)
export async function getHtml(url) {
  const bust = (url.includes('?') ? '&' : '?') + 'nc=' + Date.now();
  const res = await fetch(url + bust, {
    headers: {
      'User-Agent': UA,
      Cookie: COOKIE,
      'Cache-Control': 'no-cache',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`hanabi: HTTP ${res.status} (${url})`);
  return res.text();
}

// stáhne binární soubor (ZIP z CDN img.hanabi.fan — veřejné, ale UA pro jistotu)
export async function getBinary(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`hanabi CDN: HTTP ${res.status} (${url})`);
  return Buffer.from(await res.arrayBuffer());
}
