printf '\033c'
printf 'docs/README.md\n==============\n'
sed -n '1,20p' docs/README.md
printf '\ndocs/CONTRIBUTING.md\n====================\n'
sed -n '1,55p' docs/CONTRIBUTING.md
printf '\ndocs/RELEASE-PROCESS.md\n=======================\n'
sed -n '1,31p' docs/RELEASE-PROCESS.md
