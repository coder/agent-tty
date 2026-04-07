set -euo pipefail
printf '\033c'
echo '# git install transcript (blocked in this workspace)'
tail -n 80 "/home/coder/.mux/src/agent-terminal/npm-install-5r2j/dogfood/install-flows/git/install.log"
echo '__DOGFOOD_DONE__ install'
