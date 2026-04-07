#!/usr/bin/env bash
set -euo pipefail

# Tarball proof commands used:
#   MISE_TRUSTED_CONFIG_PATHS="$PWD:/tmp:$HOME/.npm" npx -y npm@11.9.0 run build
#   MISE_TRUSTED_CONFIG_PATHS="$PWD:/tmp:$HOME/.npm" npx -y npm@11.9.0 pack --json --ignore-scripts --pack-destination dogfood/install-flows/tarball-artifact
#   MISE_TRUSTED_CONFIG_PATHS="$PWD:/tmp:$HOME/.npm" npx -y npm@11.9.0 install -g --prefix <tarball-prefix> <tarball.tgz>
#   PATH="$(dirname "/home/coder/.npm/_npx/387698761821791d/node_modules/node/bin/node"):$PATH" <tarball-prefix>/bin/agent-terminal version --json
#   PATH="$(dirname "/home/coder/.npm/_npx/387698761821791d/node_modules/node/bin/node"):$PATH" <tarball-prefix>/bin/agent-terminal --home <isolated-home> doctor --json
#   /home/coder/.npm/_npx/387698761821791d/node_modules/node/bin/node --import tsx ./src/cli/main.ts create/run/wait/screenshot/record export ...
#
# Git proof commands used:
#   MISE_TRUSTED_CONFIG_PATHS="$PWD:/tmp:$HOME/.npm" npx -y npm@11.9.0 install -g --prefix <git-prefix> "git+file:///tmp/tmp.6ZtZ24ucrQ/src#4443b7a66dcf91e9798773abdf363eda746358aa"
#   /home/coder/.npm/_npx/387698761821791d/node_modules/node/bin/node --import tsx ./src/cli/main.ts create/run/wait/screenshot/record export ...
#
# See tarball/install-step.sh, tarball/version-step.sh, tarball/doctor-step.sh,
# and git/install-step.sh for the exact terminal-display commands captured in the screenshots/video.
