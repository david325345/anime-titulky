// config.js — veškerá konfigurace z env proměnných (nastav v Coolify).
// Přihlašovací údaje NIKDY nedávej do kódu, jen do env.

import path from 'node:path';

export const CONFIG = {
  // přihlášení do hiyori (nastav v Coolify: HIYORI_USER / HIYORI_PASS)
  user: process.env.HIYORI_USER || '',
  pass: process.env.HIYORI_PASS || '',

  baseUrl: 'https://hiyori.cz',
  userAgent:
    process.env.HIYORI_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  // kam se ukládá SQLite + stažené soubory (v Coolify připoj persistent volume sem)
  dataDir: process.env.DATA_DIR || path.resolve('./data'),

  port: Number(process.env.PORT || 8080),

  // scrape interval v minutách (0 = vypnout automatiku, jen ruční tlačítko)
  intervalMin: Number(process.env.SCRAPE_INTERVAL_MIN || 60),

  // spustit scrape hned po startu služby?
  runOnBoot: process.env.RUN_ON_BOOT !== 'false',

  // stahovat soubory? Zatím VYPNUTO — jen evidujeme, co přibylo. Zapneš přes env.
  downloadEnabled: process.env.DOWNLOAD_ENABLED === 'true',

  // ve feedu bereme karty novější než (poslední běh − tento buffer), kvůli překryvu
  feedOverlapMin: Number(process.env.FEED_OVERLAP_MIN || 20),

  // strop na počet detailů (anime) za jeden běh — ochrana proti hammrování
  maxDetailsPerRun: Number(process.env.MAX_DETAILS_PER_RUN || 80),

  // limit stažených titulků z JEDNOHO webu za běh (per-doména)
  maxDownloadsPerHost: Number(process.env.MAX_DOWNLOADS_PER_HOST || 2),

  // volitelný celkový strop za běh napříč všemi weby (0 = bez stropu)
  maxDownloadsPerRun: Number(process.env.MAX_DOWNLOADS_PER_RUN || 0),

  // min. rozestup (ms) mezi requesty na TÝŽ web (per-doména brzda proti banu)
  perHostDelayMs: Number(process.env.PER_HOST_DELAY_MS || 4000),

  // pauza mezi requesty (ms) — základ; skutečná pauza je náhodná v rozsahu min–max
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS || 2000),
  delayMinMs: Number(process.env.DELAY_MIN_MS || 0), // 0 = odvodit z requestDelayMs
  delayMaxMs: Number(process.env.DELAY_MAX_MS || 0),

  // anti-ban: kolik requestů za sebou smí selhat, než běh utneme
  maxConsecutiveErrors: Number(process.env.MAX_CONSECUTIVE_ERRORS || 4),

  // při HTTP 429/503: kolikrát zkusit znovu a základní čekání (když chybí Retry-After)
  rateLimitRetries: Number(process.env.RATE_LIMIT_RETRIES || 2),
  rateLimitBackoffMs: Number(process.env.RATE_LIMIT_BACKOFF_MS || 30000),

  // Cloudflare R2 (S3 API). Když chybí klíče, upload na R2 se přeskočí (jen lokální uložení).
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'titulky-cache',
    prefix: process.env.R2_PREFIX || 'subs',
    publicBase: (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, ''), // volitelné veřejné URL
  },

  // Zdroje, které se NEMAJÍ vůbec evidovat — záznamy z nich se při přidávání
  // anime přeskočí (nezaloží se ani jako pending_extern). Hodí se pro archivy,
  // které už máme kompletně naimportované jinudy (např. TeamNS v akihabara.db).
  // Porovnává se bez ohledu na velikost písmen a okolní mezery.
  // Přebít jde přes env, čárkou oddělený seznam.
  blocked: {
    domains: (process.env.BLOCKED_DOMAINS || 'teamns.gensubs.cz')
      .split(',').map((s) => s.trim()).filter(Boolean),
    groups: (process.env.BLOCKED_GROUPS || 'Team NShonyaku')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  // Basic Auth na dashboard + admin (addon endpointy zůstávají veřejné).
  // Když AUTH_USER/AUTH_PASS chybí, dashboard není chráněný.
  // AUTH_USER2/AUTH_PASS2 je volitelný druhý účet se stejnými právy.
  auth: {
    user: process.env.AUTH_USER || '',
    pass: process.env.AUTH_PASS || '',
    user2: process.env.AUTH_USER2 || '',
    pass2: process.env.AUTH_PASS2 || '',
  },

  // Český "fetcher" agent (agent.php na CZ hostingu). Weby ange.3mka.cz a wosir.cz
  // blokují zahraniční/datacenter IP → stahujeme přes něj. Bez AGENT_URL se tyto
  // zdroje nestahují (parser hodí srozumitelnou chybu).
  agent: {
    url: process.env.AGENT_URL || '',
    token: process.env.AGENT_TOKEN || '',
  },

  // wosir.cz — vyžaduje vlastní účet (přihlášení e-mailem).
  wosir: {
    email: process.env.WOSIR_EMAIL || '',
    pass: process.env.WOSIR_PASS || '',
  },

  // gensubs.cz — vyžaduje vlastní účet (web jde přímo, bez agenta).
  gensubs: {
    user: process.env.GENSUBS_USER || '',
    pass: process.env.GENSUBS_PASS || '',
  },
};

export function assertConfig() {
  if (!CONFIG.user || !CONFIG.pass) {
    throw new Error(
      'Chybí přihlašovací údaje. Nastav env HIYORI_USER a HIYORI_PASS (v Coolify).'
    );
  }
}
