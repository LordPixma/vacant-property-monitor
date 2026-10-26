# VacantWatch — vacant property monitor

A tool for a homelessness charity to find, track and act on empty homes in the postcodes it covers: council and housing-association voids, long-term empty private houses, and derelict or abandoned buildings. Field workers record what they see on the ground from their phones, online or offline. Coordinators see every case on a map with a priority score, the reasons behind it and what to do next, alongside all the public data on the property and its neighbourhood.

Runs entirely on Cloudflare: Workers (TypeScript and Python), D1, R2, KV, static assets and Cron Triggers.

**Live deployment:** https://vacantwatch.samuel-200.workers.dev · field app: https://vacantwatch.samuel-200.workers.dev/field/

## What it does

| | |
|---|---|
| **Dashboard** (`/`) | Overview tiles, map of every case coloured by priority, filterable property register, property pages with visits, photos, tasks, history and eight public-data panels, a postcode **area report** for anywhere in England and Wales, tasks board, CSV / GeoJSON export. |
| **Admin** (`/#/admin`) | Users and roles, watch areas (postcode outcodes, sectors or full postcodes), a support-services directory, CSV import of council or partner empty-property lists, data-source health, settings, and the audit log. |
| **Field app** (`/field/`) | Installable PWA. Properties near me (GPS), report a new property, log a visit with tap-to-tick signals, photos (resized and stripped of EXIF on the phone), my tasks, help nearby (shelters, food banks, health). Everything works offline and syncs when there is signal. |
| **Insights** (Python Worker) | Scores each property 0–100 for priority, estimates how likely it is to be empty, explains every point, recommends next steps (StreetLink referral, report an unsafe building, Empty Homes Officer, EDMO, Land Registry owner search) and writes a plain-English area profile. |

### Public data gathered for every property

| Source | What you get |
|---|---|
| postcodes.io (ONS Postcode Directory) | Coordinates, local authority, ward, parish, constituency, police force, LSOA/MSOA, rural/urban class, **Index of Multiple Deprivation** rank and decile |
| data.police.uk | Street-level crime for the last three months within the area radius, by category; anti-social behaviour; top streets; outcomes; the neighbourhood policing team's contact details |
| HM Land Registry Price Paid (SPARQL) | This property's sale history; every sale in the postcode; five-year median and yearly medians (portfolio and non-residential sales excluded) |
| EPC register (optional, free token) | This property's energy band, floor area, age, tenure at assessment, heating; bands across the postcode |
| Environment Agency | Flood alert and warning areas; live flood warnings |
| planning.data.gov.uk | Conservation area, Article 4, listed building (on site or within 15 m), brownfield register, tree preservation, green belt, flood risk zone; listed buildings and brownfield sites within 250 m |
| ONS Census 2021 via Nomis | Tenure (including council and housing-association renting), accommodation type, household deprivation for the LSOA |
| OpenStreetMap + your own entries | Shelters, food banks, outreach, GPs, pharmacies, community centres, toilets and water, police, transport — synced daily per watch area into D1 |

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for limits and licences.

## Layout

```
worker/      TypeScript API Worker (Hono) + static dashboard and field PWA (worker/public)
  src/         routes, auth, enrichment, public-data source adapters, cron
  migrations/  D1 schema (SQL)
  test/        vitest unit tests
insights/    Python Worker: priority scoring and area profiles (service-bound, not public)
  src/insights/  pure Python, tested with pytest
docs/        architecture, data sources, deployment, data protection, field guide
scripts/     deploy, vendoring and icon rendering
```

## Quick start

```bash
cd worker && npm install
npx wrangler d1 migrations apply DB --local
printf 'SETUP_TOKEN=local-setup-token\nENVIRONMENT=development\n' > .dev.vars
npx wrangler dev -c wrangler.jsonc -c ../insights/wrangler.jsonc   # both Workers on :8787
```

Open http://localhost:8787, create the first admin with the setup token, then add a watch area.

Tests: `cd worker && npm test && npm run typecheck` and `cd insights && uv run --with pytest pytest`.

Deploying to your own Cloudflare account: [docs/DEPLOY.md](docs/DEPLOY.md).

## Read before using it with real people

This holds information about buildings and, through visit notes and photos, can touch on people. [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md) covers what to record and what not to, and [docs/FIELD_GUIDE.md](docs/FIELD_GUIDE.md) is the one-page brief for field workers: observe from the street, never enter a building, and refer anyone who may be sleeping rough to StreetLink.
