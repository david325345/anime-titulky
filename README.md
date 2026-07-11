# NimeToDex · Titulky

Samostatná služba, která scrapuje fansub titulky z hiyori.cz a ukazuje v web dashboardu,
co se poslední přidalo a jestli se stažení povedlo.

## Jak to funguje

1. **Feed** `/anime/posledni-pridane-titulky` → zjistí, která anime mají čerstvé titulky.
2. **Detail** `/anime/{id}` → z tabulky vytáhne každý titulek: `sub_id` (dedup klíč),
   epizoda, jazyk (CZ/SK), skupina, release, verze a download odkaz + `anilist`/`mal` ID.
3. **Stažení**
   - **direct** (`/anime/downloadsubtitles?id=`) → stáhne rovnou soubor (.ass/.srt/.zip).
   - **extern** (wosir.cz, hns.sk, …) → zatím jen zaznamená odkaz (`pending_extern`);
     parsery přidáváme postupně do `scraper/sources/`.

Dedup jede přes `sub_id`, takže každý běh řeší jen skutečně nové titulky.

## Struktura

```
server.js            web dashboard + API + hodinový interval
config.js            konfigurace z env
db.js                SQLite schema + dotazy
scraper/
  http.js            session (cookie Hiyori), login, GET/binary + auto-relogin
  feed.js            parser feedu
  detail.js          parser detailu /anime/{id}
  download.js        stažení přímých titulků
  run.js             orchestrace jednoho běhu
  sources/           externí weby (dispatcher + placeholdery wosir/hns)
public/              dashboard (index.html + style.css + app.js)
Dockerfile
```

Data (SQLite `hiyori.db` + stažené titulky ve `files/`) se ukládají do `DATA_DIR` (`/data`).

## Nasazení v Coolify

1. Nový resource → **Dockerfile** (nebo Git repo s tímto Dockerfile).
2. **Environment** – nastav minimálně:
   - `HIYORI_USER`
   - `HIYORI_PASS`
3. **Persistent Storage** – připoj volume na `/data` (jinak se DB i titulky ztratí při redeployi).
4. **Port** – aplikace poslouchá na `8080`.
5. Deploy. Dashboard je pak na přiřazené doméně; scrape jede automaticky 1×/h
   a jde spustit i tlačítkem „Spustit teď".

## Lokální test

```bash
npm install
HIYORI_USER=Procho HIYORI_PASS=... DATA_DIR=./data node server.js
# nebo jen jeden běh scrapu bez serveru:
HIYORI_USER=Procho HIYORI_PASS=... DATA_DIR=./data npm run run-once
```

## Přidání parseru pro externí web

V `scraper/sources/<domena>.js` doplň `export async function download(sub)`,
která z `sub.url` stáhne soubor a vrátí `{ buf, filename }`, a zaregistruj modul
v `scraper/sources/index.js`. Titulky té domény se pak přestanou označovat jako
`pending_extern` a začnou se stahovat.

## TODO (úroveň 2+)

- parsery wosir.cz (`download.php?id=`, `download_bd.php?id=`) a hns.sk (stránka epizody)
- napojení na indexer: mapování `anilist_id` → mal/kitsu/anidb (Fribb/manami) a dál na imdb/tvdb + season
- API endpoint pro dotaz podle libovolného ID (`anilist`/`imdb`/`mal` + epizoda) → varianty + odkaz ke stažení
- upload titulků na R2
