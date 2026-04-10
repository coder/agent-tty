#!/usr/bin/env bash
set -euo pipefail

# Local proof commands used:
#   npm run pack:release -- --pack-destination dogfood/20260410-release-tarball/release-artifact --metadata-file dogfood/20260410-release-tarball/package-metadata.json
#   npm install -g --prefix <install-prefix> <release-tarball.tgz>
#   PATH="<node24-bin>:$PATH" <install-prefix>/bin/agent-terminal version --json
#   PATH="<node24-bin>:$PATH" <install-prefix>/bin/agent-terminal --home <verify-home> doctor --json
#   PATH="<node24-bin>:$PATH" <node24> dist/cli/main.js --home <session-home> create/run/wait/screenshot/record export ...
