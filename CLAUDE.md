# VacantWatch

A standalone vacant-property monitor for a homelessness charity. **It is not part of PropertyManager360**: it lives in this folder of the PropFlow360 repository only until it moves to its own repository, and none of the PM360 rules in the parent CLAUDE.md (organisation scoping, monday.com boards, PM360 deploy pipeline, brand rules) apply here. Nothing in the parent `pnpm-workspace.yaml` or `.github/workflows` builds or deploys it.

## Layout and commands

- `worker/` TypeScript API Worker + static dashboard (`public/app`) and field PWA (`public/field`). `npm test`, `npm run typecheck`, `npx wrangler dev -c wrangler.jsonc -c ../insights/wrangler.jsonc`.
- `insights/` Python Worker (scoring, area profile). `uv run --no-project --with pytest python -m pytest -q -c pyproject.toml`.
- Deploy: `scripts/deploy.sh` (insights first, then migrations, then the API Worker). Details in `docs/DEPLOY.md`.

## Rules

- A CHECK-constrained column takes its values from `worker/src/lib/enums.ts`; `test/wiring.test.ts` replays every migration and fails on disagreement.
- Crons: `triggers.crons` in `wrangler.jsonc` must match `CRON_*` in `src/cron.ts`. Never export anything but the default handler from `src/index.ts`: Workers treat every named export of the entry module as an entrypoint.
- Every create/update/delete calls `audit()`.
- Enrichment runs to a time budget (`BUDGET` in `src/enrich.ts`); work started from a request must finish inside `waitUntil`'s ~30 s.
- Do not query Overpass per property: Cloudflare egress is refused or rate-limited. Services come from the `support_services` directory.
- Offline writes carry a `client_id`; any new write endpoint the field app uses must be idempotent on it.
- Frontend HTML goes through the `html` tagged template in `public/shared/ui.js`, which escapes every interpolation. Use `raw()` only for markup you built.
- No semicolons inside SQL string literals in migrations.
