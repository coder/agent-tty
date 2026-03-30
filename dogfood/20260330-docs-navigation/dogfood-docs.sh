printf '\033c'
printf 'dogfood/README.md\n=================\n'
sed -n '1,29p' dogfood/README.md
printf '\ndogfood/CATALOG.md\n==================\n'
sed -n '1,55p' dogfood/CATALOG.md
