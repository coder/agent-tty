#!/usr/bin/env bash
set -euo pipefail
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run smoke:install -- --skip-build
echo "OXC_MIGRATION_DOGFOOD_DONE"
