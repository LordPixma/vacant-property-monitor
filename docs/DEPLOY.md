# Deploying

Everything runs on Cloudflare. Workers Free is enough to try it; Workers Paid is recommended for a real team (more subrequests per cron run and longer CPU time).

## First deployment

```bash
cd worker && npm install

# 1. Resources
npx wrangler d1 create vacantwatch-db              # put database_id in wrangler.jsonc
npx wrangler kv namespace create vacantwatch-cache # put id in wrangler.jsonc
npx wrangler r2 bucket create vacantwatch-photos

# 2. The Python insights Worker first: the API Worker's service binding names it
cd ../insights && npx --prefix ../worker wrangler deploy

# 3. Schema, then the API Worker (serves the dashboard and field app too)
cd ../worker
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy

# 4. Secrets
python3 -c "import secrets; print(secrets.token_urlsafe(24))" | npx wrangler secret put SETUP_TOKEN
npx wrangler secret put EPC_API_TOKEN      # optional, from get-energy-performance-data.communities.gov.uk
```

Or run `scripts/deploy.sh`, which does steps 2 and 3 after running the tests.

Then open the Worker URL, enter the setup token to create the first admin, and:

1. **Admin → Settings**: your organisation's name, the outreach contact field workers see, and the council's Empty Homes Officer.
2. **Admin → Watch areas**: add the outcodes or sectors you cover. Each one syncs support services from OpenStreetMap.
3. **Admin → Users**: add coordinators and field workers. Each gets a one-time password to change at first sign-in.
4. Optionally **Admin → Import** a council empty-property list.
5. Field workers open `/field/` on their phone and choose "Add to Home Screen".

After setup, you can delete the setup token (`npx wrangler secret delete SETUP_TOKEN`); it only ever works while there are no users.

## Variables and secrets

| Name | Kind | Purpose |
|---|---|---|
| `ORG_NAME` | var | Default organisation name (Admin → Settings overrides it) |
| `ENVIRONMENT` | var | `production` |
| `CONTACT_EMAIL` | var, optional | Added to the User-Agent on public API calls, as OSM and police.uk ask |
| `SETUP_TOKEN` | secret | Creates the first admin; useless once one exists |
| `EPC_API_TOKEN` | secret, optional | Turns on the EPC panel |

## Custom domain

Workers → vacantwatch → Settings → Domains & Routes → add a custom domain on a zone in the same account.

## GitHub Actions

`.github/workflows/ci.yml` runs the TypeScript and Python tests on every push and pull request. `deploy.yml` runs the same tests and deploys both Workers on every push to `main` (or by hand from the Actions tab). It needs two repository secrets, under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN`: a token with Workers Scripts, D1, Workers KV Storage and Workers R2 Storage edit permissions on the account.
- `CLOUDFLARE_ACCOUNT_ID`: the account the resources in `wrangler.jsonc` live in.

Until both are set, the deploy job skips with a notice instead of failing.

## Backups

D1 keeps 30 days of Time Travel (`npx wrangler d1 time-travel info vacantwatch-db`). For an off-platform copy, `npx wrangler d1 export vacantwatch-db --remote --output backup.sql` on a schedule. Photos in R2 are not versioned; enable R2 bucket lifecycle or copy them out if they matter.

## Current deployment

| Resource | Name / id |
|---|---|
| API Worker | `vacantwatch` → https://vacantwatch.samuel-200.workers.dev |
| Python Worker | `vacantwatch-insights` (no public URL) |
| D1 | `vacantwatch-db` (`e4c4bc8a-7e7c-4059-a367-63d3012aaf94`) |
| KV | `vacantwatch-cache` (`c1f14143c05b42cc972b36eadd7eaa33`) |
| R2 | `vacantwatch-photos` |
| Crons | `15 * * * *` enrichment sweep, `40 3 * * *` revisits + rescore + services sync |
