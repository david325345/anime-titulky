// r2.js — upload titulků na Cloudflare R2 (S3-kompatibilní API) přes aws4fetch.
// Když nejsou nastavené R2 klíče, upload se přeskočí (služba jede jen lokálně).
import { AwsClient } from 'aws4fetch';
import { CONFIG } from './config.js';

let client = null;
function getClient() {
  const { accountId, accessKeyId, secretKey } = CONFIG.r2;
  if (!accountId || !accessKeyId || !secretKey) return null;
  if (!client) {
    client = new AwsClient({
      accessKeyId,
      secretAccessKey: secretKey,
      region: 'auto',
      service: 's3',
    });
  }
  return client;
}

export function r2Enabled() {
  return !!getClient();
}

function endpoint(key) {
  const safe = key.split('/').map(encodeURIComponent).join('/');
  return `https://${CONFIG.r2.accountId}.r2.cloudflarestorage.com/${CONFIG.r2.bucket}/${safe}`;
}

// veřejné URL (pokud je nastaven R2_PUBLIC_BASE), jinak null
export function r2PublicUrl(key) {
  if (!CONFIG.r2.publicBase) return null;
  const safe = key.split('/').map(encodeURIComponent).join('/');
  return `${CONFIG.r2.publicBase}/${safe}`;
}

// nahraje buffer na R2. Vrací key, nebo hodí chybu.
export async function r2Put(key, body, contentType = 'application/octet-stream') {
  const c = getClient();
  if (!c) return null;
  const res = await c.fetch(endpoint(key), {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${res.status}: ${t.slice(0, 200)}`);
  }
  return key;
}
