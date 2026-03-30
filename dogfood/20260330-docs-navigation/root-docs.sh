printf '\033c'
printf 'README.md\n=========\n'
sed -n '1,54p' README.md
printf '\nRELEASE.md\n==========\n'
sed -n '1,38p' RELEASE.md
printf '\nROADMAP.md\n==========\n'
sed -n '1,39p' ROADMAP.md
