// tools/oprav-gzip-archiv.mjs — najde v archivu (akihabara.db) titulky, které na R2 leží
// NEZABALENÉ, přestože klíč končí .gz, a zabalí je gzipem (obsah se nemění).
// Addon i služba soubory z R2 rozbalují, takže nezabalený soubor jim nefungoval
// (u fontů hlášeno jako „incorrect header check“).
//
// Použití (terminál kontejneru služby, složka /app):
//   node tools/oprav-gzip-archiv.mjs                    jen kontrola Soul Eater (AL 3588)
//   node tools/oprav-gzip-archiv.mjs --opravit          kontrola + oprava Soul Eater
//   node tools/oprav-gzip-archiv.mjs --anilist=1234     jiné anime (s --opravit opraví)
//   node tools/oprav-gzip-archiv.mjs --vse [--opravit]  celý archiv (~13 tisíc souborů, desítky minut)
//
// Po opravě smaže u opravených titulků chybové záznamy fontů (sub_fonts, stav 'error'),
// aby se při dalším vyžádání zpracovaly znovu. Archivní DB se nemění.

import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { CONFIG } from '../config.js';
import { r2Enabled, r2Get, r2Put, isGzip } from '../r2.js';

const args = process.argv.slice(2);
const fix = args.includes('--opravit');
const all = args.includes('--vse');
const alArg = args.find((a) => a.startsWith('--anilist='));
const anilist = all ? null : Number(alArg ? alArg.split('=')[1] : 3588);
const PARALLEL = 6;

if (!r2Enabled()) {
  console.error('R2 není nastavené (chybí R2_* env).');
  process.exit(1);
}
const aki = new Database(path.join(CONFIG.dataDir, 'akihabara.db'), { readonly: true, fileMustExist: true });
const rows = aki
  .prepare(
    'SELECT akihabara_id AS id, anime_title, episode, r2_key FROM subs ' +
    "WHERE r2_key IS NOT NULL AND r2_key <> ''" +
    (anilist ? ' AND anilist_id = ?' : '') +
    ' ORDER BY anime_title, episode'
  )
  .all(...(anilist ? [anilist] : []));
console.log(
  `Kontroluji ${rows.length} titulků ${all ? 'v celém archivu' : `AL ${anilist}`}` +
  (fix ? ' a opravuji nezabalené…' : ' (jen kontrola — oprava s --opravit)…')
);

const bad = [];      // klíč .gz, ale soubor není gzip
const missing = [];  // soubor na R2 není
const failed = [];   // chyba při čtení / opravě
let ok = 0;
let done = 0;

async function check(r) {
  try {
    const buf = await r2Get(r.r2_key);
    if (!buf) { missing.push(r); return; }
    if (isGzip(buf) || !/\.gz$/i.test(r.r2_key)) { ok++; return; }
    bad.push(r);
    if (!fix) return;
    await r2Put(r.r2_key, zlib.gzipSync(buf), 'application/gzip');
    // kontrola: po nahrání musí jít rozbalit na přesně původní obsah
    const back = await r2Get(r.r2_key);
    if (!back || !isGzip(back) || !zlib.gunzipSync(back).equals(buf)) throw new Error('kontrola po nahrání nesedí');
    r.fixed = true;
  } catch (e) {
    failed.push({ ...r, error: e.message });
  } finally {
    if (++done % 500 === 0) console.log(`  … ${done}/${rows.length}`);
  }
}

let next = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < rows.length) await check(rows[next++]);
}));

const ep = (r) => (r.episode != null ? `díl ${r.episode}` : 'film');
console.log(`\nV pořádku: ${ok} | nezabalené: ${bad.length} | chybí na R2: ${missing.length} | chyby: ${failed.length}`);
for (const r of bad) console.log(`  ${r.fixed ? '✔ opraveno ' : '✗ nezabalené'}  ${r.id}  ${r.anime_title} – ${ep(r)}`);
for (const r of missing) console.log(`  ? chybí na R2  ${r.id}  ${r.anime_title} – ${ep(r)}  (${r.r2_key})`);
for (const r of failed) console.log(`  ! chyba  ${r.id}  ${r.anime_title} – ${ep(r)}: ${r.error}`);

const fixedIds = bad.filter((r) => r.fixed).map((r) => r.id);
if (fixedIds.length) {
  const main = new Database(path.join(CONFIG.dataDir, 'hiyori.db'));
  main.pragma('busy_timeout = 8000');
  const del = main.prepare("DELETE FROM sub_fonts WHERE src = 'aki' AND sub_id = ? AND state = 'error'");
  let n = 0;
  for (const id of fixedIds) n += del.run(id).changes;
  main.close();
  console.log(`\nOpraveno ${fixedIds.length} souborů. Smazáno ${n} chybových záznamů fontů — zpracují se při dalším vyžádání.`);
} else if (bad.length && !fix) {
  console.log('\nOpravíš je stejným příkazem s --opravit.');
}
aki.close();
