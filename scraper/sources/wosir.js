// scraper/sources/wosir.js — parser pro wosir.cz (ZATÍM NEIMPLEMENTOVÁNO).
//
// Odkazy z hiyori mají tvar:
//   https://wosir.cz/download.php?id=1339        (běžná verze)
//   https://wosir.cz/download_bd.php?id=1311      (BD verze)
//
// Až budeme dělat úroveň 2: prozkoumat, co ten endpoint vrací (přímý soubor?
// Content-Disposition? nutný vlastní login na wosir? Cloudflare?), pak sem
// doplnit download().
//
// export async function download(sub) {
//   // ... stáhni z sub.url, vrať { buf, filename }
// }

export const name = 'wosir.cz';
// download zatím záměrně neexportujeme → dispatcher nechá titulek jako pending_extern.
