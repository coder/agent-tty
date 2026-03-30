#!/usr/bin/env bash
set -euo pipefail
BUNDLE="dogfood/20260330-docs-navigation"
HOME_DIR="$(mktemp -d)"
CLI=(npx tsx src/cli/main.ts --home "$HOME_DIR")
# See notes.md for the exact proof artifacts copied from the generated session.
