#!/usr/bin/env bash
# Test, then deploy both Workers and apply migrations. Mirrors .github/workflows/deploy.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== tests"
(cd worker && npm run typecheck && npm test)
(cd insights && uv run --no-project --with pytest python -m pytest -q -c pyproject.toml)

echo "== insights (Python) first: the API Worker's service binding names it"
(cd insights && npx --prefix ../worker wrangler deploy)

echo "== D1 migrations, then the API Worker"
(cd worker && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy)
