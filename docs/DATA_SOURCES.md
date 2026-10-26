# Data sources

All are free and open. Attribution is shown beside each panel in the app, as the licences require.

| Source | Endpoint | Key | Cached | Licence | Coverage and caveats |
|---|---|---|---|---|---|
| postcodes.io | `api.postcodes.io/postcodes/{pc}` | none | 30 days | OGL; contains OS data © Crown copyright | UK. Terminated postcodes fall back to `/terminated_postcodes`. The IMD rank is the English Indices of Deprivation 2019 (32,844 LSOAs); no decile is claimed outside England. |
| data.police.uk | `crimes-street/all-crime?poly=…&date=…` | none | 14 days per month | OGL v3 | England, Wales, NI. Locations are anonymised to nearby points. **Greater Manchester Police does not publish street-level crime** to police.uk; the app says so instead of reporting "low crime". Add other forces to `FORCES_NOT_PUBLISHING` in `worker/src/sources/crime.ts` if you find more. |
| HM Land Registry Price Paid | `landregistry.data.gov.uk/landregistry/query` (SPARQL) | none | 7 days | OGL v3 | England and Wales, sales since 1995. Right-to-buy, gifts and some transfers do not appear. Medians use category A (standard) residential sales only. |
| EPC register | `api.get-energy-performance-data.communities.gov.uk/api/domestic/search` | **bearer token** (free) | 14 days | OGL v3 (address data subject to Royal Mail/OS terms) | England and Wales. Set `EPC_API_TOKEN`; without it the panel says "Not configured". The detail response is read defensively because the new service's schema has changed before. |
| Environment Agency flood monitoring | `environment.data.gov.uk/flood-monitoring/id/floodAreas`, `/id/floods` | none | areas 30 days, live warnings 15 min | OGL v3 | England only. |
| planning.data.gov.uk | `entity.json?latitude&longitude&dataset=…` and a 250 m box query | none | 30 days | OGL v3 | England. Completeness varies by council: absence of a designation is not proof there is none. |
| ONS Census 2021 via Nomis | `nomisweb.co.uk/api/v01/dataset/NM_2072_1` (TS054 tenure), `NM_2062_1` (TS044), `NM_2031_1` (TS011) | none | 90 days | OGL v3 | England and Wales, by 2021 LSOA (~1,500 people). |
| OpenStreetMap via Overpass | `maps.mail.ru`, `overpass.private.coffee`, `overpass.kumi.systems`, `overpass-api.de` | none | synced weekly into D1 per watch area | ODbL | Community-mapped. See ARCHITECTURE.md for why this is a directory and not a live query. |
| OpenStreetMap tiles | `tile.openstreetmap.org` | none | viewed tiles cached by the PWA | ODbL | Fine at charity scale under the OSM tile policy. For heavy use, switch `TILE_URL` in `public/shared/map.js` to a commercial tile provider. |

## Not included, and why

- **Council tax band / VOA** — no public API, and the VOA site forbids scraping.
- **Council empty-homes and business-rates lists** — published as files, differently per council. Import them through Admin → Import (CSV); the header matcher understands common column names.
- **Owner names** — HM Land Registry title registers cost a fee per title and name individuals; the app recommends the search but does not automate it.
- **Street-level imagery** — Google Street View needs a paid key and its terms do not allow storing images; workers' own photos are used instead.

## Adding a source

Write a `SourceDef` in `worker/src/sources/` (see `flood.ts` for a small one), add it to `SOURCES` in `sources/index.ts`, render it in `public/shared/area.js`, and, if it should move the score, read it in `insights/src/insights/scoring.py`.
