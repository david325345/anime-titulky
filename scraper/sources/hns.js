// scraper/sources/hns.js — parser pro hns.sk (ZATÍM NEIMPLEMENTOVÁNO).
//
// Odkazy z hiyori mají tvar:
//   https://hns.sk/anime/episode/{slug}/{id}
// Tohle je stránka epizody, ne přímý soubor — bude potřeba z ní vyparsovat
// odkaz na stažení titulku (a nejspíš vlastní session na hns.sk).
//
// export async function download(sub) {
//   // ... najdi na stránce odkaz na soubor, stáhni, vrať { buf, filename }
// }

export const name = 'hns.sk';
// download zatím záměrně neexportujeme → dispatcher nechá titulek jako pending_extern.
