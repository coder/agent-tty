set -euo pipefail
printf '\033c'
echo '# tarball install transcript'
tail -n 60 "/home/coder/.mux/src/agent-terminal/npm-install-5r2j/dogfood/install-flows/tarball/install.log"
echo '__DOGFOOD_DONE__ install'
